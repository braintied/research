/**
 * Source-mode research coordinator.
 *
 * Public research and trusted recall are deliberately separate executions.
 * Private Cortex/Telegram evidence is never appended to a prompt consumed by
 * Gemini, Claude, Voyage, Tavily, or any other external provider. A trusted
 * Ora coordinator can reconcile the returned manifests locally.
 */

import { createEvidenceIdentity, EvidenceItemSchema, type EvidenceItem } from './evidence.js';
import { runResearch } from './kinds.js';
import type { KindResearchResult, ResearchKind, RunResearchInput } from './kinds.js';
import type { IndexSink, OnPipelineUsage, ResearchCacheAdapter } from './index.js';
import type { Logger } from './logger.js';
import { canonicalizeUrl, type ProviderName, type SearchOpts } from './types.js';
import { getEnabledSearchProviders } from './providers/index.js';
import type { ResearchCredentials } from './credentials.js';
import {
  evaluateSourceModeCoverage,
  resolveSourceExecutionPlan,
  type AtomicSourceMode,
  type SourceExecutionPlan,
  type SourceMode,
  type SourceModeCoverageReport,
  type SourceModeScope,
  type TrustedSourceMode,
} from './source-modes.js';
import { compileProfileExecution } from './profiles/registry.js';
import { evaluateCoverage, type CoverageReport } from './profiles/coverage.js';
import type { ResearchMode, ResearchProfile, SourceLane } from './profiles/types.js';

export interface TrustedRecallInput {
  /** Public decision question only; never an externally synthesized report. */
  question: string;
  mode: TrustedSourceMode;
  asOf: string;
  limit: number;
  profileRef?: string;
  sourcePackIds?: string[];
  queryHints?: string[];
  signal?: AbortSignal;
}

export interface TrustedSourceAdapter {
  /**
   * Adapter identity is injected by Ora; this package owns no DB credentials.
   * The instance must already be bound to authenticated tenant context. Tenant
   * identifiers are intentionally absent from research-program input.
   */
  readonly id: string;
  readonly modes: readonly TrustedSourceMode[];
  recall(input: TrustedRecallInput): Promise<EvidenceItem[]>;
}

export interface RunResearchProgramInput {
  /** Host-resolved credentials, forwarded to the public research runner. */
  credentials: ResearchCredentials;
  brief: string;
  /** Explicit ISO date/timestamp makes freshness and reruns reproducible. */
  asOf: string;
  sourceModes?: SourceMode[];
  /** Optional versioned profile; supplies source modes/packs and coverage. */
  profileRef?: string;
  profileMode?: ResearchMode;
  kind?: ResearchKind;
  maxCostUsd?: number;
  synthesisModelOverride?: string;
  minFreeResults?: number;
  recencyDays?: number;
  requiredProviders?: ProviderName[];
  scopes?: Partial<Record<AtomicSourceMode, SourceModeScope>>;
  providerSearchOptions?: Partial<Record<ProviderName, Omit<SearchOpts, 'limit'>>>;
  indexSink?: IndexSink;
  onUsage?: OnPipelineUsage;
  cache?: ResearchCacheAdapter;
  logger?: Logger;
  trustedAdapters?: TrustedSourceAdapter[];
  signal?: AbortSignal;
  /** Test/preflight override; runtime normally derives this from provider config. */
  availableProviders?: ProviderName[];
  /** Dependency injection for tests or a caller-owned durable execution wrapper. */
  publicRunner?: (input: RunResearchInput) => Promise<KindResearchResult>;
}

export interface TrustedRecallFailure {
  mode: TrustedSourceMode;
  adapterId: string | null;
  error: string;
}

