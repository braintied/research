/**
 * Perplexity Search Provider
 *
 * Wraps Perplexity's Sonar API (https://api.perplexity.ai/chat/completions).
 * `search()` runs a `sonar` query and maps the returned search_results /
 * citations into the shared SearchResult contract — useful when a subquery
 * benefits from an answer-engine pass alongside raw SERP results.
 *
 * The heavier managed end-to-end pipeline (`sonar-deep-research`) lives in
 * `src/managed-research.ts`, not here.
 *
 * Raw fetch, no SDK. Enabled when PERPLEXITY_API_KEY is set.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import {
  SearchResultSchema,
  type SearchProvider,
  type SearchResult,
  type SearchOpts,
} from '../types.js';

// =============================================================================
// Perplexity API response schema (subset we consume)
// =============================================================================

const PerplexitySearchResultItemSchema = z.object({
  title: z.string().default(''),
  url: z.string(),
  date: z.string().nullable().optional(),
});

const PerplexityResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().default(''),
      }),
    }),
  ).default([]),
  search_results: z.array(PerplexitySearchResultItemSchema).default([]),
  citations: z.array(z.string()).default([]),
});

// =============================================================================
// Provider
// =============================================================================

export const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

export function getPerplexityApiKey(): string {
  const key = process.env.PERPLEXITY_API_KEY;
  if (key === undefined || key === '') {
    throw new Error('PERPLEXITY_API_KEY environment variable is not configured');
  }
  return key;
}

function isEnabled(): boolean {
  const key = process.env.PERPLEXITY_API_KEY;
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

export const perplexityProvider: SearchProvider = {
  name: 'perplexity',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const apiKey = getPerplexityApiKey();

    const body: Record<string, unknown> = {
      model: 'sonar',
      messages: [
        {
          role: 'user',
          content: query,
        },
      ],
      max_tokens: 512,
    };

    if (opts.recency_days !== undefined && opts.recency_days > 0) {
      if (opts.recency_days <= 1) {
        body['search_recency_filter'] = 'day';
      } else if (opts.recency_days <= 7) {
        body['search_recency_filter'] = 'week';
      } else if (opts.recency_days <= 31) {
        body['search_recency_filter'] = 'month';
      } else {
        body['search_recency_filter'] = 'year';
      }
    }

    const response = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Perplexity API error: ${response.status} ${errorBody.slice(0, 200)}`);
    }

    const rawJson: unknown = await response.json();
    const parsed = PerplexityResponseSchema.safeParse(rawJson);

    if (!parsed.success) {
      logger.warn({ query: query.slice(0, 60), errors: parsed.error.message }, '[Perplexity] Invalid response shape');
      return [];
    }

    const firstChoice = parsed.data.choices[0];
    const answer = firstChoice !== undefined ? firstChoice.message.content : '';
    const limit = opts.limit !== undefined ? opts.limit : 10;

    const results: SearchResult[] = [];

    // Prefer structured search_results; fall back to bare citation URLs.
    if (parsed.data.search_results.length > 0) {
      for (const item of parsed.data.search_results.slice(0, limit)) {
        const publishedAt =
          item.date !== null && item.date !== undefined ? toIsoString(item.date) : undefined;
        const candidate = {
          provider: 'perplexity' as const,
          url: item.url,
          title: item.title,
          snippet: answer.slice(0, 500),
          published_at: publishedAt,
          engagement: {},
          raw_metadata: {},
        };
        const validated = SearchResultSchema.safeParse(candidate);
        if (validated.success) {
          results.push(validated.data);
        }
      }
    } else {
      for (const url of parsed.data.citations.slice(0, limit)) {
        const candidate = {
          provider: 'perplexity' as const,
          url,
          title: '',
          snippet: answer.slice(0, 500),
          engagement: {},
          raw_metadata: {},
        };
        const validated = SearchResultSchema.safeParse(candidate);
        if (validated.success) {
          results.push(validated.data);
        }
      }
    }

    logger.info(
      { query: query.slice(0, 60), count: results.length },
      '[Perplexity] Search complete',
    );

    return results;
  },
};
