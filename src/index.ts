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

import { z } from 'zod';
import {
  hashUrl,
  canonicalizeUrl,
  SearchResultSchema,
} from './types.js';
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
} from './types.js';
import { DEPTH_CONFIG, getModelPricing } from './depth-config.js';
import type { ResearchDepth } from './depth-config.js';
import { CostTracker } from './cost-tracker.js';
import {
  EXTRACTION_MODEL,
  GEMINI_MAX_CONTENT_CHARS,
  CHARS_PER_TOKEN,
  mapWithConcurrency,
} from './pipeline-core.js';
import { planSubqueries } from './planner.js';
import type { PlannerUsage } from './planner.js';
import {
  getEnabledProviders,
  routeProvidersForSourceTypes,
  extractQuotesWithGemini,
} from './providers/index.js';
import { rerankQuotes } from './rerank.js';
import {
  synthesizeAllSections,
  assembleFinalReport,
} from './synthesis.js';
import type { SectionSpec } from './synthesis.js';
import { critiqueDraft } from './critique.js';
import { buildReportChunks } from './chunker.js';
import { validateGrounding } from './grounding.js';
import type { GroundingResult } from './grounding.js';
import { logger as defaultLogger } from './logger.js';
import type { Logger } from './logger.js';

// =============================================================================
// Public re-exports — types, schemas, config
// =============================================================================

export * from './types.js';
export {
  DEPTH_CONFIG,
  coerceDepth,
  getDepthConfig,
  getModelPricing,
  deepResearchSynthesisCostUsd,
  MODEL_PRICING,
  DEEPSEEK_V4_PRO_PROMO_EXPIRY_AT,
} from './depth-config.js';
export type { ResearchDepth, DepthTunables, ModelPricing } from './depth-config.js';
export { CostTracker } from './cost-tracker.js';
export { logger } from './logger.js';
export type { Logger } from './logger.js';

// Stage-level building blocks (so consumers can compose their own pipelines)
export { planSubqueries, summarizePromptBrief } from './planner.js';
export type { PlanSubqueriesInput, PlannerUsage } from './planner.js';
export {
  getAllProviders,
  getEnabledProviders,
  routeProvidersForSourceTypes,
  extractQuotesWithGemini,
  tavilyProvider,
  exaProvider,
  serpapiProvider,
  serperProvider,
  searxngProvider,
  perplexityProvider,
  redditProvider,
  youtubeProvider,
  hnProvider,
  rssProvider,
  crawl4aiProvider,
  facebookGroupsProvider,
  tiktokProvider,
  instagramProvider,
  xProvider,
  podcastsProvider,
  triggerCollection,
  pollSnapshot,
  downloadSnapshot,
  fetchLinkedInPostsBrightData,
  fetchFacebookGroupPostsBrightData,
} from './providers/index.js';
export type { PollSnapshotOptions } from './providers/index.js';
export { rerankQuotes } from './rerank.js';
export {
  synthesizeSection,
  synthesizeAllSections,
  assembleFinalReport,
} from './synthesis.js';
export type {
  SectionSpec,
  SynthesizeSectionInput,
  SynthesizeAllInput,
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

// Knowledge-ingestion core (continuous internet-knowledge ingestion).
export * from './ingestion/index.js';

// Standalone scrape primitives — the Crawl4AI → Jina Reader → direct-fetch
// chain, usable outside the research pipeline (e.g. Sentigen WebResearch).
export {
  crawlUrl,
  crawlWithCrawl4AI,
  jinaReaderFetch,
  directFetchAsText,
} from './pipeline-core.js';

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

// =============================================================================
// Constants — mirror the original runner's budget knobs
// =============================================================================

const SEARCH_RESULT_LIMIT = 8;
const CUMULATIVE_URL_CEILING = 400;
const RERANK_TOP_K = 40;

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
  category: 'search' | 'fetch' | 'extract' | 'embed' | 'synth' | 'critique' | 'plan' | 'transcribe';
  model?: string;
  units: number;
  costUsd: number;
  metadata: Record<string, unknown>;
}

