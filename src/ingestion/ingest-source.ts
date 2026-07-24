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

import { hashUrl, canonicalizeUrl } from '../types.js';
import type { SearchResult, SearchOpts } from '../types.js';
import {
  redditProvider,
  youtubeProvider,
  rssProvider,
  tavilyProvider,
  crawl4aiProvider,
  tiktokProvider,
  instagramProvider,
  xProvider,
} from '../providers/index.js';
import {
  fetchLinkedInPostsBrightData,
  fetchFacebookGroupPostsBrightData,
} from '../providers/brightdata.js';
import { crawlUrl } from '../pipeline-core.js';
import { logger } from '../logger.js';
import { KnowledgeSourceTypeSchema } from './types.js';
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
  web_search: 0.004,
};

// =============================================================================
// LinkedIn — Bright Data Web Scraper API (providers/brightdata.ts).
// Kept as a named wrapper (was a self-contained Apify call that 403'd) so the
// switch keeps a single call site; the Bright Data client owns trigger/poll/
// download, Zod validation, and IngestedItem mapping.
// =============================================================================

async function fetchLinkedInPosts(
  profileIdentifier: string,
  maxItems: number,
): Promise<IngestedItem[]> {
  return fetchLinkedInPostsBrightData(profileIdentifier, maxItems);
}

// =============================================================================
// Helpers
// =============================================================================

function toExcerpt(content: string, snippet: string): string {
  const base = content.trim().length > 0 ? content.trim() : snippet.trim();
  if (base.length <= 320) return base;
  return `${base.slice(0, 320).trim()}…`;
}

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

interface BuildItemInput {
  sourceId: string | null;
  sourceType: KnowledgeSourceType;
  url: string;
  title: string;
  contentMd: string;
  author: string | null;
  publishedAt: string | null;
  engagement: IngestEngagement;
}

function buildItem(input: BuildItemInput): IngestedItem {
  const canonical = canonicalizeUrl(input.url);
  return {
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    url: canonical,
    urlHash: hashUrl(canonical),
    title: input.title,
    contentMd: input.contentMd,
    excerpt: toExcerpt(input.contentMd, input.title),
    author: input.author,
    publishedAt: input.publishedAt,
    engagement: input.engagement,
    qualityScore: null,
    // categorize/embed fill these in later; defaults keep the type total.
    category: 'other',
    tags: [],
    whyItMatters: null,
    quotes: [],
    embedding: null,
  };
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
      buildItem({
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
async function enrichWithFullContent(items: IngestedItem[]): Promise<void> {
  let enriched = 0;
  for (const item of items) {
    if (enriched >= BLOG_CONTENT_ENRICH_LIMIT) break;
    try {
      const md = await crawlUrl(item.url);
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
  source: KnowledgeSource,
  opts: IngestSourceOptions = {},
): Promise<IngestResult> {
  const sourceType = KnowledgeSourceTypeSchema.parse(source.sourceType);
  const maxItems = opts.maxItems !== undefined ? opts.maxItems : DEFAULT_MAX_ITEMS;
  const recencyDays = opts.recencyDays !== undefined ? opts.recencyDays : DEFAULT_RECENCY_DAYS;

  const searchOpts: SearchOpts = {
    limit: maxItems,
    recency_days: recencyDays,
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
    let items: IngestedItem[] = [];

    switch (sourceType) {
      case 'reddit': {
        const r = await redditProvider.search(buildQuery(source), searchOpts);
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'youtube': {
        const r = await youtubeProvider.search(buildQuery(source), searchOpts);
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'rss':
      case 'podcast': {
        // RSS provider scans explicit feed URLs supplied via feed_urls; the
        // identifier IS the feed URL. A blank query => match-all in the feed.
        const r = await rssProvider.search(source.topics.join(' '), {
          ...searchOpts,
          feed_urls: [source.identifier],
        });
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'blog':
      case 'web_search': {
        const r = await tavilyProvider.search(buildQuery(source), {
          ...searchOpts,
          include_domains: sourceType === 'blog' ? [extractDomain(source.identifier)] : undefined,
        });
        items = mapSearchResults(r, source.id, sourceType);
        await enrichWithFullContent(items);
        break;
      }
      case 'tiktok': {
        const r = await tiktokProvider.search(buildQuery(source), searchOpts);
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'instagram': {
        const r = await instagramProvider.search(buildQuery(source), searchOpts);
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'x': {
        const r = await xProvider.search(buildQuery(source), searchOpts);
        items = mapSearchResults(r, source.id, sourceType);
        break;
      }
      case 'linkedin': {
        const liItems = await fetchLinkedInPosts(source.identifier, maxItems);
        for (const it of liItems) {
          it.sourceId = source.id;
        }
        items = liItems;
        break;
      }
      case 'facebook': {
        const fbItems = await fetchFacebookGroupPostsBrightData(source.identifier, maxItems);
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