export interface ResearchProgramResult {
  status: 'complete' | 'partial';
  sourcePlan: SourceExecutionPlan;
  sourceCoverage: SourceModeCoverageReport;
  profileCoverage: CoverageReport | null;
  publicResearch: KindResearchResult | null;
  publicEvidence: EvidenceItem[];
  /** Private/restricted references for trusted-local reconciliation only. */
  trustedEvidence: EvidenceItem[];
  trustedRecallFailures: TrustedRecallFailure[];
  costUsd: number;
  /** Explicit reminder for callers handling the two result boundaries. */
  dataBoundary: 'public_report_and_private_manifest_separate';
}

export class SourcePlanUnavailableError extends Error {
  constructor(public readonly plan: SourceExecutionPlan) {
    const reasons = [
      ...plan.missingModes.map((mode) => `missing source mode: ${mode}`),
      ...plan.missingRequiredProviders.map((provider) => `missing required provider: ${provider}`),
    ];
    super(`Source execution plan is not ready (${reasons.join('; ')}).`);
    this.name = 'SourcePlanUnavailableError';
  }
}

function adapterForMode(
  mode: TrustedSourceMode,
  plan: SourceExecutionPlan,
  adapters: TrustedSourceAdapter[],
): TrustedSourceAdapter | null {
  const entry = plan.entries.find((candidate) => candidate.mode === mode);
  if (entry?.adapterId === undefined) return null;
  return adapters.find((adapter) => adapter.id === entry.adapterId && adapter.modes.includes(mode)) ?? null;
}

function validateTrustedEvidence(
  items: EvidenceItem[],
  mode: TrustedSourceMode,
  allowedSourcePackIds: string[] | undefined,
): EvidenceItem[] {
  const expectedLane: SourceLane = mode === 'cortex' ? 'private_cortex' : 'private_telegram';
  const allowedPacks = new Set(allowedSourcePackIds ?? [`mode-${mode}`]);
  return items.map((item) => {
    const parsed = EvidenceItemSchema.parse(item);
    if (parsed.visibility === 'public') {
      throw new Error(`Trusted ${mode} adapter returned public evidence; trusted recall must remain private/restricted.`);
    }
    if (parsed.provider !== 'internal' && parsed.provider !== 'manual') {
      throw new Error(`Trusted ${mode} adapter returned external provider ${parsed.provider}.`);
    }
    if (parsed.lane !== expectedLane) {
      throw new Error(`Trusted ${mode} adapter returned evidence for lane ${parsed.lane}; expected ${expectedLane}.`);
    }
    if (!allowedPacks.has(parsed.sourcePackId)) {
      throw new Error(`Trusted ${mode} adapter returned unexpected source pack ${parsed.sourcePackId}.`);
    }
    return parsed;
  });
}

function trustedCounts(
  evidenceByMode: Map<TrustedSourceMode, EvidenceItem[]>,
): Partial<Record<TrustedSourceMode, { evidence: number; sources: number }>> {
  const result: Partial<Record<TrustedSourceMode, { evidence: number; sources: number }>> = {};
  for (const [mode, evidence] of evidenceByMode.entries()) {
    result[mode] = {
      evidence: evidence.length,
      sources: new Set(evidence.map((item) => item.canonicalUrl ?? item.sourceRef)).size,
    };
  }
  return result;
}

function sourceClassForMode(mode: string | undefined): EvidenceItem['sourceClass'] {
  if (mode === 'x') return 'social_post';
  if (mode === 'reddit' || mode === 'community' || mode === 'youtube') return 'community_discussion';
  if (mode === 'github') return 'first_party_statement';
  return 'secondary_analysis';
}

