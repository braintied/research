/**
 * Bright Data Web Scraper API — read-only knowledge ingestion client.
 *
 * Replaces the failing Apify LinkedIn (HTTP 403) path and the stub Facebook-
 * groups ingestion with Bright Data's Web Scraper API (dataset trigger →
 * snapshot poll → download). Two high-level functions normalize records into
 * `IngestedItem[]` for the continuous ingestion pipeline:
 *   - fetchLinkedInPostsBrightData(identifier, maxItems)
 *   - fetchFacebookGroupPostsBrightData(identifier, maxItems)
 *
 * Dataset IDs are CONFIGURABLE via env (they differ per Bright Data account):
 *   - BRIGHTDATA_LINKEDIN_DATASET_ID    — LinkedIn-posts dataset
 *   - BRIGHTDATA_FB_GROUPS_DATASET_ID   — Facebook-group-posts dataset
 * When a dataset ID env var is unset, the high-level fn logs a clear warning
 * and returns an empty array (tolerated — never crashes the sweep).
 *
 * Auth: Bearer `BRIGHTDATA_API_TOKEN`. Every payload boundary is Zod-validated.
 * Instagram intentionally does not use this tolerant ingestion wrapper. Its
 * strict search/post/profile implementation lives in `instagram.ts` so an
 * empty/error response cannot be converted into a successful empty sweep.
 */

import { z } from 'zod';
import { hashUrl, canonicalizeUrl } from '../types.js';
import { logger } from '../logger.js';
import { waitForBrightDataSnapshot } from './brightdata-snapshot.js';
import { MissingCredentialError, type ResearchCredentials } from '../credentials.js';
import type { IngestedItem, IngestEngagement } from '../ingestion/types.js';

// =============================================================================
// Constants
// =============================================================================

const BRIGHTDATA_BASE_URL = 'https://api.brightdata.com/datasets/v3';
const BRIGHTDATA_UNLOCK_URL = 'https://api.brightdata.com/request';
const UNLOCK_TIMEOUT_MS = 90_000;
const TRIGGER_TIMEOUT_MS = 30_000;
const PROGRESS_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const SCRAPE_TIMEOUT_MS = 90_000;

// Snapshot polling — backoff-capped total wait so a slow snapshot returns a
// tolerated timeout error rather than blocking the whole sweep.
const POLL_INITIAL_INTERVAL_MS = 5_000;
const POLL_MAX_INTERVAL_MS = 15_000;
const POLL_MAX_WAIT_MS = 180_000;

const MIN_CONTENT_CHARS = 80;

// =============================================================================
// Credentials & dataset-id resolution
// =============================================================================

function requireBrightDataToken(credentials: ResearchCredentials): string {
  if (credentials.brightdata === undefined) {
    throw new MissingCredentialError('brightdata', 'required for Bright Data collection');
  }
  return credentials.brightdata.apiToken;
}

/**
 * Dataset ids are per-collector. A configured token with no dataset id means
 * the host bought the account but not this collector: that lane returns empty
 * with a warning rather than failing the whole sweep.
 */
function linkedInDatasetId(credentials: ResearchCredentials): string | null {
  if (credentials.brightdata === undefined) return null;
  if (credentials.brightdata.linkedinDatasetId === undefined) return null;
  return credentials.brightdata.linkedinDatasetId;
}

function facebookGroupsDatasetId(credentials: ResearchCredentials): string | null {
  if (credentials.brightdata === undefined) return null;
  if (credentials.brightdata.facebookGroupsDatasetId === undefined) return null;
  return credentials.brightdata.facebookGroupsDatasetId;
}

// =============================================================================
// Bright Data API payload schemas
// =============================================================================

const TriggerResponseSchema = z.object({
  snapshot_id: z.string().min(1),
});

// Bright Data records vary by dataset; be permissive and map whatever fields
// exist. `.passthrough()` keeps unknown keys without failing validation.
const BrightDataRecordSchema = z
  .object({
    url: z.string().optional(),
    post_url: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    post_text: z.string().optional(),
    description: z.string().optional(),
    title: z.string().optional(),
    author: z.string().optional(),
    user_name: z.string().optional(),
    author_name: z.string().optional(),
    profile_name: z.string().optional(),
    date_posted: z.string().optional(),
    timestamp: z.string().optional(),
    likes: z.number().optional(),
    num_likes: z.number().optional(),
    likes_count: z.number().optional(),
    comments: z.number().optional(),
    num_comments: z.number().optional(),
    comments_count: z.number().optional(),
  })
  .passthrough();

