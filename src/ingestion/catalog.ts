/**
 * Catalog ingestion — enumerate ONE account's own output.
 *
 * The sweep lanes in ingest-source.ts answer "what is new about a topic"
 * (search, 15 items, 30 days). A person corpus asks a different question:
 * "everything this account has published" — a channel's uploads, a profile's
 * posts, a feed's episodes, a site's pages — optionally with transcripts.
 *
 * A source opts in with `config.mode = 'catalog'`; the identifier then names
 * the account rather than a query:
 *
 *   youtube    channel id, /channel/ URL, or @handle
 *   instagram  username or profile URL
 *   podcast    RSS/Atom feed URL          (rss is the same lane)
 *   blog       site URL; pages come from its sitemap
 *
 * Cost is per lane, from what the providers actually bill: Bright Data per
 * Instagram record, Groq/Deepgram per audio hour. YouTube Data API, RSS and
 * Crawl4AI are free. Every failure that does not abort the lane is counted in
 * `skipped` so a caller can tell "no transcript" from "no episodes".
 */

import { z } from 'zod';
import type { ResearchCredentials } from '../credentials.js';
import { logger } from '../logger.js';
import { crawlUrl } from '../pipeline-core.js';
import { fetchPublicText } from '../public-http.js';
import { fetchRssFeed } from '../advice-rss.js';
import { discoverInstagramProfilePosts } from '../providers/instagram.js';
import { listChannelVideos, resolveChannelId } from '../youtube/channel.js';
import { getVideoMetadata } from '../youtube/metadata.js';
import type { YoutubeVideoMetadata } from '../youtube/metadata.js';
import {
  extractTranscriptWithFallback,
  transcribeAudioUrl,
  type TranscriptResult,
} from '../transcript/index.js';
import { buildIngestedItem } from './build-item.js';
import type { IngestedItem, KnowledgeSource } from './types.js';

// =============================================================================
// Config
// =============================================================================

const CatalogConfigSchema = z.object({
  mode: z.literal('catalog'),
  /** Fetch transcripts for videos / episodes. Paid beyond YouTube captions. */
  transcribe: z.boolean().default(false),
  /** Ceiling on transcripts per run; unset means every item in the batch. */
  maxTranscripts: z.number().int().positive().optional(),
});

export interface CatalogConfig {
  mode: 'catalog';
  transcribe: boolean;
  maxTranscripts?: number;
}

/**
 * `null` when the source is an ordinary sweep source. A config that claims
 * catalog mode but is malformed throws, because silently falling back to a
 * topic search on a channel id would search for the literal string "UC…".
 */
export function parseCatalogConfig(config: Record<string, unknown>): CatalogConfig | null {
  if (config.mode !== 'catalog') return null;
  const parsed = CatalogConfigSchema.parse(config);
  return {
    mode: 'catalog',
    transcribe: parsed.transcribe,
    ...(parsed.maxTranscripts === undefined ? {} : { maxTranscripts: parsed.maxTranscripts }),
  };
}

export interface CatalogIngestOptions {
  maxItems: number;
  recencyDays: number;
  signal?: AbortSignal;
}

/**
 * Transport seams. Defaults are the real package functions; tests inject
 * fakes because fetchPublicText and fetchRssFeed ride node:http, which a
 * `globalThis.fetch` stub never sees.
 */
export interface CatalogDependencies {
  fetchFeed?: typeof fetchRssFeed;
  fetchText?: typeof fetchPublicText;
  crawl?: typeof crawlUrl;
}

export interface CatalogIngestResult {
  items: IngestedItem[];
  costUsd: number;
  /** Items enumerated but dropped, by reason (e.g. transcript unavailable is NOT a drop). */
  skipped: Record<string, number>;
  /** Transcript outcomes for the batch, so "0 transcripts" is visible. */
  transcripts: { attempted: number; succeeded: number };
}

/** Bright Data Instagram posts dataset, per returned record. */
const BRIGHTDATA_INSTAGRAM_COST_PER_RECORD_USD = 0.0015;

function cutoffFor(recencyDays: number, now: Date): Date | null {
  if (!Number.isFinite(recencyDays) || recencyDays <= 0) return null;
  return new Date(now.getTime() - recencyDays * 24 * 60 * 60 * 1000);
}

function isOnOrAfter(iso: string | null | undefined, cutoff: Date | null): boolean {
  if (cutoff === null) return true;
  if (iso === null || iso === undefined) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= cutoff.getTime();
}

