/**
 * Answer engine — Perplexity-parity cited quick answers (2026-07-25).
 *
 * One search, then ONE cheap-model synthesis with inline [n] citations.
 * Targets <15s warm and ~$0.002–0.01/query — the drop-in replacement for the
 * high-volume "quick answer with citations" Perplexity call sites, while
 * `kind: 'managed'` remains the premium hosted option.
 *
 * Search cascade (first tier that returns enough results wins):
 *
 *   1. Tavily      — `include_raw_content` returns server-side page extraction
 *                    INLINE with the results, so a substantial hit needs no
 *                    crawl at all. Tavily's extraction also survives JS,
 *                    paywalls, and bot-walls that defeat a headless re-crawl.
 *   2. SearXNG     — free self-hosted breadth, snippets only.
 *   3. Serper      — paid last resort when the free tiers come back thin.
 *
 * This mirrors the raw-content short-circuit in runDeepResearch. Leading with
 * Tavily is both higher quality AND fewer round-trips: every raw-content hit
 * removes a crawl that SearXNG-first would have forced.
 */

import { vendorUnitCostUsd } from '@braintied/cost';
import { createTavilyProvider } from './providers/tavily.js';
import { searxngSearch, recencyDaysToTimeRange } from './providers/searxng.js';
import { createSerperProvider } from './providers/serper.js';
import { crawlWithCrawl4AI } from './pipeline-core.js';
import type { ResearchCredentials } from './credentials.js';
import { synthesisGenerate } from './synthesis.js';
import { getModelPricing } from './depth-config.js';
import type { FinalReport, ProviderName } from './types.js';
import { safeLogger } from './logger.js';
import type { Logger } from './logger.js';

import { resolveResearchSynthesisModel } from './model-policy.js';

function answerSynthModelDefault(): string {
  return resolveResearchSynthesisModel('answer');
}
const SEARCH_LIMIT = 8;
const MIN_SEARCH_RESULTS_BEFORE_PAID = 3;
const MAX_SOURCES_TO_READ = 5;
/** Search snippets at least this long skip the Crawl4AI fetch entirely. */
const SNIPPET_SUFFICIENT_CHARS = 1_500;
/**
 * Tavily raw_content at least this long is treated as a completed fetch.
 * Mirrors the runDeepResearch short-circuit threshold so both entry points
 * make the same call on the same page.
 */
const RAW_CONTENT_SUFFICIENT_CHARS = 800;
const FETCH_TIMEOUT_MS = 8_000;
const PER_SOURCE_CONTENT_CHARS = 6_000;
const SYNTH_MAX_TOKENS = 1_500;

function requireSearchUnitCost(vendor: 'tavily' | 'serper'): number {
  const usd = vendorUnitCostUsd(vendor);
  if (usd === undefined) {
    throw new Error(`@braintied/cost is missing a unit rate for ${vendor}`);
  }
  return usd;
}

const SERPER_COST_USD = requireSearchUnitCost('serper');
const TAVILY_COST_USD = requireSearchUnitCost('tavily');

export interface RunAnswerInput {
  /** Host-resolved credentials; search tiers and the synthesis model come from it. */
  credentials: ResearchCredentials;
  /** The question to answer. */
  query: string;
  /** Restrict sources to the last N days (SearXNG time_range buckets). */
  recencyDays?: number;
  /** How many sources to read (default 5, max 8). */
  maxSources?: number;
  /** Synthesis model (resolveSynthesisModel prefixes). Default gemini-3.6-flash. */
  synthesisModelOverride?: string;
  /**
   * Replace the default cited-answer system prompt entirely — for callers
   * that want web-grounded STRUCTURED output (e.g. "return only JSON") where
   * inline [n] citations would corrupt the format. Sources are still passed
   * as the numbered user-message blocks; grounding language is appended.
   */
  systemPromptOverride?: string;
  logger?: Logger;
}

export interface AnswerCitation {
  index: number;
  title: string;
  url: string;
  /** Which search provider surfaced this source. */
  provider: ProviderName;
}

export interface RunAnswerResult {
  /** The cited answer in markdown, [n] anchors matching `citations`. */
  answer: string;
  citations: AnswerCitation[];
  costUsd: number;
  durationMs: number;
  /**
   * Which search tier(s) supplied results, in the order they ran — e.g.
   * 'tavily', 'searxng+serper', 'tavily+searxng'.
   */
  searchBackend: string;
  /** FinalReport-shaped view so `runResearch({kind:'answer'})` matches other kinds. */
  report: FinalReport;
}

/** How a source's text was obtained — drives the crawl-avoidance log line. */
type ContentOrigin = 'search_raw_content' | 'snippet' | 'crawl';

interface AnswerCandidate {
  title: string;
  url: string;
  snippet: string;
  /** Server-side page extraction returned inline by the search API (Tavily). */
  rawContent: string;
  provider: ProviderName;
}

interface AnswerSource {
  title: string;
  url: string;
  content: string;
  provider: ProviderName;
  origin: ContentOrigin;
}

