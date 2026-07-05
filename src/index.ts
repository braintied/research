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

import {
  hashUrl,
  canonicalizeUrl,
} from './types.js';
import type {
  Subquery,
  SearchResult,
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
import { planSubqueries } from './planner.js';
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
export { validateGrounding } from './grounding.js';
export type {
  GroundingResult,
  HallucinatedCitation,
  ValidateGroundingInput,
} from './grounding.js';
export { parseMarkdownReport } from './parse-markdown-report.js';

// Knowledge-ingestion core (continuous internet-knowledge ingestion).
export * from './ingestion/index.js';

// Research kinds — semantic presets (quick/standard/deep/managed/social).
export {
  RESEARCH_KINDS,
  RESEARCH_KIND_PRESETS,
  coerceResearchKind,
  runResearch,
} from './kinds.js';
export type { ResearchKind, ResearchKindPreset, RunResearchInput, KindResearchResult } from './kinds.js';

// Managed deep research (Perplexity sonar-deep-research).
export { runManagedResearch } from './managed-research.js';
export type { RunManagedResearchInput, RunManagedResearchResult } from './managed-research.js';

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
}

export interface RunDeepResearchResult {
  report: FinalReport;
  quotes: VerbatimQuote[];
  costUsd: number;
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
  const costTracker = new CostTracker(capUsd);

  const targetWordCount = {
    min: depthConfig.targetWordCountMin,
    max: depthConfig.targetWordCountMax,
  };

  log.info(
    {
      depth,
      subqueriesMin: depthConfig.subqueriesMin,
      subqueriesMax: depthConfig.subqueriesMax,
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
  }
  const availableProviderNames = Object.keys(enabledProviders);

  // ---------------------------------------------------------------------------
  // Step 1: plan subqueries (restricted to providers enabled for this run)
  // ---------------------------------------------------------------------------
  let subqueries: Subquery[] = await planSubqueries({
    promptMd: input.brief,
    targetWordCount,
    subqueriesMin: depthConfig.subqueriesMin,
    subqueriesMax: depthConfig.subqueriesMax,
    availableProviders: availableProviderNames,
  });

  if (subqueries.length === 0) {
    throw new Error('Planner returned zero subqueries — cannot proceed');
  }

  // ---------------------------------------------------------------------------
  // Step 2: search (route providers per subquery, run in parallel, dedup)
  // ---------------------------------------------------------------------------
  const allSearchResults = await runSearch(subqueries, enabledProviders, log);

  // Depth-aware fetch cap with global ceiling.
  const naturalCap = subqueries.length * depthConfig.urlsPerSubquery;
  const cappedCount = Math.min(naturalCap, CUMULATIVE_URL_CEILING);
  const urlsToFetch = allSearchResults.slice(0, Math.min(allSearchResults.length, cappedCount));

  // ---------------------------------------------------------------------------
  // Step 3: fetch content
  // ---------------------------------------------------------------------------
  const markdownByUrl = await fetchContent(urlsToFetch, enabledProviders, log);

  // ---------------------------------------------------------------------------
  // Step 4: extract quotes → per-section maps
  // ---------------------------------------------------------------------------
  const extraction = await extractQuotes(
    subqueries,
    allSearchResults,
    markdownByUrl,
    enabledProviders,
    depthConfig.urlsPerSubquery,
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
      subqueriesMin: depthConfig.subqueriesMin,
      subqueriesMax: depthConfig.subqueriesMax,
      availableProviders: availableProviderNames,
    });

    if (additionalSubqueries.length === 0) {
      break;
    }

    subqueries = [...subqueries, ...additionalSubqueries];

    // Extra search for the refinement subqueries only.
    const extraResults = await runSearch(additionalSubqueries, enabledProviders, log);
    const extraToFetch = extraResults.slice(0, Math.min(extraResults.length, CUMULATIVE_URL_CEILING));
    const extraMarkdown = await fetchContent(extraToFetch, enabledProviders, log);

    const extraExtraction = await extractQuotes(
      additionalSubqueries,
      extraResults,
      extraMarkdown,
      enabledProviders,
      depthConfig.urlsPerSubquery,
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
  };
}

// =============================================================================
// Internal stage helpers
// =============================================================================

type EnabledProviders = ReturnType<typeof getEnabledProviders>;

