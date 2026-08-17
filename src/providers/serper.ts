/**
 * Serper Search Provider
 *
 * Wraps Serper (https://google.serper.dev/search) — Google SERP results with
 * the most generous free tier of the 2026 search-API landscape (2,500 free
 * queries/month, then ~$0.30–1.00 per 1k). Positioned as the cheap breadth
 * tier alongside self-hosted SearXNG, below Tavily's quality tier.
 *
 * Raw fetch, no SDK. Enabled when SERPER_API_KEY is set.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { MissingCredentialError, type ResearchCredentials } from '../credentials.js';
import {
  SearchResultSchema,
  type SearchProvider,
  type SearchResult,
  type SearchOpts,
} from '../types.js';

// =============================================================================
// Serper API response schema (organic results subset we consume)
// =============================================================================

const SerperOrganicItemSchema = z.object({
  title: z.string().default(''),
  link: z.string(),
  snippet: z.string().default(''),
  date: z.string().optional(),
  position: z.number().optional(),
});

const SerperResponseSchema = z.object({
  organic: z.array(SerperOrganicItemSchema).default([]),
});

// =============================================================================
// Provider
// =============================================================================

const SERPER_API_URL = 'https://google.serper.dev/search';

function requireApiKey(credentials: ResearchCredentials): string {
  if (credentials.serperApiKey === undefined) {
    throw new MissingCredentialError('serperApiKey', 'required for the Serper search lane');
  }
  return credentials.serperApiKey;
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

export function createSerperProvider(credentials: ResearchCredentials): SearchProvider {
  return {
    name: 'serper',

    enabled: credentials.serperApiKey !== undefined,

    async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
      const apiKey = requireApiKey(credentials);

      const body: Record<string, unknown> = {
        q: query,
        num: opts.limit !== undefined ? opts.limit : 10,
      };

      if (opts.recency_days !== undefined && opts.recency_days > 0) {
        // Serper uses Google's tbs date-range operators.
        if (opts.recency_days <= 1) {
          body['tbs'] = 'qdr:d';
        } else if (opts.recency_days <= 7) {
          body['tbs'] = 'qdr:w';
        } else if (opts.recency_days <= 31) {
          body['tbs'] = 'qdr:m';
        } else {
          body['tbs'] = 'qdr:y';
        }
      }

      const response = await fetch(SERPER_API_URL, {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Serper API error: ${response.status} ${errorBody.slice(0, 200)}`);
      }

      const rawJson: unknown = await response.json();
      const parsed = SerperResponseSchema.safeParse(rawJson);

      if (!parsed.success) {
        logger.warn({ query: query.slice(0, 60), errors: parsed.error.message }, '[Serper] Invalid response shape');
        return [];
      }

      const results: SearchResult[] = [];

      for (const item of parsed.data.organic) {
        const publishedAt = item.date !== undefined ? toIsoString(item.date) : undefined;

        const candidate = {
          provider: 'serper' as const,
          url: item.link,
          title: item.title,
          snippet: item.snippet.slice(0, 500),
          published_at: publishedAt,
          engagement: {
            score: item.position !== undefined ? 1 / item.position : undefined,
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
        '[Serper] Search complete',
      );

      return results;
    },
  };
}
