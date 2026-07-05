/**
 * SearXNG client — Phase 1 Experiment 4 scaffold
 *
 * Round-robin multi-instance client for self-hosted SearXNG. Reads
 * SEARXNG_URLS as a comma-separated list (e.g.,
 * "https://searxng-a.fly.dev,https://searxng-b.fly.dev,https://searxng-c.fly.dev").
 *
 * Phase 1 Experiment 4 uses this only for the smoke-test script
 * (`scripts/smoke-test-searxng.ts`) — measure success rate across 1,000
 * queries / 24h before promoting SearXNG to Tier 1 in the cascading search
 * registry. Phase 2 wires it into the provider registry alongside Tavily,
 * Exa, etc., once we know the upstream-engine reliability profile.
 *
 * Plan: ~/.claude/plans/we-were-building-in-imperative-eich.md
 * (Phase 1 Experiment 4)
 */

import { z } from 'zod';
import { logger } from '../logger.js';

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
// Result shape (matches the SearchResult contract minus the strict provider
// enum — we don't ship SearXNG into ProviderName until Phase 2)
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
}

// =============================================================================
// Round-robin instance picker
// =============================================================================

let rrCounter = 0;

function getInstanceUrls(): string[] {
  const raw = process.env.SEARXNG_URLS;
  if (raw === undefined || raw === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s.length > 0);
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
 * Hit one SearXNG instance (round-robin). On failure, fall back to the next
 * instance once. Returns structured outcome so the smoke test can compute
 * success rate without losing per-instance attribution.
 */
export async function searxngSearch(
  query: string,
  opts: SearxngSearchOpts = {},
): Promise<SearxngSearchOutcome> {
  const urls = getInstanceUrls();
  if (urls.length === 0) {
    return {
      success: false,
      triedUrls: [],
      results: [],
      error: 'SEARXNG_URLS environment variable not configured',
    };
  }

  const triedUrls: string[] = [];
  const primary = pickPrimaryUrl(urls);
  triedUrls.push(primary);

  try {
    const results = await callOnce(primary, query, opts);
    return { success: true, triedUrls, results };
  } catch (primaryError) {
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    logger.warn({ url: primary, error: primaryMessage, query: query.slice(0, 60) }, '[SearXNG] primary failed; trying fallback');

    // Pick next instance not yet tried
    for (const candidate of urls) {
      if (triedUrls.includes(candidate)) continue;
      triedUrls.push(candidate);
      try {
        const results = await callOnce(candidate, query, opts);
        return { success: true, triedUrls, results };
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        logger.warn({ url: candidate, error: fallbackMessage }, '[SearXNG] fallback failed');
      }
    }

    return { success: false, triedUrls, results: [], error: primaryMessage };
  }
}