function bump(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

function transcriptSection(result: TranscriptResult): string {
  return `\n\n## Transcript (${result.tier})\n\n${result.text.trim()}`;
}

// =============================================================================
// YouTube — channel uploads
// =============================================================================

async function ingestYoutubeCatalog(
  credentials: ResearchCredentials,
  source: KnowledgeSource,
  catalog: CatalogConfig,
  opts: CatalogIngestOptions,
  now: Date,
): Promise<CatalogIngestResult> {
  const skipped: Record<string, number> = {};
  const transcripts = { attempted: 0, succeeded: 0 };
  let costUsd = 0;

  const channelId = await resolveChannelId({
    identifier: source.identifier,
    ...(credentials.youtubeApiKey === undefined ? {} : { youtubeApiKey: credentials.youtubeApiKey }),
  });
  const refs = await listChannelVideos({
    channelId,
    ...(credentials.youtubeApiKey === undefined ? {} : { youtubeApiKey: credentials.youtubeApiKey }),
    maxVideos: opts.maxItems,
  });

  const cutoff = cutoffFor(opts.recencyDays, now);
  const inWindow = refs.filter((ref) => {
    // The yt-dlp path has no publish time; a recency window cannot be applied
    // to it, so those refs pass through rather than vanish.
    if (ref.publishedAt === undefined) return true;
    const keep = isOnOrAfter(ref.publishedAt, cutoff);
    if (!keep) bump(skipped, 'older_than_recency');
    return keep;
  }).slice(0, opts.maxItems);

  const metadataById = new Map<string, YoutubeVideoMetadata>();
  if (credentials.youtubeApiKey !== undefined && inWindow.length > 0) {
    const metadata = await getVideoMetadata({
      videoIds: inWindow.map((ref) => ref.videoId),
      youtubeApiKey: credentials.youtubeApiKey,
    });
    for (const m of metadata) metadataById.set(m.videoId, m);
  }

  const items: IngestedItem[] = [];
  for (const ref of inWindow) {
    if (opts.signal?.aborted === true) throw new Error('catalog ingest aborted');
    const meta = metadataById.get(ref.videoId);
    const title = meta !== undefined ? meta.title : ref.title;
    let contentMd = meta !== undefined ? meta.description.trim() : '';

    if (catalog.transcribe && (catalog.maxTranscripts === undefined || transcripts.attempted < catalog.maxTranscripts)) {
      transcripts.attempted += 1;
      try {
        const transcript = await extractTranscriptWithFallback({
          videoId: ref.videoId,
          ...(credentials.groqApiKey === undefined ? {} : { groqApiKey: credentials.groqApiKey }),
          ...(credentials.deepgramApiKey === undefined ? {} : { deepgramApiKey: credentials.deepgramApiKey }),
        });
        transcripts.succeeded += 1;
        contentMd += transcriptSection(transcript);
        if (transcript.usage !== undefined) costUsd += transcript.usage.estimatedCostUsd;
      } catch (err) {
        bump(skipped, 'transcript_unavailable');
        logger.warn(
          { videoId: ref.videoId, error: err instanceof Error ? err.message : String(err) },
          '[catalog] YouTube transcript unavailable; keeping metadata item',
        );
      }
    }

    items.push(buildIngestedItem({
      sourceId: source.id,
      sourceType: 'youtube',
      url: `https://www.youtube.com/watch?v=${ref.videoId}`,
      title,
      contentMd,
      author: meta !== undefined ? meta.channelTitle : null,
      publishedAt: meta?.publishedAt ?? ref.publishedAt ?? null,
      engagement: meta === undefined
        ? {}
        : { views: meta.viewCount, likes: meta.likeCount, comments: meta.commentCount },
    }));
  }

  return { items, costUsd, skipped, transcripts };
}

// =============================================================================
// Instagram — profile posts
// =============================================================================

async function ingestInstagramCatalog(
  credentials: ResearchCredentials,
  source: KnowledgeSource,
  opts: CatalogIngestOptions,
  now: Date,
): Promise<CatalogIngestResult> {
  const cutoff = cutoffFor(opts.recencyDays, now);
  const posts = await discoverInstagramProfilePosts(credentials, {
    username: source.identifier,
    limit: opts.maxItems,
    ...(cutoff === null ? {} : { since: cutoff.toISOString().slice(0, 10) }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  const items = posts.map((post) => {
    const lines: string[] = [];
    if (post.caption.length > 0) lines.push(post.caption.trim());
    if (post.mediaUrls.length > 0) {
      lines.push('', '## Media', '', ...post.mediaUrls.map((url) => `- ${url}`));
    }
    if (post.comments.length > 0) {
      lines.push('', '## Comments', '', ...post.comments.slice(0, 10).map((c) =>
        c.author !== undefined ? `- **${c.author}:** ${c.text}` : `- ${c.text}`));
    }
    const heading = post.caption.length > 0
      ? post.caption.split('\n')[0].slice(0, 120)
      : `Instagram ${post.postType ?? 'post'} ${post.canonicalId}`;
    return buildIngestedItem({
      sourceId: source.id,
      sourceType: 'instagram',
      url: post.url,
      title: heading,
      contentMd: lines.join('\n'),
      author: post.author ?? null,
      publishedAt: post.publishedAt ?? null,
      engagement: {
        ...(post.viewCount === undefined ? {} : { views: post.viewCount }),
        ...(post.likeCount === undefined ? {} : { likes: post.likeCount }),
        ...(post.commentCount === undefined ? {} : { comments: post.commentCount }),
      },
    });
  });

  return {
    items,
    costUsd: posts.length * BRIGHTDATA_INSTAGRAM_COST_PER_RECORD_USD,
    skipped: {},
    transcripts: { attempted: 0, succeeded: 0 },
  };
}

// =============================================================================
// Podcast / RSS — every episode, optional audio transcription
// =============================================================================

/** "No window" for fetchRssFeed, whose maxAgeDays has no off switch. */
const FEED_NO_WINDOW_DAYS = 36_500;

async function ingestFeedCatalog(
  credentials: ResearchCredentials,
  source: KnowledgeSource,
  catalog: CatalogConfig,
  opts: CatalogIngestOptions,
  fetchFeed: typeof fetchRssFeed,
): Promise<CatalogIngestResult> {
  const skipped: Record<string, number> = {};
  const transcripts = { attempted: 0, succeeded: 0 };
  let costUsd = 0;
  const sourceType = source.sourceType === 'podcast' ? 'podcast' : 'rss';

  const feed = await fetchFeed(
    source.identifier,
    opts.maxItems,
    opts.recencyDays > 0 ? opts.recencyDays : FEED_NO_WINDOW_DAYS,
  );
  if (!feed.success) {
    throw new Error(`Feed fetch failed for ${source.identifier}: ${feed.error ?? 'unknown error'}`);
  }

  const items: IngestedItem[] = [];
  for (const entry of feed.items.slice(0, opts.maxItems)) {
    if (opts.signal?.aborted === true) throw new Error('catalog ingest aborted');
    if (entry.url.length === 0) { bump(skipped, 'no_url'); continue; }
    let contentMd = entry.description.trim();

    if (catalog.transcribe && (catalog.maxTranscripts === undefined || transcripts.attempted < catalog.maxTranscripts)) {
      if (entry.audioUrl === null) {
        bump(skipped, 'no_audio_enclosure');
      } else {
        transcripts.attempted += 1;
        try {
          const transcript = await transcribeAudioUrl({
            audioUrl: entry.audioUrl,
            ...(credentials.groqApiKey === undefined ? {} : { groqApiKey: credentials.groqApiKey }),
            ...(credentials.deepgramApiKey === undefined ? {} : { deepgramApiKey: credentials.deepgramApiKey }),
          });
          transcripts.succeeded += 1;
          contentMd += transcriptSection(transcript);
          if (transcript.usage !== undefined) costUsd += transcript.usage.estimatedCostUsd;
        } catch (err) {
          bump(skipped, 'transcript_unavailable');
          logger.warn(
            { url: entry.url, error: err instanceof Error ? err.message : String(err) },
            '[catalog] Episode transcript unavailable; keeping show-notes item',
          );
        }
      }
    }

    items.push(buildIngestedItem({
      sourceId: source.id,
      sourceType,
      url: entry.url,
      title: entry.title.length > 0 ? entry.title : entry.url,
      contentMd,
      author: feed.feedTitle.length > 0 ? feed.feedTitle : null,
      publishedAt: entry.publishedAt,
      engagement: {},
    }));
  }

  return { items, costUsd, skipped, transcripts };
}

// =============================================================================
// Site — sitemap pages
// =============================================================================

const LOC_PATTERN = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

function locsFrom(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(LOC_PATTERN)) {
    const value = match[1];
    if (value !== undefined) out.push(value.trim());
  }
  return out;
}

/**
 * Same-host page URLs from `/sitemap.xml`, following one level of sitemap
 * index. A site without a sitemap yields just the identifier page: a crawl
 * that guessed links would be a crawler, which is a different tier.
 */
export async function listSitemapPages(
  siteUrl: string,
  maxPages: number,
  fetchText: typeof fetchPublicText = fetchPublicText,
): Promise<string[]> {
  const origin = new URL(siteUrl).origin;
  const host = new URL(siteUrl).host;
  const seen = new Set<string>([siteUrl]);
  const pages: string[] = [siteUrl];

  const sitemapUrl = `${origin}/sitemap.xml`;
  let response;
  try {
    response = await fetchText(sitemapUrl, {
      acceptedContentTypes: ['application/xml', 'text/xml', 'application/rss+xml', 'text/plain', 'text/html'],
      maxBytes: 5 * 1024 * 1024,
    });
  } catch (err) {
    logger.warn({ sitemapUrl, error: err instanceof Error ? err.message : String(err) }, '[catalog] sitemap fetch failed');
    return pages;
  }
  if (!response.ok) return pages;

  let locs = locsFrom(response.text);
  const childSitemaps = locs.filter((loc) => /sitemap[^/]*\.xml(\?.*)?$/i.test(loc));
  if (childSitemaps.length > 0 && childSitemaps.length === locs.length) {
    locs = [];
    for (const child of childSitemaps.slice(0, 20)) {
      try {
        const childResponse = await fetchText(child, {
          acceptedContentTypes: ['application/xml', 'text/xml', 'text/plain'],
          maxBytes: 5 * 1024 * 1024,
        });
        if (childResponse.ok) locs.push(...locsFrom(childResponse.text));
      } catch {
        // one bad child sitemap should not empty the whole site
      }
    }
  }

  for (const loc of locs) {
    if (pages.length >= maxPages) break;
    let candidate: URL;
    try { candidate = new URL(loc); } catch { continue; }
    if (candidate.host !== host) continue;
    if (/\.(xml|pdf|jpe?g|png|gif|svg|webp|mp3|mp4|zip)(\?.*)?$/i.test(candidate.pathname)) continue;
    const normalized = candidate.toString().replace(/\/$/, '');
    const key = normalized.replace(/^https?:\/\//, '');
    if (seen.has(key) || seen.has(normalized) || seen.has(`${normalized}/`)) continue;
    seen.add(key);
    pages.push(candidate.toString());
  }
  return pages.slice(0, maxPages);
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#{1,3}\s+(.+)$/m);
  if (heading !== null && heading[1] !== undefined) {
    const text = heading[1].replace(/[*_`]/g, '').trim();
    if (text.length > 0) return text.slice(0, 200);
  }
  return fallback;
}

async function ingestSiteCatalog(
  credentials: ResearchCredentials,
  source: KnowledgeSource,
  opts: CatalogIngestOptions,
  fetchText: typeof fetchPublicText,
  crawl: typeof crawlUrl,
): Promise<CatalogIngestResult> {
  const skipped: Record<string, number> = {};
  const siteUrl = source.identifier.startsWith('http') ? source.identifier : `https://${source.identifier}`;
  const pages = await listSitemapPages(siteUrl, opts.maxItems, fetchText);

  const items: IngestedItem[] = [];
  for (const pageUrl of pages) {
    if (opts.signal?.aborted === true) throw new Error('catalog ingest aborted');
    let markdown: string | null;
    try {
      markdown = await crawl(credentials, pageUrl);
    } catch (err) {
      bump(skipped, 'crawl_failed');
      logger.warn({ pageUrl, error: err instanceof Error ? err.message : String(err) }, '[catalog] page crawl failed');
      continue;
    }
    if (markdown === null || markdown.trim().length === 0) { bump(skipped, 'empty_page'); continue; }
    items.push(buildIngestedItem({
      sourceId: source.id,
      sourceType: 'blog',
      url: pageUrl,
      title: titleFromMarkdown(markdown, pageUrl),
      contentMd: markdown.trim(),
      author: null,
      publishedAt: null,
      engagement: {},
    }));
  }

  return { items, costUsd: 0, skipped, transcripts: { attempted: 0, succeeded: 0 } };
}

// =============================================================================
// Dispatch
// =============================================================================

export async function ingestCatalog(
  credentials: ResearchCredentials,
  source: KnowledgeSource,
  catalog: CatalogConfig,
  opts: CatalogIngestOptions,
  now: Date = new Date(),
  deps: CatalogDependencies = {},
): Promise<CatalogIngestResult> {
  const fetchFeed = deps.fetchFeed ?? fetchRssFeed;
  const fetchText = deps.fetchText ?? fetchPublicText;
  const crawl = deps.crawl ?? crawlUrl;
  switch (source.sourceType) {
    case 'youtube':
      return ingestYoutubeCatalog(credentials, source, catalog, opts, now);
    case 'instagram':
      return ingestInstagramCatalog(credentials, source, opts, now);
    case 'podcast':
    case 'rss':
      return ingestFeedCatalog(credentials, source, catalog, opts, fetchFeed);
    case 'blog':
      return ingestSiteCatalog(credentials, source, opts, fetchText, crawl);
    default:
      throw new Error(`Catalog mode is not implemented for source type "${source.sourceType}"`);
  }
}
