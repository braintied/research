/**
 * @braintied/research — deep-research engine.
 *
 * Lineage: harvested from ora-ai's cortex-worker deep-research pipeline,
 * decoupled from Cortex/Inngest as @swishh/research (v0.1.x), then promoted
 * to this shared cross-product package. `runDeepResearch` composes the same
 * modules in the same order as the original 12-step Inngest runner, but as a
 * single plain async function with no `step.run` boundaries and no database
 * writes. Report indexing is optional and injected via `indexSink`.
 */

import { vendorUnitCostUsd } from '@braintied/cost';
import { findCatalogModel } from '@braintied/models';
import { z } from 'zod';
import {
  hashUrl,
  canonicalizeUrl,
  resolveSameSourceCitationUrl,
  SearchResultSchema,
  SubquerySchema,
  ExtractedQuotesSchema,
} from './types.js';
import {
  extractCacheKey,
  EXTRACT_CACHE_TTL_SECONDS,
} from './extract-cache.js';
import { selectUrlsToFetch, resultsForSubquery } from './fetch-selection.js';
import {
  hasVerifiableSentence,
  isKeyClaimSupportedBySource,
  isVerbatimQuoteSupportedBySource,
} from './evidence-validation.js';
import type {
  Subquery,
  SearchResult,
  SearchProvider,
  ExtractedQuotes,
  VerbatimQuote,
  ProviderName,
  SectionDraft,
  FinalReport,
  ReportChunkInput,
  SearchOpts,
} from './types.js';
import { DEPTH_CONFIG, EXTRACT_SPEND_SHARE, getModelPricing, refinementExtractReserve } from './depth-config.js';
import type { ResearchDepth } from './depth-config.js';
import { CostTracker } from './cost-tracker.js';
import {
  researchModelRates,
  researchStageResolution,
  resolveResearchCritiqueModel,
} from './model-policy.js';
import {
  extractionModelId,
  GEMINI_MAX_CONTENT_CHARS,
  CHARS_PER_TOKEN,
  mapWithConcurrency,
} from './pipeline-core.js';
import { planSubqueries } from './planner.js';
import type { PlannerUsage } from './planner.js';
import { splitDecisionBriefQuestions } from './decision-brief.js';
import { runAdaptiveExtraction, sectionEvidenceFrom, sectionNeedsEvidence } from './extract-budget.js';
import type { SectionEvidence, SectionEvidenceTarget } from './extract-budget.js';
import {
  createProviderRegistry,
  getEnabledProviders,
  getEnabledSearchProviders,
  routeProvidersForSourceTypes,
  extractQuotesWithGemini,
} from './providers/index.js';
import type { ProviderRegistry } from './providers/index.js';
import type { ResearchCredentials } from './credentials.js';
import { rerankQuotes } from './rerank.js';
import {
  synthesizeAllSections,
  assembleFinalReport,
} from './synthesis.js';
import type { SectionSpec } from './synthesis.js';
import { critiqueDraft } from './critique.js';
import { buildReportChunks } from './chunker.js';
import {
  buildGroundingEvidenceChunks,
  validateGrounding,
} from './grounding.js';
import type { GroundingResult } from './grounding.js';
import { safeLogger } from './logger.js';
import type { Logger } from './logger.js';
import { parseCachedSearchResults, searchCachePolicyIdentity } from './search-cache.js';
import {
  analyzeBriefRequirements,
  assessFetchedPage,
  focusContentWindow,
  isBoilerplateEvidence,
  isPrimarySourceUrl,
  judgeEvidenceRelevance,
  questionTerms,
  RELEVANCE_KEEP_THRESHOLD,
  selectFacetAnswers,
  urlIsOnDomain,
} from './answer-quality.js';
import type {
  AnswerQuality,
  AnswerQualityModelUsage,
  BriefRequirements,
  EvidenceJudgment,
  EvidenceUnitForJudging,
  FetchQualityCounts,
  GateCounts,
} from './answer-quality.js';

// =============================================================================
// Public re-exports — types, schemas, config
// =============================================================================

export * from './types.js';
export {
  DEPTH_CONFIG,
  coerceDepth,
  getDepthConfig,
  getModelPricing,
  tryGetModelPricing,
  deepResearchSynthesisCostUsd,
  MODEL_PRICING,
  DEEPSEEK_V4_PRO_PROMO_EXPIRY_AT,
  refinementRounds,
  refinementExtractReserve,
  REFINEMENT_EXTRACT_RESERVE_SHARE,
} from './depth-config.js';
export type { ResearchDepth, DepthTunables, ModelPricing } from './depth-config.js';
export { CostTracker } from './cost-tracker.js';
export { logger } from './logger.js';
export { researchUserAgent, setResearchUserAgentContact } from './user-agent.js';
export type { Logger } from './logger.js';

// The package's entire configuration surface. Hosts resolve env at their own
// process boundary and pass the record in; src/ never reads process.env.
export {
  resolveResearchCredentials,
  isApifyFallbackAllowed,
  resolveGeminiApiKey,
  requireGeminiApiKey,
  requireVoyageApiKey,
  requireAnthropicApiKey,
  MissingCredentialError,
  RESEARCH_ENV_NAMES,
  GEMINI_KEY_ENV_NAMES,
  GEMINI_KEY_NAME_ENV,
  NEUTRAL_GEMINI_KEY_NAME_ENV,
  CRAWL4AI_ALLOWED_DOMAINS_ENV,
  NEUTRAL_CRAWL4AI_ALLOWED_DOMAINS_ENV,
  CRAWL4AI_NETWORK_GUARD_ENV,
  NEUTRAL_CRAWL4AI_NETWORK_GUARD_ENV,
  CRAWL4AI_NETWORK_GUARD_VALUE,
} from './credentials.js';
export type {
  ResearchCredentials,
  ResearchEnvironment,
  RedditCredentials,
  XCredentials,
  BrightDataCredentials,
  GitHubPublicAuthConfig,
  Crawl4AiConfig,
} from './credentials.js';

// Stage-level building blocks (so consumers can compose their own pipelines)
export { planSubqueries, summarizePromptBrief } from './planner.js';
export type { PlanSubqueriesInput, PlannerUsage } from './planner.js';
export { splitDecisionBriefQuestions, questionHeadingFor, SHARED_CONTEXT_MAX_CHARS } from './decision-brief.js';
export type { DecisionBriefSplit } from './decision-brief.js';
export {
  allocateExtractBudgetFairShare,
  runAdaptiveExtraction,
  sectionEvidenceFrom,
  sectionNeedsEvidence,
  takeAdaptiveExtractWave,
} from './extract-budget.js';
export type {
  AdaptiveExtractionInput,
  AdaptiveExtractionResult,
  SectionEvidence,
  SectionEvidenceTarget,
} from './extract-budget.js';
export {
  createProviderRegistry,
  getAllProviders,
  getEnabledProviders,
  getEnabledSearchProviders,
  routeProvidersForSourceTypes,
  extractQuotesWithGemini,
  createTavilyProvider,
  tavilyAnswer,
  createExaProvider,
  createSerpapiProvider,
  createSerperProvider,
  createSearxngProvider,
  searxngSearch,
  searxngEnginesParam,
  recencyDaysToTimeRange,
  createPerplexityProvider,
  perplexityAnswer,
  PerplexityApiError,
  createRedditProvider,
  createRedditClient,
  probeReddit,
  RedditApiError,
  REDDIT_VAULT_KEYS,
  redditCredentialsFromResolver,
  redditThreadApiUrl,
  collectRedditCorpus,
  fetchExpandedThread,
  discoverSubreddits,
  flattenCorpusTree,
  redactUserMentions,
  redditSearchCacheKey,
  REDDIT_CORPUS_SCHEMA,
  createDirectoryThreadStore,
  createYoutubeProvider,
  createHnProvider,
  rssProvider,
  createCrawl4aiProvider,
  createFacebookGroupsProvider,
  createTiktokProvider,
  createInstagramProvider,
  discoverInstagramProfilePosts,
  InstagramSnapshotPendingError,
  fetchInstagramProfile,
  normalizeInstagramProfileSnapshot,
  INSTAGRAM_PROFILE_WAIT_MS,
  BRIGHTDATA_INSTAGRAM_POSTS_DATASET_ID,
  BRIGHTDATA_INSTAGRAM_PROFILES_DATASET_ID,
  APIFY_INSTAGRAM_STORIES_ACTOR_ID,
  canonicalizeInstagramPostUrl,
  canonicalizeInstagramProfileUrl,
  canonicalizeInstagramStoriesUrl,
  parseInstagramStoriesUrl,
  createXProvider,
  fetchTweetWithBackends,
  createPodcastsProvider,
  createGithubProvider,
  resolveGitHubPublicAuthState,
  triggerCollection,
  pollSnapshot,
  waitForBrightDataSnapshot,
  BrightDataSnapshotPendingError,
  downloadSnapshot,
  scrapeDataset,
  unlockUrl,
  fetchLinkedInPostsBrightData,
  fetchFacebookGroupPostsBrightData,
  // Strict, consent-gated LinkedIn member profile. Named explicitly because
  // this block is an allow-list, not `export *`: the dist export test in
  // tests/ is what caught these missing, since a source-level suite imports
  // the provider module directly and cannot see the root surface.
  fetchLinkedInPublicProfile,
  canonicalizeLinkedInProfileUrl,
  linkedInPublicIdentifier,
  normalizeLinkedInProfileRecord,
  linkedInProfileEvidence,
  NotALinkedInProfileUrlError,
  LinkedInProfileIdentityMismatchError,
  BRIGHTDATA_LINKEDIN_PROFILES_DATASET_ID,
  LINKEDIN_PUBLIC_PROFILE_PURPOSE,
  LINKEDIN_PUBLIC_PROFILE_SOURCE_PACK,
} from './providers/index.js';
export type {
  LinkedInPosition,
  LinkedInEducation,
  NormalizedLinkedInProfile,
  LinkedInProfileFieldId,
  FetchLinkedInPublicProfileInput,
  LinkedInPublicProfileResult,
  InstagramStoriesTarget,
  InstagramProfilePostsInput,
  NormalizedInstagramPost,
  InstagramBioLink,
  InstagramProfile,
  InstagramProfilePost,
  InstagramProfileFetchResult,
  FetchInstagramProfileOptions,
  RedditClient,
  RedditClientOptions,
  RedditSearchOptions,
  RedditListSubredditOptions,
  RedditFetchThreadOptions,
  RedditSearchSort,
  RedditListingSort,
  RedditCommentSort,
  RedditTimeFilter,
  RedditPost,
  RedditListing,
  RedditComment,
  RedditThread,
  RedditProbeResult,
  RedditErrorStage,
  RedditThreadUrlResult,
  RedditMoreStub,
  RedditMoreChildrenOptions,
  RedditMoreChildrenResult,
  RedditSubredditInfo,
  RedditSearchSubredditsOptions,
  RedditCorpusCommentMode,
  RedditCorpusComment,
  RedditCorpusCommentStats,
  RedditCorpusThread,
  RedditCorpusErrorStage,
  RedditCorpusError,
  RedditCorpusSearchPage,
  RedditThreadStore,
  RedditCorpusProgress,
  RedditCorpusOptions,
  RedditCorpusResult,
  ExpandThreadOptions,
  ExpandedThread,
  DiscoverSubredditsOptions,
  DiscoverSubredditsResult,
  XBackend,
  XBackendAttempt,
  XTweetChainResult,
  XTweetChainOptions,
  ProviderRegistry,
  PollSnapshotOptions,
  ScrapeDatasetOptions,
  WaitForBrightDataSnapshotOptions,
  BrightDataSnapshotWaitResult,
  BrightDataRecord,
  UnlockUrlOptions,
  UnlockedPage,
  GitHubPublicAuthCode,
  GitHubPublicAuthState,
  PerplexityAnswerModel,
  PerplexityAnswerOptions,
  PerplexityAnswerResult,
  TavilyAnswerOptions,
  TavilyAnswerResult,
} from './providers/index.js';
export { rerankQuotes } from './rerank.js';
export {
  synthesizeSection,
  synthesizeAllSections,
  assembleFinalReport,
  SynthesisTimeoutError,
  SYNTHESIS_REQUEST_TIMEOUT_MS,
} from './synthesis.js';
export type {
  SectionSpec,
  SynthesizeSectionInput,
  SynthesizeAllInput,
  SynthesisSectionProgress,
  AssembleFinalReportInput,
} from './synthesis.js';
export { critiqueDraft } from './critique.js';
export { buildReportChunks } from './chunker.js';
export type { BuildReportChunksInput } from './chunker.js';
export { embedTexts } from './embedder.js';
export {
  assessGroundingQuality,
  GROUNDING_PASS_THRESHOLD,
  GROUNDING_STRONG_THRESHOLD,
  validateGrounding,
} from './grounding.js';
export type {
  GroundingResult,
  GroundingQuality,
  HallucinatedCitation,
  ValidateGroundingInput,
} from './grounding.js';
export { parseMarkdownReport } from './parse-markdown-report.js';

