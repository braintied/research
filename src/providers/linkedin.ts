/**
 * LinkedIn public profile — STRICT, consent-gated, one person at a time.
 *
 * This module fetches ONE person's own public LinkedIn profile, from a URL
 * that person supplied, after that source's consent card. It is modelled on
 * `providers/instagram.ts` (strict, fail-closed) and deliberately NOT on the
 * tolerant LinkedIn *posts* wrapper in `providers/brightdata.ts`, which logs a
 * warning and returns `[]` when its dataset id is unset. A tolerated empty
 * result is the wrong contract here twice over: it reads as "this person has
 * no profile" to an interview that is about to open with what it just learned,
 * and it hides a misconfiguration behind a person's name.
 *
 * What it reads: headline, summary/about, current and past positions,
 * education, skills, location, and the public websites the profile itself
 * lists.
 *
 * What it never reads: connections, followers lists, messages, other people's
 * profiles, or anyone's posts. Those fields are not in the normalizer, so the
 * absence is structural rather than a policy comment. `refuseNonProfileUrl`
 * and the identifier-mismatch check in `normalizeLinkedInProfileRecord` are
 * the two guards that keep a caller from pointing this at a second person.
 *
 * Env (resolved by the HOST and passed in as `ResearchCredentials`, never read
 * here — see `test/no-direct-env.test.ts`):
 *   BRIGHTDATA_API_TOKEN   required. Bright Data Web Scraper API bearer token.
 *
 * The dataset id is a constant, not an env var, for the same reason the
 * Instagram profiles dataset is: it identifies a Bright Data *collector*, not
 * a secret, and an unset env var is how the tolerant wrapper turns a
 * misconfiguration into a successful empty sweep.
 */

import { z } from 'zod';
import { createEvidenceIdentity, EvidenceItemSchema, type EvidenceItem } from '../evidence.js';
import { MissingCredentialError, type ResearchCredentials } from '../credentials.js';
import { logger } from '../logger.js';
import { sleep } from '../pipeline-core.js';
import { requireSourceConsent, type ConsentProof } from '../consent-gate.js';

// =============================================================================
// Constants
// =============================================================================

const BRIGHTDATA_BASE_URL = 'https://api.brightdata.com/datasets/v3';

/**
 * Bright Data's LinkedIn *profile* collector — the same dataset Sentigen's
 * onboarding enrichment uses (`src/lib/scraping/brightdata-client.ts`). Not
 * the posts collector, which is `BRIGHTDATA_LINKEDIN_DATASET_ID` and belongs
 * to the tolerant ingestion wrapper.
 */
export const BRIGHTDATA_LINKEDIN_PROFILES_DATASET_ID = 'gd_l1viktl72bvl7bjuj0';

/** The consent purpose a caller must hold before this provider will run. */
export const LINKEDIN_PUBLIC_PROFILE_PURPOSE = 'source:linkedin_public_profile';

/** Source pack id carried on every evidence item this module emits. */
export const LINKEDIN_PUBLIC_PROFILE_SOURCE_PACK = 'linkedin-public-profile';

const TRIGGER_TIMEOUT_MS = 30_000;
const PROGRESS_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const SCRAPE_TIMEOUT_MS = 90_000;

// One profile, not a discovery crawl: a profile scrape returns a single record
// and settles in seconds. The 20-minute ceiling the Instagram *posts*
// discovery needs would turn a dead snapshot into a hung interview.
const POLL_INITIAL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 8_000;
const POLL_MAX_WAIT_MS = 120_000;

/**
 * Paths under linkedin.com that are not a member profile. `/in/<id>` is the
 * only shape this module accepts, so this set exists for the near misses a
 * person actually pastes.
 */
const NON_PROFILE_LINKEDIN_PATHS: ReadonlySet<string> = new Set([
  'company', 'school', 'showcase', 'groups', 'events', 'jobs', 'feed', 'posts',
  'pulse', 'learning', 'sales', 'talent', 'help', 'legal', 'login', 'signup',
  'checkpoint', 'mynetwork', 'messaging', 'notifications', 'search', 'people',
  'newsletters', 'today', 'directory', 'pub', 'profile',
]);

// =============================================================================
// Credentials
// =============================================================================

function requireBrightDataToken(credentials: ResearchCredentials): string {
  if (credentials.brightdata === undefined) {
    throw new MissingCredentialError(
      'brightdata',
      'required for the LinkedIn public-profile fetch (BRIGHTDATA_API_TOKEN)',
    );
  }
  return credentials.brightdata.apiToken;
}

