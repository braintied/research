/**
 * Answer engine — Perplexity-parity cited quick answers on the self-hosted
 * stack (2026-07-09).
 *
 * One search (SearXNG, free; Serper fallback when thin) → fetch the top few
 * URLs via Crawl4AI (skipped when the search snippet is already substantial)
 * → ONE cheap-model synthesis with inline [n] citations. Targets <15s warm
 * and ~$0.002–0.01/query — the drop-in replacement for the high-volume
 * "quick answer with citations" Perplexity call sites, while `kind: 'managed'`
 * remains the premium hosted option.
 */

import { searxngSearch, recencyDaysToTimeRange } from './providers/searxng.js';
import { serperProvider } from './providers/serper.js';
import { crawlWithCrawl4AI } from './pipeline-core.js';
import { synthesisGenerate } from './synthesis.js';
import { getModelPricing } from './depth-config.js';
import type { FinalReport } from './types.js';
import { logger as defaultLogger } from './logger.js';
import type { Logger } from './logger.js';

const ANSWER_SYNTH_MODEL_DEFAULT = 'gemini-3-flash-preview';
const SEARCH_LIMIT = 8;
const MIN_SEARCH_RESULTS_BEFORE_PAID = 3;
const MAX_SOURCES_TO_READ = 5;
/** Search snippets at least this long skip the Crawl4AI fetch entirely. */
const SNIPPET_SUFFICIENT_CHARS = 1_500;
const FETCH_TIMEOUT_MS = 8_000;
const PER_SOURCE_CONTENT_CHARS = 6_000;
const SYNTH_MAX_TOKENS = 1_500;
/** Serper flat per-search cost (mirrors SEARCH_COST_PER_CALL_USD). */
const SERPER_COST_USD = 0.001;

export interface RunAnswerInput {
  /** The question to answer. */
  query: string;
  /** Restrict sources to the last N days (SearXNG time_range buckets). */
  recencyDays?: number;
  /** How many sources to read (default 5, max 8). */
  maxSources?: number;
  /** Synthesis model (resolveSynthesisModel prefixes). Default gemini-3-flash-preview. */
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
}

export interface RunAnswerResult {
  /** The cited answer in markdown, [n] anchors matching `citations`. */
  answer: string;
  citations: AnswerCitation[];
  costUsd: number;
  durationMs: number;
  /** Which search backend supplied results: 'searxng', 'serper', or 'searxng+serper'. */
  searchBackend: string;
  /** FinalReport-shaped view so `runResearch({kind:'answer'})` matches other kinds. */
  report: FinalReport;
}

interface AnswerSource {
  title: string;
  url: string;
  content: string;
  fetched: boolean;
}

async function fetchSourceContent(url: string, snippet: string, log: Logger): Promise<{ content: string; fetched: boolean }> {
  if (snippet.length >= SNIPPET_SUFFICIENT_CHARS) {
    return { content: snippet, fetched: false };
  }
  try {
    const raced = await Promise.race([
      crawlWithCrawl4AI(url),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
    ]);
    if (raced !== null && raced.trim().length > snippet.length) {
      return { content: raced.slice(0, PER_SOURCE_CONTENT_CHARS), fetched: true };
    }
  } catch (err: unknown) {
    log.warn(
      { url: url.slice(0, 80), error: err instanceof Error ? err.message.slice(0, 120) : String(err) },
      '[runAnswer] fetch failed — using snippet',
    );
  }
  return { content: snippet, fetched: false };
}

/**
 * Answer a question with inline citations using the self-hosted search stack.
 */