// Versioned investigation profiles, evidence lineage, and coverage gates.
export * from './profiles/index.js';
// Consent as a required input, and the one program that runs against a named
// person. Both refuse rather than degrade: see `consent-gate.ts`.
export * from './consent-gate.js';
export * from './consented-person.js';
export * from './evidence.js';
export * from './source-modes.js';
export * from './source-health.js';
export * from './research-program.js';
export * from './answer-quality.js';

// Knowledge-ingestion core (continuous internet-knowledge ingestion).
export * from './ingestion/index.js';

// Standalone scrape primitives — the Crawl4AI → direct-fetch chain, usable
// outside the research pipeline (e.g. Sentigen WebResearch).
export {
  crawlUrl,
  crawlUrlDetailed,
  crawlWithCrawl4AI,
  directFetchAsText,
  EXTRACTION_MODEL,
  extractionModelId,
  resolveGeminiRequestModel,
} from './pipeline-core.js';
export type {
  Crawl4AIDeclineReason,
  CrawlMethod,
  CrawlUrlDetailedResult,
} from './pipeline-core.js';

export {
  resolveResearchExtractionModel,
  resolveResearchSynthesisModel,
  resolveResearchCritiqueModel,
  resolveResearchAssemblyModel,
  researchModelRates,
  researchStageCostFields,
  researchStageResolution,
  researchModelRequirements,
} from './model-policy.js';
export type { ResearchModelRequirement, ResearchModelStage } from './model-policy.js';

// The one model transport every stage calls; routes by the resolution's provider.
export {
  callModel,
  credentialFieldForProvider,
  isProviderAccountFailure,
  providerForModelId,
  UnroutableModelError,
} from './model-call.js';
export type { ModelCallInput, ModelCallResult, ModelCallTarget } from './model-call.js';

// Research kinds — semantic presets (quick/standard/deep/managed/social).
export {
  RESEARCH_KINDS,
  RESEARCH_KIND_PRESETS,
  coerceResearchKind,
  runResearch,
} from './kinds.js';
export type { ResearchKind, ResearchKindPreset, RunResearchInput, KindResearchResult } from './kinds.js';

// Answer engine — cited quick answers on the self-hosted stack.
export { runAnswer } from './answer.js';
export type { RunAnswerInput, RunAnswerResult, AnswerCitation } from './answer.js';

// Managed deep research (Perplexity sonar-deep-research).
export { runManagedResearch } from './managed-research.js';
export type { RunManagedResearchInput, RunManagedResearchResult } from './managed-research.js';

// Document layer — research → typed structured documents (PRD, briefs, specs).
export * from './documents/index.js';

// YouTube channel ingestion — Data API v3 channel catalog, playlists,
// metadata, and comment trees. All keys are function arguments.
export {
  resolveChannelId,
  listChannelVideos,
  getChannelPlaylists,
  getPlaylistVideoIds,
  buildPlaylistMembership,
  getVideoMetadata,
  getVideoComments,
} from './youtube/index.js';
export type {
  ChannelVideoRef,
  ChannelPlaylist,
  YoutubeVideoMetadata,
  YoutubeComment,
} from './youtube/index.js';

// RSS/Atom feed reader — the podcast lane's transport, exported so a host can
// size a catalog run (episode count, durations) before it approves the spend.
export { fetchRssFeed } from './advice-rss.js';
export type { FeedItem, FeedResult } from './advice-rss.js';

// Unified YouTube transcript stack — captions → Groq Whisper → Deepgram.
export { extractTranscriptWithFallback, transcribeAudioUrl, TranscriptUnavailableError } from './transcript/index.js';
export type {
  AudioTranscriptInput,
  TranscriptResult,
  TranscriptSegmentWindow,
  TranscriptTier,
  TranscriptUsage,
} from './transcript/index.js';

// YC portfolio provider (public yc-oss API).
export { fetchYcPortfolio } from './providers/yc-portfolio.js';
export type { YcCompany } from './providers/yc-portfolio.js';

// =============================================================================
// Constants — mirror the original runner's budget knobs
// =============================================================================

const SEARCH_RESULT_LIMIT = 8;
/** Fetch ceiling (crawl). Extract has a separate, tighter run budget. */
const CUMULATIVE_URL_CEILING = 400;
/**
 * Tokens reserved per extraction call when estimating its cost before
 * dispatch: the output allowance (a short JSON list of quotes and claims) and
 * the fixed prompt that rides on every call (instructions plus the focus
 * questions). A close estimate, used only to keep parallel calls under the
 * extraction ceiling and the run cap; never recorded as spend.
 */
const EXTRACT_OUTPUT_TOKEN_ALLOWANCE = 1500;
const EXTRACT_PROMPT_TOKEN_ALLOWANCE = 900;
const RERANK_TOP_K = 40;

/**
 * Mutable run-level extract budget. Shared across the main extract pass and
 * every critique re-extract so the whole run cannot exceed maxExtractPages.
 */
interface ExtractBudget {
  remaining: number;
  concurrency: number;
  /**
   * Extraction spend (the 'extract' cost category only) may not pass this,
   * counting calls in flight. Synthesis and critique spend do not count
   * against it, so a refinement pass can still read pages while the run's
   * hard cap has room.
   */
  spendCeilingUsd: number;
  /** The run's whole dollar cap; extraction checks it with in-flight estimates included. */
  hardCapUsd: number;
  /** Evidence a section needs before it stops taking pages. */
  target: SectionEvidenceTarget;
  /** Pages per section in the first wave of each extract pass. */
  firstWavePagesPerSection: number;
  /** URLs already extracted this run — skip re-paying Gemini for them. */
  doneUrls: Set<string>;
  /** Stage counts for the run, shared by the first pass and refinement. */
  funnel: EvidenceFunnel;
}

/**
 * Where a run's evidence went, stage by stage. A thin report used to say only
 * "no source-validated evidence"; on 2026-09-26 a run discovered 55 sources
 * and kept zero, and nothing in the metadata said which stage dropped them.
 */
export interface EvidenceFunnel {
  /** Search results that arrived with fetched page content. */
  sourcesWithContent: number;
  /** Pages sent to the extractor. */
  sourcesExtracted: number;
  /** Pages with content that the extract budget skipped. */
  sourcesSkippedForBudget: number;
  /** Pages skipped because extraction reached its share of the dollar cap. */
  sourcesSkippedForCost: number;
  /** Page ceiling for the run (main pass + refinement). */
  pageBudget: number;
  /** Extraction waves run; each wave after the first served only sections below target. */
  extractWaves: number;
  /** Candidate pages left unread because their section already had enough evidence. */
  sourcesNotNeeded: number;
  /** Sections still below the evidence target when extraction stopped. */
  sectionsBelowTarget: number;
  /** Pages with no complete sentence at all; nothing on them could be quoted, so they were not extracted. */
  sourcesWithoutVerifiableText: number;
  quotesExtracted: number;
  quotesValidated: number;
  claimsExtracted: number;
  claimsValidated: number;
  /** Pages whose every extracted item failed source validation. */
  sourcesWithNoValidatedEvidence: number;
}

function emptyEvidenceFunnel(): EvidenceFunnel {
  return {
    sourcesWithContent: 0,
    sourcesExtracted: 0,
    sourcesSkippedForBudget: 0,
    sourcesSkippedForCost: 0,
    pageBudget: 0,
    extractWaves: 0,
    sourcesNotNeeded: 0,
    sectionsBelowTarget: 0,
    sourcesWithoutVerifiableText: 0,
    quotesExtracted: 0,
    quotesValidated: 0,
    claimsExtracted: 0,
    claimsValidated: 0,
    sourcesWithNoValidatedEvidence: 0,
  };
}

// =============================================================================
// runDeepResearch — the main orchestrator
// =============================================================================

export type IndexSink = (chunks: ReportChunkInput[]) => Promise<void>;

/**
 * Per-stage usage event for pipeline runs (audit M3) — fired every time the
 * CostTracker records an entry, so consumers with their own attribution
 * ledgers (Sentigen admin_ai_usage_log, cortex gauge_events) see EVERY spend:
 * search, fetch, extract, rerank/embed, synth, critique, plan, assembly.
 */
export interface PipelineUsageEvent {
  provider: string;
  /**
   * Canonical vendor name for search/scrape rows (`tavily`, `serper`,
   * `brightdata`). Same as `provider` today; hosts must copy it onto
   * `AiUsageInput.vendor` or the ledger column stays NULL (measured
   * 2026-08-16: 1,720/1,720 Tavily rows).
   */
  vendor?: string;
  category: 'search' | 'fetch' | 'extract' | 'embed' | 'synth' | 'critique' | 'plan' | 'transcribe';
  model?: string;
  units: number;
  costUsd: number;
  metadata: Record<string, unknown>;
}

export type OnPipelineUsage = (event: PipelineUsageEvent) => void | Promise<void>;

const SAFE_USAGE_OPERATIONS = new Set([
  'brief-analysis-input',
  'brief-analysis-output',
  'relevance-input',
  'relevance-output',
  'assembly-input',
  'assembly-input-cached',
  'assembly-output',
  'extract-input',
  'extract-input-estimated',
  'extract-output',
  'extract-cache-hit',
  'plan-input',
  'plan-output',
  'rerank-2',
  'synth-input',
  'synth-input-cached',
  'synth-output',
]);
const SAFE_USAGE_SORTS = new Set([
  'comments', 'latest', 'mixed', 'new', 'rating', 'relevance', 'top', 'views',
]);
const SAFE_USAGE_SOURCE_MODES = new Set([
  'all', 'all_public', 'all_social', 'community', 'cortex', 'facebook_groups',
  'github', 'instagram', 'reddit', 'telegram', 'tiktok', 'web', 'x', 'youtube',
]);
/**
 * Model ids emitted in usage metadata that the `@braintied/models` catalog
 * does not carry: the OpenRouter bake-off id. Every catalog id is accepted by
 * `isSafeUsageModel`, so the model a stage resolves to is never dropped from
 * telemetry. The hand-kept list this replaced did not name `deepseek-flash`,
 * so under the fleet default every research cost event would have reached
 * the ledger with no model at all.
 */
const SAFE_NON_CATALOG_USAGE_MODELS = new Set([
  'qwen/qwen3-235b-a22b-instruct-2507',
]);

function isSafeUsageModel(value: string): boolean {
  return SAFE_NON_CATALOG_USAGE_MODELS.has(value) || findCatalogModel(value) !== null;
}

const SAFE_USAGE_NUMERIC_FIELDS = new Set([
  'actual_tokens',
  'estimated_sections',
  'gaps',
  'pass',
  'recency_days',
  'results',
  'sections',
]);

function safeUsageString(key: string, value: string): string | undefined {
  if (key === 'operation') return SAFE_USAGE_OPERATIONS.has(value) ? value : undefined;
  if (key === 'sort') return SAFE_USAGE_SORTS.has(value) ? value : undefined;
  if (key === 'source_mode') return SAFE_USAGE_SOURCE_MODES.has(value) ? value : undefined;
  if (key === 'model') return isSafeUsageModel(value) ? value : undefined;
  return undefined;
}

export function sanitizePipelineUsageMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'number'
        && Number.isFinite(value)
        && SAFE_USAGE_NUMERIC_FIELDS.has(key)) {
      safe[key] = value;
    }
    if (typeof value === 'string') {
      const sanitized = safeUsageString(key, value);
      if (sanitized !== undefined) safe[key] = sanitized;
    }
  }
  return safe;
}

/** CostTracker that also notifies an OnPipelineUsage listener per entry. */
class NotifyingCostTracker extends CostTracker {
  constructor(
    capUsd: number,
    private readonly listener: OnPipelineUsage | undefined,
    private readonly log: Logger,
  ) {
    super(capUsd);
  }

  override record(entry: Parameters<CostTracker['record']>[0]): void {
    super.record(entry);
    if (this.listener !== undefined) {
      const modelRaw = entry.metadata['model'];
      const safeModel = typeof modelRaw === 'string'
        ? safeUsageString('model', modelRaw)
        : undefined;
      const event: PipelineUsageEvent = {
        provider: entry.provider,
        vendor: entry.category === 'search' ? entry.provider : undefined,
        category: entry.category,
        model: safeModel,
        units: entry.units,
        costUsd: entry.units * entry.unit_cost_usd,
        metadata: sanitizePipelineUsageMetadata(entry.metadata),
      };
      Promise.resolve(this.listener(event)).catch((err: unknown) => {
        this.log.warn(
          { error: err instanceof Error ? err.message.slice(0, 120) : String(err) },
          '[runDeepResearch] onUsage listener failed (non-fatal)',
        );
      });
    }
  }

