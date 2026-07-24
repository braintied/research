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

function validatedPublicEvidenceItems(
  discoveries: KindResearchResult['discoveries'],
  validatedEvidence: NonNullable<KindResearchResult['validatedEvidence']>,
  profile: ResearchProfile | null,
): EvidenceItem[] {
  if (profile === null) return [];
  const retrievedAt = new Date().toISOString();
  const evidence: EvidenceItem[] = [];
  const seen = new Set<string>();
  const discoveryByUrl = new Map(
    discoveries.map((discovery) => [canonicalizeUrl(discovery.url), discovery]),
  );

  for (const accepted of validatedEvidence) {
    const discovery = discoveryByUrl.get(canonicalizeUrl(accepted.source_url));
    if (discovery === undefined) continue;
    for (const sourcePackId of discovery.source_pack_ids) {
      const pack = profile.sourcePacks.find((candidate) => candidate.id === sourcePackId);
      if (pack === undefined || pack.visibility !== 'public') continue;
      const identity = createEvidenceIdentity({
        sourceRef: accepted.source_url,
        content: accepted.content,
        publishedAt: discovery.published_at,
      });
      const packedIdentity = `${sourcePackId}\u0000${identity.id}`;
      if (seen.has(packedIdentity)) continue;
      seen.add(packedIdentity);
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
    (Object.keys(getEnabledSearchProviders()) as ProviderName[]);
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
  if (profileExecution !== null) {
    const publishedBefore = exactAsOfBoundary(input.asOf);
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
  );
  const validatedPublicUrls = new Set(
    (publicResearch?.validatedEvidence ?? []).map((item) => canonicalizeUrl(item.source_url)),
  );
  const validatedDiscoveries = (publicResearch?.discoveries ?? []).filter((discovery) =>
    validatedPublicUrls.has(canonicalizeUrl(discovery.url)));
  const coverage = evaluateSourceModeCoverage(
    plan,
    validatedDiscoveries,
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
