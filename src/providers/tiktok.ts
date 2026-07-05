/**
 * TikTok Search Provider
 *
 * Uses Apify actor `clockworks/free-tiktok-scraper` (free tier) for search +
 * comment fetching. Searches by query string, returns videos with inline
 * comments when `shouldDownloadComments: true`.
 *
 * Rate limit: 5-second queue between Apify calls.
 * Env required: APIFY_API_TOKEN (shared with other Apify providers).
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { sleep } from '../pipeline-core.js';
import {
  SearchResultSchema,
  FetchResultSchema,
  type SearchProvider,
  type SearchResult,
  type FetchResult,
  type ExtractedQuotes,
  type SearchOpts,
} from '../types.js';
import { extractQuotesWithGemini } from './gemini-extractor.js';

// =============================================================================
// Rate limiter — 5-second queue between Apify calls
// =============================================================================

const TT_RATE_LIMIT_MS = 5000;
let lastTtCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastTtCallAt;
  if (elapsed < TT_RATE_LIMIT_MS) {
    await sleep(TT_RATE_LIMIT_MS - elapsed);
  }
  lastTtCallAt = Date.now();
}

// =============================================================================
// Apify API helpers
// =============================================================================

const APIFY_BASE_URL = 'https://api.apify.com/v2';
const ACTOR_ID = 'clockworks/free-tiktok-scraper';
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 5 * 60 * 1_000;

function getApifyToken(): string {
  const token = process.env.APIFY_API_TOKEN;
  if (token === undefined || token === '') {
    throw new Error('APIFY_API_TOKEN environment variable is not configured');
  }
  return token;
}

function isEnabled(): boolean {
  const token = process.env.APIFY_API_TOKEN;
  return token !== undefined && token !== '';
}

interface ApifyRunData {
  id: string;
  defaultDatasetId: string;
  status: string;
  usageTotalUsd?: number;
}

async function startApifyRun(
  actorId: string,
  input: Record<string, unknown>,
  token: string,
): Promise<{ runId: string; datasetId: string }> {
  const url = `${APIFY_BASE_URL}/acts/${encodeURIComponent(actorId)}/runs?token=${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Apify start error (${actorId}): HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as { data: ApifyRunData };
  const runId = json.data.id;
  const datasetId = json.data.defaultDatasetId;

  if (runId === '' || runId === undefined) {
    throw new Error(`Apify actor "${actorId}" start response missing run id`);
  }

  return { runId, datasetId };
}

async function pollRunUntilDone(runId: string, token: string): Promise<{ usageUsd: number }> {
  const startTime = Date.now();
  const statusUrl = `${APIFY_BASE_URL}/actor-runs/${runId}?token=${token}`;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Apify poll error: HTTP ${response.status} ${body.slice(0, 100)}`);
    }

    const json = (await response.json()) as { data: ApifyRunData };
    const status = json.data.status;

    if (status === 'SUCCEEDED') {
      const usageUsd = json.data.usageTotalUsd !== undefined ? json.data.usageTotalUsd : 0;
      return { usageUsd };
    }

    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run "${runId}" ended with status "${status}"`);
    }
  }

  throw new Error(`Apify run "${runId}" timed out after ${MAX_WAIT_MS / 1000}s`);
}

async function fetchDatasetItems(datasetId: string, token: string): Promise<unknown[]> {
  const url = `${APIFY_BASE_URL}/datasets/${datasetId}/items?token=${token}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Apify dataset fetch error: HTTP ${response.status} ${body.slice(0, 100)}`);
  }

  return (await response.json()) as unknown[];
}

// =============================================================================
// TikTok item schema (clockworks/free-tiktok-scraper output shape)
// =============================================================================

const TikTokAuthorMetaSchema = z.object({
  name: z.string().optional(),
  nickName: z.string().optional(),
  id: z.string().optional(),
}).passthrough();

const TikTokCommentSchema = z.object({
  text: z.string().optional(),
  uniqueId: z.string().optional(),
  diggCount: z.number().optional(),
  createTime: z.number().optional(),
}).passthrough();

const TikTokItemSchema = z.object({
  id: z.string().optional(),
  webVideoUrl: z.string().optional(),
  text: z.string().optional(),
  createTimeISO: z.string().optional(),
  createTime: z.number().optional(),
  authorMeta: TikTokAuthorMetaSchema.optional(),
  playCount: z.number().optional(),
  diggCount: z.number().optional(),
  commentCount: z.number().optional(),
  shareCount: z.number().optional(),
  comments: z.array(TikTokCommentSchema).optional(),
}).passthrough();

// =============================================================================
// Helpers
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

function unixToIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function extractVideoUrl(item: z.infer<typeof TikTokItemSchema>): string | null {
  if (item.webVideoUrl !== undefined && item.webVideoUrl.length > 0) {
    return item.webVideoUrl;
  }
  if (item.id !== undefined && item.id.length > 0) {
    return `https://www.tiktok.com/@unknown/video/${item.id}`;
  }
  return null;
}

function extractAuthor(item: z.infer<typeof TikTokItemSchema>): string | undefined {
  if (item.authorMeta === undefined) return undefined;
  const name = item.authorMeta.nickName !== undefined && item.authorMeta.nickName.length > 0
    ? item.authorMeta.nickName
    : item.authorMeta.name;
  if (name === undefined || name.length === 0) return undefined;
  return `@${name}`;
}

function extractPublishedAt(item: z.infer<typeof TikTokItemSchema>): string | undefined {
  if (item.createTimeISO !== undefined && item.createTimeISO.length > 0) {
    return toIsoString(item.createTimeISO);
  }
  if (item.createTime !== undefined && item.createTime > 0) {
    return unixToIso(item.createTime);
  }
  return undefined;
}

// =============================================================================
// Provider
// =============================================================================

export const tiktokProvider: SearchProvider = {
  name: 'tiktok',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const token = getApifyToken();
    await rateLimit();

    const limit = opts.limit !== undefined ? Math.min(opts.limit, 25) : 15;

    const input: Record<string, unknown> = {
      searchQueries: [query],
      resultsPerPage: limit,
      shouldDownloadComments: true,
      shouldDownloadCommentReplies: false,
    };

    let items: unknown[] = [];

    try {
      const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
      await pollRunUntilDone(runId, token);
      items = await fetchDatasetItems(datasetId, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ query: query.slice(0, 60), error: msg }, '[TikTok] Search failed');
      return [];
    }

    const results: SearchResult[] = [];

    for (const rawItem of items) {
      const parsed = TikTokItemSchema.safeParse(rawItem);
      if (!parsed.success) continue;

      const item = parsed.data;
      const videoUrl = extractVideoUrl(item);
      if (videoUrl === null) continue;

      const caption = item.text !== undefined ? item.text : '';

      const candidate = {
        provider: 'tiktok' as const,
        url: videoUrl,
        canonical_id: item.id !== undefined && item.id.length > 0 ? item.id : undefined,
        title: caption.slice(0, 200),
        snippet: caption.slice(0, 300),
        author: extractAuthor(item),
        published_at: extractPublishedAt(item),
        engagement: {
          view_count: item.playCount,
          like_count: item.diggCount,
          comment_count: item.commentCount,
        },
        raw_metadata: {
          share_count: item.shareCount,
          comments: item.comments !== undefined ? item.comments.slice(0, 50) : [],
        },
      };

      const validated = SearchResultSchema.safeParse(candidate);
      if (validated.success) {
        results.push(validated.data);
      }
    }

    logger.info(
      { query: query.slice(0, 60), count: results.length },
      '[TikTok] Search complete',
    );

    return results;
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    const token = getApifyToken();
    await rateLimit();

    // Extract video ID from URL for targeted fetch
    const videoIdMatch = /\/video\/(\d+)/.exec(url);
    const videoId = videoIdMatch !== null ? videoIdMatch[1] : null;

    const input: Record<string, unknown> = videoId !== null
      ? {
          videoUrls: [url],
          commentsPerPage: 100,
          shouldDownloadComments: true,
          shouldDownloadCommentReplies: false,
        }
      : {
          searchQueries: [url],
          resultsPerPage: 1,
          shouldDownloadComments: true,
          shouldDownloadCommentReplies: false,
        };

    // signal is passed to AbortSignal.timeout fallback; stored for future use
    void signal;

    let items: unknown[] = [];

    try {
      const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
      await pollRunUntilDone(runId, token);
      items = await fetchDatasetItems(datasetId, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return FetchResultSchema.parse({
        provider: 'tiktok',
        url,
        fetch_status: 'failed',
        fetch_error: `TikTok fetch failed: ${msg.slice(0, 200)}`,
      });
    }

    const firstItem = items[0];
    if (firstItem === undefined) {
      return FetchResultSchema.parse({
        provider: 'tiktok',
        url,
        fetch_status: 'failed',
        fetch_error: 'No items returned from Apify',
      });
    }

    const parsed = TikTokItemSchema.safeParse(firstItem);
    if (!parsed.success) {
      return FetchResultSchema.parse({
        provider: 'tiktok',
        url,
        fetch_status: 'failed',
        fetch_error: `Invalid item shape: ${parsed.error.message.slice(0, 100)}`,
      });
    }

    const item = parsed.data;
    const caption = item.text !== undefined ? item.text : '';
    const author = extractAuthor(item);

    // Build markdown with caption + top comments
    const lines: string[] = [
      `# TikTok: ${caption.slice(0, 100)}`,
      '',
      `**Creator:** ${author !== undefined ? author : 'Unknown'} | **Views:** ${item.playCount !== undefined ? item.playCount : 0} | **Likes:** ${item.diggCount !== undefined ? item.diggCount : 0}`,
      '',
      '## Caption',
      '',
      caption,
      '',
    ];

    const comments = item.comments;
    if (comments !== undefined && Array.isArray(comments) && comments.length > 0) {
      lines.push('## Top Comments', '');

      // Sort by diggCount desc
      const sortedComments = [...comments]
        .map(c => TikTokCommentSchema.safeParse(c))
        .filter(r => r.success)
        .map(r => r.data)
        .sort((a, b) => (b.diggCount !== undefined ? b.diggCount : 0) - (a.diggCount !== undefined ? a.diggCount : 0))
        .slice(0, 100);

      for (const comment of sortedComments) {
        const commentText = comment.text !== undefined ? comment.text : '';
        if (commentText.length === 0) continue;
        const commentAuthor = comment.uniqueId !== undefined ? `@${comment.uniqueId}` : 'Unknown';
        lines.push(`**${commentAuthor}** (${comment.diggCount !== undefined ? comment.diggCount : 0} likes)`);
        lines.push('');
        lines.push(commentText);
        lines.push('');
        lines.push('---');
        lines.push('');
      }
    }

    const markdown = lines.join('\n');

    const result = FetchResultSchema.parse({
      provider: 'tiktok',
      url,
      canonical_id: item.id !== undefined && item.id.length > 0 ? item.id : undefined,
      title: caption.slice(0, 200),
      author,
      published_at: extractPublishedAt(item),
      raw_content: caption,
      markdown,
      engagement: {
        view_count: item.playCount,
        like_count: item.diggCount,
        comment_count: item.commentCount,
      },
      fetch_status: 'ok',
      raw_metadata: {
        share_count: item.shareCount,
        comments: item.comments !== undefined ? item.comments.slice(0, 100) : [],
      },
    });

    logger.info(
      { url: url.slice(0, 60), comments: comments !== undefined ? comments.length : 0 },
      '[TikTok] Fetch complete',
    );

    return result;
  },

  async extract(raw: FetchResult): Promise<ExtractedQuotes> {
    const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
    return extractQuotesWithGemini({
      provider: 'tiktok',
      url: raw.url,
      content,
      mode: 'reddit', // closest equivalent — comment threads with engagement
    });
  },
};
