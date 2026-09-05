/**
 * ingestSource — route one knowledge source to the right @swishh/research
 * provider, run it, and normalize results into IngestedItem[].
 *
 * REUSES the existing 13 providers (tavily, crawl4ai, reddit, youtube, rss,
 * tiktok, instagram, x, podcasts via rss …) — no scraping is re-implemented.
 * LinkedIn and Facebook groups have no SearchProvider; they are fetched through
 * the Bright Data Web Scraper API client (providers/brightdata.ts), which
 * normalizes records straight into IngestedItem[].
 *
 * Failure-tolerant: any provider error is caught and returned as a non-throwing
 * IngestResult with `error` set, so one bad source never aborts a sweep.
 */

import type { SearchResult, SearchOpts } from '../types.js';
import { createProviderRegistry } from '../providers/index.js';
import type { ResearchCredentials } from '../credentials.js';
import {
  fetchLinkedInPostsBrightData,
  fetchFacebookGroupPostsBrightData,
} from '../providers/brightdata.js';
import { crawlUrl } from '../pipeline-core.js';
import { logger } from '../logger.js';
import { KnowledgeSourceTypeSchema } from './types.js';
import { buildIngestedItem, toExcerpt } from './build-item.js';
import { ingestCatalog, parseCatalogConfig } from './catalog.js';
import type {
  KnowledgeSource,
  KnowledgeSourceType,
  IngestedItem,
  IngestResult,
  IngestSourceOptions,
  IngestEngagement,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_ITEMS = 15;
const DEFAULT_RECENCY_DAYS = 30;
const BLOG_CONTENT_ENRICH_LIMIT = 5; // crawl full content for at most N blog/web items per source

// Rough per-provider cost estimates (USD) for sweep budgeting. Search providers
// that are free HTTP (reddit/youtube/rss) are ~0; Apify-backed actors cost more.
const PROVIDER_RUN_COST_USD: Record<KnowledgeSourceType, number> = {
  blog: 0.002,
  rss: 0,
  reddit: 0,
  youtube: 0,
  podcast: 0,
  tiktok: 0.05,
  instagram: 0.05,
  x: 0.05,
  linkedin: 0.08,
  facebook: 0.08,
  web_search: 0,
};

// =============================================================================
// LinkedIn — Bright Data Web Scraper API (providers/brightdata.ts).
// Kept as a named wrapper (was a self-contained Apify call that 403'd) so the
// switch keeps a single call site; the Bright Data client owns trigger/poll/
// download, Zod validation, and IngestedItem mapping.
// =============================================================================

async function fetchLinkedInPosts(
  credentials: ResearchCredentials,
  profileIdentifier: string,
  maxItems: number,
): Promise<IngestedItem[]> {
  return fetchLinkedInPostsBrightData(credentials, profileIdentifier, maxItems);
}

// =============================================================================
// Helpers
// =============================================================================

function searchEngagementToIngest(
  e: SearchResult['engagement'],
): IngestEngagement {
  const out: IngestEngagement = {};
  if (e.upvotes !== undefined) out.upvotes = e.upvotes;
  if (e.view_count !== undefined) out.views = e.view_count;
  if (e.like_count !== undefined) out.likes = e.like_count;
  if (e.comment_count !== undefined) out.comments = e.comment_count;
  if (e.score !== undefined) out.score = e.score;
  return out;
}

/**
 * Build the provider query string for a source. The `identifier` carries the
 * source-specific target; `topics` are appended as keyword filters where the
 * provider treats the query as free text.
 */
function buildQuery(source: KnowledgeSource): string {
  const topics = source.topics.filter((t) => t.trim().length > 0).join(' ');
  switch (source.sourceType) {
    case 'reddit':
      // Reddit search supports Lucene `subreddit:` scoping in the q param.
      return topics.length > 0
        ? `subreddit:${source.identifier} ${topics}`
        : `subreddit:${source.identifier}`;
    case 'web_search':
      return source.identifier;
    case 'youtube':
    case 'tiktok':
    case 'instagram':
    case 'x':
      return topics.length > 0 ? `${source.identifier} ${topics}` : source.identifier;
    case 'blog':
      return topics.length > 0 ? topics : source.identifier;
    default:
      return topics.length > 0 ? topics : source.identifier;
  }
}

function mapSearchResults(
  results: SearchResult[],
  sourceId: string | null,
  sourceType: KnowledgeSourceType,
): IngestedItem[] {
  const out: IngestedItem[] = [];
  for (const r of results) {
    if (r.url.length === 0) continue;
    const content = r.snippet.trim();
    out.push(
      buildIngestedItem({
        sourceId,
        sourceType,
        url: r.url,
        title: r.title.length > 0 ? r.title : r.url,
        contentMd: content,
        author: r.author !== undefined ? r.author : null,
        publishedAt: r.published_at !== undefined ? r.published_at : null,
        engagement: searchEngagementToIngest(r.engagement),
      }),
    );
  }
  return out;
}

/**
 * For blog/web_search items, the search snippet alone is thin — crawl the top
 * few URLs for full markdown so categorization + embedding have real signal.
 */
async function enrichWithFullContent(
  credentials: ResearchCredentials,
  items: IngestedItem[],
): Promise<void> {
  let enriched = 0;
  for (const item of items) {
    if (enriched >= BLOG_CONTENT_ENRICH_LIMIT) break;
    try {
      const md = await crawlUrl(credentials, item.url);
      if (md !== null && md.trim().length > item.contentMd.length) {
        item.contentMd = md.trim();
        item.excerpt = toExcerpt(item.contentMd, item.title);
        enriched++;
      }
    } catch (err) {
      logger.warn(
        { url: item.url.slice(0, 80), error: err instanceof Error ? err.message : String(err) },
        '[ingestSource] content enrich failed',
      );
    }
  }
}

// =============================================================================
// ingestSource
// =============================================================================

export async function ingestSource(
  credentials: ResearchCredentials,
  source: KnowledgeSource,
  opts: IngestSourceOptions = {},
): Promise<IngestResult> {
  const providers = createProviderRegistry(credentials);
  const sourceType = KnowledgeSourceTypeSchema.parse(source.sourceType);
  const maxItems = opts.maxItems !== undefined ? opts.maxItems : DEFAULT_MAX_ITEMS;
  const recencyDays = opts.recencyDays !== undefined ? opts.recencyDays : DEFAULT_RECENCY_DAYS;

  const searchOpts: SearchOpts = {
    limit: maxItems,
    recency_days: recencyDays > 0 ? recencyDays : undefined,
    signal: opts.signal,
  };

  const baseResult: IngestResult = {
    sourceId: source.id,
    sourceType,
    items: [],
    costUsd: 0,
    error: null,
  };

  try {
    // Catalog mode enumerates ONE account's own output (a channel's uploads, a
    // profile's posts, a feed's episodes, a site's pages) instead of searching
    // a topic. It is the person-corpus door; the switch below is the topic door.
    const catalog = parseCatalogConfig(source.config);
    if (catalog !== null) {
      const harvested = await ingestCatalog(credentials, source, catalog, {
        maxItems,
        recencyDays,
        signal: opts.signal,
      });
      // Same dedupe contract as the sweep lanes: one item per url_hash, then
      // the caller's ceiling. A profile crawl can return one post twice.
      const seenHashes = new Set<string>();
      const uniqueItems = harvested.items.filter((it) => {
        if (seenHashes.has(it.urlHash)) return false;
        seenHashes.add(it.urlHash);
        return true;
      });
      return { ...baseResult, items: uniqueItems.slice(0, maxItems), costUsd: harvested.costUsd };
    }

    let items: IngestedItem[] = [];

    switch (sourceType) {
      case 'reddit': {
        const r = await providers.reddit.search(buildQuery(source), searchOpts);
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'youtube': {
        const r = await providers.youtube.search(buildQuery(source), searchOpts);
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'rss':
      case 'podcast': {
        // RSS provider scans explicit feed URLs supplied via feed_urls; the
        // identifier IS the feed URL. A blank query => match-all in the feed.
        const r = await providers.rss.search(source.topics.join(' '), {
          ...searchOpts,
          feed_urls: [source.identifier],
        });
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'blog': {
        const r = await providers.tavily.search(buildQuery(source), {
          ...searchOpts,
          include_domains: [extractDomain(source.identifier)],
        });
        items = mapSearchResults(r, source.id, sourceType);
        await enrichWithFullContent(credentials, items);
        break;
      }
      case 'web_search': {
        if (providers.searxng.enabled) {
          const r = await providers.searxng.search(buildQuery(source), searchOpts);
          items = mapSearchResults(r, source.id, sourceType);
        } else if (providers.tavily.enabled) {
          const r = await providers.tavily.search(buildQuery(source), searchOpts);
          items = mapSearchResults(r, source.id, sourceType);
        } else {
          throw new Error('web_search requires SearXNG URLs or a Tavily key');
        }
        await enrichWithFullContent(credentials, items);
        break;
      }
      case 'tiktok': {
        const r = await providers.tiktok.search(buildQuery(source), searchOpts);
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'instagram': {
        const r = await providers.instagram.search(buildQuery(source), searchOpts);
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'x': {
        const r = await providers.x.search(buildQuery(source), searchOpts);
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'linkedin': {
        const liItems = await fetchLinkedInPosts(credentials, source.identifier, maxItems);
        for (const it of liItems) {
          it.sourceId = source.id;
        }
        items = liItems;
        break;
      }
      case 'facebook': {
        const fbItems = await fetchFacebookGroupPostsBrightData(credentials, source.identifier, maxItems);
        for (const it of fbItems) {
          it.sourceId = source.id;
        }
        items = fbItems;
        break;
      }
      default: {
        // Exhaustiveness — KnowledgeSourceType is closed; this is unreachable.
        const never: never = sourceType;
        throw new Error(`Unhandled source type: ${String(never)}`);
      }
    }

    // Dedup within this single source by url_hash (cross-source/global dedup is
    // the consumer's job via the DB unique constraint).
    const seen = new Set<string>();
    const deduped: IngestedItem[] = [];
    for (const it of items) {
      if (seen.has(it.urlHash)) continue;
      seen.add(it.urlHash);
      deduped.push(it);
    }

    const trimmed = deduped.slice(0, maxItems);

    return {
      ...baseResult,
      items: trimmed,
      costUsd: trimmed.length > 0 ? PROVIDER_RUN_COST_USD[sourceType] : 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { sourceType, identifier: source.identifier.slice(0, 60), error: msg },
      '[ingestSource] source ingest failed (tolerated)',
    );
    return { ...baseResult, error: msg };
  }
}

function extractDomain(urlOrDomain: string): string {
  try {
    return new URL(urlOrDomain).hostname.replace(/^www\./, '');
  } catch {
    return urlOrDomain.replace(/^www\./, '');
  }
}