export type BrightDataRecord = z.infer<typeof BrightDataRecordSchema>;

// =============================================================================
// Low-level client — trigger / poll / download
// =============================================================================

export interface PollSnapshotOptions {
  maxWaitMs?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  /** Caller abort: stops the wait at once, between polls or mid-request. */
  signal?: AbortSignal;
}

/**
 * Kept as an interface with its own `signal` member, as published in 2.8.0.
 * A type alias of the same shape reads to the release's api-surface check as
 * a removed member, which would block publishing this package.
 */
export interface ScrapeDatasetOptions extends PollSnapshotOptions {
  signal?: AbortSignal;
}

/**
 * Thrown when a snapshot is still running at the wait ceiling. The snapshot
 * keeps running on Bright Data's side and is billed once; poll `snapshotId`
 * again, or download it, instead of triggering a second collection.
 */
export class BrightDataSnapshotPendingError extends Error {
  readonly snapshotId: string;
  /** The last retryable poll failure inside the wait, when the ceiling was hit through one. */
  readonly lastTransientError: string | undefined;
  constructor(snapshotId: string, waitedMs: number, lastTransientError?: string) {
    const lastPoll = lastTransientError === undefined ? '' : `; last poll: ${lastTransientError}`;
    super(`Bright Data snapshot "${snapshotId}" not ready after ${Math.round(waitedMs / 1000)}s (tolerated timeout${lastPoll})`);
    this.name = 'BrightDataSnapshotPendingError';
    this.snapshotId = snapshotId;
    this.lastTransientError = lastTransientError;
  }
}

/**
 * POST a JSON array of input objects to a Bright Data dataset and return the
 * snapshot id for polling.
 */
export async function triggerCollection(
  credentials: ResearchCredentials,
  datasetId: string,
  inputs: Array<Record<string, unknown>>,
): Promise<string> {
  const token = requireBrightDataToken(credentials);
  const url = `${BRIGHTDATA_BASE_URL}/trigger?dataset_id=${encodeURIComponent(datasetId)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(inputs),
    signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Bright Data trigger error (${datasetId}): HTTP ${response.status} ${body.slice(0, 200)}`,
    );
  }

  const parsed = TriggerResponseSchema.parse(await response.json());
  return parsed.snapshot_id;
}

/**
 * Kick off a Bright Data discovery crawl (keyword or URL seed), then poll and
 * download the snapshot. This is the preferred replacement for Apify keyword
 * scrapers when a dataset supports `type=discover_new`.
 *
 * Matches the Swishh production boundary:
 *   POST /datasets/v3/trigger?dataset_id=…&type=discover_new&discover_by=keyword|url
 */
export async function discoverAndDownload(
  credentials: ResearchCredentials,
  datasetId: string,
  discoverBy: 'keyword' | 'url',
  input: Record<string, unknown>,
  opts: PollSnapshotOptions = {},
): Promise<BrightDataRecord[]> {
  const token = requireBrightDataToken(credentials);
  const url =
    `${BRIGHTDATA_BASE_URL}/trigger` +
    `?dataset_id=${encodeURIComponent(datasetId)}` +
    `&type=discover_new` +
    `&discover_by=${encodeURIComponent(discoverBy)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([input]),
    signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Bright Data discover error (${datasetId}/${discoverBy}): HTTP ${response.status} ${body.slice(0, 200)}`,
    );
  }

  const parsed = TriggerResponseSchema.parse(await response.json());
  await pollSnapshot(credentials, parsed.snapshot_id, opts);
  return downloadSnapshot(credentials, parsed.snapshot_id);
}

/**
 * Poll a snapshot until it reports `ready`, backing off between polls. A poll
 * that times out, hits a network error, or gets HTTP 5xx/429 is retried inside
 * `maxWaitMs`; a terminal status, a caller abort, or another 4xx throws at once.
 * Throws BrightDataSnapshotPendingError (a tolerated timeout carrying the
 * snapshot id) when the ceiling passes.
 */