  override recordMany(entries: Parameters<CostTracker['record']>[0][]): void {
    for (const e of entries) this.record(e);
  }
}

// Per-call search cost estimates (USD) — audit M2. Catalog vendors come from
// `@braintied/cost` (one table). These two are not in that catalog yet.
const LOCAL_SEARCH_COST_PER_CALL_USD: Partial<Record<ProviderName, number>> = {
  perplexity: 0.005,
  podcasts: 0.002,
};

function searchCostPerCallUsd(provider: ProviderName): number | undefined {
  // Provider name `x` is three backends (twitterapi.io / official X / Apify)
  // with different unit prices. Do not apply the official-X catalog rate to
  // every X search — that would over-count the fleet primary ~33×.
  if (provider === 'x') {
    return undefined;
  }
  const catalog = vendorUnitCostUsd(provider);
  if (catalog !== undefined) {
    return catalog;
  }
  return LOCAL_SEARCH_COST_PER_CALL_USD[provider];
}

// Extraction pricing comes from @braintied/models for the live extract wire id.
function extractionRates(): { inputUsdPerM: number; outputUsdPerM: number } {
  try {
    return researchModelRates(extractionModelId());
  } catch {
    return { inputUsdPerM: 0.25, outputUsdPerM: 1.5 };
  }
}
// Voyage rerank-2 (USD per 1M tokens).
const VOYAGE_RERANK_USD_PER_M = 0.05;

/**
 * Free-first tiering (audit M5): among GENERAL web-search providers, the $0/
 * free-quota tier runs first; paid general providers only fire when the free
 * tier returned fewer than `minFreeResults` unique results for the subquery.
 * Specialist providers (reddit/youtube/hn/rss/social) always run as routed —
 * the planner picked them deliberately for source-type coverage.
 */
const GENERAL_FREE_SEARCH: ReadonlySet<ProviderName> = new Set(['searxng', 'serper']);
const GENERAL_PAID_SEARCH: ReadonlySet<ProviderName> = new Set(['tavily', 'exa', 'serpapi', 'perplexity']);
const DEFAULT_MIN_FREE_RESULTS = 5;

/**
 * Pluggable source cache — modeled on ora-ai's `research_source_cache` table
 * (per-provider TTLs), which the original decoupling dropped. Each consumer
 * plugs its own store (Postgres, Redis, memory). Keys are namespaced by the
 * pipeline: `search:<provider>:<query>` and `fetch:<url>`. Errors from the
 * adapter are swallowed (cache is an optimization, never a dependency).
 */
export interface ResearchCacheAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Per-provider search-result TTLs (seconds) — mirrors ora-ai's cache policy. */
const SEARCH_CACHE_TTL_SECONDS: Partial<Record<ProviderName, number>> = {
  serpapi: 7 * 86_400,
  serper: 7 * 86_400,
  searxng: 7 * 86_400,
  tavily: 7 * 86_400,
  exa: 30 * 86_400,
  perplexity: 7 * 86_400,
  reddit: 24 * 3_600,
  youtube: 24 * 3_600,
  github: 12 * 3_600,
  x: 6 * 3_600,
  hn: 24 * 3_600,
  rss: 7 * 86_400,
};
const DEFAULT_SEARCH_CACHE_TTL_SECONDS = 14 * 86_400;
const FETCH_CACHE_TTL_SECONDS = 30 * 86_400;

export { extractCacheKey, EXTRACT_CACHE_TTL_SECONDS, EXTRACT_CACHE_KEY_PREFIX } from './extract-cache.js';

function searchCacheTtl(provider: ProviderName, opts: SearchOpts): number {
  const configured = SEARCH_CACHE_TTL_SECONDS[provider] ?? DEFAULT_SEARCH_CACHE_TTL_SECONDS;
  if (opts.recency_days !== undefined && opts.recency_days <= 7) return Math.min(configured, 3_600);
  if (opts.sort === 'latest' || opts.sort === 'new' || opts.sort === 'mixed') {
    return Math.min(configured, 6 * 3_600);
  }
  return configured;
}

async function cacheGet(cache: ResearchCacheAdapter | undefined, key: string, log: Logger): Promise<string | null> {
  if (cache === undefined) return null;
  try {
    return await cache.get(key);
  } catch (err: unknown) {
    log.warn({ key: key.slice(0, 80), error: errMsg(err).slice(0, 120) }, '[cache] get failed (non-fatal)');
    return null;
  }
}

async function cacheSet(
  cache: ResearchCacheAdapter | undefined,
  key: string,
  value: string,
  ttlSeconds: number,
  log: Logger,
): Promise<void> {
  if (cache === undefined) return;
  try {
    await cache.set(key, value, ttlSeconds);
  } catch (err: unknown) {
    log.warn({ key: key.slice(0, 80), error: errMsg(err).slice(0, 120) }, '[cache] set failed (non-fatal)');
  }
}

export interface RunDeepResearchInput {
  /**
   * Host-resolved credentials. Every provider lane, model call, and crawler
   * endpoint comes from this record; the package reads no ambient state.
   */
  credentials: ResearchCredentials;
  /** The research brief / prompt to investigate. */
  brief: string;
  /** Depth mode — 'standard' (default) or 'wide'. */
  depth?: ResearchDepth;
  /** Hard cost cap in USD. Defaults to DEPTH_CONFIG[depth].hardCapUsd. */
  maxCostUsd?: number;
  /** Optional logger for orchestrator-level progress. Defaults to console. */
  logger?: Logger;
  /**
   * Optional sink for report chunks. When provided, the assembled report is
   * chunked (exec summary + sections + quotes + source summaries) and handed to
   * the sink so the consumer can embed/index it however it wants. When omitted,
   * indexing is skipped entirely.
   */
  indexSink?: IndexSink;
  /**
   * Optional provider allowlist. When provided, only these providers (further
   * intersected with the configured set) participate in search/fetch — used
   * by research kinds (e.g. 'social' restricts to community providers).
   */
  providers?: ProviderName[];
  /** Optional source cache (search results + fetched markdown). */
  cache?: ResearchCacheAdapter;
  /**
   * Fired for every recorded cost entry (search, extract, rerank, synth,
   * critique, assembly) — wire to your attribution ledger. Errors swallowed.
   */
  onUsage?: OnPipelineUsage;
  /**
   * Free-first tier threshold: paid general-search providers only fire for a
   * subquery when the free tier returned fewer unique results than this.
   * Default 5. Set 0 to always fan out to paid providers (legacy behavior).
   */
  minFreeResults?: number;
  /**
   * Override the planner's subquery breadth for THIS run (evals/fan-out
   * ablation — ROADMAP Phase 2 tests whether the 15–35 default band over-
   * spends). Omit to use the depth preset. Applies to the initial plan and
   * every re-plan.
   */
  subqueryBandOverride?: { min: number; max: number };
  /**
   * Synthesis/assembly model override (see resolveSynthesisModel for the
   * accepted prefixes). The stage APIs accepted this since Phase 1 Experiment 1
   * but the top-level entrypoints never forwarded it — synthesis was
   * effectively hardcoded to claude-sonnet-4-6, which is ~90% of a quick-run's
   * cost. The 'quick' kind now defaults this via resolveResearchSynthesisModel('quick').
   */
  synthesisModelOverride?: string;
  /**
   * Deterministic searches that run in addition to LLM-planned subqueries.
   * Source-mode/profile executors use these to guarantee required lanes.
   */
  seedSubqueries?: Subquery[];
  /** Search controls applied to every provider unless overridden below. */
  searchOptions?: Omit<SearchOpts, 'limit'>;
  /** Provider-specific controls layered over searchOptions. */
  providerSearchOptions?: Partial<Record<ProviderName, Omit<SearchOpts, 'limit'>>>;
}

export interface RunDeepResearchResult {
  report: FinalReport;
  quotes: VerbatimQuote[];
  costUsd: number;
  /** Deduplicated discoveries, with source-mode/source-pack lineage. */
  discoveries: SearchResult[];
  /**
   * Exact fetched evidence that survived extraction validation. Coverage
   * gates consume these excerpts rather than unverified search snippets.
   */
  validatedEvidence: ValidatedEvidenceExcerpt[];
  /**
   * Faithfulness verdict for the assembled report (audit F2: this was
   * computed and then discarded — callers could never see, gate on, or
   * surface it). Diagnostic: the pipeline never aborts on a low ratio; the
   * CALLER decides whether to flag, retry, or reject.
   */
  grounding: GroundingResult;
  /** Stage counts: how many sources and items survived each step. */
  evidenceFunnel: EvidenceFunnel;
  /**
   * Did the report answer the brief (asked facts found, primary source
   * cited)? Same object as `report.answer_quality`. Always set by
   * runDeepResearch; optional so hosts that construct this result (injected
   * runners, test doubles) keep compiling.
   */
  answerQuality?: AnswerQuality;
}

export interface ValidatedEvidenceExcerpt {
  source_url: string;
  content: string;
  kind: 'verbatim_quote' | 'key_claim';
}

/**
 * Run the full deep-research pipeline for a single brief.
 *
 * Sequence (mirrors deep-research-prompt-runner.ts, minus Inngest + Cortex):
 *   plan subqueries → route providers → search → dedup → fetch content →
 *   extract quotes → synthesize sections (with rerank) →
 *   critique/refine loop → assemble report → validate grounding →
 *   [optional index] → return.
 */