async function fetchSourceContent(
  credentials: ResearchCredentials,
  candidate: AnswerCandidate,
  log: Logger,
): Promise<{ content: string; origin: ContentOrigin }> {
  // The search API already extracted this page server-side. That extraction
  // survives JS/paywalls/bot-walls a headless re-crawl would fail on, so it is
  // both cheaper AND better than crawling the same URL again.
  if (candidate.rawContent.length >= RAW_CONTENT_SUFFICIENT_CHARS) {
    return {
      content: candidate.rawContent.slice(0, PER_SOURCE_CONTENT_CHARS),
      origin: 'search_raw_content',
    };
  }
  if (candidate.snippet.length >= SNIPPET_SUFFICIENT_CHARS) {
    return { content: candidate.snippet, origin: 'snippet' };
  }
  try {
    const raced = await Promise.race([
      crawlWithCrawl4AI(credentials, candidate.url),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
    ]);
    if (raced !== null && raced.trim().length > candidate.snippet.length) {
      return { content: raced.slice(0, PER_SOURCE_CONTENT_CHARS), origin: 'crawl' };
    }
  } catch (err: unknown) {
    log.warn(
      { url: candidate.url.slice(0, 80), error: err instanceof Error ? err.message.slice(0, 120) : String(err) },
      '[runAnswer] fetch failed — using snippet',
    );
  }
  return { content: candidate.snippet, origin: 'snippet' };
}

/**
 * Derive the text to SEARCH from a caller prompt. Migrated Perplexity call
 * sites pass full LLM prompts ("List 10 competitors… Respond with ONLY a JSON
 * object matching this schema: {…}") — feeding format instructions to a search
 * engine returns zero results. Cut at the first output-format directive and
 * cap length; the FULL prompt still goes to synthesis.
 */
export function deriveSearchQuery(query: string): string {
  const formatDirective = /respond with|return only|return exactly|return a json|return json|as a json|output json|json (array|object)|no prose|no markdown/i;
  const match = formatDirective.exec(query);
  let searchable = match !== null ? query.slice(0, match.index) : query;
  // Multi-line prompts ("Research X\n\nContext: …\nAnswer these questions: …")
  // search terribly — the first line is the searchable intent.
  const firstLine = searchable.split('\n')[0].trim();
  if (firstLine.length >= 20) {
    searchable = firstLine;
  }
  // Strip double quotes: prompts quote entity names ("Inference-Optimization")
  // which SearXNG treats as exact-match and returns zero results for.
  searchable = searchable.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
  if (searchable.length > 300) {
    const cut = searchable.slice(0, 300);
    const lastSpace = cut.lastIndexOf(' ');
    searchable = cut.slice(0, lastSpace > 200 ? lastSpace : 300);
  }
  return searchable.length > 0 ? searchable : query.slice(0, 300);
}

/**
 * Answer a question with inline citations using the self-hosted search stack.
 */