// Deterministic pack attribution: a discovery whose host sits inside a public
// pack's includeDomains is evidence for that pack no matter which subquery
// surfaced it. Pack seeds are already host-restricted by include_domains, so
// this only adds planner-found URLs on the same authorities. Without it,
// coverage requirements silently under-count whenever the planner (not a pack
// seed) finds the page — the 2026-07-27 release-canary failure mode, where
// award-source-coverage found 6 of 8 required items despite healthy award
// evidence in the report.
export function domainMatchedPublicPackIds(
  discovery: KindResearchResult['discoveries'][number],
  profile: ResearchProfile,
): string[] {
  let host: string;
  try {
    host = new URL(discovery.url).hostname.toLowerCase();
  } catch {
    // A non-URL discovery (provider-native id) keeps its seed attribution only.
    return [];
  }
  const matched: string[] = [];
  for (const pack of profile.sourcePacks) {
    if (pack.visibility !== 'public') continue;
    for (const domain of pack.includeDomains) {
      const normalized = domain.toLowerCase().replace(/^www\./, '');
      if (host === normalized || host.endsWith(`.${normalized}`)) {
        matched.push(pack.id);
        break;
      }
    }
  }
  return matched;
}

/**
 * Providers whose discovery payload is the primary evidence surface (title +
 * snippet or discussion body). HN/RSS/podcasts do not ship page HTML with the
 * search hit, and re-fetch/extract often returns empty under bot walls or
 * discussion-thread shapes. Without this path, community packs can search
 * successfully and still assemble 0 coverage evidence (2026-08 release canary:
 * guidance/practitioner at 0e while award/template still filled via Tavily
 * raw_content).
 *
 * GitHub joins the set for the same reason: REST search returns repository
 * identity + description, but github.com HTML extract is routinely empty
 * (SPA / bot walls). Without native admission, open-implementation-sources
 * can search 10+ public repos and still assemble 0e/0s (2026-08-04 canary
 * after models 1.2.6: implementation-coverage only, other packs green).
 */
// Tavily/SearXNG/GitHub join when domain-filtered packs still surface hits
// but Gemini extract fails (empty body / bot walls). Seed or domain pack
// attribution is still required — never invent packs from a bare host.
// Pack provider lists still bind provenance (github-native cannot fill a
// web-only pack).
const PROVIDER_NATIVE_DISCOVERY_PROVIDERS = new Set([
  'hn',
  'rss',
  'podcasts',
  'tavily',
  'searxng',
  'github',
]);

const MIN_PROVIDER_NATIVE_BODY_CHARS = 40;

function discoveryBody(discovery: KindResearchResult['discoveries'][number]): string {
  return [discovery.title, discovery.snippet]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .join('\n')
    .trim();
}

function packIdsForDiscovery(
  discovery: KindResearchResult['discoveries'][number],
  profile: ResearchProfile,
): string[] {
  const packIds = [...discovery.source_pack_ids];
  for (const packId of domainMatchedPublicPackIds(discovery, profile)) {
    if (!packIds.includes(packId)) packIds.push(packId);
  }
  return packIds;
}

function withinAsOfBoundary(
  discovery: KindResearchResult['discoveries'][number],
  publishedBeforeMs: number | null,
): boolean {
  if (publishedBeforeMs === null) return true;
  if (discovery.published_at === undefined) return true;
  return new Date(discovery.published_at).getTime() <= publishedBeforeMs;
}

