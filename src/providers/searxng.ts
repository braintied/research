/**
 * SearXNG Search Provider
 *
 * Round-robin multi-instance client for self-hosted SearXNG. Reads
 * SEARXNG_URLS as a comma-separated list (e.g.,
 * "https://searxng-a.fly.dev,https://searxng-b.fly.dev,https://searxng-c.fly.dev").
 *
 * $0/query metasearch — the default free breadth tier of the provider
 * registry (Tavily remains the paid quality tier). Originally a Phase-1
 * smoke-test scaffold (`scripts/smoke-test-searxng.ts`); the registry wiring
 * promised as "Phase 2" is now done via `searxngProvider` below.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import type { ResearchCredentials } from '../credentials.js';
import {
  SearchResultSchema,
  type SearchProvider,
  type SearchResult,
  type SearchOpts,
} from '../types.js';

// =============================================================================
// SearXNG /search JSON response shape (subset we consume)
// =============================================================================

const SearxngResultSchema = z.object({
  title: z.string().default(''),
  url: z.string(),
  content: z.string().default(''),
  engine: z.string().optional(),
  publishedDate: z.string().nullable().optional(),
  score: z.number().optional(),
});

const SearxngResponseSchema = z.object({
  results: z.array(SearxngResultSchema).default([]),
  number_of_results: z.number().optional(),
  unresponsive_engines: z.array(z.unknown()).optional(),
});

// =============================================================================
// Result shape — raw client output; `searxngProvider.search()` maps this into
// the shared SearchResult contract.
// =============================================================================

export interface SearxngResult {
  url: string;
  title: string;
  snippet: string;
  engine: string | undefined;
  published_at: string | undefined;
  score: number | undefined;
}

export interface SearxngSearchOpts {
  /** Default 10. */
  limit?: number;
  /** Per-instance request timeout. Default 12s. */
  timeoutMs?: number;
  /** SearXNG `format=json` is required; this is here only to override category. */
  category?: 'general' | 'news' | 'science';
  /**
   * SearXNG native recency filter. Mapped from SearchOpts.recency_days by the
   * provider — before this existed, recency filtering was a paid-Tavily-only
   * capability.
   */
  timeRange?: 'day' | 'week' | 'month' | 'year';
  /**
   * Restrict to named SearXNG engines (`youtube`, `reddit`, `bing`).
   * Absent means the instance default set.
   */
  engines?: string[];
}

const SEARXNG_ENGINE_NAME = /^[a-z][a-z0-9_-]{0,32}$/;

/** Join a caller engine list into SearXNG `engines=` (invalid names dropped). */
export function searxngEnginesParam(engines: string[] | undefined): string | undefined {
  if (engines === undefined || engines.length === 0) return undefined;
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of engines) {
    const name = raw.trim().toLowerCase();
    if (!SEARXNG_ENGINE_NAME.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    cleaned.push(name);
  }
  if (cleaned.length === 0) return undefined;
  return cleaned.join(',');
}

/** Map a recency window in days onto SearXNG's discrete time_range buckets. */
export function recencyDaysToTimeRange(days: number | undefined): SearxngSearchOpts['timeRange'] {
  if (days === undefined || days <= 0) return undefined;
  if (days <= 1) return 'day';
  if (days <= 7) return 'week';
  if (days <= 31) return 'month';
  if (days <= 366) return 'year';
  return undefined;
}

// =============================================================================
// Round-robin instance picker
// =============================================================================

let rrCounter = 0;

function instanceUrls(credentials: ResearchCredentials): string[] {
  if (credentials.searxngUrls === undefined) return [];
  return credentials.searxngUrls.filter((url) => url.length > 0);
}

function pickPrimaryUrl(urls: string[]): string {
  const idx = rrCounter % urls.length;
  rrCounter = (rrCounter + 1) % Math.max(urls.length, 1);
  return urls[idx];
}

// =============================================================================
// Single-instance call
// =============================================================================