export async function runDeepResearch(
  input: RunDeepResearchInput,
): Promise<RunDeepResearchResult> {
  const log: Logger = safeLogger(input.logger);
  const depth: ResearchDepth = input.depth !== undefined ? input.depth : 'standard';
  const depthConfig = DEPTH_CONFIG[depth];
  const capUsd: number = input.maxCostUsd !== undefined ? input.maxCostUsd : depthConfig.hardCapUsd;
  const costTracker: CostTracker = new NotifyingCostTracker(capUsd, input.onUsage, log);
  const minFreeResults = input.minFreeResults !== undefined ? input.minFreeResults : DEFAULT_MIN_FREE_RESULTS;

  const targetWordCount = {
    min: depthConfig.targetWordCountMin,
    max: depthConfig.targetWordCountMax,
  };

  const subqueriesMin = input.subqueryBandOverride !== undefined
    ? input.subqueryBandOverride.min
    : depthConfig.subqueriesMin;
  const subqueriesMax = input.subqueryBandOverride !== undefined
    ? input.subqueryBandOverride.max
    : depthConfig.subqueriesMax;

  log.info(
    {
      depth,
      subqueriesMin,
      subqueriesMax,
      urlsPerSubquery: depthConfig.urlsPerSubquery,
      critiqueMaxPasses: depthConfig.critiqueMaxPasses,
      capUsd,
    },
    '[runDeepResearch] Pipeline configured',
  );

  const providerRegistry = createProviderRegistry(input.credentials);
  let enabledProviders = getEnabledProviders(input.credentials);
  if (input.providers !== undefined && input.providers.length > 0) {
    const allowlist = new Set<string>(input.providers);
    // crawl4ai is the shared fetch backbone — always keep it available.
    allowlist.add('crawl4ai');
    const filtered: typeof enabledProviders = {};
    for (const [name, provider] of Object.entries(enabledProviders)) {
      if (allowlist.has(name)) {
        filtered[name as ProviderName] = provider;
      }
    }
    enabledProviders = filtered;
  } else {
    // Cost discipline: perplexity never participates in pipeline runs
    // implicitly (its per-call cost dwarfs the free/cheap tiers). It is
    // opt-in only — kind='managed' (runManagedResearch) or an explicit
    // input.providers list that names it.
    if (enabledProviders['perplexity'] !== undefined) {
      const { perplexity: _excluded, ...withoutPerplexity } = enabledProviders;
      enabledProviders = withoutPerplexity;
    }
  }
  // Keep fetch-capable providers (notably Crawl4AI) available for acquisition,
  // but expose only real search providers to the planner and search fan-out.
  const globallySearchable = getEnabledSearchProviders(input.credentials);
  const searchProviders: typeof enabledProviders = {};
  for (const [name, provider] of Object.entries(enabledProviders)) {
    if (globallySearchable[name as ProviderName] !== undefined) {
      searchProviders[name as ProviderName] = provider;
    }
  }
  const availableProviderNames = Object.keys(searchProviders);

  if (availableProviderNames.length === 0) {
    throw new Error('No enabled search-capable providers are available for this run.');
  }

  // Planner spend → CostTracker 'plan' category (audit F8: previously never
  // recorded, so the hard cap under-counted by every plan + re-plan call).
  const plannerUsageSink = (usage: PlannerUsage): void => {
    // Rates for the model that ran; provider is the one that served it.
    const pricing = getModelPricing(usage.model);
    costTracker.record({
      provider: usage.provider,
      category: 'plan',
      units: usage.inputTokens,
      unit_cost_usd: pricing.inputUsdPerM / 1_000_000,
      metadata: { model: usage.model, operation: 'plan-input' },
    });
    costTracker.record({
      provider: usage.provider,
      category: 'plan',
      units: usage.outputTokens,
      unit_cost_usd: pricing.outputUsdPerM / 1_000_000,
      metadata: { model: usage.model, operation: 'plan-output' },
    });
  };

  // ---------------------------------------------------------------------------
  // Step 1: plan subqueries (restricted to providers enabled for this run)
  //
  // Decision briefs plan per question. A multi-question brief planned as one
  // blob gives the planner no per-question budget — measured 2026-08-15, an
  // 8-question brief planned at standard depth yielded subqueries for the
  // first few questions only, and every later section assembled as an
  // evidence gap. Each question gets its own share of the band and its
  // section paths are namespaced q{n}.* so extract-budget allocation and
  // report headings align with the caller's questions.
  // ---------------------------------------------------------------------------
  // Answer-quality usage → CostTracker: brief analysis bills as 'plan', the
  // relevance judge as 'critique' (both are cheap extract-tier calls).
  const answerUsageSink = (usage: AnswerQualityModelUsage): void => {
    const pricing = getModelPricing(usage.model);
    const category = usage.stage === 'brief-analysis' ? 'plan' : 'critique';
    costTracker.record({
      provider: usage.provider,
      category,
      units: usage.inputTokens,
      unit_cost_usd: pricing.inputUsdPerM / 1_000_000,
      metadata: { model: usage.model, operation: `${usage.stage}-input` },
    });
    costTracker.record({
      provider: usage.provider,
      category,
      units: usage.outputTokens,
      unit_cost_usd: pricing.outputUsdPerM / 1_000_000,
      metadata: { model: usage.model, operation: `${usage.stage}-output` },
    });
  };

  // What must the answer contain? Runs beside planning. A failure is
  // recorded on the answer-quality verdict (status not_assessed), never
  // replaced by a guess.
  let analysisError: string | undefined;
  const requirementsPromise: Promise<BriefRequirements | null> = analyzeBriefRequirements({
    credentials: input.credentials,
    brief: input.brief,
    usageSink: answerUsageSink,
  }).catch((error: unknown) => {
    analysisError = errMsg(error).slice(0, 240);
    log.warn({ error: analysisError }, '[runDeepResearch] Brief analysis failed; answer check not assessed');
    return null;
  });

  const decisionSplit = splitDecisionBriefQuestions(input.brief);
  let plannedSubqueries: Subquery[];
  let sectionTitles: Record<string, string> | undefined;
  if (decisionSplit === null) {
    plannedSubqueries = await planSubqueries({
      credentials: input.credentials,
      promptMd: input.brief,
      targetWordCount,
      subqueriesMin,
      subqueriesMax,
      availableProviders: availableProviderNames,
      usageSink: plannerUsageSink,
    });
  } else {
    const questionCount = decisionSplit.questions.length;
    const perQuestionMin = Math.max(2, Math.floor(subqueriesMin / questionCount));
    const perQuestionMax = Math.max(3, Math.ceil(subqueriesMax / questionCount));
    const titles: Record<string, string> = {};
    decisionSplit.questions.forEach((question, index) => {
      titles[`q${index + 1}`] = question;
    });
    sectionTitles = titles;
    log.info(
      { questionCount, perQuestionMin, perQuestionMax },
      '[runDeepResearch] Decision brief detected — planning per question',
    );
    const perQuestionPlans = await mapWithConcurrency(
      decisionSplit.questions,
      2,
      async (question, index) => {
        const questionNumber = index + 1;
        try {
          const planned = await planSubqueries({
            credentials: input.credentials,
            promptMd: `${decisionSplit.sharedContext}\n\nResearch question:\n${question}`,
            targetWordCount,
            subqueriesMin: perQuestionMin,
            subqueriesMax: perQuestionMax,
            availableProviders: availableProviderNames,
            usageSink: plannerUsageSink,
          });
          return planned.map((subquery) => ({
            ...subquery,
            section_path: `q${questionNumber}.${subquery.section_path}`,
          }));
        } catch (error) {
          // One question's plan failing must not kill the other questions'
          // research; the run only aborts when EVERY plan came back empty.
          log.warn(
            {
              questionNumber,
              error: error instanceof Error ? error.message : String(error),
            },
            '[runDeepResearch] Per-question plan failed — continuing without it',
          );
          return [];
        }
      },
    );
    plannedSubqueries = perQuestionPlans.flat();
  }

  const seededSubqueries = (input.seedSubqueries ?? []).map((subquery) => SubquerySchema.parse(subquery));
  const requirements = await requirementsPromise;
  const primarySubqueries = primarySourceSubqueries(requirements, searchProviders);
  let subqueries: Subquery[] = [...primarySubqueries, ...seededSubqueries, ...plannedSubqueries];
  if (requirements !== null) {
    log.info(
      {
        questions: requirements.questions.length,
        facets: requirements.questions.reduce((n, q) => n + q.facets.length, 0),
        primarySources: requirements.primary_sources.map((source) => source.domain),
        primarySubqueries: primarySubqueries.length,
      },
      '[runDeepResearch] Brief requirements analyzed',
    );
  }
  const briefQuestions = requirements === null ? undefined : requirements.questions.map((q) => q.question);
  const focusTerms = questionTerms(requirements, input.brief);
  const fetchQuality: FetchQualityCounts = { pagesRejected: 0, evidenceRejected: 0 };

  if (subqueries.length === 0) {
    throw new Error('Planner returned zero subqueries — cannot proceed');
  }

  // ---------------------------------------------------------------------------
  // Step 2: search (route providers per subquery, run in parallel, dedup)
  // ---------------------------------------------------------------------------
  const allSearchResults = await runSearch(
    providerRegistry,
    subqueries, searchProviders, costTracker, log, input.cache, minFreeResults,
    input.searchOptions, input.providerSearchOptions,
  );
  // Canonical primary-source pages (named in the brief, or the official page
  // the analysis named on the official domain) are fetched directly, ahead of
  // anything search ranked, so "cite the official changelog" reads it.
  allSearchResults.unshift(...primarySourceDirectResults(requirements, allSearchResults));
  allSearchResults.sort((a, b) => primaryRank(a, requirements) - primaryRank(b, requirements));
  const allDiscoveries: SearchResult[] = [...allSearchResults];

  // Provenance map for the bibliography (audit m3) — accumulated across the
  // initial search and every critique-loop refinement search.
  const sourceMetaByUrl: Record<string, {
    provider?: string; title?: string; author?: string; published_at?: string; scraped_at?: string;
  }> = {};
  // When this run obtained each page's content (a cache hit counts as the
  // moment the run read it). Carried to the bibliography so a stored report
  // says when its evidence was scraped, not only when the report was written.
  const stampScraped = (markdownByUrlNow: Record<string, string>): void => {
    const at = new Date().toISOString();
    for (const url of Object.keys(markdownByUrlNow)) {
      const meta = sourceMetaByUrl[url];
      if (meta !== undefined && meta.scraped_at === undefined) meta.scraped_at = at;
      else if (meta === undefined) sourceMetaByUrl[url] = { scraped_at: at };
    }
  };
  const recordSourceMeta = (results: SearchResult[]): void => {
    for (const r of results) {
      if (sourceMetaByUrl[r.url] === undefined) {
        sourceMetaByUrl[r.url] = {
          provider: r.provider,
          title: r.title,
          author: r.author,
          published_at: r.published_at,
        };
      }
    }
  };
  recordSourceMeta(allSearchResults);

  // Depth-aware fetch cap with global ceiling.
  const urlsToFetch = selectUrlsToFetch(
    subqueries,
    allSearchResults,
    depthConfig.urlsPerSubquery,
    CUMULATIVE_URL_CEILING,
  );

  // ---------------------------------------------------------------------------
  // Step 3: fetch content
  // ---------------------------------------------------------------------------
  const markdownByUrl = await fetchContent(input.credentials, urlsToFetch, enabledProviders, log, input.cache, fetchQuality);
  stampScraped(markdownByUrl);

  // ---------------------------------------------------------------------------
  // Step 4: extract quotes → per-section maps
  // ---------------------------------------------------------------------------
  // Run-level budget (main + critique). Prevents one brief from minting
  // thousands of Gemini extract calls (Aug 2026 GCP incident class).
  //
  // Part of the budget is held back for the refinement pass. Without it the
  // main pass spent every page (20 of 20, measured 2026-09-24) and the
  // critique's refinement subqueries could search but never extract.
  //
  // maxExtractPages is a ceiling. How many pages a run reads is decided by
  // evidence: extraction runs in waves and stops feeding a section once it
  // reaches the depth's evidence target (see extractQuotes).
  const refinementReserve = refinementExtractReserve(depthConfig);
  const extractBudget: ExtractBudget = {
    remaining: depthConfig.maxExtractPages - refinementReserve,
    concurrency: depthConfig.extractConcurrency,
    spendCeilingUsd: capUsd * EXTRACT_SPEND_SHARE,
    hardCapUsd: capUsd,
    target: { units: depthConfig.evidenceTargetUnits, sources: depthConfig.evidenceTargetSources },
    firstWavePagesPerSection: depthConfig.firstWavePagesPerSection,
    doneUrls: new Set<string>(),
    funnel: { ...emptyEvidenceFunnel(), pageBudget: depthConfig.maxExtractPages },
  };
  let refinementReserveReleased = refinementReserve === 0;

  const extraction = await extractQuotes(
    input.credentials,
    subqueries,
    allSearchResults,
    markdownByUrl,
    enabledProviders,
    depthConfig.urlsPerSubquery,
    costTracker,
    log,
    extractBudget,
    input.cache,
    { terms: focusTerms, questions: briefQuestions, fetchQuality, requirements, prior: null },
  );

  let { quotesBySection } = extraction;
  const { claimsBySection, sourceQuotesByUrl, providerCoverageBySection } = extraction;

  // ---------------------------------------------------------------------------
  // Step 5: section synthesis (rerank per section, then synthesize)
  // ---------------------------------------------------------------------------
  // Relevance gate: every evidence unit is judged against the brief's
  // questions once; off-topic units never reach synthesis. Judgments persist
  // across critique passes so only new evidence is judged again.
  const judgments = new Map<string, EvidenceJudgment>();
  const gate: GateCounts = {
    status: requirements === null ? 'not_run' : 'applied',
    judged: 0,
    kept: 0,
    dropped: 0,
    unjudged: 0,
  };
  const gateEvidence = async (): Promise<GatedEvidence> => {
    const gated = await applyRelevanceGate({
      credentials: input.credentials,
      requirements,
      quotesBySection,
      claimsBySection,
      judgments,
      gate,
      usageSink: answerUsageSink,
      log,
    });
    return gated;
  };
  let gated = await gateEvidence();
  let sections = await synthesizeSections(
    input.credentials,
    subqueries,
    gated.quotesBySection,
    gated.claimsBySection,
    targetWordCount,
    costTracker,
    log,
    input.synthesisModelOverride,
    sectionTitles,
    briefQuestions,
  );

  // ---------------------------------------------------------------------------
  // Step 6: critique / refinement loop
  // ---------------------------------------------------------------------------
  const finalGaps: string[] = [];
  let critiquePass = 0;
  while (critiquePass < depthConfig.critiqueMaxPasses) {
    const critique = await critiqueDraft({
      credentials: input.credentials,
      promptMd: input.brief,
      sections,
      targetWordCount,
      providerCoverageBySection,
    });

    // Critique cost — real model + catalog rates (same path as synth).
    // Prior: hard-coded provider 'anthropic' + Sonnet rate with no model in
    // metadata. Critique has used resolveResearchCritiqueModel() (Gemini cheap
    // tier by default) since the model-policy rewrite, so the ledger stored
    // synthetic model `anthropic:deep-research` and landed priced_by=unpriced
    // (78 rows / 7d measured 2026-08-04). Stamp the real model so ingest can
    // catalog-price tokens; flat 2000-token estimate kept until critiqueDraft
    // returns usage (token accounting is a separate step).
    const critiqueModel = resolveResearchCritiqueModel();
    const critiquePricing = getModelPricing(critiqueModel);
    costTracker.record({
      provider: critiquePricing.provider,
      category: 'critique',
      units: 2000,
      unit_cost_usd: critiquePricing.inputUsdPerM / 1_000_000,
      metadata: {
        pass: critiquePass,
        gaps: critique.gaps.length,
        model: critiqueModel,
        operation: 'critique-input-estimated',
      },
    });

    finalGaps.length = 0;
    for (const g of critique.gaps) {
      finalGaps.push(`${g.section_path}: ${g.description}`);
    }

    // Quality-bar exit.
    if (critique.gaps.length < 2 && critique.meets_target) {
      break;
    }
    // Last-pass exit.
    if (critiquePass >= depthConfig.critiqueMaxPasses - 1) {
      break;
    }
    // Cost-cap exit.
    if (costTracker.exceedsCap()) {
      log.warn(
        { cost: costTracker.total(), cap: capUsd },
        '[runDeepResearch] Cost cap hit, stopping critique loop',
      );
      break;
    }

    const refinementHint = serializeCritiqueHint(critique);
    const additionalSubqueries = await planSubqueries({
    credentials: input.credentials,
      promptMd: input.brief,
      targetWordCount,
      refinementHint,
      subqueriesMin,
      subqueriesMax,
      availableProviders: availableProviderNames,
      usageSink: plannerUsageSink,
    });

    if (additionalSubqueries.length === 0) {
      break;
    }

    subqueries = [...subqueries, ...additionalSubqueries];

    // Extra search for the refinement subqueries only.
    const extraResults = await runSearch(
    providerRegistry,
      additionalSubqueries, searchProviders, costTracker, log, input.cache, minFreeResults,
      input.searchOptions, input.providerSearchOptions,
    );
    mergeDiscoveryResults(allDiscoveries, extraResults);
    recordSourceMeta(extraResults);
    const extraToFetch = extraResults.slice(0, Math.min(extraResults.length, CUMULATIVE_URL_CEILING));
    const extraMarkdown = await fetchContent(input.credentials, extraToFetch, enabledProviders, log, input.cache, fetchQuality);
    stampScraped(extraMarkdown);

    if (!refinementReserveReleased) {
      extractBudget.remaining += refinementReserve;
      refinementReserveReleased = true;
    }

    const extraExtraction = await extractQuotes(
      input.credentials,
      additionalSubqueries,
      extraResults,
      extraMarkdown,
      enabledProviders,
      depthConfig.urlsPerSubquery,
      costTracker,
      log,
      extractBudget,
      input.cache,
      {
        terms: focusTerms,
        questions: briefQuestions,
        fetchQuality,
        requirements,
        prior: { quotesBySection, claimsBySection },
      },
    );

    // Merge new evidence into the running maps.
    for (const [path, quotes] of Object.entries(extraExtraction.quotesBySection)) {
      if (quotesBySection[path] === undefined) {
        quotesBySection[path] = [];
      }
      for (const q of quotes) {
        quotesBySection[path].push(q);
      }
    }
    for (const [path, claims] of Object.entries(extraExtraction.claimsBySection)) {
      if (claimsBySection[path] === undefined) {
        claimsBySection[path] = [];
      }
      for (const c of claims) {
        claimsBySection[path].push(c);
      }
    }
    for (const [url, quotes] of Object.entries(extraExtraction.sourceQuotesByUrl)) {
      sourceQuotesByUrl[url] = quotes;
    }
    for (const [path, providers] of Object.entries(extraExtraction.providerCoverageBySection)) {
      if (providerCoverageBySection[path] === undefined) {
        providerCoverageBySection[path] = [];
      }
      for (const p of providers) {
        if (!providerCoverageBySection[path].includes(p)) {
          providerCoverageBySection[path].push(p);
        }
      }
    }

    // Re-synthesize with the enriched evidence.
    gated = await gateEvidence();
    sections = await synthesizeSections(
    input.credentials,
      subqueries,
      gated.quotesBySection,
      gated.claimsBySection,
      targetWordCount,
      costTracker,
      log,
      input.synthesisModelOverride,
      sectionTitles,
      briefQuestions,
    );

    critiquePass++;
  }

  // ---------------------------------------------------------------------------
  // Step 7: assemble final report
  // ---------------------------------------------------------------------------
  const facetAnswers = requirements === null
    ? []
    : selectFacetAnswers({ requirements, units: gated.units, judgments });
  const assembly = await assembleFinalReport({
    promptMd: input.brief,
    sections,
    gaps: finalGaps,
    sourceMeta: sourceMetaByUrl,
    synthesisModelOverride: input.synthesisModelOverride,
    sectionTitles,
    answerCheck: {
      requirements,
      ...(analysisError !== undefined ? { analysisError } : {}),
      answers: facetAnswers,
      gate,
      fetchQuality,
    },
  });
  recordSynthCost(costTracker, assembly.model, assembly.inputTokens, assembly.cachedReadTokens, assembly.outputTokens, 'assembly');
  const report = assembly.report;

  // ---------------------------------------------------------------------------
  // Step 8: validate grounding (diagnostic; never aborts)
  // ---------------------------------------------------------------------------
  const groundingChunks = buildGroundingEvidenceChunks({
    sourceQuotesByUrl,
    claimsBySection,
  });
  const grounding = validateGrounding({
    fullMarkdown: report.full_markdown,
    bibliography: report.bibliography,
    chunks: groundingChunks,
  });
  const validatedEvidence: ValidatedEvidenceExcerpt[] = groundingChunks.flatMap((chunk) => {
    if (chunk.source_url === null) return [];
    return [{
      source_url: chunk.source_url,
      content: chunk.content,
      kind: chunk.metadata['grounding_basis'] === 'verbatim_quote'
        ? 'verbatim_quote' as const
        : 'key_claim' as const,
    }];
  });
  log.info(
    { ratio: grounding.ratio, valid: grounding.valid_citations, total: grounding.total_citations },
    '[runDeepResearch] Grounding validation complete',
  );

  if (!grounding.passed) {
    const groundingWarning = grounding.status === 'ungrounded'
      ? 'This report contains no citation markers and must not be treated as source-verified.'
      : `Automated evidence validation matched ${grounding.valid_citations} of ` +
        `${grounding.total_citations} cited sources (${Math.round(grounding.ratio * 100)}%). ` +
        'Treat the report as unverified until its claims are checked against primary sources.';
    const warningBlock = `> **Evidence warning:** ${groundingWarning}`;
    report.full_markdown = `${warningBlock}\n\n${report.full_markdown}`;
    report.gaps = [...report.gaps, groundingWarning];
    report.word_count = report.full_markdown.trim().split(/\s+/).length;
    log.warn(
      {
        quality: grounding.quality,
        ratio: grounding.ratio,
        valid: grounding.valid_citations,
        total: grounding.total_citations,
      },
      '[runDeepResearch] Report marked with evidence warning',
    );
  }

  // ---------------------------------------------------------------------------
  // Step 9: optional indexing
  // ---------------------------------------------------------------------------
  if (input.indexSink !== undefined) {
    const sourceQuotesMap = new Map<string, VerbatimQuote[]>();
    for (const [url, quotes] of Object.entries(sourceQuotesByUrl)) {
      sourceQuotesMap.set(url, quotes);
    }
    const chunks = buildReportChunks({ report, sourceQuotesByUrl: sourceQuotesMap });
    await input.indexSink(chunks);
    log.info({ chunks: chunks.length }, '[runDeepResearch] Report chunks handed to indexSink');
  }

  // ---------------------------------------------------------------------------
  // Collect grounded quotes (full verbatim evidence pool) + return.
  // ---------------------------------------------------------------------------
  const allQuotes: VerbatimQuote[] = [];
  for (const quotes of Object.values(sourceQuotesByUrl)) {
    for (const q of quotes) {
      allQuotes.push(q);
    }
  }

  const plannedSections = new Set(subqueries.map((subquery) => subquery.section_path));
  extractBudget.funnel.sectionsBelowTarget = [...plannedSections].filter((section) =>
    sectionNeedsEvidence(sectionEvidence(section, quotesBySection, claimsBySection, null), extractBudget.target),
  ).length;

  return {
    report,
    quotes: allQuotes,
    costUsd: costTracker.total(),
    discoveries: allDiscoveries,
    validatedEvidence,
    grounding,
    evidenceFunnel: extractBudget.funnel,
    answerQuality: report.answer_quality ?? notAssessedAnswerQuality(gate, fetchQuality),
  };
}