export async function runAnswer(input: RunAnswerInput): Promise<RunAnswerResult> {
  const log = safeLogger(input.logger);
  const tavilyProvider = createTavilyProvider(input.credentials);
  const serperProvider = createSerperProvider(input.credentials);
  const startedAt = Date.now();
  const maxSources = Math.min(input.maxSources !== undefined ? input.maxSources : MAX_SOURCES_TO_READ, SEARCH_LIMIT);
  const synthModel = input.synthesisModelOverride !== undefined && input.synthesisModelOverride.length > 0
    ? input.synthesisModelOverride
    : answerSynthModelDefault();

  let costUsd = 0;

  // -- Search: Tavily first, free breadth next, paid last ---------------------
  const tiersUsed: string[] = [];
  const candidates: AnswerCandidate[] = [];
  const seenUrls = new Set<string>();

  const searchQuery = deriveSearchQuery(input.query);

  const addCandidate = (
    candidate: AnswerCandidate,
  ): void => {
    if (seenUrls.has(candidate.url)) return;
    seenUrls.add(candidate.url);
    candidates.push(candidate);
  };

  // Tier 1 — Tavily. Best extraction, and raw_content removes a crawl per hit.
  if (tavilyProvider.enabled) {
    try {
      const tavilyResults = await tavilyProvider.search(searchQuery, {
        limit: SEARCH_LIMIT,
        recency_days: input.recencyDays,
      });
      costUsd += TAVILY_COST_USD;
      tiersUsed.push('tavily');
      for (const r of tavilyResults) {
        const raw = r.raw_metadata['raw_content'];
        addCandidate({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          rawContent: typeof raw === 'string' ? raw : '',
          provider: 'tavily',
        });
      }
    } catch (err: unknown) {
      log.warn(
        { error: err instanceof Error ? err.message.slice(0, 120) : String(err) },
        '[runAnswer] tavily search failed (non-fatal, falling through)',
      );
    }
  }

  // Tier 2 — SearXNG. Free breadth when Tavily is absent or came back thin.
  if (candidates.length < MIN_SEARCH_RESULTS_BEFORE_PAID) {
    try {
      const searxng = await searxngSearch(input.credentials, searchQuery, {
        limit: SEARCH_LIMIT,
        timeRange: recencyDaysToTimeRange(input.recencyDays),
      });
      if (searxng.results.length > 0) tiersUsed.push('searxng');
      for (const r of searxng.results) {
        addCandidate({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          rawContent: '',
          provider: 'searxng',
        });
      }
    } catch (err: unknown) {
      log.warn(
        { error: err instanceof Error ? err.message.slice(0, 120) : String(err) },
        '[runAnswer] searxng search failed (non-fatal, falling through)',
      );
    }
  }

  // Tier 3 — Serper. Paid, only when both free-of-charge tiers came back thin.
  if (candidates.length < MIN_SEARCH_RESULTS_BEFORE_PAID && serperProvider.enabled) {
    try {
      const serperResults = await serperProvider.search(searchQuery, { limit: SEARCH_LIMIT });
      costUsd += SERPER_COST_USD;
      tiersUsed.push('serper');
      for (const r of serperResults) {
        addCandidate({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          rawContent: '',
          provider: 'serper',
        });
      }
    } catch (err: unknown) {
      log.warn(
        { error: err instanceof Error ? err.message.slice(0, 120) : String(err) },
        '[runAnswer] serper fallback failed (non-fatal)',
      );
    }
  }

  const searchBackend = tiersUsed.length > 0 ? tiersUsed.join('+') : 'none';

  if (candidates.length === 0) {
    throw new Error(
      `runAnswer: no search results for "${input.query.slice(0, 80)}" (tiers attempted: ${searchBackend}). `
      + 'Set TAVILY_API_KEY for the primary tier, or SEARXNG_URLS for the free fallback.',
    );
  }

  // -- Fetch top sources (parallel; raw_content and snippets skip the crawl) ---
  const top = candidates.slice(0, maxSources);
  const sources: AnswerSource[] = await Promise.all(
    top.map(async (c): Promise<AnswerSource> => {
      const { content, origin } = await fetchSourceContent(input.credentials, c, log);
      return { title: c.title, url: c.url, content, provider: c.provider, origin };
    }),
  );

  // -- Single synthesis call ----------------------------------------------------
  const sourceBlocks = sources
    .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content}`)
    .join('\n\n---\n\n');

  // Override mode uses Perplexity semantics — web results as supporting
  // context on top of model knowledge (strict source-only grounding made the
  // model refuse structured-output tasks whenever the SERP was thin). The
  // default cited-answer mode stays strictly grounded.
  const system = input.systemPromptOverride !== undefined && input.systemPromptOverride.length > 0
    ? `${input.systemPromptOverride}\n\nUse the numbered web sources below as supporting context; `
      + 'combine them with your own knowledge when they are incomplete.'
    : 'You answer questions using ONLY the numbered sources provided. '
      + 'Write a direct, concise answer in markdown. Cite every factual claim inline with [n] '
      + 'matching the source numbers. If the sources do not answer the question, say what is '
      + 'missing instead of guessing. No preamble.';
  const user = `Question: ${input.query}\n\nSources:\n\n${sourceBlocks}`;

  const synth = await synthesisGenerate({
    credentials: input.credentials,
    system,
    user,
    model: synthModel,
    maxTokens: SYNTH_MAX_TOKENS,
  });

  const pricing = getModelPricing(synthModel);
  costUsd += (synth.inputTokens / 1_000_000) * pricing.inputUsdPerM
    + (synth.outputTokens / 1_000_000) * pricing.outputUsdPerM;

  const citations: AnswerCitation[] = sources.map((s, i) => ({
    index: i + 1,
    title: s.title,
    url: s.url,
    provider: s.provider,
  }));
  const durationMs = Date.now() - startedAt;

  const answer = synth.text.trim();
  const report: FinalReport = {
    title: input.query.slice(0, 200),
    executive_summary: answer.slice(0, 1_000),
    full_markdown: answer,
    sections: [{
      section_path: 'answer',
      heading: 'Answer',
      level: 2,
      body_md: answer,
      word_count: answer.trim().split(/\s+/).filter((w) => w.length > 0).length,
      source_urls: citations.map((c) => c.url),
      inline_citations: citations.map((c) => ({
        anchor: `[${c.index}]`,
        source_url: c.url,
        quote_excerpt: '',
      })),
    }],
    bibliography: citations.map((c) => ({
      citation_anchor: `[${c.index}]`,
      source_url: c.url,
      title: c.title,
      author: '',
      provider: c.provider,
    })),
    gaps: [],
    word_count: answer.trim().split(/\s+/).filter((w) => w.length > 0).length,
  };

  log.info(
    {
      query: input.query.slice(0, 60),
      sources: sources.length,
      // Crawls avoided because the search API already returned the page body.
      fromSearchRawContent: sources.filter((s) => s.origin === 'search_raw_content').length,
      crawled: sources.filter((s) => s.origin === 'crawl').length,
      backend: searchBackend,
      model: synthModel,
      costUsd: Number(costUsd.toFixed(5)),
      durationMs,
    },
    '[runAnswer] complete',
  );

  return { answer, citations, costUsd, durationMs, searchBackend, report };
}