export type OnPipelineUsage = (event: PipelineUsageEvent) => void | Promise<void>;

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
      const event: PipelineUsageEvent = {
        provider: entry.provider,
        category: entry.category,
        model: typeof modelRaw === 'string' ? modelRaw : undefined,
        units: entry.units,
        costUsd: entry.units * entry.unit_cost_usd,
        metadata: entry.metadata,
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

// Per-call search cost estimates (USD) — audit M2. Free providers are $0;
// paid providers use list-price estimates so the cap sees search spend.
const SEARCH_COST_PER_CALL_USD: Partial<Record<ProviderName, number>> = {
  tavily: 0.008,
  exa: 0.007,
  serpapi: 0.015,
  serper: 0.001,
  perplexity: 0.005,
  podcasts: 0.002,
};

// Gemini flash-lite extraction pricing (USD per 1M tokens).
const EXTRACTION_INPUT_USD_PER_M = 0.10;
const EXTRACTION_OUTPUT_USD_PER_M = 0.40;
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
  tavily: 30 * 86_400,
  exa: 30 * 86_400,
  perplexity: 7 * 86_400,
  reddit: 60 * 86_400,
  youtube: 60 * 86_400,
  hn: 60 * 86_400,
  rss: 7 * 86_400,
};
const DEFAULT_SEARCH_CACHE_TTL_SECONDS = 14 * 86_400;
const FETCH_CACHE_TTL_SECONDS = 30 * 86_400;

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
   * intersected with the env-enabled set) participate in search/fetch — used
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
   * cost. The 'quick' kind now defaults this to gemini-3-flash-preview.
   */
  synthesisModelOverride?: string;
}

export interface RunDeepResearchResult {
  report: FinalReport;
  quotes: VerbatimQuote[];
  costUsd: number;
  /**
   * Faithfulness verdict for the assembled report (audit F2: this was
   * computed and then discarded — callers could never see, gate on, or
   * surface it). Diagnostic: the pipeline never aborts on a low ratio; the
   * CALLER decides whether to flag, retry, or reject.
   */
  grounding: GroundingResult;
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
  const log: Logger = input.logger !== undefined ? input.logger : defaultLogger;
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

  let enabledProviders = getEnabledProviders();
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
  const availableProviderNames = Object.keys(enabledProviders);

  // Planner spend → CostTracker 'plan' category (audit F8: previously never
  // recorded, so the hard cap under-counted by every plan + re-plan call).
  const plannerUsageSink = (usage: PlannerUsage): void => {
    const isGemini = usage.model.startsWith('gemini-');
    const pricing = isGemini
      ? { inputUsdPerM: EXTRACTION_INPUT_USD_PER_M, outputUsdPerM: EXTRACTION_OUTPUT_USD_PER_M, provider: 'google' }
      : (() => {
          const p = getModelPricing(usage.model);
          return { inputUsdPerM: p.inputUsdPerM, outputUsdPerM: p.outputUsdPerM, provider: p.provider };
        })();
    costTracker.record({
      provider: pricing.provider,
      category: 'plan',
      units: usage.inputTokens,
      unit_cost_usd: pricing.inputUsdPerM / 1_000_000,
      metadata: { model: usage.model, operation: 'plan-input' },
    });
    costTracker.record({
      provider: pricing.provider,
      category: 'plan',
      units: usage.outputTokens,
      unit_cost_usd: pricing.outputUsdPerM / 1_000_000,
      metadata: { model: usage.model, operation: 'plan-output' },
    });
  };

  // ---------------------------------------------------------------------------
  // Step 1: plan subqueries (restricted to providers enabled for this run)
  // ---------------------------------------------------------------------------
  let subqueries: Subquery[] = await planSubqueries({
    promptMd: input.brief,
    targetWordCount,
    subqueriesMin,
    subqueriesMax,
    availableProviders: availableProviderNames,
    usageSink: plannerUsageSink,
  });