// =============================================================================
// Internal stage helpers
// =============================================================================

type EnabledProviders = ReturnType<typeof getEnabledProviders>;

/**
 * Required/seeded searches are a locked source contract. Planner routing may
 * broaden an ordinary generated subquery, but it must never inject a web
 * provider into a source pack that explicitly requires HN/RSS/podcasts (or
 * any other specialist lane).
 */
export function providersForSubquery(
  registry: ProviderRegistry,
  subquery: Subquery,
): ProviderName[] {
  const providerNames = new Set<ProviderName>(subquery.providers);
  if (!subquery.required && subquery.source_pack_id === undefined) {
    for (const providerName of routeProvidersForSourceTypes(registry, subquery.expected_source_types)) {
      providerNames.add(providerName);
    }
  }
  return Array.from(providerNames);
}

/**
 * Search one provider for one subquery — cache-aware, cost-recorded (audit
 * M2: only LIVE calls record cost; cache hits are free), never throws.
 */
async function searchOneProvider(
  providerName: ProviderName,
  provider: SearchProvider,
  subquery: Subquery,
  costTracker: CostTracker,
  log: Logger,
  cache?: ResearchCacheAdapter,
  runSearchOptions?: Omit<SearchOpts, 'limit'>,
  providerSearchOptions?: Partial<Record<ProviderName, Omit<SearchOpts, 'limit'>>>,
): Promise<SearchResult[]> {
  const effectiveOptions: SearchOpts = {
    ...runSearchOptions,
    ...providerSearchOptions?.[providerName],
    ...subquery.search_options,
    expected_source_types: subquery.expected_source_types,
    limit: subquery.search_options.limit ?? SEARCH_RESULT_LIMIT,
  };
  const cacheIdentity = JSON.stringify({
    provider: providerName,
    policy: searchCachePolicyIdentity(providerName),
    query: subquery.query,
    sourcePackId: subquery.source_pack_id ?? null,
    sourceMode: subquery.source_mode ?? null,
    options: {
      limit: effectiveOptions.limit,
      recency_days: effectiveOptions.recency_days ?? null,
      published_before: effectiveOptions.published_before ?? null,
      sort: effectiveOptions.sort ?? null,
      include_domains: effectiveOptions.include_domains ?? [],
      exclude_domains: effectiveOptions.exclude_domains ?? [],
      feed_urls: effectiveOptions.feed_urls ?? [],
      communities: effectiveOptions.communities ?? [],
      handles: effectiveOptions.handles ?? [],
      channel_ids: effectiveOptions.channel_ids ?? [],
      max_pages: effectiveOptions.max_pages ?? null,
      expected_source_types: effectiveOptions.expected_source_types ?? [],
    },
  });
  const cacheKey = `search:${providerName}:${hashUrl(cacheIdentity)}`;
  const cached = await cacheGet(cache, cacheKey, log);
  if (cached !== null) {
    const parsed = parseCachedSearchResults(providerName, cached);
    if (parsed !== null) return parsed;
  }
  try {
    const providerResults = await provider.search(subquery.query, effectiveOptions);
    const results = filterSearchResults(providerResults, effectiveOptions);
    const perCall = searchCostPerCallUsd(providerName);
    if (perCall !== undefined && perCall > 0) {
      costTracker.record({
        provider: providerName,
        category: 'search',
        units: 1,
        unit_cost_usd: perCall,
        metadata: {
          results: results.length,
          source_mode: subquery.source_mode,
          sort: effectiveOptions.sort,
          recency_days: effectiveOptions.recency_days,
        },
      });
    }
    await cacheSet(
      cache,
      cacheKey,
      JSON.stringify(results),
      searchCacheTtl(providerName, effectiveOptions),
      log,
    );
    return results;
  } catch (err: unknown) {
    log.warn(
      {
        providerName,
        query: subquery.query.slice(0, 60),
        error: errMsg(err).slice(0, 120),
      },
      '[runDeepResearch] Search failed (non-fatal)',
    );
    return [];
  }
}

