/**
 * Instagram Reels Search Provider
 *
 * Uses Apify actor `apify/instagram-reel-scraper` to search Reels by hashtag
 * and fetch comment threads. The provider pivots a text query to likely
 * hashtags (e.g. "AI for teachers" → #aiforteachers, #chatgptforteachers).
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

const IG_RATE_LIMIT_MS = 5000;
let lastIgCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastIgCallAt;
  if (elapsed < IG_RATE_LIMIT_MS) {
    await sleep(IG_RATE_LIMIT_MS - elapsed);
  }
  lastIgCallAt = Date.now();
}

// =============================================================================
// Apify API helpers
// =============================================================================

const APIFY_BASE_URL = 'https://api.apify.com/v2';
const ACTOR_ID = 'apify/instagram-reel-scraper';
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
// Hashtag derivation — pivot a free-text query to candidate hashtags
// =============================================================================

function deriveHashtags(query: string): string[] {
  // Normalize: lowercase, strip punctuation, split on spaces
  const normalized = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const words = normalized.split(/\s+/).filter(w => w.length > 1);

  const hashtags: string[] = [];

  // Full phrase concatenated (e.g. "ai for teachers" → "aiforteachers")
  const fullSlug = words.join('');
  if (fullSlug.length > 0 && fullSlug.length <= 30) {
    hashtags.push(fullSlug);
  }

  // Key-word pairs that are commonly hashtagged
  if (words.length >= 2) {
    const pairSlug = words.slice(0, 2).join('');
    if (pairSlug !== fullSlug) {
      hashtags.push(pairSlug);
    }
  }

  // Prepend "chatgpt" variant if query mentions "ai" or "chatgpt"
  if (words.includes('ai') || words.includes('chatgpt')) {
    const withChatgpt = words
      .filter(w => w !== 'ai' && w !== 'chatgpt' && w !== 'for' && w !== 'the' && w !== 'and')
      .slice(0, 2)
      .join('');
    if (withChatgpt.length > 0) {
      hashtags.push(`chatgpt${withChatgpt}`);
      hashtags.push(`ai${withChatgpt}`);
    }
  }

  // Always include a broad "ai" hashtag as fallback
  if (!hashtags.includes('artificialintelligence')) {
    hashtags.push('artificialintelligence');
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tag of hashtags) {
    if (!seen.has(tag)) {
      seen.add(tag);
      unique.push(tag);
    }
  }

  return unique.slice(0, 3); // max 3 hashtag searches per query
}

// =============================================================================
// Instagram Reel item schema (apify/instagram-reel-scraper output shape)
// =============================================================================

const IgReelCommentSchema = z.object({
  text: z.string().optional(),
  ownerUsername: z.string().optional(),
  likesCount: z.number().optional(),
  timestamp: z.string().optional(),
}).passthrough();

const IgReelItemSchema = z.object({
  id: z.string().optional(),
  shortCode: z.string().optional(),
  url: z.string().optional(),
  caption: z.string().optional(),
  ownerUsername: z.string().optional(),
  timestamp: z.string().optional(),
  videoViewCount: z.number().optional(),
  likesCount: z.number().optional(),
  commentsCount: z.number().optional(),
  hashtags: z.array(z.string()).optional(),
  comments: z.array(IgReelCommentSchema).optional(),
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

function extractReelUrl(item: z.infer<typeof IgReelItemSchema>): string | null {
  if (item.url !== undefined && item.url.length > 0) {
    return item.url;
  }
  if (item.shortCode !== undefined && item.shortCode.length > 0) {
    return `https://www.instagram.com/reel/${item.shortCode}/`;
  }
  if (item.id !== undefined && item.id.length > 0) {
    return `https://www.instagram.com/p/${item.id}/`;
  }
  return null;
}

// =============================================================================
// Provider
// =============================================================================

export const instagramProvider: SearchProvider = {
  name: 'instagram',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const token = getApifyToken();
    const limit = opts.limit !== undefined ? Math.min(opts.limit, 25) : 15;

    const hashtags = deriveHashtags(query);
    const results: SearchResult[] = [];

    // Search up to 2 hashtags per query call
    for (const hashtag of hashtags.slice(0, 2)) {
      await rateLimit();

      const input: Record<string, unknown> = {
        search: hashtag,
        searchType: 'hashtag',
        resultsLimit: limit,
      };

      let items: unknown[] = [];

      try {
        const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
        await pollRunUntilDone(runId, token);
        items = await fetchDatasetItems(datasetId, token);
        logger.info(
          { hashtag, items: items.length, query: query.slice(0, 60) },
          '[Instagram] Hashtag scrape complete',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ hashtag, error: msg }, '[Instagram] Hashtag scrape failed, skipping');
        continue;
      }

      for (const rawItem of items) {
        const parsed = IgReelItemSchema.safeParse(rawItem);
        if (!parsed.success) continue;

        const item = parsed.data;
        const reelUrl = extractReelUrl(item);
        if (reelUrl === null) continue;

        const caption = item.caption !== undefined ? item.caption : '';
        const author = item.ownerUsername !== undefined && item.ownerUsername.length > 0
          ? `@${item.ownerUsername}`
          : undefined;
        const publishedAt = item.timestamp !== undefined ? toIsoString(item.timestamp) : undefined;

        const candidate = {
          provider: 'instagram' as const,
          url: reelUrl,
          canonical_id: item.shortCode !== undefined && item.shortCode.length > 0
            ? item.shortCode
            : (item.id !== undefined && item.id.length > 0 ? item.id : undefined),
          title: caption.slice(0, 200),
          snippet: caption.slice(0, 500),
          author,
          published_at: publishedAt,
          engagement: {
            view_count: item.videoViewCount,
            like_count: item.likesCount,
            comment_count: item.commentsCount,
          },
          raw_metadata: {
            hashtag,
            hashtags: item.hashtags,
          },
        };

        const validated = SearchResultSchema.safeParse(candidate);
        if (validated.success) {
          results.push(validated.data);
        }
      }
    }

    logger.info(
      { query: query.slice(0, 60), count: results.length, hashtags },
      '[Instagram] Search complete',
    );

    return results;
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    const token = getApifyToken();
    await rateLimit();

    // signal reserved for future cancellation support
    void signal;

    const input: Record<string, unknown> = {
      directUrls: [url],
      resultsLimit: 1,
      commentsLimit: 100,
    };

    let items: unknown[] = [];

    try {
      const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
      await pollRunUntilDone(runId, token);
      items = await fetchDatasetItems(datasetId, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return FetchResultSchema.parse({
        provider: 'instagram',
        url,
        fetch_status: 'failed',
        fetch_error: `Instagram fetch failed: ${msg.slice(0, 200)}`,
      });
    }

    const firstItem = items[0];
    if (firstItem === undefined) {
      return FetchResultSchema.parse({
        provider: 'instagram',
        url,
        fetch_status: 'failed',
        fetch_error: 'No items returned from Apify',
      });
    }

    const parsed = IgReelItemSchema.safeParse(firstItem);
    if (!parsed.success) {
      return FetchResultSchema.parse({
        provider: 'instagram',
        url,
        fetch_status: 'failed',
        fetch_error: `Invalid item shape: ${parsed.error.message.slice(0, 100)}`,
      });
    }

    const item = parsed.data;
    const caption = item.caption !== undefined ? item.caption : '';
    const author = item.ownerUsername !== undefined && item.ownerUsername.length > 0
      ? `@${item.ownerUsername}`
      : undefined;

    // Build markdown with caption + top comments
    const lines: string[] = [
      `# Instagram Reel: ${caption.slice(0, 100)}`,
      '',
      `**Creator:** ${author !== undefined ? author : 'Unknown'} | **Views:** ${item.videoViewCount !== undefined ? item.videoViewCount : 0} | **Likes:** ${item.likesCount !== undefined ? item.likesCount : 0}`,
      '',
      '## Caption',
      '',
      caption,
      '',
    ];

    const comments = item.comments;
    if (comments !== undefined && Array.isArray(comments) && comments.length > 0) {
      lines.push('## Comments', '');

      const sortedComments = [...comments]
        .map(c => IgReelCommentSchema.safeParse(c))
        .filter(r => r.success)
        .map(r => r.data)
        .sort((a, b) => (b.likesCount !== undefined ? b.likesCount : 0) - (a.likesCount !== undefined ? a.likesCount : 0))
        .slice(0, 100);

      for (const comment of sortedComments) {
        const commentText = comment.text !== undefined ? comment.text : '';
        if (commentText.length === 0) continue;
        const commentAuthor = comment.ownerUsername !== undefined ? `@${comment.ownerUsername}` : 'Unknown';
        lines.push(`**${commentAuthor}** (${comment.likesCount !== undefined ? comment.likesCount : 0} likes)`);
        lines.push('');
        lines.push(commentText);
        lines.push('');
        lines.push('---');
        lines.push('');
      }
    }

    const markdown = lines.join('\n');
    const publishedAt = item.timestamp !== undefined ? toIsoString(item.timestamp) : undefined;

    const result = FetchResultSchema.parse({
      provider: 'instagram',
      url,
      canonical_id: item.shortCode !== undefined && item.shortCode.length > 0
        ? item.shortCode
        : (item.id !== undefined && item.id.length > 0 ? item.id : undefined),
      title: caption.slice(0, 200),
      author,
      published_at: publishedAt,
      raw_content: caption,
      markdown,
      engagement: {
        view_count: item.videoViewCount,
        like_count: item.likesCount,
        comment_count: item.commentsCount,
      },
      fetch_status: 'ok',
      raw_metadata: {
        hashtags: item.hashtags,
        comments: item.comments !== undefined ? item.comments.slice(0, 100) : [],
      },
    });

    logger.info(
      { url: url.slice(0, 60), comments: comments !== undefined ? comments.length : 0 },
      '[Instagram] Fetch complete',
    );

    return result;
  },

  async extract(raw: FetchResult): Promise<ExtractedQuotes> {
    const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
    return extractQuotesWithGemini({
      provider: 'instagram',
      url: raw.url,
      content,
      mode: 'reddit', // closest equivalent — comment threads with engagement
    });
  },
};