export async function pollSnapshot(
  credentials: ResearchCredentials,
  snapshotId: string,
  opts: PollSnapshotOptions = {},
): Promise<void> {
  const token = requireBrightDataToken(credentials);
  const initialIntervalMs =
    opts.initialIntervalMs !== undefined ? opts.initialIntervalMs : POLL_INITIAL_INTERVAL_MS;
  const result = await waitForBrightDataSnapshot({
    snapshotId,
    token,
    maxWaitMs: opts.maxWaitMs !== undefined ? opts.maxWaitMs : POLL_MAX_WAIT_MS,
    progressTimeoutMs: PROGRESS_TIMEOUT_MS,
    initialDelayMs: initialIntervalMs,
    intervalMs: initialIntervalMs * 2,
    backoffFactor: 2,
    maxIntervalMs: opts.maxIntervalMs !== undefined ? opts.maxIntervalMs : POLL_MAX_INTERVAL_MS,
    signal: opts.signal,
    label: 'Bright Data',
    subject: `Bright Data snapshot "${snapshotId}"`,
  });
  if (!result.ready) {
    throw new BrightDataSnapshotPendingError(snapshotId, result.waitedMs, result.lastTransientError);
  }
}

/**
 * Download a ready snapshot as JSON and Zod-validate each record.
 */
export async function downloadSnapshot(
  credentials: ResearchCredentials,
  snapshotId: string,
): Promise<BrightDataRecord[]> {
  const token = requireBrightDataToken(credentials);
  const url = `${BRIGHTDATA_BASE_URL}/snapshot/${encodeURIComponent(snapshotId)}?format=json`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Bright Data download error (${snapshotId}): HTTP ${response.status} ${body.slice(0, 100)}`,
    );
  }

  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) {
    throw new Error(`Bright Data download (${snapshotId}) did not return a JSON array`);
  }

  const records: BrightDataRecord[] = [];
  for (const entry of raw) {
    const parsed = BrightDataRecordSchema.safeParse(entry);
    if (parsed.success) {
      records.push(parsed.data);
    }
  }
  return records;
}

export type UnlockUrlOptions = {
  render?: boolean;
  country?: string;
  signal?: AbortSignal;
};

export type UnlockedPage = {
  url: string;
  html: string;
  fetchedAt: string;
};

const UnlockErrorSchema = z.object({
  error: z.string().min(1),
});

/**
 * Web Unlocker (`POST /request`) for a single public URL.
 *
 * Social `scrapeDataset` collectors cannot fetch New Yorker / Aeon /
 * Consequence. This is the news-page path. Requires `unlockerZone` — a
 * token alone is not enough, and this function never guesses a zone name.
 * Spends per request. Do not call without an approved budget.
 */
export async function unlockUrl(
  credentials: ResearchCredentials,
  url: string,
  opts: UnlockUrlOptions = {},
): Promise<UnlockedPage> {
  const token = requireBrightDataToken(credentials);
  if (credentials.brightdata === undefined || credentials.brightdata.unlockerZone === undefined) {
    throw new MissingCredentialError(
      'brightdata.unlockerZone',
      'required for Web Unlocker page fetch (BRIGHTDATA_UNLOCKER_ZONE)',
    );
  }
  const zone = credentials.brightdata.unlockerZone;
  const country = opts.country !== undefined ? opts.country : 'us';
  const payload: Record<string, string> = {
    zone,
    url,
    format: 'raw',
    country,
  };
  if (opts.render === true) {
    payload.render = 'true';
  }

  const response = await fetch(BRIGHTDATA_UNLOCK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(UNLOCK_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    const parsed = UnlockErrorSchema.safeParse(safeJson(text));
    const detail = parsed.success ? parsed.data.error : text.slice(0, 200);
    throw new Error(`Bright Data unlocker error: HTTP ${String(response.status)} ${detail}`);
  }
  if (text.trim().length < 40) {
    throw new Error('Bright Data unlocker returned an empty page');
  }

  return {
    url,
    html: text,
    fetchedAt: new Date().toISOString(),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Run Bright Data's nominally synchronous scrape endpoint. The API may return
 * records immediately or accept the request as an asynchronous snapshot (HTTP
 * 202). Both contracts are handled so callers never mistake acceptance for an
 * empty result.
 */
export async function scrapeDataset(
  credentials: ResearchCredentials,
  datasetId: string,
  inputs: Array<Record<string, unknown>>,
  opts: ScrapeDatasetOptions = {},
): Promise<BrightDataRecord[]> {
  const token = requireBrightDataToken(credentials);
  const endpoint = `${BRIGHTDATA_BASE_URL}/scrape`
    + `?dataset_id=${encodeURIComponent(datasetId)}`
    + '&format=json&include_errors=true';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(inputs),
    signal: opts.signal ?? AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bright Data scrape error (${datasetId}): HTTP ${response.status} ${body.slice(0, 100)}`);
  }

  const raw: unknown = await response.json();
  if (Array.isArray(raw)) {
    const records: BrightDataRecord[] = [];
    for (const entry of raw) {
      const parsed = BrightDataRecordSchema.safeParse(entry);
      if (parsed.success) records.push(parsed.data);
    }
    return records;
  }

  const accepted = TriggerResponseSchema.safeParse(raw);
  if (accepted.success) {
    await pollSnapshot(credentials, accepted.data.snapshot_id, opts);
    return downloadSnapshot(credentials, accepted.data.snapshot_id);
  }

  const single = BrightDataRecordSchema.safeParse(raw);
  if (single.success) return [single.data];
  throw new Error(`Bright Data scrape (${datasetId}) returned neither records nor a snapshot id`);
}