function validatedPublicEvidenceItems(
  discoveries: KindResearchResult['discoveries'],
  validatedEvidence: NonNullable<KindResearchResult['validatedEvidence']>,
  profile: ResearchProfile | null,
  publishedBefore: string | null,
): EvidenceItem[] {
  if (profile === null) return [];
  const publishedBeforeMs = publishedBefore === null ? null : new Date(publishedBefore).getTime();
  const retrievedAt = new Date().toISOString();
  const evidence: EvidenceItem[] = [];
  const seen = new Set<string>();
  // Exact-fetched quotes win over provider-native title+snippet for the same
  // pack+URL (content hashes differ, so the identity Set alone is not enough).
  const exactFetchedPackUrls = new Set<string>();
  const discoveryByUrl = new Map(
    discoveries.map((discovery) => [canonicalizeUrl(discovery.url), discovery]),
  );

  for (const accepted of validatedEvidence) {
    const discovery = discoveryByUrl.get(canonicalizeUrl(accepted.source_url));
    if (discovery === undefined) continue;
    // Snapshot contract: a profile run assembles the evidence ledger as of its
    // date boundary, so an item dated after the boundary can never be ledger
    // evidence. Coverage evaluation already treats such items as ineligible
    // (futureEvidenceCount) and the release canary rejects any manifest that
    // contains one (public_manifest_invalid, 2026-07-27: a planner-found
    // repository stamped with its post-as-of pushed_at). Providers enforce
    // published_before only when the subquery carries it; planner queries do
    // not, so the boundary is enforced here, once, at assembly.
    if (!withinAsOfBoundary(discovery, publishedBeforeMs)) continue;
    for (const sourcePackId of packIdsForDiscovery(discovery, profile)) {
      const pack = profile.sourcePacks.find((candidate) => candidate.id === sourcePackId);
      if (pack === undefined || pack.visibility !== 'public') continue;
      // Evidence provenance: a discovery becomes pack evidence only when it was
      // acquired through one of the pack's declared providers. Seed attribution
      // satisfies this by construction (compileProfileExecution builds pack
      // seeds from the same providers list), so this binds the domain-matched
      // path: without it a tavily/searxng result on github.com is attributed to
      // open-implementation-sources, whose v2 contract is native GitHub evidence
      // only, and a github-native repository record is attributed to
      // ai-design-guidance, whose contract is web providers. The release
      // canary's independent per-pack provider whitelist rejects both
      // (public_manifest_invalid, 2026-07-27). Dropped discoveries still inform
      // synthesis; they just never enter the pack's evidence ledger.
      if (!pack.providers.includes(discovery.provider)) continue;
      const identity = createEvidenceIdentity({
        sourceRef: accepted.source_url,
        content: accepted.content,
        publishedAt: discovery.published_at,
      });
      const packedIdentity = `${sourcePackId}\u0000${identity.id}`;
      if (seen.has(packedIdentity)) continue;
      seen.add(packedIdentity);
      exactFetchedPackUrls.add(`${sourcePackId}\u0000${canonicalizeUrl(accepted.source_url)}`);
      evidence.push(EvidenceItemSchema.parse({
        ...identity,
        sourceRef: accepted.source_url,
        canonicalUrl: canonicalizeUrl(accepted.source_url),
        title: discovery.title,
        author: discovery.author,
        publishedAt: discovery.published_at,
        retrievedAt,
        provider: discovery.provider,
        sourceClass: sourceClassForMode(discovery.source_modes[0]),
        lane: pack.lane as SourceLane,
        sourcePackId,
        visibility: 'public',
        exactQuote: accepted.kind === 'verbatim_quote' ? accepted.content : undefined,
        contentRef: accepted.source_url,
        engagement: Object.fromEntries(
          Object.entries(discovery.engagement).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
        ),
        metadata: {
          source_modes: discovery.source_modes,
          backend: discovery.raw_metadata['backend'],
          evidence_kind: accepted.kind,
          validation: 'exact_fetched_source_sentence',
        },
      }));
    }
  }

  // Provider-native discovery evidence for HN / RSS / podcasts / tavily /
  // searxng. Only when the discovery already carries a seed or domain pack id
  // — never invent packs from a bare host. Prefer exact-fetched quotes when
  // both exist for the same pack+URL.
  for (const discovery of discoveries) {
    if (!PROVIDER_NATIVE_DISCOVERY_PROVIDERS.has(discovery.provider)) continue;
    if (!withinAsOfBoundary(discovery, publishedBeforeMs)) continue;
    const body = discoveryBody(discovery);
    if (body.length < MIN_PROVIDER_NATIVE_BODY_CHARS) continue;
    for (const sourcePackId of packIdsForDiscovery(discovery, profile)) {
      const pack = profile.sourcePacks.find((candidate) => candidate.id === sourcePackId);
      if (pack === undefined || pack.visibility !== 'public') continue;
      if (!pack.providers.includes(discovery.provider)) continue;
      const packUrlKey = `${sourcePackId}\u0000${canonicalizeUrl(discovery.url)}`;
      if (exactFetchedPackUrls.has(packUrlKey)) continue;
      const identity = createEvidenceIdentity({
        sourceRef: discovery.url,
        content: body,
        publishedAt: discovery.published_at,
      });
      const packedIdentity = `${sourcePackId}\u0000${identity.id}`;
      if (seen.has(packedIdentity)) continue;
      seen.add(packedIdentity);
      evidence.push(EvidenceItemSchema.parse({
        ...identity,
        sourceRef: discovery.url,
        canonicalUrl: canonicalizeUrl(discovery.url),
        title: discovery.title,
        author: discovery.author,
        publishedAt: discovery.published_at,
        retrievedAt,
        provider: discovery.provider,
        sourceClass: sourceClassForMode(discovery.source_modes[0]),
        lane: pack.lane as SourceLane,
        sourcePackId,
        visibility: 'public',
        exactQuote: body.slice(0, 2_000),
        contentRef: discovery.url,
        engagement: Object.fromEntries(
          Object.entries(discovery.engagement).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
        ),
        metadata: {
          source_modes: discovery.source_modes,
          backend: discovery.raw_metadata['backend'],
          evidence_kind: 'provider_native_discovery',
          validation: 'provider_native_discovery',
        },
      }));
    }
  }

  return evidence;
}