// =============================================================================
// URL canonicalization — the first of the two who-is-this guards
// =============================================================================

/**
 * `https://www.linkedin.com/in/<public-identifier>/` or null.
 *
 * Returns null for a company page, a post, a feed URL, a search URL, any
 * non-LinkedIn host, and any `/in/` URL carrying extra path segments (which is
 * how `/in/someone/recent-activity/` and `/in/someone/detail/contact-info/`
 * would otherwise slip through as "the profile").
 */
export function canonicalizeLinkedInProfileUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const hostname = url.hostname.toLowerCase();
  const isLinkedIn = hostname === 'linkedin.com'
    || hostname === 'www.linkedin.com'
    // Country subdomains (uk., de., ...) are the same member namespace.
    || /^[a-z]{2}\.linkedin\.com$/.test(hostname);
  if (!isLinkedIn) return null;

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const first = segments[0];
  if (first === undefined) return null;
  if (NON_PROFILE_LINKEDIN_PATHS.has(first.toLowerCase())) return null;
  if (first.toLowerCase() !== 'in') return null;
  // Exactly `/in/<id>`: a third segment is a sub-page of the profile, not the
  // profile, and some of those sub-pages are other people.
  if (segments.length !== 2) return null;

  const identifier = segments[1];
  if (identifier === undefined) return null;
  const normalized = decodeURIComponent(identifier).toLowerCase();
  // LinkedIn public identifiers are 3-100 chars of letters, digits and dashes.
  if (!/^[a-z0-9À-ɏЀ-ӿ-]{3,100}$/.test(normalized)) return null;

  return `https://www.linkedin.com/in/${normalized}/`;
}

/** The `/in/<id>` segment of a canonical profile URL. */
export function linkedInPublicIdentifier(canonicalUrl: string): string | null {
  const canonical = canonicalizeLinkedInProfileUrl(canonicalUrl);
  if (canonical === null) return null;
  const segments = new URL(canonical).pathname.split('/').filter((s) => s.length > 0);
  return segments[1] ?? null;
}

/**
 * Thrown when a caller points this module at something that is not one
 * member's profile page. Distinct from a fetch failure so a route can tell a
 * person "that is a company page" rather than "LinkedIn is down".
 */
export class NotALinkedInProfileUrlError extends Error {
  constructor(public readonly url: string) {
    super(`Not a LinkedIn member profile URL: ${url.slice(0, 200)}`);
    this.name = 'NotALinkedInProfileUrlError';
  }
}

/**
 * Thrown when the profile that came back is a different person than the caller
 * declared. Never downgraded to an empty result: a mismatch means the caller's
 * subject and the fetched profile disagree, and guessing which one is right is
 * how one person's evidence lands on another person's card.
 */
export class LinkedInProfileIdentityMismatchError extends Error {
  constructor(
    public readonly expectedIdentifier: string,
    public readonly returnedIdentifier: string | null,
  ) {
    super(
      `LinkedIn profile identity mismatch: asked for "${expectedIdentifier}", `
      + `Bright Data returned "${returnedIdentifier ?? 'no identifier'}"`,
    );
    this.name = 'LinkedInProfileIdentityMismatchError';
  }
}

// =============================================================================
// Bright Data payload schemas
// =============================================================================

const TriggerResponseSchema = z.object({ snapshot_id: z.string().min(1) });
const ProgressResponseSchema = z.object({ status: z.string().min(1) });
const RecordSchema = z.record(z.string(), z.unknown());
const RecordArraySchema = z.array(z.unknown());

type LinkedInRecord = z.infer<typeof RecordSchema>;

// =============================================================================
// Normalized profile
// =============================================================================

export interface LinkedInPosition {
  readonly title: string;
  readonly company?: string;
  readonly location?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly description?: string;
}

export interface LinkedInEducation {
  readonly school: string;
  readonly degree?: string;
  readonly field?: string;
  readonly startYear?: string;
  readonly endYear?: string;
}

/**
 * One person's own public profile. Every field here is something the person
 * published about themselves on their own profile page.
 */
export interface NormalizedLinkedInProfile {
  readonly url: string;
  readonly publicIdentifier: string;
  readonly fullName?: string;
  readonly headline?: string;
  /** The "About" section. */
  readonly summary?: string;
  readonly location?: string;
  readonly currentCompany?: string;
  readonly positions: readonly LinkedInPosition[];
  readonly education: readonly LinkedInEducation[];
  readonly skills: readonly string[];
  /** Websites the profile itself lists. */
  readonly websites: readonly string[];
}

