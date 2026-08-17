/**
 * Tavily Search Provider
 *
 * Wraps Tavily Search API (https://api.tavily.com/search).
 * Implements SearchProvider with a simple in-memory token-bucket rate limiter
 * capped at 100 requests/minute (free tier).
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { sleep } from '../pipeline-core.js';
import { MissingCredentialError, type ResearchCredentials } from '../credentials.js';
import {
  SearchResultSchema,
  type SearchProvider,
  type SearchResult,
  type SearchOpts,
} from '../types.js';

// =============================================================================
// Rate limiter — 100 req/min = 1 req per 600ms minimum
// =============================================================================

const TAVILY_RATE_LIMIT_MS = 620; // slightly above 600ms for safety margin

let lastTavilyCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastTavilyCallAt;
  if (elapsed < TAVILY_RATE_LIMIT_MS) {
    await sleep(TAVILY_RATE_LIMIT_MS - elapsed);
  }
  lastTavilyCallAt = Date.now();
}

// =============================================================================
// Tavily API response schema
// =============================================================================

const TavilyResultItemSchema = z.object({
  title: z.string().default(''),
  url: z.string(),
  content: z.string().default(''),
  raw_content: z.string().nullable().optional(),
  score: z.number().default(0),
  published_date: z.string().optional(),
});

const TavilyResponseSchema = z.object({
  results: z.array(TavilyResultItemSchema).default([]),
});

// =============================================================================
// Provider
// =============================================================================

const TAVILY_API_URL = 'https://api.tavily.com/search';

function requireApiKey(credentials: ResearchCredentials): string {
  if (credentials.tavilyApiKey === undefined) {
    throw new MissingCredentialError('tavilyApiKey', 'required for the Tavily search lane');
  }
  return credentials.tavilyApiKey;
}

function toIsoString(dateStr: string): string | undefined {
  if (dateStr.length === 0) return undefined;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString();
  } catch {
    return undefined;
  }
}

// =============================================================================
// Answer primitive
// =============================================================================

export interface TavilyAnswerOptions {
  /** Default 8. */
  maxResults?: number;
  /** 'basic' is cheaper; default 'advanced'. */
  searchDepth?: 'basic' | 'advanced';
  includeDomains?: string[];
  excludeDomains?: string[];
  /**
   * Ask Tavily for server-side page extraction inline with each result.
   * 'markdown' | 'text' pick the format; false (default) omits it. Callers that
   * need page bodies should set this rather than re-crawling each URL — the
   * extraction survives JS/paywalls/bot-walls a headless crawl fails on.
   */
  includeRawContent?: false | 'markdown' | 'text';
  signal?: AbortSignal;
}

export interface TavilyAnswerResult {
  /** Tavily's native synthesized answer. Empty string when it returns none. */
  answer: string;
  results: {
    title: string;
    url: string;
    content: string;
    score?: number;
    rawContent?: string;
  }[];
}

/**
 * Run a Tavily search asking for its NATIVE answer.
 *
 * `tavilyProvider.search()` sets `include_answer: false` on purpose — the
 * pipeline wants raw sources to synthesize over, not Tavily's own summary — and
 * maps results into `SearchResult[]`, which has nowhere to put an answer. A
 * caller that specifically wants "query in, answer out" therefore had no way to
 * use the provider and kept its own `fetch`.
 *
 * This asks for `include_answer: true` and returns it verbatim. Tavily's answer
 * is generated server-side and included in the same billed search, so this
 * costs exactly what a plain search costs — unlike routing through
 * `runAnswer()`, which adds an LLM synthesis pass.
 *
 * Tavily rejects queries over 400 characters with HTTP 400, so the query is
 * truncated at a word boundary rather than failing the call.
 */