  if (subqueries.length === 0) {
    throw new Error('Planner returned zero subqueries — cannot proceed');
  }

  // ---------------------------------------------------------------------------
  // Step 2: search (route providers per subquery, run in parallel, dedup)
  // ---------------------------------------------------------------------------
  const allSearchResults = await runSearch(
    subqueries, enabledProviders, costTracker, log, input.cache, minFreeResults,
  );

  // Provenance map for the bibliography (audit m3) — accumulated across the
  // initial search and every critique-loop refinement search.
  const sourceMetaByUrl: Record<string, {
    provider?: string; title?: string; author?: string; published_at?: string;
  }> = {};
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
  const naturalCap = subqueries.length * depthConfig.urlsPerSubquery;
  const cappedCount = Math.min(naturalCap, CUMULATIVE_URL_CEILING);
  const urlsToFetch = allSearchResults.slice(0, Math.min(allSearchResults.length, cappedCount));

  // ---------------------------------------------------------------------------
  // Step 3: fetch content
  // ---------------------------------------------------------------------------
  const markdownByUrl = await fetchContent(urlsToFetch, enabledProviders, log, input.cache);

  // ---------------------------------------------------------------------------
  // Step 4: extract quotes → per-section maps
  // ---------------------------------------------------------------------------
  const extraction = await extractQuotes(
    subqueries,
    allSearchResults,
    markdownByUrl,
    enabledProviders,
    depthConfig.urlsPerSubquery,
    costTracker,
    log,
  );

  let { quotesBySection } = extraction;
  const { claimsBySection, sourceQuotesByUrl, providerCoverageBySection } = extraction;

  // ---------------------------------------------------------------------------
  // Step 5: section synthesis (rerank per section, then synthesize)
  // ---------------------------------------------------------------------------
  let sections = await synthesizeSections(
    subqueries,
    quotesBySection,
    claimsBySection,
    targetWordCount,
    costTracker,
    log,
    input.synthesisModelOverride,
  );