// =============================================================================
// Record readers (module-private: one consumer, deliberately not extracted)
// =============================================================================

function readString(record: LinkedInRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function readStringArray(record: LinkedInRecord, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      out.push(value.trim());
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        out.push(entry.trim());
        continue;
      }
      if (entry !== null && typeof entry === 'object') {
        const nested = entry as LinkedInRecord;
        const label = readString(nested, 'name', 'title', 'skill', 'label', 'value');
        if (label !== null) out.push(label);
      }
    }
  }
  return uniqueStrings(out);
}

function readRecordArray(record: LinkedInRecord, ...keys: string[]): LinkedInRecord[] {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const rows: LinkedInRecord[] = [];
    for (const entry of value) {
      const parsed = RecordSchema.safeParse(entry);
      if (parsed.success) rows.push(parsed.data);
    }
    if (rows.length > 0) return rows;
  }
  return [];
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function optional(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

function normalizePositions(record: LinkedInRecord): LinkedInPosition[] {
  const rows = readRecordArray(record, 'experience', 'positions', 'experiences');
  const out: LinkedInPosition[] = [];
  for (const row of rows) {
    const title = readString(row, 'title', 'position', 'role');
    if (title === null) continue;
    out.push({
      title,
      company: optional(readString(row, 'company', 'company_name', 'subtitle', 'organization')),
      location: optional(readString(row, 'location', 'place')),
      startDate: optional(readString(row, 'start_date', 'starts_at', 'from')),
      endDate: optional(readString(row, 'end_date', 'ends_at', 'to')),
      description: optional(readString(row, 'description', 'summary')),
    });
  }
  return out;
}

function normalizeEducation(record: LinkedInRecord): LinkedInEducation[] {
  const rows = readRecordArray(record, 'education', 'educations', 'schools');
  const out: LinkedInEducation[] = [];
  for (const row of rows) {
    const school = readString(row, 'title', 'school', 'school_name', 'institute');
    if (school === null) continue;
    out.push({
      school,
      degree: optional(readString(row, 'degree', 'degree_name')),
      field: optional(readString(row, 'field', 'field_of_study', 'fos')),
      startYear: optional(readString(row, 'start_year', 'starts_at', 'from')),
      endYear: optional(readString(row, 'end_year', 'ends_at', 'to')),
    });
  }
  return out;
}

function normalizeWebsites(record: LinkedInRecord): string[] {
  const raw = readStringArray(record, 'websites', 'website', 'external_url', 'url_websites');
  const out: string[] = [];
  for (const candidate of raw) {
    try {
      const url = new URL(candidate.startsWith('http') ? candidate : `https://${candidate}`);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      // A LinkedIn URL in the websites block is the profile linking to itself
      // or to a company; neither is "a site this person owns".
      if (url.hostname.toLowerCase().endsWith('linkedin.com')) continue;
      out.push(url.toString());
    } catch {
      continue;
    }
  }
  return uniqueStrings(out);
}

/**
 * Map one Bright Data record onto the expected person, or refuse.
 *
 * The identifier comparison is the second who-is-this guard and it is
 * deliberately an equality check on the `/in/<id>` segment, not a name
 * similarity score: two people share a name, nobody shares a public
 * identifier.
 */
export function normalizeLinkedInProfileRecord(
  record: LinkedInRecord,
  expectedUrl: string,
): NormalizedLinkedInProfile {
  const expectedCanonical = canonicalizeLinkedInProfileUrl(expectedUrl);
  if (expectedCanonical === null) throw new NotALinkedInProfileUrlError(expectedUrl);
  const expectedIdentifier = linkedInPublicIdentifier(expectedCanonical);
  if (expectedIdentifier === null) throw new NotALinkedInProfileUrlError(expectedUrl);

  const declaredUrl = readString(record, 'url', 'profile_url', 'input_url', 'linkedin_url');
  const identifierFromUrl = declaredUrl !== null
    ? linkedInPublicIdentifier(declaredUrl)
    : null;
  const identifierField = readString(record, 'public_identifier', 'publicIdentifier', 'id');
  const returnedIdentifier = identifierFromUrl
    ?? (identifierField !== null ? identifierField.toLowerCase() : null);

  if (returnedIdentifier === null || returnedIdentifier !== expectedIdentifier) {
    throw new LinkedInProfileIdentityMismatchError(expectedIdentifier, returnedIdentifier);
  }

  return {
    url: expectedCanonical,
    publicIdentifier: expectedIdentifier,
    fullName: optional(readString(record, 'name', 'full_name', 'fullName')),
    headline: optional(readString(record, 'headline', 'position', 'title')),
    summary: optional(readString(record, 'about', 'summary', 'bio')),
    location: optional(readString(record, 'location', 'city', 'country_code')),
    currentCompany: optional(readString(record, 'current_company_name', 'company', 'current_company')),
    positions: normalizePositions(record),
    education: normalizeEducation(record),
    skills: readStringArray(record, 'skills', 'skill', 'top_skills'),
    websites: normalizeWebsites(record),
  };
}

/** True when the record carried something a person actually wrote about themselves. */
function hasUsefulProfileData(profile: NormalizedLinkedInProfile): boolean {
  return profile.fullName !== undefined
    || profile.headline !== undefined
    || profile.summary !== undefined
    || profile.location !== undefined
    || profile.currentCompany !== undefined
    || profile.positions.length > 0
    || profile.education.length > 0
    || profile.skills.length > 0
    || profile.websites.length > 0;
}

// =============================================================================
// Bright Data transport — trigger / poll / download, strict at every step
// =============================================================================

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const composed = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout;
  return fetch(url, { ...init, signal: composed });
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

async function pollSnapshot(
  snapshotId: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${BRIGHTDATA_BASE_URL}/progress/${encodeURIComponent(snapshotId)}`;
  const startedAt = Date.now();
  let intervalMs = POLL_INITIAL_INTERVAL_MS;

  while (Date.now() - startedAt < POLL_MAX_WAIT_MS) {
    await sleep(intervalMs);
    const response = await fetchWithTimeout(
      url,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      PROGRESS_TIMEOUT_MS,
      signal,
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Bright Data LinkedIn profile progress error: HTTP ${response.status} ${body.slice(0, 100)}`,
      );
    }
    const status = ProgressResponseSchema
      .parse(await readJson(response, 'Bright Data LinkedIn profile progress'))
      .status
      .toLowerCase();
    if (status === 'ready') return;
    if (status === 'failed') {
      throw new Error(`Bright Data LinkedIn profile snapshot "${snapshotId}" ended with status "failed"`);
    }
    intervalMs = Math.min(intervalMs * 2, POLL_MAX_INTERVAL_MS);
  }

  throw new Error(
    `Bright Data LinkedIn profile snapshot "${snapshotId}" not ready after `
    + `${Math.round(POLL_MAX_WAIT_MS / 1000)}s`,
  );
}