export async function tavilyAnswer(
  credentials: ResearchCredentials,
  query: string,
  options: TavilyAnswerOptions = {},
): Promise<TavilyAnswerResult> {
  const apiKey = requireApiKey(credentials);
  await rateLimit();

  const TAVILY_MAX_QUERY_LENGTH = 400;
  let safeQuery = query;
  if (query.length > TAVILY_MAX_QUERY_LENGTH) {
    const truncated = query.slice(0, TAVILY_MAX_QUERY_LENGTH);
    const lastSpace = truncated.lastIndexOf(' ');
    safeQuery = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
    logger.warn(
      { originalLength: query.length, truncatedLength: safeQuery.length },
      '[Tavily] Query truncated to fit the 400-char limit',
    );
  }

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query: safeQuery,
    search_depth: options.searchDepth !== undefined ? options.searchDepth : 'advanced',
    include_answer: true,
    include_raw_content:
      options.includeRawContent !== undefined ? options.includeRawContent : false,
    max_results: options.maxResults !== undefined ? options.maxResults : 8,
  };
  if (options.includeDomains !== undefined && options.includeDomains.length > 0) {
    body['include_domains'] = options.includeDomains;
  }
  if (options.excludeDomains !== undefined && options.excludeDomains.length > 0) {
    body['exclude_domains'] = options.excludeDomains;
  }

  const response = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // Bounded: a dead host must not stall a user-facing request.
    signal: options.signal !== undefined ? options.signal : AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Tavily API error: ${response.status} ${errText.slice(0, 200)}`);
  }

  const data: unknown = await response.json();
  const parsed = TavilyAnswerResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Tavily returned an unexpected response shape: ${parsed.error.message}`);
  }

  return {
    answer: parsed.data.answer,
    results: parsed.data.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
      rawContent: r.raw_content !== null && r.raw_content !== undefined ? r.raw_content : undefined,
    })),
  };
}

const TavilyAnswerResponseSchema = z.object({
  answer: z.string().default(''),
  results: z
    .array(
      z.object({
        title: z.string().default(''),
        url: z.string(),
        content: z.string().default(''),
        score: z.number().optional(),
        raw_content: z.string().nullish(),
      }),
    )
    .default([]),
});

export function createTavilyProvider(credentials: ResearchCredentials): SearchProvider {
  return {
    name: 'tavily',

    capabilities: {
      search: true,
      fetch: false,
      extract: false,
      backends: ['tavily_search_raw_content', 'crawl4ai', 'direct_fetch'],
    },

    enabled: credentials.tavilyApiKey !== undefined,

    async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
      const apiKey = requireApiKey(credentials);
      await rateLimit();

      const body: Record<string, unknown> = {
        api_key: apiKey,
        query,
        search_depth: 'advanced',
        max_results: opts.limit !== undefined ? opts.limit : 10,
        include_answer: false,
        // Tavily's server-side extraction handles JS/paywalls/bot-walls far
        // better than a headless re-crawl of the same URL. The pipeline's fetch
        // stage short-circuits on raw_metadata.raw_content, saving a crawl per
        // web result (and rescuing pages the crawler can't render at all).
        include_raw_content: true,
      };

      if (opts.include_domains !== undefined && opts.include_domains.length > 0) {
        body['include_domains'] = opts.include_domains;
      }

      if (opts.exclude_domains !== undefined && opts.exclude_domains.length > 0) {
        body['exclude_domains'] = opts.exclude_domains;
      }

      if (opts.published_before !== undefined) {
        const upper = new Date(opts.published_before);
        if (!Number.isNaN(upper.getTime())) {
          body['end_date'] = upper.toISOString().slice(0, 10);
          if (opts.recency_days !== undefined && opts.recency_days > 0) {
            const lower = new Date(upper.getTime() - opts.recency_days * 86_400_000);
            body['start_date'] = lower.toISOString().slice(0, 10);
          }
        }
      } else if (opts.recency_days !== undefined && opts.recency_days > 0) {
        body['days'] = opts.recency_days;
      }

      const response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Tavily API error: ${response.status} ${errorBody.slice(0, 200)}`);
      }

      const rawJson: unknown = await response.json();
      const parsed = TavilyResponseSchema.safeParse(rawJson);

      if (!parsed.success) {
        logger.warn({ query: query.slice(0, 60), errors: parsed.error.message }, '[Tavily] Invalid response shape');
        return [];
      }

      const results: SearchResult[] = [];

      for (const item of parsed.data.results) {
        const publishedAt = item.published_date !== undefined ? toIsoString(item.published_date) : undefined;

        const rawContent = item.raw_content !== undefined && item.raw_content !== null
          ? item.raw_content
          : '';

        const candidate = {
          provider: 'tavily' as const,
          url: item.url,
          title: item.title,
          snippet: item.content.slice(0, 500),
          published_at: publishedAt,
          engagement: {
            score: item.score,
          },
          raw_metadata: {
            backend: 'tavily_search',
            ...(rawContent.length > 0 ? { raw_content: rawContent } : {}),
          },
        };

        const validated = SearchResultSchema.safeParse(candidate);
        if (validated.success) {
          results.push(validated.data);
        }
      }

      logger.info(
        { query: query.slice(0, 60), count: results.length },
        '[Tavily] Search complete',
      );

      return results;
    },
  };
}