  // ---------------------------------------------------------------------------
  // Step 6: critique / refinement loop
  // ---------------------------------------------------------------------------
  const finalGaps: string[] = [];
  let critiquePass = 0;
  while (critiquePass < depthConfig.critiqueMaxPasses) {
    const critique = await critiqueDraft({
      promptMd: input.brief,
      sections,
      targetWordCount,
      providerCoverageBySection,
    });

    // Critique cost (matches runner's flat 2000-token estimate at Sonnet rate).
    costTracker.record({
      provider: 'anthropic',
      category: 'critique',
      units: 2000,
      unit_cost_usd: 3 / 1_000_000,
      metadata: { pass: critiquePass, gaps: critique.gaps.length },
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
      additionalSubqueries, enabledProviders, costTracker, log, input.cache, minFreeResults,
    );
    recordSourceMeta(extraResults);
    const extraToFetch = extraResults.slice(0, Math.min(extraResults.length, CUMULATIVE_URL_CEILING));
    const extraMarkdown = await fetchContent(extraToFetch, enabledProviders, log, input.cache);

    const extraExtraction = await extractQuotes(
      additionalSubqueries,
      extraResults,
      extraMarkdown,
      enabledProviders,
      depthConfig.urlsPerSubquery,
      costTracker,
      log,
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
    sections = await synthesizeSections(
      subqueries,
      quotesBySection,
      claimsBySection,
      targetWordCount,
      costTracker,
      log,
      input.synthesisModelOverride,
    );

    critiquePass++;
  }

  // ---------------------------------------------------------------------------
  // Step 7: assemble final report
  // ---------------------------------------------------------------------------
  const assembly = await assembleFinalReport({
    promptMd: input.brief,
    sections,
    gaps: finalGaps,
    sourceMeta: sourceMetaByUrl,
    synthesisModelOverride: input.synthesisModelOverride,
  });
  recordSynthCost(costTracker, assembly.model, assembly.inputTokens, assembly.cachedReadTokens, assembly.outputTokens, 'assembly');
  const report = assembly.report;

  // ---------------------------------------------------------------------------
  // Step 8: validate grounding (diagnostic; never aborts)
  // ---------------------------------------------------------------------------
  const groundingChunks: ReportChunkInput[] = [];
  for (const [sourceUrl, quotes] of Object.entries(sourceQuotesByUrl)) {
    for (const q of quotes) {
      groundingChunks.push({
        chunk_kind: 'quote',
        section_path: '',
        heading: null,
        content: q.quote,
        source_url: sourceUrl,
        source_provider: null,
        source_author: q.author !== undefined ? q.author : null,
        source_published_at: q.published_at !== undefined ? q.published_at : null,
        source_engagement: { ...q.engagement },
        citation_anchor: null,
        metadata: {},
      });
    }
  }
  const grounding = validateGrounding({
    fullMarkdown: report.full_markdown,
    bibliography: report.bibliography,
    chunks: groundingChunks,
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

  return {
    report,
    quotes: allQuotes,
    costUsd: costTracker.total(),
    grounding,
  };
}

// =============================================================================
// Internal stage helpers
// =============================================================================

type EnabledProviders = ReturnType<typeof getEnabledProviders>;

const CachedSearchResultsSchema = z.array(SearchResultSchema);

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
): Promise<SearchResult[]> {
  const cacheKey = `search:${providerName}:${subquery.query}`;
  const cached = await cacheGet(cache, cacheKey, log);
  if (cached !== null) {
    try {
      const parsed = CachedSearchResultsSchema.safeParse(JSON.parse(cached));
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Corrupt cache entry — fall through to a live search.
    }
  }
  try {
    const results = await provider.search(subquery.query, { limit: SEARCH_RESULT_LIMIT });
    const perCall = SEARCH_COST_PER_CALL_USD[providerName];
    if (perCall !== undefined && perCall > 0) {
      costTracker.record({
        provider: providerName,
        category: 'search',
        units: 1,
        unit_cost_usd: perCall,
        metadata: { query: subquery.query.slice(0, 80), results: results.length },
      });
    }
    const ttl = SEARCH_CACHE_TTL_SECONDS[providerName];
    await cacheSet(
      cache,
      cacheKey,
      JSON.stringify(results),
      ttl !== undefined ? ttl : DEFAULT_SEARCH_CACHE_TTL_SECONDS,
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

/**
 * Route + run searches for a set of subqueries, deduped by canonical URL.
 * Free-first tiering (audit M5): free general-search + specialist providers
 * run first; paid general providers fire only when the first tier returned
 * fewer than `minFreeResults` unique results for the subquery.
 */
async function runSearch(
  subqueries: Subquery[],
  enabledProviders: EnabledProviders,
  costTracker: CostTracker,
  log: Logger,
  cache?: ResearchCacheAdapter,
  minFreeResults: number = DEFAULT_MIN_FREE_RESULTS,
): Promise<SearchResult[]> {
  // Bounded fan-out (audit F7): wide mode plans 50-80 subqueries; unbounded
  // Promise.all ran them all at once and 429-stormed providers and our own
  // scraper. Per-provider rate limiters bound the inner tier calls.
  const perSubqueryResults = await mapWithConcurrency(
    subqueries,
    4,
    async (subquery): Promise<SearchResult[]> => {
      const providerNames = new Set<ProviderName>(subquery.providers);
      for (const pn of routeProvidersForSourceTypes(subquery.expected_source_types)) {
        providerNames.add(pn);
      }

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
              subResults.push({ ...result, url: canonical, retrieved_for: [subquery.section_path] });
            }
          }
        }
      };

      collect(await Promise.all(
        tier1.map((entry) =>
          searchOneProvider(entry.name, entry.provider, subquery, costTracker, log, cache),
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
            searchOneProvider(entry.name, entry.provider, subquery, costTracker, log, cache),
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
      }
    }
  }
  const merged = Array.from(mergedByHash.values());
  log.info({ total: merged.length }, '[runDeepResearch] Search phase complete');
  return merged;
}

/** Fetch markdown content for a set of results — provider.fetch, else crawl4ai. */
async function fetchContent(
  results: SearchResult[],
  enabledProviders: EnabledProviders,
  log: Logger,
  cache?: ResearchCacheAdapter,
): Promise<Record<string, string>> {
  const markdownByUrl: Record<string, string> = {};
  const crawl4aiProvider = enabledProviders['crawl4ai'];

  // Bounded fan-out (audit F7): the previous unbounded Promise.all put every
  // fetch (≤400) in flight at once — a 429 storm against our own scraper.
  await mapWithConcurrency(
    results,
    8,
    async (result) => {
      const cacheKey = `fetch:${result.url}`;
      const cachedMarkdown = await cacheGet(cache, cacheKey, log);
      if (cachedMarkdown !== null && cachedMarkdown.length > 0) {
        markdownByUrl[result.url] = cachedMarkdown;
        return;
      }

      // Search-time raw content (Tavily include_raw_content): the search API
      // already extracted the page server-side, which survives JS/paywalls/
      // bot-walls that break a headless re-crawl of the same URL. Use it and
      // skip the crawl.
      const searchRawContent = result.raw_metadata['raw_content'];
      if (typeof searchRawContent === 'string' && searchRawContent.length >= 800) {
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
      if (markdown.length > 0) {
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
  subqueries: Subquery[],
  allSearchResults: SearchResult[],
  markdownByUrl: Record<string, string>,
  enabledProviders: EnabledProviders,
  urlsPerSubquery: number,
  costTracker: CostTracker,
  log: Logger,
): Promise<ExtractionMaps> {
  // Map each section to the URLs its OWN subqueries actually retrieved
  // (audit F1). The old mapping bucketed by provider identity over the global
  // deduped list — every same-provider section got identical URLs and later
  // sections inherited earlier sections' sources. It also overwrote the map
  // per subquery, so only a section's LAST subquery counted; URLs now merge
  // across all of a section's subqueries (per-subquery cap preserved).
  const sectionToUrls = new Map<string, string[]>();
  for (const subquery of subqueries) {
    const sectionUrls: string[] = [];
    for (const result of allSearchResults) {
      if (result.retrieved_for.includes(subquery.section_path)) {
        sectionUrls.push(result.url);
        if (sectionUrls.length >= urlsPerSubquery) {
          break;
        }
      }
    }
    // Legacy fallback for callers composing their own untagged SearchResults
    // (retrieved_for defaults to []): the old provider heuristic, better than
    // an evidence-empty section.
    if (sectionUrls.length === 0) {
      for (const result of allSearchResults) {
        if (result.retrieved_for.length === 0 && subquery.providers.includes(result.provider)) {
          sectionUrls.push(result.url);
          if (sectionUrls.length >= urlsPerSubquery) {
            break;
          }
        }
      }
    }
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

  const resultsWithContent = allSearchResults.filter(
    (r) => markdownByUrl[r.url] !== undefined && markdownByUrl[r.url].length > 0,
  );

  // Bounded fan-out (audit F7): extraction is one Gemini call per source —
  // unbounded Promise.all hammered the API with every source at once.
  await mapWithConcurrency(
    resultsWithContent,
    8,
    async (result) => {
      const markdown = markdownByUrl[result.url];
      const providerName = result.provider;
      const provider = enabledProviders[providerName];

      let extracted: ExtractedQuotes;
      if (provider !== undefined && provider.extract !== undefined) {
        try {
          extracted = await provider.extract({
            provider: providerName,
            url: result.url,
            raw_content: markdown,
            markdown,
            title: '',
            engagement: {},
            fetch_status: 'ok',
          });
        } catch (err: unknown) {
          log.warn(
            { url: result.url.slice(0, 80), error: errMsg(err).slice(0, 120) },
            '[runDeepResearch] Provider extract() failed, falling back to Gemini',
          );
          extracted = await extractQuotesWithGemini({
            provider: providerName,
            url: result.url,
            content: markdown,
            mode: 'longform',
          });
        }
      } else {
        extracted = await extractQuotesWithGemini({
          provider: providerName,
          url: result.url,
          content: markdown,
          mode: extractionModeFor(providerName),
        });
      }

      // Extraction cost (audit M2) — real Gemini tokens when the extractor
      // reported them, else a conservative estimate from content length so
      // the cap still sees extraction spend from provider-native extractors.
      if (extracted.usage !== undefined) {
        costTracker.record({
          provider: 'google',
          category: 'extract',
          units: extracted.usage.prompt_tokens,
          unit_cost_usd: EXTRACTION_INPUT_USD_PER_M / 1_000_000,
          metadata: { model: EXTRACTION_MODEL, operation: 'extract-input', url: result.url.slice(0, 80) },
        });
        costTracker.record({
          provider: 'google',
          category: 'extract',
          units: extracted.usage.candidate_tokens,
          unit_cost_usd: EXTRACTION_OUTPUT_USD_PER_M / 1_000_000,
          metadata: { model: EXTRACTION_MODEL, operation: 'extract-output', url: result.url.slice(0, 80) },
        });
      } else {
        const estimatedInputTokens = Math.ceil(Math.min(markdown.length, GEMINI_MAX_CONTENT_CHARS) / CHARS_PER_TOKEN);
        costTracker.record({
          provider: 'google',
          category: 'extract',
          units: estimatedInputTokens,
          unit_cost_usd: EXTRACTION_INPUT_USD_PER_M / 1_000_000,
          metadata: { model: EXTRACTION_MODEL, operation: 'extract-input-estimated', url: result.url.slice(0, 80) },
        });
      }

      const quotes = extracted.verbatim_quotes;
      sourceQuotesByUrl[result.url] = quotes;

      for (const [sectionPath, sectionUrls] of sectionToUrls.entries()) {
        if (!sectionUrls.includes(result.url)) {
          continue;
        }
        if (quotesBySection[sectionPath] === undefined) {
          quotesBySection[sectionPath] = [];
        }
        for (const q of quotes) {
          quotesBySection[sectionPath].push(q);
        }
        if (claimsBySection[sectionPath] === undefined) {
          claimsBySection[sectionPath] = [];
        }
        for (const claim of extracted.key_claims) {
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
    },
  );

  log.info(
    { sections: Object.keys(quotesBySection).length, sources: Object.keys(sourceQuotesByUrl).length },
    '[runDeepResearch] Quote extraction complete',
  );
  return { quotesBySection, claimsBySection, sourceQuotesByUrl, providerCoverageBySection };
}

/** Build section specs, rerank per-section quote pools, then synthesize. */
async function synthesizeSections(
  subqueries: Subquery[],
  quotesBySection: Record<string, VerbatimQuote[]>,
  claimsBySection: Record<string, { claim: string; source_url: string; provider: ProviderName }[]>,
  targetWordCount: { min: number; max: number },
  costTracker: CostTracker,
  log: Logger,
  synthesisModelOverride?: string,
): Promise<SectionDraft[]> {
  const sectionPathsSeen = new Set<string>();
  const sectionGoals: Record<string, string[]> = {};
  for (const subquery of subqueries) {
    sectionPathsSeen.add(subquery.section_path);
    if (sectionGoals[subquery.section_path] === undefined) {
      sectionGoals[subquery.section_path] = [];
    }
    if (subquery.rationale.length > 0) {
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
    const rerankResult = await rerankQuotes({ query: spec.goal, quotes: raw, topK: RERANK_TOP_K });
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
    sectionsToWrite,
    quotesByPath: rerankedQuotesByPath,
    claimsByPath: claimsBySection,
    synthesisModelOverride,
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