async function callOnce(
  baseUrl: string,
  query: string,
  opts: SearxngSearchOpts,
): Promise<SearxngResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    language: 'en',
  });
  if (opts.category !== undefined) {
    params.set('categories', opts.category);
  }
  if (opts.timeRange !== undefined) {
    params.set('time_range', opts.timeRange);
  }
  const engines = searxngEnginesParam(opts.engines);
  if (engines !== undefined) {
    params.set('engines', engines);
  }
  const url = `${baseUrl}/search?${params.toString()}`;
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 12_000;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'cortex-deep-research/1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`SearXNG ${response.status} from ${baseUrl}`);
  }

  const rawJson: unknown = await response.json();
  const parsed = SearxngResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(`SearXNG invalid response shape from ${baseUrl}`);
  }

  const limit = opts.limit !== undefined ? opts.limit : 10;
  return parsed.data.results.slice(0, limit).map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.content.slice(0, 500),
    engine: r.engine,
    published_at: r.publishedDate !== null && r.publishedDate !== undefined ? r.publishedDate : undefined,
    score: r.score,
  }));
}

// =============================================================================
// Public API — round-robin with single failover
// =============================================================================

export interface SearxngSearchOutcome {
  success: boolean;
  triedUrls: string[];
  results: SearxngResult[];
  error?: string;
}

/**
 * Hit one SearXNG instance (round-robin). On transport failure, invalid
 * response, or an empty result set, fail over through the remaining pool.
 * HTTP 200 with zero results commonly means every upstream engine on that
 * instance is rate-limited, so treating it as healthy prevents useful failover.
 */
export async function searxngSearch(
  credentials: ResearchCredentials,
  query: string,
  opts: SearxngSearchOpts = {},
): Promise<SearxngSearchOutcome> {
  const urls = instanceUrls(credentials);
  if (urls.length === 0) {
    return {
      success: false,
      triedUrls: [],
      results: [],
      error: 'ResearchCredentials.searxngUrls is not configured',
    };
  }

  const triedUrls: string[] = [];
  const primary = pickPrimaryUrl(urls);
  const candidates = [primary, ...urls.filter((candidate) => candidate !== primary)];
  let lastError = 'All SearXNG instances returned no results';

  for (const candidate of candidates) {
    triedUrls.push(candidate);
    try {
      const results = await callOnce(candidate, query, opts);
      if (results.length > 0) {
        return { success: true, triedUrls, results };
      }
      lastError = `SearXNG returned no results from ${candidate}`;
      logger.warn(
        { url: candidate, query: query.slice(0, 60) },
        '[SearXNG] empty result set; trying fallback',
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn(
        { url: candidate, error: lastError, query: query.slice(0, 60) },
        '[SearXNG] instance failed; trying fallback',
      );
    }
  }

  return { success: false, triedUrls, results: [], error: lastError };
}

// =============================================================================
// SearchProvider registration — the free breadth tier
// =============================================================================

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

export function createSearxngProvider(credentials: ResearchCredentials): SearchProvider {
  return {
    name: 'searxng',

    capabilities: {
      search: true,
      fetch: false,
      extract: false,
      backends: ['searxng'],
    },

    enabled: instanceUrls(credentials).length > 0,

    async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
      const outcome = await searxngSearch(credentials, query, {
        limit: opts.limit,
        timeRange: recencyDaysToTimeRange(opts.recency_days),
        engines: opts.engines,
      });

      if (!outcome.success) {
        throw new Error(
          outcome.error !== undefined ? outcome.error : 'SearXNG search failed on all instances',
        );
      }

      const results: SearchResult[] = [];
      for (const item of outcome.results) {
        const publishedAt = item.published_at !== undefined ? toIsoString(item.published_at) : undefined;

        const candidate = {
          provider: 'searxng' as const,
          url: item.url,
          title: item.title,
          snippet: item.snippet,
          published_at: publishedAt,
          engagement: {
            score: item.score,
          },
          raw_metadata: { backend: 'searxng', ...(item.engine !== undefined ? { engine: item.engine } : {}) },
        };

        const validated = SearchResultSchema.safeParse(candidate);
        if (validated.success) {
          results.push(validated.data);
        }
      }

      logger.info(
        { query: query.slice(0, 60), count: results.length },
        '[SearXNG] Search complete',
      );

      return results;
    },
  };
}
