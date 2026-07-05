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

function getApiKey(): string {
  const key = process.env.TAVILY_API_KEY;
  if (key === undefined || key === '') {
    throw new Error('TAVILY_API_KEY environment variable is not configured');
  }
  return key;
}

function isEnabled(): boolean {
  const key = process.env.TAVILY_API_KEY;
  return key !== undefined && key !== '';
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

export const tavilyProvider: SearchProvider = {
  name: 'tavily',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const apiKey = getApiKey();
    await rateLimit();

    const body: Record<string, unknown> = {
      api_key: apiKey,
      query,
      search_depth: 'advanced',
      max_results: opts.limit !== undefined ? opts.limit : 10,
      include_answer: false,
      include_raw_content: false,
    };

    if (opts.include_domains !== undefined && opts.include_domains.length > 0) {
      body['include_domains'] = opts.include_domains;
    }

    if (opts.exclude_domains !== undefined && opts.exclude_domains.length > 0) {
      body['exclude_domains'] = opts.exclude_domains;
    }

    if (opts.recency_days !== undefined && opts.recency_days > 0) {
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

      const candidate = {
        provider: 'tavily' as const,
        url: item.url,
        title: item.title,
        snippet: item.content.slice(0, 500),
        published_at: publishedAt,
        engagement: {
          score: item.score,
        },
        raw_metadata: {},
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