async function downloadSnapshot(
  snapshotId: string,
  token: string,
  signal?: AbortSignal,
): Promise<LinkedInRecord[]> {
  const url = `${BRIGHTDATA_BASE_URL}/snapshot/${encodeURIComponent(snapshotId)}?format=json`;
  const response = await fetchWithTimeout(
    url,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    DOWNLOAD_TIMEOUT_MS,
    signal,
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Bright Data LinkedIn profile download error: HTTP ${response.status} ${body.slice(0, 100)}`,
    );
  }
  return parseRecords(await readJson(response, 'Bright Data LinkedIn profile download'));
}

function parseRecords(raw: unknown): LinkedInRecord[] {
  const single = RecordSchema.safeParse(raw);
  const asArray = RecordArraySchema.safeParse(raw);
  const entries = asArray.success ? asArray.data : single.success ? [single.data] : null;
  if (entries === null) {
    throw new Error('Bright Data LinkedIn profile response was neither a record nor an array');
  }
  const records: LinkedInRecord[] = [];
  for (const entry of entries) {
    const parsed = RecordSchema.safeParse(entry);
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

/**
 * Run the profile collector for exactly one URL.
 *
 * Handles both Bright Data contracts the way `providers/brightdata.ts`
 * `scrapeDataset` does — records inline, or an accepted snapshot to poll — so
 * acceptance is never mistaken for an empty profile.
 */
async function scrapeProfileRecords(
  canonicalUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<LinkedInRecord[]> {
  const endpoint = `${BRIGHTDATA_BASE_URL}/scrape`
    + `?dataset_id=${encodeURIComponent(BRIGHTDATA_LINKEDIN_PROFILES_DATASET_ID)}`
    + '&format=json&include_errors=true';
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ url: canonicalUrl }]),
    },
    SCRAPE_TIMEOUT_MS,
    signal,
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Bright Data LinkedIn profile scrape error: HTTP ${response.status} ${body.slice(0, 100)}`,
    );
  }

  const raw = await readJson(response, 'Bright Data LinkedIn profile scrape');
  const accepted = TriggerResponseSchema.safeParse(raw);
  if (accepted.success) {
    await pollSnapshot(accepted.data.snapshot_id, token, signal);
    return downloadSnapshot(accepted.data.snapshot_id, token, signal);
  }
  return parseRecords(raw);
}