function filterSearchResults(results: SearchResult[], opts: SearchOpts): SearchResult[] {
  const upper = opts.published_before !== undefined
    ? new Date(opts.published_before).getTime()
    : Date.now();
  const lower = opts.recency_days !== undefined && !Number.isNaN(upper)
    ? upper - opts.recency_days * 86_400_000
    : null;
  const includeDomains = new Set((opts.include_domains ?? []).map((domain) => domain.toLowerCase().replace(/^www\./, '')));
  const excludeDomains = new Set((opts.exclude_domains ?? []).map((domain) => domain.toLowerCase().replace(/^www\./, '')));

  return results.filter((result) => {
    if (result.published_at !== undefined) {
      const timestamp = new Date(result.published_at).getTime();
      if (Number.isNaN(timestamp)) return false;
      if (!Number.isNaN(upper) && timestamp > upper) return false;
      if (lower !== null && timestamp < lower) return false;
    }
    let hostname = '';
    try {
      hostname = new URL(result.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return includeDomains.size === 0;
    }
    if (excludeDomains.has(hostname) || Array.from(excludeDomains).some((domain) => hostname.endsWith(`.${domain}`))) return false;
    if (includeDomains.size > 0 && !includeDomains.has(hostname) && !Array.from(includeDomains).some((domain) => hostname.endsWith(`.${domain}`))) return false;
    return true;
  });
}

/**
 * Route + run searches for a set of subqueries, deduped by canonical URL.
 * Free-first tiering (audit M5): free general-search + specialist providers
 * run first; paid general providers fire only when the first tier returned
 * fewer than `minFreeResults` unique results for the subquery.
 */
async function runSearch(
  registry: ProviderRegistry,
  subqueries: Subquery[],
  enabledProviders: EnabledProviders,
  costTracker: CostTracker,
  log: Logger,
  cache?: ResearchCacheAdapter,
  minFreeResults: number = DEFAULT_MIN_FREE_RESULTS,
  runSearchOptions?: Omit<SearchOpts, 'limit'>,
  providerSearchOptions?: Partial<Record<ProviderName, Omit<SearchOpts, 'limit'>>>,
): Promise<SearchResult[]> {
  // Bounded fan-out (audit F7): wide mode plans 50-80 subqueries; unbounded
  // Promise.all ran them all at once and 429-stormed providers and our own
  // scraper. Per-provider rate limiters bound the inner tier calls.
  const perSubqueryResults = await mapWithConcurrency(
    subqueries,
    4,
    async (subquery): Promise<SearchResult[]> => {
      const providerNames = providersForSubquery(registry, subquery);

      interface TierEntry {
        name: ProviderName;
        provider: SearchProvider;
      }
      const tier1: TierEntry[] = [];
      const tier2Paid: TierEntry[] = [];
      for (const providerName of providerNames) {
        const provider = enabledProviders[providerName];
        if (provider === undefined) continue;
        if (GENERAL_PAID_SEARCH.has(providerName) && minFreeResults > 0) {
          tier2Paid.push({ name: providerName, provider });
        } else {
          // Free general (searxng/serper) + all specialist providers the
          // planner routed deliberately.
          tier1.push({ name: providerName, provider });
        }
      }

      const subResults: SearchResult[] = [];
      const subSeen = new Set<string>();
      const collect = (resultSets: SearchResult[][]): void => {
        for (const resultSet of resultSets) {
          for (const result of resultSet) {
            const canonical = canonicalizeUrl(result.url);
            const hash = hashUrl(canonical);
            if (!subSeen.has(hash)) {
              subSeen.add(hash);
              // Provenance tag (audit F1): this result was retrieved FOR this
              // subquery's section. Cache entries come back untagged (tags are
              // per-run); tagging happens here, after retrieval.
              subResults.push({
                ...result,
                url: canonical,
                retrieved_for: [subquery.section_path],
                source_pack_ids: subquery.source_pack_id !== undefined ? [subquery.source_pack_id] : [],
                source_modes: subquery.source_mode !== undefined ? [subquery.source_mode] : [],
              });
            }
          }
        }
      };

      collect(await Promise.all(
        tier1.map((entry) =>
          searchOneProvider(
            entry.name, entry.provider, subquery, costTracker, log, cache,
            runSearchOptions, providerSearchOptions,
          ),
        ),
      ));

      // Paid tier only when free coverage is thin (or tiering disabled).
      if (tier2Paid.length > 0 && subResults.length < minFreeResults) {
        log.info(
          {
            query: subquery.query.slice(0, 60),
            freeResults: subResults.length,
            paid: tier2Paid.map((e) => e.name),
          },
          '[runDeepResearch] Free tier thin — falling through to paid providers',
        );
        collect(await Promise.all(
          tier2Paid.map((entry) =>
            searchOneProvider(
              entry.name, entry.provider, subquery, costTracker, log, cache,
              runSearchOptions, providerSearchOptions,
            ),
          ),
        ));
      }

      return subResults;
    },
  );

  // Cross-subquery dedup — MERGE provenance instead of dropping it (audit
  // F1): a URL retrieved by several subqueries is evidence for all of their
  // sections, and the previous blind dedup severed that link entirely.
  const mergedByHash = new Map<string, SearchResult>();
  for (const subResults of perSubqueryResults) {
    for (const result of subResults) {
      const hash = hashUrl(result.url);
      const existing = mergedByHash.get(hash);
      if (existing === undefined) {
        mergedByHash.set(hash, result);
      } else {
        for (const path of result.retrieved_for) {
          if (!existing.retrieved_for.includes(path)) {
            existing.retrieved_for.push(path);
          }
        }
        for (const packId of result.source_pack_ids) {
          if (!existing.source_pack_ids.includes(packId)) existing.source_pack_ids.push(packId);
        }
        for (const mode of result.source_modes) {
          if (!existing.source_modes.includes(mode)) existing.source_modes.push(mode);
        }
      }
    }
  }
  const merged = Array.from(mergedByHash.values());
  log.info({ total: merged.length }, '[runDeepResearch] Search phase complete');
  return merged;
}

function mergeDiscoveryResults(target: SearchResult[], additions: SearchResult[]): void {
  const byHash = new Map(target.map((result) => [hashUrl(result.url), result]));
  for (const addition of additions) {
    const key = hashUrl(addition.url);
    const existing = byHash.get(key);
    if (existing === undefined) {
      target.push(addition);
      byHash.set(key, addition);
      continue;
    }
    for (const path of addition.retrieved_for) {
      if (!existing.retrieved_for.includes(path)) existing.retrieved_for.push(path);
    }
    for (const packId of addition.source_pack_ids) {
      if (!existing.source_pack_ids.includes(packId)) existing.source_pack_ids.push(packId);
    }
    for (const mode of addition.source_modes) {
      if (!existing.source_modes.includes(mode)) existing.source_modes.push(mode);
    }
  }
}

/** Fetch markdown content for a set of results — provider.fetch, else crawl4ai. */
async function fetchContent(
  credentials: ResearchCredentials,
  results: SearchResult[],
  enabledProviders: EnabledProviders,
  log: Logger,
  cache: ResearchCacheAdapter | undefined,
  fetchQuality: FetchQualityCounts,
): Promise<Record<string, string>> {
  const markdownByUrl: Record<string, string> = {};
  const crawl4aiProvider = enabledProviders['crawl4ai'];
  // Error pages, bot walls and navigation shells are not content. They used
  // to reach extraction, where "A required part of this site couldn't load"
  // became a validated, cited executive-summary sentence (2026-10-12).
  const accept = (url: string, markdown: string): boolean => {
    const assessment = assessFetchedPage(markdown);
    if (assessment.usable) return true;
    fetchQuality.pagesRejected++;
    log.info(
      { url: url.slice(0, 80), reason: assessment.reason, proseChars: assessment.proseChars },
      '[runDeepResearch] Fetched page rejected as non-content',
    );
    return false;
  };

  // Bounded fan-out (audit F7): the previous unbounded Promise.all put every
  // fetch (≤400) in flight at once — a 429 storm against our own scraper.
  await mapWithConcurrency(
    results,
    8,
    async (result) => {
      const cacheKey = `fetch:${result.url}`;
      const cachedMarkdown = await cacheGet(cache, cacheKey, log);
      if (cachedMarkdown !== null && cachedMarkdown.length > 0) {
        if (accept(result.url, cachedMarkdown)) markdownByUrl[result.url] = cachedMarkdown;
        return;
      }

      // Search-time raw content (Tavily include_raw_content): the search API
      // already extracted the page server-side, which survives JS/paywalls/
      // bot-walls that break a headless re-crawl of the same URL. Use it and
      // skip the crawl.
      const searchRawContent = result.raw_metadata['raw_content'];
      if (typeof searchRawContent === 'string' && searchRawContent.length >= 800) {
        if (!accept(result.url, searchRawContent)) return;
        markdownByUrl[result.url] = searchRawContent;
        await cacheSet(cache, cacheKey, searchRawContent, FETCH_CACHE_TTL_SECONDS, log);
        return;
      }

      const provider = enabledProviders[result.provider];
      let markdown = '';
      try {
        if (provider !== undefined && provider.fetch !== undefined) {
          const fetchResult = await provider.fetch(result.url);
          markdown = fetchResult.markdown;
        } else if (crawl4aiProvider !== undefined && crawl4aiProvider.fetch !== undefined) {
          const fetchResult = await crawl4aiProvider.fetch(result.url);
          markdown = fetchResult.markdown;
        }
      } catch (err: unknown) {
        log.warn(
          { url: result.url.slice(0, 80), error: errMsg(err).slice(0, 120) },
          '[runDeepResearch] Fetch failed (non-fatal, skipping)',
        );
      }
      if (markdown.length > 0 && accept(result.url, markdown)) {
        markdownByUrl[result.url] = markdown;
        await cacheSet(cache, cacheKey, markdown, FETCH_CACHE_TTL_SECONDS, log);
      }
    },
  );

  log.info(
    { fetched: Object.keys(markdownByUrl).length, attempted: results.length },
    '[runDeepResearch] Fetch phase complete',
  );
  return markdownByUrl;
}

interface ExtractionMaps {
  quotesBySection: Record<string, VerbatimQuote[]>;
  claimsBySection: Record<string, { claim: string; source_url: string; provider: ProviderName }[]>;
  sourceQuotesByUrl: Record<string, VerbatimQuote[]>;
  providerCoverageBySection: Record<string, ProviderName[]>;
}

/** Extract verbatim quotes from fetched content and bucket them by section. */
async function extractQuotes(
  credentials: ResearchCredentials,
  subqueries: Subquery[],
  allSearchResults: SearchResult[],
  markdownByUrl: Record<string, string>,
  enabledProviders: EnabledProviders,
  urlsPerSubquery: number,
  costTracker: CostTracker,
  log: Logger,
  extractBudget: ExtractBudget,
  cache: ResearchCacheAdapter | undefined,
  focus: ExtractFocus,
): Promise<ExtractionMaps> {
  // Map each section to the URLs its OWN subqueries actually retrieved
  // (audit F1). The old mapping bucketed by provider identity over the global
  // deduped list — every same-provider section got identical URLs and later
  // sections inherited earlier sections' sources. It also overwrote the map
  // per subquery, so only a section's LAST subquery counted; URLs now merge
  // across all of a section's subqueries (per-subquery cap preserved).
  const sectionToUrls = new Map<string, string[]>();
  for (const subquery of subqueries) {
    const sectionUrls = resultsForSubquery(subquery, allSearchResults, urlsPerSubquery).map((result) => result.url);
    const existing = sectionToUrls.get(subquery.section_path);
    if (existing === undefined) {
      sectionToUrls.set(subquery.section_path, sectionUrls);
    } else {
      for (const url of sectionUrls) {
        if (!existing.includes(url)) {
          existing.push(url);
        }
      }
    }
  }

  const quotesBySection: Record<string, VerbatimQuote[]> = {};
  const claimsBySection: Record<string, { claim: string; source_url: string; provider: ProviderName }[]> = {};
  const sourceQuotesByUrl: Record<string, VerbatimQuote[]> = {};
  const providerCoverageBySection: Record<string, ProviderName[]> = {};

  const resultsFetched = allSearchResults.filter(
    (r) => markdownByUrl[r.url] !== undefined && markdownByUrl[r.url].length > 0,
  );
  // A page with no complete sentence cannot produce a quote the evidence
  // contract accepts. Drop it before it takes a slot in the extract budget.
  const resultsWithContent = resultsFetched.filter((r) => hasVerifiableSentence(markdownByUrl[r.url] ?? ''));
  extractBudget.funnel.sourcesWithoutVerifiableText += resultsFetched.length - resultsWithContent.length;

  // Dedup by URL, skip already-extracted, then hard-cap to remaining budget.
  // Primary-source pages go first so the budget never skips the official page.
  const seen = new Set<string>();
  const candidates: typeof resultsWithContent = [];
  const ordered = [...resultsWithContent].sort(
    (a, b) => primaryRank(a, focus.requirements) - primaryRank(b, focus.requirements),
  );
  for (const result of ordered) {
    if (seen.has(result.url) || extractBudget.doneUrls.has(result.url)) {
      continue;
    }
    seen.add(result.url);
    candidates.push(result);
  }

  // Adaptive, not a fixed share. The first wave gives each section
  // firstWavePagesPerSection pages; after every wave the run counts validated
  // evidence per section and only sections below target get more, thinnest
  // first, until targets, candidates, the page budget or the extraction
  // dollar ceiling run out. Measured 2026-10-26: a fixed budget fed 14 pages
  // to 20 sections and left 11 of them empty at $0.03 of a $2 cap.
  //
  // A page feeds every section it was retrieved for or that a subquery's top
  // results named. It is queued and credited under all of them, so a page one
  // section no longer needs is still read for another, and a refinement page
  // past the top results still counts for the section that searched for it.
  const sectionsOf = (result: (typeof candidates)[number]): string[] => {
    const sections = new Set<string>(result.retrieved_for);
    for (const [sectionPath, sectionUrls] of sectionToUrls.entries()) {
      if (sectionUrls.includes(result.url)) sections.add(sectionPath);
    }
    return [...sections];
  };
  extractBudget.funnel.sourcesWithContent += candidates.length;

  const evidenceNow = (): Map<string, SectionEvidence> => {
    const sections = new Set<string>();
    for (const result of candidates) for (const section of sectionsOf(result)) sections.add(section);
    const out = new Map<string, SectionEvidence>();
    for (const section of sections) {
      out.set(section, sectionEvidence(section, quotesBySection, claimsBySection, focus.prior));
    }
    return out;
  };

  const extractRates = extractionRates();
  const estimateExtractUsd = (result: (typeof candidates)[number]): number => {
    const markdown = markdownByUrl[result.url];
    const chars = markdown === undefined ? GEMINI_MAX_CONTENT_CHARS : Math.min(markdown.length, GEMINI_MAX_CONTENT_CHARS);
    const questionTokens = Math.ceil((focus.questions ?? []).join(' ').length / CHARS_PER_TOKEN);
    return ((Math.ceil(chars / CHARS_PER_TOKEN) + EXTRACT_PROMPT_TOKEN_ALLOWANCE + questionTokens) * extractRates.inputUsdPerM
      + EXTRACT_OUTPUT_TOKEN_ALLOWANCE * extractRates.outputUsdPerM) / 1_000_000;
  };
  const extractSpentUsd = (): number => {
    const spent = costTracker.byCategory()['extract'];
    return spent === undefined ? 0 : spent;
  };

  const extractOne = async (result: (typeof candidates)[number]): Promise<void> => {
    const markdown = markdownByUrl[result.url];
    const providerName = result.provider;
    const provider = enabledProviders[providerName];
    const extractResolution = researchStageResolution('extract');
    const modelId = extractResolution.apiModelId;
    // The extractor reads a question-focused window of a long page, and is
    // told the questions; the cache key carries both so a focused
    // extraction is never served for a different question.
    const window = focusContentWindow(markdown, focus.terms, GEMINI_MAX_CONTENT_CHARS);
    const focusQuestions = focus.questions ?? [];
    const cacheKey = extractCacheKey(
      result.url,
      focusQuestions.length > 0 ? `${window}\u0000${focusQuestions.join('\u0000')}` : markdown,
      modelId,
    );

    let extracted: ExtractedQuotes | null = null;
    let cacheHit = false;
    const cachedRaw = await cacheGet(cache, cacheKey, log);
    if (cachedRaw !== null) {
      try {
        const parsed = ExtractedQuotesSchema.safeParse(JSON.parse(cachedRaw));
        if (parsed.success) {
          extracted = parsed.data;
          cacheHit = true;
        }
      } catch {
        // corrupt cache entry — fall through to live extract
      }
    }

    if (extracted === null) {
      if (provider !== undefined && provider.extract !== undefined) {
        try {
          extracted = await provider.extract({
            provider: providerName,
            url: result.url,
            raw_content: markdown,
            markdown,
            title: '',
            engagement: {},
            raw_metadata: {},
            fetch_status: 'ok',
          });
        } catch (err: unknown) {
          log.warn(
            { url: result.url.slice(0, 80), error: errMsg(err).slice(0, 120) },
            '[runDeepResearch] Provider extract() failed, falling back to Gemini',
          );
          extracted = await extractQuotesWithGemini({
            credentials,
            provider: providerName,
            url: result.url,
            content: window,
            mode: 'longform',
            focusQuestions,
          });
        }
      } else {
        extracted = await extractQuotesWithGemini({
          credentials,
          provider: providerName,
          url: result.url,
          content: window,
          mode: extractionModeFor(providerName),
          focusQuestions,
        });
      }
      await cacheSet(cache, cacheKey, JSON.stringify(extracted), EXTRACT_CACHE_TTL_SECONDS, log);
    }

    // Extraction cost (audit M2) — real Gemini tokens when the extractor
    // reported them, else a conservative estimate from content length so
    // the cap still sees extraction spend from provider-native extractors.
    // Cache hits do not re-bill the LLM (record $0 with operation tag).
    if (cacheHit) {
      costTracker.record({
        provider: extractResolution.provider,
        category: 'extract',
        units: 0,
        unit_cost_usd: 0,
        metadata: { model: modelId, operation: 'extract-cache-hit' },
      });
    } else if (extracted.usage !== undefined) {
      const rates = extractionRates();
      costTracker.record({
        provider: extractResolution.provider,
        category: 'extract',
        units: extracted.usage.prompt_tokens,
        unit_cost_usd: rates.inputUsdPerM / 1_000_000,
        metadata: { model: modelId, operation: 'extract-input' },
      });
      costTracker.record({
        provider: extractResolution.provider,
        category: 'extract',
        units: extracted.usage.candidate_tokens,
        unit_cost_usd: rates.outputUsdPerM / 1_000_000,
        metadata: { model: modelId, operation: 'extract-output' },
      });
    } else {
      const rates = extractionRates();
      const estimatedInputTokens = Math.ceil(Math.min(markdown.length, GEMINI_MAX_CONTENT_CHARS) / CHARS_PER_TOKEN);
      costTracker.record({
        provider: extractResolution.provider,
        category: 'extract',
        units: estimatedInputTokens,
        unit_cost_usd: rates.inputUsdPerM / 1_000_000,
        metadata: { model: modelId, operation: 'extract-input-estimated' },
      });
    }

    // Provider-native extractors cross the same immutable evidence boundary
    // as Gemini. Nothing becomes synthesis or coverage evidence unless it is
    // one complete sentence/line from the fetched source. Quote URLs are
    // normalized back to the fetched source (or a same-source anchor) so an
    // extractor cannot redirect provenance to an unrelated page.
    const supportedQuotes = extracted.verbatim_quotes
      .filter((quote) => isVerbatimQuoteSupportedBySource(quote.quote, markdown));
    const supportedClaims = extracted.key_claims.filter((claim) =>
      isKeyClaimSupportedBySource(claim, markdown));
    // A sentence can be verbatim and still be site chrome or an error
    // banner. Those are dropped here, before they can be cited.
    const quotes = supportedQuotes
      .filter((quote) => !isBoilerplateEvidence(quote.quote))
      .map((quote) => ({
        ...quote,
        source_url: resolveSameSourceCitationUrl(result.url, quote.source_url),
      }));
    const claims = supportedClaims.filter((claim) => !isBoilerplateEvidence(claim));
    focus.fetchQuality.evidenceRejected +=
      (supportedQuotes.length - quotes.length) + (supportedClaims.length - claims.length);
    const droppedEvidence =
      (extracted.verbatim_quotes.length - quotes.length) +
      (extracted.key_claims.length - claims.length);
    const funnel = extractBudget.funnel;
    funnel.quotesExtracted += extracted.verbatim_quotes.length;
    funnel.quotesValidated += quotes.length;
    funnel.claimsExtracted += extracted.key_claims.length;
    funnel.claimsValidated += claims.length;
    if (quotes.length === 0 && claims.length === 0) funnel.sourcesWithNoValidatedEvidence += 1;
    if (droppedEvidence > 0) {
      log.warn(
        { url: result.url.slice(0, 80), droppedEvidence },
        '[runDeepResearch] Dropped source-unsupported extracted evidence',
      );
    }
    sourceQuotesByUrl[result.url] = quotes;

    for (const sectionPath of sectionsOf(result)) {
      if (quotesBySection[sectionPath] === undefined) {
        quotesBySection[sectionPath] = [];
      }
      for (const q of quotes) {
        quotesBySection[sectionPath].push(q);
      }
      if (claimsBySection[sectionPath] === undefined) {
        claimsBySection[sectionPath] = [];
      }
      for (const claim of claims) {
        claimsBySection[sectionPath].push({
          claim,
          source_url: result.url,
          provider: providerName,
        });
      }
      if (providerCoverageBySection[sectionPath] === undefined) {
        providerCoverageBySection[sectionPath] = [];
      }
      if (!providerCoverageBySection[sectionPath].includes(providerName)) {
        providerCoverageBySection[sectionPath].push(providerName);
      }
    }
  };

  // Bounded fan-out (audit F7): one model call per source, never unbounded.
  const outcome = await runAdaptiveExtraction({
    candidates,
    keyOf: (result) => result.url,
    sectionsOf,
    evidence: evidenceNow,
    target: extractBudget.target,
    firstWavePagesPerSection: extractBudget.firstWavePagesPerSection,
    concurrency: extractBudget.concurrency,
    pageBudget: Math.max(0, extractBudget.remaining),
    extractSpentUsd,
    extractCeilingUsd: extractBudget.spendCeilingUsd,
    estimateUsd: estimateExtractUsd,
    hardCapReached: (reservedUsd) => costTracker.total() + reservedUsd > extractBudget.hardCapUsd,
    extract: async (result) => {
      extractBudget.doneUrls.add(result.url);
      await extractOne(result);
    },
  });
  extractBudget.remaining -= outcome.extracted;
  const funnel = extractBudget.funnel;
  funnel.sourcesExtracted += outcome.extracted;
  funnel.extractWaves += outcome.waves;
  funnel.sourcesNotNeeded += outcome.notNeeded;
  funnel.sourcesSkippedForBudget += outcome.skippedForBudget;
  funnel.sourcesSkippedForCost += outcome.skippedForCost;
  log.info(
    { candidates: candidates.length, ...outcome, remainingBudget: extractBudget.remaining },
    '[runDeepResearch] Adaptive extraction finished',
  );

  log.info(
    { sections: Object.keys(quotesBySection).length, sources: Object.keys(sourceQuotesByUrl).length },
    '[runDeepResearch] Quote extraction complete',
  );
  return { quotesBySection, claimsBySection, sourceQuotesByUrl, providerCoverageBySection };
}

/** Build section specs, rerank per-section quote pools, then synthesize. */
async function synthesizeSections(
  credentials: ResearchCredentials,
  subqueries: Subquery[],
  quotesBySection: Record<string, VerbatimQuote[]>,
  claimsBySection: Record<string, { claim: string; source_url: string; provider: ProviderName }[]>,
  targetWordCount: { min: number; max: number },
  costTracker: CostTracker,
  log: Logger,
  synthesisModelOverride: string | undefined,
  sectionTitles: Record<string, string> | undefined,
  briefQuestions: string[] | undefined,
): Promise<SectionDraft[]> {
  const sectionPathsSeen = new Set<string>();
  const sectionGoals: Record<string, string[]> = {};
  for (const subquery of subqueries) {
    sectionPathsSeen.add(subquery.section_path);
    if (sectionGoals[subquery.section_path] === undefined) {
      sectionGoals[subquery.section_path] = [];
    }
    if (subquery.rationale.length > 0
        && !sectionGoals[subquery.section_path].includes(subquery.rationale)) {
      sectionGoals[subquery.section_path].push(subquery.rationale);
    }
  }

  const totalSections = sectionPathsSeen.size;
  const wordsPerSection = Math.floor(targetWordCount.min / Math.max(totalSections, 1));
  const sectionsToWrite: SectionSpec[] = Array.from(sectionPathsSeen).map((path) => {
    const goals = sectionGoals[path];
    return {
      section_path: path,
      goal: goals !== undefined && goals.length > 0
        ? goals.join('; ')
        : `Provide comprehensive coverage of section ${path}`,
      targetWords: wordsPerSection,
    };
  });

  // Rerank each section's quote pool against the section goal.
  // Cost (audit M2): use Voyage's REAL total_tokens when the API reports it;
  // fall back to the legacy ~650 tokens/section estimate on fallback paths.
  const rerankedQuotesByPath: Record<string, VerbatimQuote[]> = {};
  let rerankActualTokens = 0;
  let rerankEstimatedSections = 0;
  for (const spec of sectionsToWrite) {
    const raw = quotesBySection[spec.section_path];
    if (raw === undefined || raw.length === 0) {
      rerankedQuotesByPath[spec.section_path] = [];
      continue;
    }
    const rerankResult = await rerankQuotes({
      credentials,
      query: spec.goal,
      quotes: raw,
      topK: RERANK_TOP_K,
    });
    rerankedQuotesByPath[spec.section_path] = rerankResult.quotes;
    if (rerankResult.total_tokens !== undefined && rerankResult.total_tokens > 0) {
      rerankActualTokens += rerankResult.total_tokens;
    } else if (rerankResult.rerank_used) {
      rerankEstimatedSections++;
    }
  }

  const rerankUnits = rerankActualTokens + rerankEstimatedSections * 650;
  if (rerankUnits > 0) {
    costTracker.record({
      provider: 'voyage',
      category: 'embed',
      units: rerankUnits,
      unit_cost_usd: VOYAGE_RERANK_USD_PER_M / 1_000_000,
      metadata: {
        operation: 'rerank-2',
        sections: sectionsToWrite.length,
        actual_tokens: rerankActualTokens,
        estimated_sections: rerankEstimatedSections,
      },
    });
  }

  const synthesized = await synthesizeAllSections({
    credentials,
    sectionsToWrite,
    quotesByPath: rerankedQuotesByPath,
    claimsByPath: claimsBySection,
    synthesisModelOverride,
    sectionTitles,
    briefQuestions,
  });
  recordSynthCost(
    costTracker,
    synthesized.model,
    synthesized.inputTokens,
    synthesized.cachedReadTokens,
    synthesized.outputTokens,
    'synth',
  );

  log.info(
    { sections: synthesized.sections.length, model: synthesized.model },
    '[runDeepResearch] Section synthesis complete',
  );
  return synthesized.sections;
}

/** Record uncached-input / cache-read / output synthesis cost as three entries. */
function recordSynthCost(
  costTracker: CostTracker,
  model: string,
  inputTokens: number,
  cachedReadTokens: number,
  outputTokens: number,
  operation: string,
): void {
  const pricing = getModelPricing(model);
  costTracker.record({
    provider: pricing.provider,
    category: 'synth',
    units: inputTokens,
    unit_cost_usd: pricing.inputUsdPerM / 1_000_000,
    metadata: { operation: `${operation}-input`, model },
  });
  if (cachedReadTokens > 0) {
    const cachedRate = pricing.cacheHitInputUsdPerM !== undefined
      ? pricing.cacheHitInputUsdPerM
      : pricing.inputUsdPerM;
    costTracker.record({
      provider: pricing.provider,
      category: 'synth',
      units: cachedReadTokens,
      unit_cost_usd: cachedRate / 1_000_000,
      metadata: { operation: `${operation}-input-cached`, model },
    });
  }
  costTracker.record({
    provider: pricing.provider,
    category: 'synth',
    units: outputTokens,
    unit_cost_usd: pricing.outputUsdPerM / 1_000_000,
    metadata: { operation: `${operation}-output`, model },
  });
}

/** Serialize a critique into a one-line refinement hint for re-planning. */
function serializeCritiqueHint(c: {
  gaps: Array<{ section_path: string; description: string }>;
  thin_sections: string[];
  missing_provider_coverage: Array<{ section_path: string; missing_providers: ProviderName[] }>;
}): string {
  return [
    c.gaps.map((g) => `${g.section_path}: ${g.description}`).join('; '),
    c.thin_sections.length > 0 ? `Thin sections: ${c.thin_sections.join(', ')}` : '',
    c.missing_provider_coverage.length > 0
      ? `Missing providers: ${c.missing_provider_coverage
          .map((m) => `${m.section_path} needs ${m.missing_providers.join('/')}`)
          .join('; ')}`
      : '',
  ].filter((s) => s.length > 0).join('. ');
}

/** Question focus handed to extraction. */
interface ExtractFocus {
  terms: string[];
  questions: string[] | undefined;
  fetchQuality: FetchQualityCounts;
  requirements: BriefRequirements | null;
  /**
   * Evidence earlier passes already hold, so a refinement pass counts it
   * toward a section's target instead of re-feeding a section that is full.
   * Null on the main pass.
   */
  prior: SectionEvidenceMaps | null;
}

interface SectionEvidenceMaps {
  quotesBySection: Record<string, VerbatimQuote[]>;
  claimsBySection: Record<string, { claim: string; source_url: string; provider: ProviderName }[]>;
}

/** Validated units and distinct sources a section holds across this pass and any prior one. */
function sectionEvidence(
  section: string,
  quotesBySection: SectionEvidenceMaps['quotesBySection'],
  claimsBySection: SectionEvidenceMaps['claimsBySection'],
  prior: SectionEvidenceMaps | null,
): SectionEvidence {
  const maps: SectionEvidenceMaps[] = [{ quotesBySection, claimsBySection }];
  if (prior !== null) maps.push(prior);
  const entries: { source_url: string }[] = [];
  for (const map of maps) {
    const quotes = map.quotesBySection[section];
    if (quotes !== undefined) entries.push(...quotes);
    const claims = map.claimsBySection[section];
    if (claims !== undefined) entries.push(...claims);
  }
  return sectionEvidenceFrom(entries);
}

/** Section path the primary-source searches and direct fetches answer under. */
const PRIMARY_SECTION_PATH = 'A.0';
const PRIMARY_SEARCH_PROVIDERS: ProviderName[] = ['searxng', 'serper', 'tavily', 'exa'];
const MAX_PRIMARY_QUESTIONS = 3;

/**
 * One domain-restricted search per (primary source, question). The query
 * carries `site:` for engines that read operators; `include_domains` is
 * honored natively by Tavily and enforced on every provider's results.
 */
export function primarySourceSubqueries(
  requirements: BriefRequirements | null,
  searchProviders: Partial<Record<ProviderName, unknown>>,
): Subquery[] {
  if (requirements === null) return [];
  const providers = PRIMARY_SEARCH_PROVIDERS.filter((name) => searchProviders[name] !== undefined);
  if (providers.length === 0) return [];
  const out: Subquery[] = [];
  for (const source of requirements.primary_sources.slice(0, 2)) {
    for (const question of requirements.questions.slice(0, MAX_PRIMARY_QUESTIONS)) {
      out.push(SubquerySchema.parse({
        section_path: PRIMARY_SECTION_PATH,
        query: `${question.question.slice(0, 200)} site:${source.domain}`,
        providers,
        expected_source_types: ['documentation'],
        rationale: `Answer from the primary source (${source.name}): ${question.question.slice(0, 200)}`,
        search_options: { include_domains: [source.domain] },
      }));
    }
  }
  return out;
}

/** Canonical primary-source URLs not already found by search, as fetchable results. */
export function primarySourceDirectResults(
  requirements: BriefRequirements | null,
  found: SearchResult[],
): SearchResult[] {
  if (requirements === null) return [];
  const known = new Set(found.map((result) => result.url));
  const out: SearchResult[] = [];
  for (const source of requirements.primary_sources) {
    for (const url of source.urls) {
      if (known.has(url) || !urlIsOnDomain(url, source.domain)) continue;
      known.add(url);
      out.push(SearchResultSchema.parse({
        provider: 'crawl4ai',
        url,
        title: source.name,
        retrieved_for: [PRIMARY_SECTION_PATH],
      }));
    }
  }
  return out;
}

/** 0 for a primary-source result, 1 otherwise — a stable sort key. */
function primaryRank(result: SearchResult, requirements: BriefRequirements | null): number {
  if (requirements === null) return 1;
  return isPrimarySourceUrl(result.url, requirements.primary_sources) ? 0 : 1;
}

type ClaimEvidence = { claim: string; source_url: string; provider: ProviderName };

interface GatedEvidence {
  quotesBySection: Record<string, VerbatimQuote[]>;
  claimsBySection: Record<string, ClaimEvidence[]>;
  /** Every kept unit, in extraction order, for facet-answer selection. */
  units: EvidenceUnitForJudging[];
}

function evidenceKey(sourceUrl: string, text: string): string {
  return `${sourceUrl}\u0000${text.replace(/\s+/gu, ' ').trim().toLowerCase()}`;
}

/**
 * Judge any unjudged evidence against the brief's questions, then return
 * section maps holding only units judged relevant (relevance >= 2) plus any
 * the judge could not cover (counted as unjudged). Within a section, units
 * that state an asked fact and primary-source units come first.
 *
 * When the brief could not be analyzed there is nothing to judge against;
 * evidence passes through and the gate reports `not_run`.
 */
async function applyRelevanceGate(input: {
  credentials: ResearchCredentials;
  requirements: BriefRequirements | null;
  quotesBySection: Record<string, VerbatimQuote[]>;
  claimsBySection: Record<string, ClaimEvidence[]>;
  judgments: Map<string, EvidenceJudgment>;
  gate: GateCounts;
  usageSink: (usage: AnswerQualityModelUsage) => void;
  log: Logger;
}): Promise<GatedEvidence> {
  const { requirements, judgments, gate } = input;
  const units: EvidenceUnitForJudging[] = [];
  const unitKeys = new Set<string>();
  const addUnit = (text: string, sourceUrl: string): void => {
    const key = evidenceKey(sourceUrl, text);
    if (unitKeys.has(key)) return;
    unitKeys.add(key);
    units.push({ key, text, sourceUrl });
  };
  for (const quotes of Object.values(input.quotesBySection)) {
    for (const q of quotes) addUnit(q.quote, q.source_url);
  }
  for (const claims of Object.values(input.claimsBySection)) {
    for (const c of claims) addUnit(c.claim, c.source_url);
  }

  if (requirements === null || requirements.questions.length === 0) {
    gate.status = 'not_run';
    return { quotesBySection: input.quotesBySection, claimsBySection: input.claimsBySection, units };
  }

  const unjudged = units.filter((unit) => !judgments.has(unit.key));
  if (unjudged.length > 0) {
    const result = await judgeEvidenceRelevance({
      credentials: input.credentials,
      requirements,
      units: unjudged,
      usageSink: input.usageSink,
    });
    for (const [key, judgment] of result.judgments) judgments.set(key, judgment);
    if (result.failedBatches > 0 && result.judgments.size === 0) gate.status = 'unavailable';
  }

  const keep = (key: string): boolean => {
    const judgment = judgments.get(key);
    return judgment === undefined || judgment.relevance >= RELEVANCE_KEEP_THRESHOLD;
  };
  const priority = (key: string, url: string): number => {
    const judgment = judgments.get(key);
    const relevance = judgment === undefined ? RELEVANCE_KEEP_THRESHOLD : judgment.relevance;
    const answers = judgment !== undefined && judgment.answers.length > 0 ? 1 : 0;
    const primary = isPrimarySourceUrl(url, requirements.primary_sources) ? 1 : 0;
    return answers * 100 + primary * 10 + relevance;
  };

  const quotesBySection: Record<string, VerbatimQuote[]> = {};
  for (const [path, quotes] of Object.entries(input.quotesBySection)) {
    quotesBySection[path] = quotes
      .map((q, order) => ({ q, order, key: evidenceKey(q.source_url, q.quote) }))
      .filter((entry) => keep(entry.key))
      .sort((a, b) => priority(b.key, b.q.source_url) - priority(a.key, a.q.source_url) || a.order - b.order)
      .map((entry) => entry.q);
  }
  const claimsBySection: Record<string, ClaimEvidence[]> = {};
  for (const [path, claims] of Object.entries(input.claimsBySection)) {
    claimsBySection[path] = claims
      .map((c, order) => ({ c, order, key: evidenceKey(c.source_url, c.claim) }))
      .filter((entry) => keep(entry.key))
      .sort((a, b) => priority(b.key, b.c.source_url) - priority(a.key, a.c.source_url) || a.order - b.order)
      .map((entry) => entry.c);
  }

  const kept = units.filter((unit) => keep(unit.key));
  gate.judged = units.filter((unit) => judgments.has(unit.key)).length;
  gate.unjudged = units.length - gate.judged;
  gate.kept = kept.length;
  gate.dropped = units.length - kept.length;
  input.log.info(
    { units: units.length, kept: gate.kept, dropped: gate.dropped, unjudged: gate.unjudged },
    '[runDeepResearch] Relevance gate applied',
  );
  return { quotesBySection, claimsBySection, units: kept };
}

function notAssessedAnswerQuality(gate: GateCounts, fetchQuality: FetchQualityCounts): AnswerQuality {
  return {
    status: 'not_assessed',
    answered_ratio: 0,
    facets_total: 0,
    facets_answered: 0,
    questions: [],
    primary_sources: [],
    primary_source_cited: null,
    relevance_gate: {
      status: gate.status,
      units_judged: gate.judged,
      units_kept: gate.kept,
      units_dropped: gate.dropped,
      units_unjudged: gate.unjudged,
    },
    fetch_quality: {
      pages_rejected: fetchQuality.pagesRejected,
      evidence_rejected: fetchQuality.evidenceRejected,
    },
    summary_line: 'answered: not assessed',
    passed: false,
  };
}

/** Map a provider name to a Gemini extraction mode. */
function extractionModeFor(provider: ProviderName): 'reddit' | 'youtube' | 'serp' | 'longform' | 'hn' {
  if (provider === 'reddit') return 'reddit';
  if (provider === 'youtube') return 'youtube';
  if (provider === 'serpapi') return 'serp';
  if (provider === 'hn') return 'hn';
  return 'longform';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