export async function runAnswer(input: RunAnswerInput): Promise<RunAnswerResult> {
  const log = input.logger !== undefined ? input.logger : defaultLogger;
  const startedAt = Date.now();
  const maxSources = Math.min(input.maxSources !== undefined ? input.maxSources : MAX_SOURCES_TO_READ, SEARCH_LIMIT);
  const synthModel = input.synthesisModelOverride !== undefined && input.synthesisModelOverride.length > 0
    ? input.synthesisModelOverride
    : ANSWER_SYNTH_MODEL_DEFAULT;

  let costUsd = 0;

  // -- Search: SearXNG first, Serper only when thin ---------------------------
  let searchBackend = 'searxng';
  const candidates: { title: string; url: string; snippet: string }[] = [];
  const seenUrls = new Set<string>();

  const searxng = await searxngSearch(input.query, {
    limit: SEARCH_LIMIT,
    timeRange: recencyDaysToTimeRange(input.recencyDays),
  });
  for (const r of searxng.results) {
    if (seenUrls.has(r.url)) continue;
    seenUrls.add(r.url);
    candidates.push({ title: r.title, url: r.url, snippet: r.snippet });
  }

  if (candidates.length < MIN_SEARCH_RESULTS_BEFORE_PAID && serperProvider.enabled) {
    try {
      const serperResults = await serperProvider.search(input.query, { limit: SEARCH_LIMIT });
      costUsd += SERPER_COST_USD;
      searchBackend = candidates.length > 0 ? 'searxng+serper' : 'serper';
      for (const r of serperResults) {
        if (seenUrls.has(r.url)) continue;
        seenUrls.add(r.url);
        candidates.push({ title: r.title, url: r.url, snippet: r.snippet });
      }
    } catch (err: unknown) {
      log.warn(
        { error: err instanceof Error ? err.message.slice(0, 120) : String(err) },
        '[runAnswer] serper fallback failed (non-fatal)',
      );
    }
  }

  if (candidates.length === 0) {
    throw new Error(`runAnswer: no search results for "${input.query.slice(0, 80)}" (backend: ${searchBackend})`);
  }

  // -- Fetch top sources (parallel, snippet fallback) --------------------------
  const top = candidates.slice(0, maxSources);
  const sources: AnswerSource[] = await Promise.all(
    top.map(async (c): Promise<AnswerSource> => {
      const { content, fetched } = await fetchSourceContent(c.url, c.snippet, log);
      return { title: c.title, url: c.url, content, fetched };
    }),
  );

  // -- Single synthesis call ----------------------------------------------------
  const sourceBlocks = sources
    .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content}`)
    .join('\n\n---\n\n');

  const system = input.systemPromptOverride !== undefined && input.systemPromptOverride.length > 0
    ? `${input.systemPromptOverride}\n\nBase your response ONLY on the numbered sources provided.`
    : 'You answer questions using ONLY the numbered sources provided. '
      + 'Write a direct, concise answer in markdown. Cite every factual claim inline with [n] '
      + 'matching the source numbers. If the sources do not answer the question, say what is '
      + 'missing instead of guessing. No preamble.';
  const user = `Question: ${input.query}\n\nSources:\n\n${sourceBlocks}`;

  const synth = await synthesisGenerate({
    system,
    user,
    model: synthModel,
    maxTokens: SYNTH_MAX_TOKENS,
  });

  const pricing = getModelPricing(synthModel);
  costUsd += (synth.inputTokens / 1_000_000) * pricing.inputUsdPerM
    + (synth.outputTokens / 1_000_000) * pricing.outputUsdPerM;

  const citations: AnswerCitation[] = sources.map((s, i) => ({ index: i + 1, title: s.title, url: s.url }));
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
      provider: 'searxng' as const,
    })),
    gaps: [],
    word_count: answer.trim().split(/\s+/).filter((w) => w.length > 0).length,
  };

  log.info(
    {
      query: input.query.slice(0, 60),
      sources: sources.length,
      fetched: sources.filter((s) => s.fetched).length,
      backend: searchBackend,
      model: synthModel,
      costUsd: Number(costUsd.toFixed(5)),
      durationMs,
    },
    '[runAnswer] complete',
  );

  return { answer, citations, costUsd, durationMs, searchBackend, report };
}