// =============================================================================
// Field → EvidenceItem
// =============================================================================

/** One profile field, named so a review card can show it back to the person. */
export type LinkedInProfileFieldId =
  | 'headline'
  | 'summary'
  | 'location'
  | 'current_company'
  | 'position'
  | 'education'
  | 'skills'
  | 'website';

interface EvidenceDraft {
  readonly fieldId: LinkedInProfileFieldId;
  readonly text: string;
  readonly ordinal?: number;
}

function evidenceDrafts(profile: NormalizedLinkedInProfile): EvidenceDraft[] {
  const drafts: EvidenceDraft[] = [];
  if (profile.headline !== undefined) drafts.push({ fieldId: 'headline', text: profile.headline });
  if (profile.summary !== undefined) drafts.push({ fieldId: 'summary', text: profile.summary });
  if (profile.location !== undefined) drafts.push({ fieldId: 'location', text: profile.location });
  if (profile.currentCompany !== undefined) {
    drafts.push({ fieldId: 'current_company', text: profile.currentCompany });
  }
  profile.positions.forEach((position, index) => {
    const parts = [position.title];
    if (position.company !== undefined) parts.push(position.company);
    const span = [position.startDate, position.endDate]
      .filter((value): value is string => value !== undefined)
      .join(' – ');
    if (span.length > 0) parts.push(span);
    drafts.push({ fieldId: 'position', text: parts.join(' · '), ordinal: index });
  });
  profile.education.forEach((education, index) => {
    const parts = [education.school];
    if (education.degree !== undefined) parts.push(education.degree);
    if (education.field !== undefined) parts.push(education.field);
    drafts.push({ fieldId: 'education', text: parts.join(' · '), ordinal: index });
  });
  if (profile.skills.length > 0) {
    drafts.push({ fieldId: 'skills', text: profile.skills.join(', ') });
  }
  profile.websites.forEach((website, index) => {
    drafts.push({ fieldId: 'website', text: website, ordinal: index });
  });
  return drafts;
}

/**
 * Every field tagged with where it came from and when it was read.
 *
 * `sourceClass` is `first_party_statement` because this is the person's own
 * published wording about themselves, and `lane` is `primary` for the same
 * reason. Nothing here is inferred: the item's text is what the profile said,
 * so a downstream "Is this you?" card can show the sentence beside its link.
 */
export function linkedInProfileEvidence(
  profile: NormalizedLinkedInProfile,
  retrievedAt: string,
): EvidenceItem[] {
  return evidenceDrafts(profile).map((draft) => {
    const identity = createEvidenceIdentity({
      sourceRef: `${profile.url}#${draft.fieldId}${draft.ordinal !== undefined ? `:${draft.ordinal}` : ''}`,
      content: draft.text,
    });
    return EvidenceItemSchema.parse({
      id: identity.id,
      contentSha256: identity.contentSha256,
      sourceRef: profile.url,
      canonicalUrl: profile.url,
      title: profile.fullName !== undefined
        ? `${profile.fullName} — LinkedIn profile`
        : `${profile.publicIdentifier} — LinkedIn profile`,
      author: profile.fullName,
      retrievedAt,
      provider: 'linkedin',
      sourceClass: 'first_party_statement',
      lane: 'primary',
      sourcePackId: LINKEDIN_PUBLIC_PROFILE_SOURCE_PACK,
      visibility: 'public',
      exactQuote: draft.text,
      metadata: {
        fieldId: draft.fieldId,
        ...(draft.ordinal !== undefined ? { ordinal: draft.ordinal } : {}),
        publicIdentifier: profile.publicIdentifier,
        brightdataDatasetId: BRIGHTDATA_LINKEDIN_PROFILES_DATASET_ID,
        subjectOwnProfile: true,
      },
    });
  });
}

// =============================================================================
// The entry point
// =============================================================================

