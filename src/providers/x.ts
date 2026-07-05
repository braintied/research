/**
 * X (Twitter) Search Provider
 *
 * Uses Apify actor `apidojo/tweet-scraper` (already in ACTOR_MAP) to search
 * tweets by query and fetch reply threads. Searches in English only.
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

const X_RATE_LIMIT_MS = 5000;
let lastXCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastXCallAt;
  if (elapsed < X_RATE_LIMIT_MS) {
    await sleep(X_RATE_LIMIT_MS - elapsed);
  }
  lastXCallAt = Date.now();
}

// =============================================================================
// Apify API helpers
// =============================================================================

const APIFY_BASE_URL = 'https://api.apify.com/v2';
const ACTOR_ID = 'apidojo/tweet-scraper';
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
// Tweet item schema (apidojo/tweet-scraper output shape)
// =============================================================================

const TweetAuthorSchema = z.object({
  userName: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
}).passthrough();

const TweetItemSchema = z.object({
  id: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  author: TweetAuthorSchema.optional(),
  createdAt: z.string().optional(),
  likeCount: z.number().optional(),
  viewCount: z.number().optional(),
  replyCount: z.number().optional(),
  retweetCount: z.number().optional(),
  quoteCount: z.number().optional(),
  lang: z.string().optional(),
  isReply: z.boolean().optional(),
  inReplyToId: z.string().optional(),
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

function extractTweetUrl(item: z.infer<typeof TweetItemSchema>): string | null {
  if (item.url !== undefined && item.url.length > 0) {
    return item.url;
  }
  const authorName = item.author !== undefined && item.author.userName !== undefined
    ? item.author.userName
    : 'i';
  if (item.id !== undefined && item.id.length > 0) {
    return `https://x.com/${authorName}/status/${item.id}`;
  }
  return null;
}

function extractAuthor(item: z.infer<typeof TweetItemSchema>): string | undefined {
  if (item.author === undefined) return undefined;
  const handle = item.author.userName;
  if (handle !== undefined && handle.length > 0) {
    return `@${handle}`;
  }
  const name = item.author.name;
  if (name !== undefined && name.length > 0) {
    return name;
  }
  return undefined;
}

// =============================================================================
// Provider
// =============================================================================

export const xProvider: SearchProvider = {
  name: 'x',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const token = getApifyToken();
    await rateLimit();

    const maxTweets = opts.limit !== undefined ? Math.min(opts.limit, 25) : 20;

    const input: Record<string, unknown> = {
      searchTerms: [query],
      tweetLanguage: 'en',
      maxTweets,
    };

    let items: unknown[] = [];

    try {
      const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
      await pollRunUntilDone(runId, token);
      items = await fetchDatasetItems(datasetId, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ query: query.slice(0, 60), error: msg }, '[X] Search failed');
      return [];
    }

    const results: SearchResult[] = [];

    for (const rawItem of items) {
      const parsed = TweetItemSchema.safeParse(rawItem);
      if (!parsed.success) continue;

      const item = parsed.data;
      const tweetUrl = extractTweetUrl(item);
      if (tweetUrl === null) continue;

      const text = item.text !== undefined ? item.text : '';
      const publishedAt = item.createdAt !== undefined ? toIsoString(item.createdAt) : undefined;

      const candidate = {
        provider: 'x' as const,
        url: tweetUrl,
        canonical_id: item.id !== undefined && item.id.length > 0 ? item.id : undefined,
        title: text.slice(0, 200),
        snippet: text.slice(0, 500),
        author: extractAuthor(item),
        published_at: publishedAt,
        engagement: {
          like_count: item.likeCount,
          view_count: item.viewCount,
        },
        raw_metadata: {
          retweet_count: item.retweetCount,
          reply_count: item.replyCount,
          quote_count: item.quoteCount,
          lang: item.lang,
        },
      };

      const validated = SearchResultSchema.safeParse(candidate);
      if (validated.success) {
        results.push(validated.data);
      }
    }

    logger.info(
      { query: query.slice(0, 60), count: results.length },
      '[X] Search complete',
    );

    return results;
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    const token = getApifyToken();
    await rateLimit();

    // Extract tweet ID from URL
    const tweetIdMatch = /\/status\/(\d+)/.exec(url);
    const tweetId = tweetIdMatch !== null ? tweetIdMatch[1] : null;

    // signal reserved for future cancellation support
    void signal;

    const input: Record<string, unknown> = tweetId !== null
      ? {
          tweetIds: [tweetId],
          includeReplies: true,
          maxTweets: 50,
        }
      : {
          searchTerms: [url],
          maxTweets: 1,
          includeReplies: true,
        };

    let items: unknown[] = [];

    try {
      const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
      await pollRunUntilDone(runId, token);
      items = await fetchDatasetItems(datasetId, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return FetchResultSchema.parse({
        provider: 'x',
        url,
        fetch_status: 'failed',
        fetch_error: `X fetch failed: ${msg.slice(0, 200)}`,
      });
    }

    if (items.length === 0) {
      return FetchResultSchema.parse({
        provider: 'x',
        url,
        fetch_status: 'failed',
        fetch_error: 'No items returned from Apify',
      });
    }

    // Separate the root tweet from replies
    const allParsed = items
      .map(i => TweetItemSchema.safeParse(i))
      .filter(r => r.success)
      .map(r => r.data);

    // Root tweet: the one with tweetId, or first non-reply, or just first
    let rootTweet = allParsed.find(t => t.id === tweetId);
    if (rootTweet === undefined) {
      rootTweet = allParsed.find(t => t.isReply !== true);
    }
    if (rootTweet === undefined) {
      rootTweet = allParsed[0];
    }

    if (rootTweet === undefined) {
      return FetchResultSchema.parse({
        provider: 'x',
        url,
        fetch_status: 'failed',
        fetch_error: 'Could not identify root tweet',
      });
    }

    const replies = allParsed.filter(t => t !== rootTweet && t.isReply === true);

    const rootText = rootTweet.text !== undefined ? rootTweet.text : '';
    const author = extractAuthor(rootTweet);

    // Build markdown
    const lines: string[] = [
      `# Tweet by ${author !== undefined ? author : 'Unknown'}`,
      '',
      `**Likes:** ${rootTweet.likeCount !== undefined ? rootTweet.likeCount : 0} | **Views:** ${rootTweet.viewCount !== undefined ? rootTweet.viewCount : 0} | **Replies:** ${rootTweet.replyCount !== undefined ? rootTweet.replyCount : 0}`,
      '',
      '## Tweet',
      '',
      rootText,
      '',
    ];

    if (replies.length > 0) {
      lines.push('## Replies', '');

      const sortedReplies = [...replies]
        .sort((a, b) => (b.likeCount !== undefined ? b.likeCount : 0) - (a.likeCount !== undefined ? a.likeCount : 0))
        .slice(0, 50);

      for (const reply of sortedReplies) {
        const replyText = reply.text !== undefined ? reply.text : '';
        if (replyText.length === 0) continue;
        const replyAuthor = extractAuthor(reply);
        lines.push(`**${replyAuthor !== undefined ? replyAuthor : 'Unknown'}** (${reply.likeCount !== undefined ? reply.likeCount : 0} likes)`);
        lines.push('');
        lines.push(replyText);
        lines.push('');
        lines.push('---');
        lines.push('');
      }
    }

    const markdown = lines.join('\n');
    const publishedAt = rootTweet.createdAt !== undefined ? toIsoString(rootTweet.createdAt) : undefined;

    const result = FetchResultSchema.parse({
      provider: 'x',
      url,
      canonical_id: rootTweet.id !== undefined && rootTweet.id.length > 0 ? rootTweet.id : undefined,
      title: rootText.slice(0, 200),
      author,
      published_at: publishedAt,
      raw_content: rootText,
      markdown,
      engagement: {
        like_count: rootTweet.likeCount,
        view_count: rootTweet.viewCount,
      },
      fetch_status: 'ok',
      raw_metadata: {
        retweet_count: rootTweet.retweetCount,
        reply_count: rootTweet.replyCount,
        replies: replies.slice(0, 50).map(r => ({
          id: r.id,
          text: r.text,
          author: extractAuthor(r),
          likes: r.likeCount,
        })),
      },
    });

    logger.info(
      { url: url.slice(0, 60), replies: replies.length },
      '[X] Fetch complete',
    );

    return result;
  },

  async extract(raw: FetchResult): Promise<ExtractedQuotes> {
    const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
    return extractQuotesWithGemini({
      provider: 'x',
      url: raw.url,
      content,
      mode: 'reddit', // closest equivalent — threaded replies with engagement
    });
  },
};
