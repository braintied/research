/**
 * RSS Search Provider
 *
 * Discovery provider: accepts a query and scans explicit RSS/Atom endpoints
 * supplied via opts.feed_urls. Domain allowlists remain ordinary result filters
 * and are never reinterpreted as network endpoints. Filters items by
 * title+description match and returns up to 5 results per feed.
 */

import { logger } from '../logger.js';
import { fetchRssFeed } from '../advice-rss.js';
import {
  SearchResultSchema,
  type SearchProvider,
  type SearchResult,
  type SearchOpts,
} from '../types.js';

// =============================================================================
// Helpers
// =============================================================================

function toIsoString(dateStr: string | null): string | undefined {
  if (dateStr === null || dateStr.length === 0) return undefined;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Simple word-based relevance match. Planner/profile queries are intentionally
 * descriptive, so requiring half of every term makes first-party feeds
 * structurally return zero. Two distinct meaningful terms are enough to admit
 * a candidate; downstream synthesis and coverage still require fetched,
 * validated evidence.
 */
export function rssItemMatchesQuery(query: string, title: string, description: string): boolean {
  const combined = `${title} ${description}`.toLowerCase();
  const words = Array.from(new Set(
    query.toLowerCase().split(/\s+/).filter((word) => word.length >= 4),
  ));

  if (words.length === 0) {
    // Fall back to full substring match
    return combined.includes(query.toLowerCase());
  }

  let matchCount = 0;
  for (const word of words) {
    if (combined.includes(word)) {
      matchCount++;
    }
  }

  return matchCount >= Math.min(2, words.length);
}

/** Keep feed configuration explicit, deterministic, and independent of domain filters. */
export function rssFeedUrlsFromSearchOptions(opts: SearchOpts): string[] {
  return Array.from(new Set(opts.feed_urls ?? []));
}

// =============================================================================
// Provider
// =============================================================================

export const rssProvider: SearchProvider = {
  name: 'rss',

  get enabled(): boolean {
    return true; // No API key — pure HTTP fetch
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const feedUrls = rssFeedUrlsFromSearchOptions(opts);

    if (feedUrls.length === 0) {
      logger.warn({ query: query.slice(0, 60) }, '[RSS] No explicit feed URLs provided in opts.feed_urls');
      return [];
    }

    const maxAgeDays = opts.recency_days !== undefined ? opts.recency_days : 90;
    const results: SearchResult[] = [];

    for (const feedUrl of feedUrls) {
      try {
        const feed = await fetchRssFeed(feedUrl, 50, maxAgeDays);

        if (!feed.success) {
          logger.warn({ feedUrl, error: feed.error }, '[RSS] Feed fetch failed');
          continue;
        }

        let matchCount = 0;

        for (const item of feed.items) {
          if (matchCount >= 5) break;
          if (!rssItemMatchesQuery(query, item.title, item.description)) continue;
          if (item.url.length === 0) continue;

          const publishedAt = toIsoString(item.publishedAt);

          const candidate = {
            provider: 'rss' as const,
            url: item.url,
            canonical_id: item.guid !== null ? item.guid : undefined,
            title: item.title,
            snippet: item.description.slice(0, 500),
            published_at: publishedAt,
            engagement: {},
            raw_metadata: {
              feed_url: feedUrl,
              feed_title: feed.feedTitle,
              audio_url: item.audioUrl,
              duration: item.duration,
            },
          };

          const validated = SearchResultSchema.safeParse(candidate);
          if (validated.success) {
            results.push(validated.data);
            matchCount++;
          }
        }

        logger.info(
          {
            feedUrl: feedUrl.slice(0, 50),
            feedTitle: feed.feedTitle.slice(0, 30),
            matched: matchCount,
          },
          '[RSS] Feed scanned',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ feedUrl, error: msg }, '[RSS] Feed error');
      }
    }

    logger.info(
      { query: query.slice(0, 60), feedsScanned: feedUrls.length, count: results.length },
      '[RSS] Search complete',
    );

    return results;
  },
};