export interface FetchLinkedInPublicProfileInput {
  readonly credentials: ResearchCredentials;
  /**
   * The consent row the caller obtained from `@braintied/consent`'s
   * `requireConsent(current, 'source:linkedin_public_profile', scope)`. The
   * row, not a boolean: a boolean carries no notice hash, no method and no
   * proof, so nothing downstream could say what the person actually agreed to.
   */
  readonly consent: ConsentProof;
  /** The profile URL the subject supplied. */
  readonly profileUrl: string;
  /**
   * Who the caller believes this profile belongs to. When supplied it must be
   * the same `/in/<id>` as `profileUrl`, which is what makes "a URL naming a
   * different person than the caller declared" a refusal rather than a fetch.
   */
  readonly expectedPublicIdentifier?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface LinkedInPublicProfileResult {
  readonly profile: NormalizedLinkedInProfile;
  readonly evidence: readonly EvidenceItem[];
  readonly retrievedAt: string;
  /** Bright Data bills per returned record; one profile is one record. */
  readonly recordsBilled: number;
}

/**
 * Fetch ONE person's own public LinkedIn profile.
 *
 * @throws ConsentProofRequiredError  no consent row was supplied
 * @throws NotALinkedInProfileUrlError  the URL is not `/in/<id>`
 * @throws LinkedInProfileIdentityMismatchError  the URL or the record names someone else
 * @throws MissingCredentialError  no Bright Data token
 */
export async function fetchLinkedInPublicProfile(
  input: FetchLinkedInPublicProfileInput,
): Promise<LinkedInPublicProfileResult> {
  requireSourceConsent(input.consent, LINKEDIN_PUBLIC_PROFILE_PURPOSE);

  const canonicalUrl = canonicalizeLinkedInProfileUrl(input.profileUrl);
  if (canonicalUrl === null) throw new NotALinkedInProfileUrlError(input.profileUrl);

  const identifier = linkedInPublicIdentifier(canonicalUrl);
  if (identifier === null) throw new NotALinkedInProfileUrlError(input.profileUrl);

  // Declared subject vs the URL, checked BEFORE the fetch: refusing after the
  // records are billed still bills them, and still put the wrong person's
  // profile in memory.
  if (input.expectedPublicIdentifier !== undefined) {
    const expected = input.expectedPublicIdentifier.trim().toLowerCase();
    if (expected !== identifier) {
      throw new LinkedInProfileIdentityMismatchError(expected, identifier);
    }
  }

  const token = requireBrightDataToken(input.credentials);
  const records = await scrapeProfileRecords(canonicalUrl, token, input.signal);
  if (records.length === 0) {
    throw new Error(
      `Bright Data returned no record for ${canonicalUrl} — a private, renamed or `
      + 'misspelled profile is not an empty profile',
    );
  }

  // One record per profile. A second record is a different person or a
  // different page, so it is refused rather than merged.
  const first = records[0];
  if (first === undefined) {
    throw new Error(`Bright Data returned no usable record for ${canonicalUrl}`);
  }
  const profile = normalizeLinkedInProfileRecord(first, canonicalUrl);
  if (!hasUsefulProfileData(profile)) {
    throw new Error(
      `Bright Data returned a record for ${canonicalUrl} with no profile content`,
    );
  }

  const now = input.now !== undefined ? input.now() : new Date();
  const retrievedAt = now.toISOString();
  const evidence = linkedInProfileEvidence(profile, retrievedAt);

  logger.info(
    {
      publicIdentifier: profile.publicIdentifier,
      evidenceCount: evidence.length,
      consentRecordUri: input.consent.recordUri,
    },
    '[LinkedIn] public profile fetch complete',
  );

  return { profile, evidence, retrievedAt, recordsBilled: records.length };
}

// =============================================================================
// Not a SearchProvider, on purpose
// =============================================================================

/**
 * There is no `createLinkedInProvider` and no `FetchResult` shaper here.
 *
 * Both existed in the first draft of this change and both only existed to satisfy
 * `Record<ProviderName, SearchProvider>` once `linkedin` had been added to
 * `PROVIDER_NAMES` — which `check-bump` then correctly refused as a MAJOR
 * change (a consumer keying a map on that enum stops compiling). Removing the
 * enum entry removed the reason for the registry entry, which is the right
 * shape anyway:
 *
 *   - one person's profile is not a search result, so there is no search lane
 *     to register;
 *   - the `SearchProvider` interface has nowhere to carry a consent row, so a
 *     `fetch(url)` reachable through the registry would be a hole in the gate
 *     this whole module is built on.
 *
 * The one door is `fetchLinkedInPublicProfile`, which takes the consent row
 * and returns `EvidenceItem[]`.
 */