function exactAsOfBoundary(asOf: string): string {
  const value = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? `${asOf}T23:59:59.999Z` : asOf;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('asOf must be an ISO date or timestamp.');
  return parsed.toISOString();
}

export async function runResearchProgram(input: RunResearchProgramInput): Promise<ResearchProgramResult> {
  const adapters = input.trustedAdapters ?? [];
  const availableProviders = input.availableProviders ??
    (Object.keys(getEnabledSearchProviders(input.credentials)) as ProviderName[]);
  const asOfDate = input.asOf.slice(0, 10);
  const profileExecution = input.profileRef !== undefined
    ? compileProfileExecution(input.profileRef, {
        question: input.brief,
        asOf: asOfDate,
        mode: input.profileMode,
      }, availableProviders)
    : null;
  const sourceModes = input.sourceModes ?? profileExecution?.sourceModes;
  if (sourceModes === undefined || sourceModes.length === 0) {
    throw new Error('At least one source mode or a profile with executable source packs is required.');
  }
  const requiredProviders = Array.from(new Set([
    ...(profileExecution?.requiredProviders ?? []),
    ...(input.requiredProviders ?? []),
  ]));
  const plan = resolveSourceExecutionPlan({
    question: input.brief,
    modes: sourceModes,
    availableProviders,
    availableTrustedAdapters: adapters.map((adapter) => adapter.id),
    requiredProviders,
    asOf: input.asOf,
    scopes: input.scopes,
  });
  const publishedBefore = profileExecution !== null ? exactAsOfBoundary(input.asOf) : null;
  if (profileExecution !== null && publishedBefore !== null) {
    plan.seededSubqueries = profileExecution.seedSubqueries.map((subquery) => ({
      ...subquery,
      search_options: { ...subquery.search_options, published_before: publishedBefore },
    }));
  }
  if (input.recencyDays !== undefined) {
    plan.seededSubqueries = plan.seededSubqueries.map((subquery) => ({
      ...subquery,
      search_options: { ...subquery.search_options, recency_days: input.recencyDays },
    }));
  }

  if (!plan.ready) throw new SourcePlanUnavailableError(plan);
  const kind = input.kind ?? 'deep';
  if (plan.publicModes.length > 0 && (kind === 'answer' || kind === 'managed')) {
    throw new Error(`Research kind ${kind} cannot enforce deterministic source modes; use quick, standard, deep, or social.`);
  }

  // Public research receives only the caller's public question and a public
  // source-plan preamble. Trusted recall results never enter this promise.
  const publicPromise: Promise<KindResearchResult | null> = plan.publicModes.length === 0
    ? Promise.resolve(null)
    : (input.publicRunner ?? runResearch)({
        credentials: input.credentials,
        brief: `${profileExecution?.compiledBrief.outboundBrief ?? input.brief}\n\n${plan.outboundPreamble}`,
        kind,
        maxCostUsd: input.maxCostUsd,
        synthesisModelOverride: input.synthesisModelOverride,
        minFreeResults: input.minFreeResults,
        recencyDays: input.recencyDays,
        providers: plan.providerAllowlist,
        seedSubqueries: plan.seededSubqueries,
        providerSearchOptions: input.providerSearchOptions,
        indexSink: input.indexSink,
        onUsage: input.onUsage,
        cache: input.cache,
        logger: input.logger,
      });

  const evidenceByMode = new Map<TrustedSourceMode, EvidenceItem[]>();
  const trustedRecallFailures: TrustedRecallFailure[] = [];
  const recallPromises = plan.trustedModes.map(async (mode) => {
    const adapter = adapterForMode(mode, plan, adapters);
    if (adapter === null) {
      trustedRecallFailures.push({ mode, adapterId: null, error: 'authenticated tenant-bound adapter unavailable' });
      evidenceByMode.set(mode, []);
      return;
    }
    try {
      const sourcePackIds = profileExecution?.trustedPacksByMode[mode]?.map((pack) => pack.id)
        ?? [`mode-${mode}`];
      const evidence = await adapter.recall({
        question: input.brief,
        mode,
        asOf: input.asOf,
        limit: 50,
        profileRef: profileExecution?.compiledBrief.profileRef,
        sourcePackIds,
        queryHints: profileExecution?.trustedPacksByMode[mode]?.flatMap((pack) => pack.queryHints),
        signal: input.signal,
      });
      evidenceByMode.set(mode, validateTrustedEvidence(evidence, mode, sourcePackIds));
    } catch (error) {
      trustedRecallFailures.push({
        mode,
        adapterId: adapter.id,
        error: error instanceof Error ? error.message : String(error),
      });
      evidenceByMode.set(mode, []);
    }
  });

  const [publicResearch] = await Promise.all([publicPromise, Promise.all(recallPromises)]);
  const trustedEvidence = Array.from(evidenceByMode.values()).flat();
  const publicEvidence = validatedPublicEvidenceItems(
    publicResearch?.discoveries ?? [],
    publicResearch?.validatedEvidence ?? [],
    profileExecution?.profile ?? null,
    publishedBefore,
  );
  // Source-mode coverage is discovery coverage: a mode is covered when its
  // search returned enough hits. Do NOT require exact-fetched quotes —
  // provider-native modes (github REST, HN, RSS) routinely lack HTML extract
  // while still producing pack evidence. Filtering to validatedEvidence here
  // was the 2026-08-04 canary failure after github native admission:
  // program_incomplete uncovered community+github while pack floors passed.
  const coverage = evaluateSourceModeCoverage(
    plan,
    publicResearch?.discoveries ?? [],
    trustedCounts(evidenceByMode),
  );
  const profileCoverage = profileExecution !== null
    ? evaluateCoverage(profileExecution.profile, [...publicEvidence, ...trustedEvidence], input.asOf)
    : null;
  // Every pipeline kind admitted to a public program owns a grounding result.
  // Missing/null grounding is not success: otherwise a consumer regression
  // could silently turn an unverified report into program_status=complete.
  const groundingPassed = publicResearch === null || publicResearch.grounding?.passed === true;
  const status = coverage.passed && (profileCoverage?.passed ?? true) && groundingPassed && trustedRecallFailures.length === 0
    ? 'complete'
    : 'partial';

  return {
    status,
    sourcePlan: plan,
    sourceCoverage: coverage,
    profileCoverage,
    publicResearch,
    publicEvidence,
    trustedEvidence,
    trustedRecallFailures,
    costUsd: publicResearch?.costUsd ?? 0,
    dataBoundary: 'public_report_and_private_manifest_separate',
  };
}