// =============================================================================
// Record → IngestedItem mapping
// =============================================================================

function firstString(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function recordToItem(
  record: BrightDataRecord,
  sourceType: 'linkedin' | 'facebook',
): IngestedItem | null {
  const url = firstString(record.url, record.post_url);
  if (url === null) {
    return null;
  }

  const content = firstString(record.text, record.content, record.post_text, record.description);
  if (content === null || content.trim().length < MIN_CONTENT_CHARS) {
    return null;
  }

  const author = firstString(
    record.author,
    record.author_name,
    record.user_name,
    record.profile_name,
  );

  const publishedAt = firstString(record.date_posted, record.timestamp);

  const likes = firstNumber(record.likes, record.num_likes, record.likes_count);
  const comments = firstNumber(record.comments, record.num_comments, record.comments_count);

  const engagement: IngestEngagement = {};
  if (likes !== undefined) {
    engagement.likes = likes;
  }
  if (comments !== undefined) {
    engagement.comments = comments;
  }

  const title = firstString(record.title);
  const canonical = canonicalizeUrl(url);
  const contentMd = content.trim();

  return {
    sourceId: null, // overwritten by caller
    sourceType,
    url: canonical,
    urlHash: hashUrl(canonical),
    title: title !== null ? title.slice(0, 200) : contentMd.slice(0, 200),
    contentMd,
    excerpt: contentMd.length <= 320 ? contentMd : `${contentMd.slice(0, 320).trim()}…`,
    author,
    publishedAt,
    engagement,
    qualityScore: null,
    category: 'other',
    tags: [],
    whyItMatters: null,
    quotes: [],
    embedding: null,
  };
}

// =============================================================================
// High-level ingestion fns
// =============================================================================

async function collectViaBrightData(
  credentials: ResearchCredentials,
  datasetId: string,
  inputs: Array<Record<string, unknown>>,
  sourceType: 'linkedin' | 'facebook',
  maxItems: number,
): Promise<IngestedItem[]> {
  const snapshotId = await triggerCollection(credentials, datasetId, inputs);
  await pollSnapshot(credentials, snapshotId);
  const records = await downloadSnapshot(credentials, snapshotId);

  const items: IngestedItem[] = [];
  for (const record of records) {
    if (items.length >= maxItems) {
      break;
    }
    const item = recordToItem(record, sourceType);
    if (item !== null) {
      items.push(item);
    }
  }
  return items;
}

/**
 * Fetch LinkedIn posts for a profile/company identifier via Bright Data.
 * `identifier` is the LinkedIn profile or company URL.
 */
export async function fetchLinkedInPostsBrightData(
  credentials: ResearchCredentials,
  identifier: string,
  maxItems: number,
): Promise<IngestedItem[]> {
  const datasetId = linkedInDatasetId(credentials);
  if (datasetId === null) {
    logger.warn(
      { identifier: identifier.slice(0, 60) },
      '[BrightData] brightdata.linkedinDatasetId not configured — returning empty (tolerated)',
    );
    return [];
  }

  const inputs: Array<Record<string, unknown>> = [{ url: identifier }];
  return collectViaBrightData(credentials, datasetId, inputs, 'linkedin', maxItems);
}

/**
 * Fetch Facebook group posts for a group identifier via Bright Data.
 * `identifier` is the Facebook group URL.
 */
export async function fetchFacebookGroupPostsBrightData(
  credentials: ResearchCredentials,
  identifier: string,
  maxItems: number,
): Promise<IngestedItem[]> {
  const datasetId = facebookGroupsDatasetId(credentials);
  if (datasetId === null) {
    logger.warn(
      { identifier: identifier.slice(0, 60) },
      '[BrightData] brightdata.facebookGroupsDatasetId not configured — returning empty (tolerated)',
    );
    return [];
  }

  const inputs: Array<Record<string, unknown>> = [{ url: identifier }];
  return collectViaBrightData(credentials, datasetId, inputs, 'facebook', maxItems);
}
