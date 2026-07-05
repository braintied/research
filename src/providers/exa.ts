/**
 * Exa Search Provider
 *
 * Wraps Exa Search API (https://api.exa.ai/search).
 * Neural search with autoprompt. Rate limit: 60 req/min.
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
// Rate limiter — 60 req/min = 1 req per 1000ms
// =============================================================================

const EXA_RATE_LIMIT_MS = 1050;
let lastExaCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastExaCallAt;
  if (elapsed < EXA_RATE_LIMIT_MS) {
    await sleep(EXA_RATE_LIMIT_MS - elapsed);
  }
  lastExaCallAt = Date.now();
}

// =============================================================================
// Exa API response schema
// =============================================================================

const ExaResultItemSchema = z.object({
  id: z.string().default(''),
  url: z.string(),
  title: z.string().default(''),
  text: z.string().default(''),
  publishedDate: z.string().optional(),
  author: z.string().optional(),
  score: z.number().optional(),
});

const ExaResponseSchema = z.object({
  results: z.array(ExaResultItemSchema).default([]),
});

// =============================================================================
// Provider
// =============================================================================

const EXA_API_URL = 'https://api.exa.ai/search';

function getApiKey(): string {
  const key = process.env.EXA_API_KEY;
  if (key === undefined || key === '') {
    throw new Error('EXA_API_KEY environment variable is not configured');
  }
  return key;
}

function isEnabled(): boolean {
  const key = process.env.EXA_API_KEY;
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

export const exaProvider: SearchProvider = {
  name: 'exa',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const apiKey = getApiKey();
    await rateLimit();

    const body: Record<string, unknown> = {
      query,
      numResults: opts.limit !== undefined ? opts.limit : 10,
      useAutoprompt: true,
      type: 'neural',
      contents: {
        text: { maxCharacters: 500 },
      },
    };

    if (opts.recency_days !== undefined && opts.recency_days > 0) {
      const cutoff = new Date(Date.now() - opts.recency_days * 24 * 60 * 60 * 1000);
      body['startPublishedDate'] = cutoff.toISOString();
    }

    const response = await fetch(EXA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Exa API error: ${response.status} ${errorBody.slice(0, 200)}`);
    }

    const rawJson: unknown = await response.json();
    const parsed = ExaResponseSchema.safeParse(rawJson);

    if (!parsed.success) {
      logger.warn({ query: query.slice(0, 60), errors: parsed.error.message }, '[Exa] Invalid response shape');
      return [];
    }

    const results: SearchResult[] = [];

    for (const item of parsed.data.results) {
      const publishedAt = item.publishedDate !== undefined ? toIsoString(item.publishedDate) : undefined;

      const candidate = {
        provider: 'exa' as const,
        url: item.url,
        canonical_id: item.id.length > 0 ? item.id : undefined,
        title: item.title,
        snippet: item.text.slice(0, 500),
        author: item.author,
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
      '[Exa] Search complete',
    );

    return results;
  },
};