/** Route + run searches for a set of subqueries, deduped by canonical URL. */
async function runSearch(
  subqueries: Subquery[],
  enabledProviders: EnabledProviders,
  log: Logger,
): Promise<SearchResult[]> {
  const perSubqueryResults = await Promise.all(
    subqueries.map(async (subquery): Promise<SearchResult[]> => {
      const providerNames = new Set<ProviderName>(subquery.providers);
      for (const pn of routeProvidersForSourceTypes(subquery.expected_source_types)) {
        providerNames.add(pn);
      }

      const subResults: SearchResult[] = [];
      const subSeen = new Set<string>();

      const tasks: Array<Promise<SearchResult[]>> = [];
      for (const providerName of providerNames) {
        const provider = enabledProviders[providerName];
        if (provider === undefined) {
          continue;
        }
        tasks.push(
          (async (): Promise<SearchResult[]> => {
            try {
              return await provider.search(subquery.query, { limit: SEARCH_RESULT_LIMIT });
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
          })(),
        );
      }

      const chunkResults = await Promise.all(tasks);
      for (const resultSet of chunkResults) {
        for (const result of resultSet) {
          const canonical = canonicalizeUrl(result.url);
          const hash = hashUrl(canonical);
          if (!subSeen.has(hash)) {
            subSeen.add(hash);
            subResults.push({ ...result, url: canonical });
          }
        }
      }
      return subResults;
    }),
  );

  // Cross-subquery dedup.
  const merged: SearchResult[] = [];
  const seen = new Set<string>();
  for (const subResults of perSubqueryResults) {
    for (const result of subResults) {
      const hash = hashUrl(result.url);
      if (!seen.has(hash)) {
        seen.add(hash);
        merged.push(result);
      }
    }
  }
  log.info({ total: merged.length }, '[runDeepResearch] Search phase complete');
  return merged;
}

/** Fetch markdown content for a set of results — provider.fetch, else crawl4ai. */
async function fetchContent(
  results: SearchResult[],
  enabledProviders: EnabledProviders,
  log: Logger,
): Promise<Record<string, string>> {
  const markdownByUrl: Record<string, string> = {};
  const crawl4aiProvider = enabledProviders['crawl4ai'];

  await Promise.all(
    results.map(async (result) => {
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
      }
    }),
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
  log: Logger,
): Promise<ExtractionMaps> {
  // Map each subquery's section to the URLs it should draw from.
  const sectionToUrls = new Map<string, string[]>();
  for (const subquery of subqueries) {
    const sectionUrls: string[] = [];
    for (const result of allSearchResults) {
      if (subquery.providers.includes(result.provider)) {
        sectionUrls.push(result.url);
        if (sectionUrls.length >= urlsPerSubquery) {
          break;
        }
      }
    }
    sectionToUrls.set(subquery.section_path, sectionUrls);
  }

  const quotesBySection: Record<string, VerbatimQuote[]> = {};
  const claimsBySection: Record<string, { claim: string; source_url: string; provider: ProviderName }[]> = {};
  const sourceQuotesByUrl: Record<string, VerbatimQuote[]> = {};
  const providerCoverageBySection: Record<string, ProviderName[]> = {};

  const resultsWithContent = allSearchResults.filter(
    (r) => markdownByUrl[r.url] !== undefined && markdownByUrl[r.url].length > 0,
  );

  await Promise.all(
    resultsWithContent.map(async (result) => {
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
    }),
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
  const rerankedQuotesByPath: Record<string, VerbatimQuote[]> = {};
  for (const spec of sectionsToWrite) {
    const raw = quotesBySection[spec.section_path];
    if (raw === undefined || raw.length === 0) {
      rerankedQuotesByPath[spec.section_path] = [];
      continue;
    }
    const rerankResult = await rerankQuotes({ query: spec.goal, quotes: raw, topK: RERANK_TOP_K });
    rerankedQuotesByPath[spec.section_path] = rerankResult.quotes;
  }

  // Voyage rerank-2 cost (matches runner's estimate: ~650 tokens/section @ $0.05/M).
  costTracker.record({
    provider: 'voyage',
    category: 'embed',
    units: sectionsToWrite.length * 650,
    unit_cost_usd: 0.05 / 1_000_000,
    metadata: { operation: 'rerank-2', sections: sectionsToWrite.length },
  });

  const synthesized = await synthesizeAllSections({
    sectionsToWrite,
    quotesByPath: rerankedQuotesByPath,
    claimsByPath: claimsBySection,
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
