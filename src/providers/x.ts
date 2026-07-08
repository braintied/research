/**
 * X (Twitter) Search Provider
 *
 * Primary backend: twitterapi.io — the canonical X read path across Braintied
 * repos (datacenter-safe, no actor spin-up, ~$0.15/1k tweets, NOT gated by the
 * Apify account cap). Endpoints verified live in cortex-worker's
 * twitterapi-client and Swishh's scrape stack:
 *   GET /twitter/tweet/advanced_search?queryType=Top&query=...  → { tweets[] }
 *   GET /twitter/tweets?tweet_ids=<id>                          → { tweets[] }
 *   GET /twitter/tweet/replies?tweetId=<id>                     → { tweets[] } (replies arrive under `tweets`)
 *
 * Fallback backend: Apify actor `apidojo/tweet-scraper` (legacy path) when
 * TWITTERAPI_IO_KEY is absent or the twitterapi.io transport errors.
 *
 * Rate limits: 350ms courtesy gap between twitterapi.io calls; 5-second queue
 * between Apify calls (shared convention with other Apify providers).
 * Env: TWITTERAPI_IO_KEY (legacy alias TWITTERAPI_KEY) and/or APIFY_API_TOKEN.
 * The provider is enabled when either backend is configured.
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
// Rate limiters
// =============================================================================

const X_APIFY_RATE_LIMIT_MS = 5000;
let lastApifyCallAt = 0;

async function apifyRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastApifyCallAt;
  if (elapsed < X_APIFY_RATE_LIMIT_MS) {
    await sleep(X_APIFY_RATE_LIMIT_MS - elapsed);
  }
  lastApifyCallAt = Date.now();
}

const TWITTERAPI_RATE_LIMIT_MS = 350;
let lastTwitterApiCallAt = 0;

async function twitterApiRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastTwitterApiCallAt;
  if (elapsed < TWITTERAPI_RATE_LIMIT_MS) {
    await sleep(TWITTERAPI_RATE_LIMIT_MS - elapsed);
  }
  lastTwitterApiCallAt = Date.now();
}

// =============================================================================
// twitterapi.io transport
// =============================================================================

const TWITTERAPI_BASE_URL = 'https://api.twitterapi.io';
const TWITTERAPI_TIMEOUT_MS = 30_000;

function getTwitterApiKey(): string | null {
  const key = process.env.TWITTERAPI_IO_KEY;
  if (key !== undefined && key !== '') return key;
  const legacy = process.env.TWITTERAPI_KEY;
  if (legacy !== undefined && legacy !== '') return legacy;
  return null;
}

// Envelope varies by endpoint: /twitter/tweets and advanced_search return the
// array under `tweets`; /twitter/tweet/replies ALSO returns it under `tweets`
// (verified live in cortex-worker — `replies` is accepted defensively if the
// service ever emits it); user endpoints nest under `data.tweets`.
const TwitterApiEnvelopeSchema = z.object({
  status: z.string().optional(),
  msg: z.string().optional(),
  tweets: z.array(z.unknown()).optional(),
  replies: z.array(z.unknown()).optional(),
  data: z.object({
    tweets: z.array(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough();

/**
 * GET a twitterapi.io endpoint and return the tweet array from whichever
 * envelope key it arrives under. Throws on transport/HTTP errors so callers
 * can fall back to the Apify backend; an OK response with zero tweets is a
 * legitimate empty result (returned as []) and must NOT trigger fallback.
 */
async function twitterApiGet(
  path: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<unknown[]> {
  await twitterApiRateLimit();

  const search = new URLSearchParams(params);
  const url = `${TWITTERAPI_BASE_URL}${path}?${search.toString()}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'X-API-Key': apiKey },
    signal: AbortSignal.timeout(TWITTERAPI_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`twitterapi.io error (${path}): HTTP ${response.status} ${body.slice(0, 150)}`);
  }

  const raw: unknown = await response.json();
  const parsed = TwitterApiEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`twitterapi.io envelope failed validation (${path})`);
  }

  if (parsed.data.replies !== undefined) return parsed.data.replies;
  if (parsed.data.tweets !== undefined) return parsed.data.tweets;
  if (parsed.data.data !== undefined && parsed.data.data.tweets !== undefined) {
    return parsed.data.data.tweets;
  }
  return [];
}

// =============================================================================
// Apify API helpers (fallback backend)
// =============================================================================

const APIFY_BASE_URL = 'https://api.apify.com/v2';
const ACTOR_ID = 'apidojo/tweet-scraper';
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 5 * 60 * 1_000;

function getApifyToken(): string | null {
  const token = process.env.APIFY_API_TOKEN;
  if (token !== undefined && token !== '') return token;
  return null;
}

function isEnabled(): boolean {
  return getTwitterApiKey() !== null || getApifyToken() !== null;
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
// Tweet item schema — accepts both apidojo/tweet-scraper (camelCase) and
// twitterapi.io (camelCase with occasional snake_case/string-count variants)
// =============================================================================

// Every scalar is `.nullable().optional()`: twitterapi.io emits explicit
// `null` for absent values (e.g. `inReplyToId: null` on non-replies), and a
// plain `.optional()` rejects null — which silently dropped EVERY tweet
// (verified live 2026-07-07: 20 tweets in, 0 parsed out).
const TweetAuthorSchema = z.object({
  userName: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  screen_name: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  id: z.union([z.string(), z.number()]).nullable().optional(),
}).passthrough();

const TweetItemSchema = z.object({
  id: z.union([z.string(), z.number()]).nullable().optional(),
  id_str: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  fullText: z.string().nullable().optional(),
  full_text: z.string().nullable().optional(),
  author: TweetAuthorSchema.nullable().optional(),
  user: TweetAuthorSchema.nullable().optional(),
  createdAt: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  likeCount: z.number().nullable().optional(),
  like_count: z.number().nullable().optional(),
  viewCount: z.union([z.number(), z.string()]).nullable().optional(),
  view_count: z.union([z.number(), z.string()]).nullable().optional(),
  replyCount: z.number().nullable().optional(),
  reply_count: z.number().nullable().optional(),
  retweetCount: z.number().nullable().optional(),
  retweet_count: z.number().nullable().optional(),
  quoteCount: z.number().nullable().optional(),
  quote_count: z.number().nullable().optional(),
  lang: z.string().nullable().optional(),
  isReply: z.boolean().nullable().optional(),
  inReplyToId: z.string().nullable().optional(),
}).passthrough();

type TweetItem = z.infer<typeof TweetItemSchema>;

// =============================================================================
// Field readers (variant-tolerant)
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

// All readers use typeof guards: fields can be absent OR explicit null, and a
// `!== undefined` check alone would let null through to a `.length` crash.

function tweetId(item: TweetItem): string | undefined {
  if (typeof item.id === 'string' && item.id.length > 0) return item.id;
  if (typeof item.id === 'number') return String(item.id);
  if (typeof item.id_str === 'string' && item.id_str.length > 0) return item.id_str;
  return undefined;
}

function tweetText(item: TweetItem): string {
  if (typeof item.fullText === 'string' && item.fullText.length > 0) return item.fullText;
  if (typeof item.full_text === 'string' && item.full_text.length > 0) return item.full_text;
  if (typeof item.text === 'string') return item.text;
  return '';
}

function tweetCreatedAt(item: TweetItem): string | undefined {
  if (typeof item.createdAt === 'string') return toIsoString(item.createdAt);
  if (typeof item.created_at === 'string') return toIsoString(item.created_at);
  return undefined;
}

function readCount(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return n;
    return undefined;
  }
  return undefined;
}

function tweetLikes(item: TweetItem): number | undefined {
  if (typeof item.likeCount === 'number') return item.likeCount;
  if (typeof item.like_count === 'number') return item.like_count;
  return undefined;
}

function tweetViews(item: TweetItem): number | undefined {
  const camel = readCount(item.viewCount);
  if (camel !== undefined) return camel;
  return readCount(item.view_count);
}

function tweetReplies(item: TweetItem): number | undefined {
  if (typeof item.replyCount === 'number') return item.replyCount;
  if (typeof item.reply_count === 'number') return item.reply_count;
  return undefined;
}

function tweetRetweets(item: TweetItem): number | undefined {
  if (typeof item.retweetCount === 'number') return item.retweetCount;
  if (typeof item.retweet_count === 'number') return item.retweet_count;
  return undefined;
}

function tweetQuotes(item: TweetItem): number | undefined {
  if (typeof item.quoteCount === 'number') return item.quoteCount;
  if (typeof item.quote_count === 'number') return item.quote_count;
  return undefined;
}

function tweetAuthorRecord(item: TweetItem): z.infer<typeof TweetAuthorSchema> | undefined {
  if (item.author !== undefined && item.author !== null) return item.author;
  if (item.user !== undefined && item.user !== null) return item.user;
  return undefined;
}

function tweetAuthorHandle(item: TweetItem): string | undefined {
  const author = tweetAuthorRecord(item);
  if (author === undefined) return undefined;
  if (typeof author.userName === 'string' && author.userName.length > 0) return author.userName;
  if (typeof author.username === 'string' && author.username.length > 0) return author.username;
  if (typeof author.screen_name === 'string' && author.screen_name.length > 0) return author.screen_name;
  return undefined;
}

function extractAuthor(item: TweetItem): string | undefined {
  const handle = tweetAuthorHandle(item);
  if (handle !== undefined) return `@${handle}`;
  const author = tweetAuthorRecord(item);
  if (author !== undefined && typeof author.name === 'string' && author.name.length > 0) {
    return author.name;
  }
  return undefined;
}

function extractTweetUrl(item: TweetItem): string | null {
  if (typeof item.url === 'string' && item.url.length > 0) {
    return item.url;
  }
  const handle = tweetAuthorHandle(item);
  const authorName = handle !== undefined ? handle : 'i';
  const id = tweetId(item);
  if (id !== undefined) {
    return `https://x.com/${authorName}/status/${id}`;
  }
  return null;
}

// =============================================================================
// Shared mappers (both backends produce TweetItem)
// =============================================================================

function mapTweetToSearchResult(item: TweetItem): SearchResult | null {
  const tweetUrl = extractTweetUrl(item);
  if (tweetUrl === null) return null;

  const text = tweetText(item);

  const candidate = {
    provider: 'x' as const,
    url: tweetUrl,
    canonical_id: tweetId(item),
    title: text.slice(0, 200),
    snippet: text.slice(0, 500),
    author: extractAuthor(item),
    published_at: tweetCreatedAt(item),
    engagement: {
      like_count: tweetLikes(item),
      view_count: tweetViews(item),
    },
    raw_metadata: {
      retweet_count: tweetRetweets(item),
      reply_count: tweetReplies(item),
      quote_count: tweetQuotes(item),
      lang: item.lang,
    },
  };

  const validated = SearchResultSchema.safeParse(candidate);
  if (validated.success) return validated.data;
  return null;
}

function buildTweetFetchResult(
  url: string,
  rootTweet: TweetItem,
  replies: TweetItem[],
): FetchResult {
  const rootText = tweetText(rootTweet);
  const author = extractAuthor(rootTweet);
  const rootLikes = tweetLikes(rootTweet);
  const rootViews = tweetViews(rootTweet);
  const rootReplyCount = tweetReplies(rootTweet);

  const lines: string[] = [
    `# Tweet by ${author !== undefined ? author : 'Unknown'}`,
    '',
    `**Likes:** ${rootLikes !== undefined ? rootLikes : 0} | **Views:** ${rootViews !== undefined ? rootViews : 0} | **Replies:** ${rootReplyCount !== undefined ? rootReplyCount : 0}`,
    '',
    '## Tweet',
    '',
    rootText,
    '',
  ];

  if (replies.length > 0) {
    lines.push('## Replies', '');

    const sortedReplies = [...replies]
      .sort((a, b) => {
        const aLikes = tweetLikes(a);
        const bLikes = tweetLikes(b);
        return (bLikes !== undefined ? bLikes : 0) - (aLikes !== undefined ? aLikes : 0);
      })
      .slice(0, 50);

    for (const reply of sortedReplies) {
      const replyText = tweetText(reply);
      if (replyText.length === 0) continue;
      const replyAuthor = extractAuthor(reply);
      const replyLikes = tweetLikes(reply);
      lines.push(`**${replyAuthor !== undefined ? replyAuthor : 'Unknown'}** (${replyLikes !== undefined ? replyLikes : 0} likes)`);
      lines.push('');
      lines.push(replyText);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  const markdown = lines.join('\n');

  return FetchResultSchema.parse({
    provider: 'x',
    url,
    canonical_id: tweetId(rootTweet),
    title: rootText.slice(0, 200),
    author,
    published_at: tweetCreatedAt(rootTweet),
    raw_content: rootText,
    markdown,
    engagement: {
      like_count: rootLikes,
      view_count: rootViews,
    },
    fetch_status: 'ok',
    raw_metadata: {
      retweet_count: tweetRetweets(rootTweet),
      reply_count: rootReplyCount,
      replies: replies.slice(0, 50).map(r => ({
        id: tweetId(r),
        text: tweetText(r),
        author: extractAuthor(r),
        likes: tweetLikes(r),
      })),
    },
  });
}

function parseTweetItems(items: unknown[]): TweetItem[] {
  const parsed: TweetItem[] = [];
  for (const rawItem of items) {
    const result = TweetItemSchema.safeParse(rawItem);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

// =============================================================================
// Backend implementations
// =============================================================================

async function searchViaTwitterApi(
  query: string,
  opts: SearchOpts,
  apiKey: string,
): Promise<SearchResult[]> {
  // NOTE: do NOT append `-filter:retweets` — twitterapi.io's advanced_search
  // returns ZERO results for any query carrying that operator (verified live
  // 2026-07-07: "dropshipping -filter:retweets" → 0, "dropshipping" → 16).
  // `lang:en` and `min_faves:` work fine. Top queryType already favors
  // original high-engagement posts over retweets.
  const searchQuery = `${query} lang:en`;
  const items = await twitterApiGet(
    '/twitter/tweet/advanced_search',
    { queryType: 'Top', query: searchQuery },
    apiKey,
  );

  const limit = opts.limit !== undefined ? opts.limit : 20;
  const results: SearchResult[] = [];
  for (const item of parseTweetItems(items)) {
    const mapped = mapTweetToSearchResult(item);
    if (mapped !== null) results.push(mapped);
    if (results.length >= limit) break;
  }
  return results;
}

async function searchViaApify(
  query: string,
  opts: SearchOpts,
  token: string,
): Promise<SearchResult[]> {
  await apifyRateLimit();

  const maxTweets = opts.limit !== undefined ? Math.min(opts.limit, 25) : 20;

  const input: Record<string, unknown> = {
    searchTerms: [query],
    tweetLanguage: 'en',
    maxTweets,
  };

  const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
  await pollRunUntilDone(runId, token);
  const items = await fetchDatasetItems(datasetId, token);

  const results: SearchResult[] = [];
  for (const item of parseTweetItems(items)) {
    const mapped = mapTweetToSearchResult(item);
    if (mapped !== null) results.push(mapped);
  }
  return results;
}

async function fetchViaTwitterApi(
  url: string,
  tweetIdValue: string,
  apiKey: string,
): Promise<FetchResult | null> {
  const rootItems = await twitterApiGet(
    '/twitter/tweets',
    { tweet_ids: tweetIdValue },
    apiKey,
  );
  const rootParsed = parseTweetItems(rootItems);
  if (rootParsed.length === 0) return null;
  const rootTweet = rootParsed[0];

  // Replies are best-effort — a transport error here should not fail the fetch.
  let replies: TweetItem[] = [];
  try {
    const replyItems = await twitterApiGet(
      '/twitter/tweet/replies',
      { tweetId: tweetIdValue },
      apiKey,
    );
    replies = parseTweetItems(replyItems).filter(r => {
      const id = tweetId(r);
      return id === undefined || id !== tweetIdValue;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ url: url.slice(0, 60), error: msg.slice(0, 100) }, '[X] twitterapi.io replies fetch failed (continuing without)');
  }

  return buildTweetFetchResult(url, rootTweet, replies);
}

async function fetchViaApify(
  url: string,
  tweetIdValue: string | null,
  token: string,
): Promise<FetchResult> {
  await apifyRateLimit();

  const input: Record<string, unknown> = tweetIdValue !== null
    ? {
        tweetIds: [tweetIdValue],
        includeReplies: true,
        maxTweets: 50,
      }
    : {
        searchTerms: [url],
        maxTweets: 1,
        includeReplies: true,
      };

  const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
  await pollRunUntilDone(runId, token);
  const items = await fetchDatasetItems(datasetId, token);

  if (items.length === 0) {
    return FetchResultSchema.parse({
      provider: 'x',
      url,
      fetch_status: 'failed',
      fetch_error: 'No items returned from Apify',
    });
  }

  const allParsed = parseTweetItems(items);

  let rootTweet = allParsed.find(t => tweetId(t) === tweetIdValue);
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

  const root = rootTweet;
  const replies = allParsed.filter(t => t !== root && t.isReply === true);

  return buildTweetFetchResult(url, root, replies);
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
    const twitterApiKey = getTwitterApiKey();
    const apifyToken = getApifyToken();

    if (twitterApiKey !== null) {
      try {
        const results = await searchViaTwitterApi(query, opts, twitterApiKey);
        logger.info(
          { query: query.slice(0, 60), count: results.length, backend: 'twitterapi' },
          '[X] Search complete',
        );
        return results;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { query: query.slice(0, 60), error: msg.slice(0, 120) },
          '[X] twitterapi.io search failed — falling back to Apify',
        );
      }
    }

    if (apifyToken === null) {
      logger.warn({ query: query.slice(0, 60) }, '[X] No usable X backend (twitterapi.io failed or unset; no APIFY_API_TOKEN)');
      return [];
    }

    try {
      const results = await searchViaApify(query, opts, apifyToken);
      logger.info(
        { query: query.slice(0, 60), count: results.length, backend: 'apify' },
        '[X] Search complete',
      );
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ query: query.slice(0, 60), error: msg }, '[X] Search failed');
      return [];
    }
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    // signal reserved for future cancellation support
    void signal;

    const tweetIdMatch = /\/status\/(\d+)/.exec(url);
    const tweetIdValue = tweetIdMatch !== null ? tweetIdMatch[1] : null;

    const twitterApiKey = getTwitterApiKey();
    const apifyToken = getApifyToken();

    if (twitterApiKey !== null && tweetIdValue !== null) {
      try {
        const result = await fetchViaTwitterApi(url, tweetIdValue, twitterApiKey);
        if (result !== null) {
          logger.info({ url: url.slice(0, 60), backend: 'twitterapi' }, '[X] Fetch complete');
          return result;
        }
        logger.warn({ url: url.slice(0, 60) }, '[X] twitterapi.io returned no tweet for id — falling back');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { url: url.slice(0, 60), error: msg.slice(0, 120) },
          '[X] twitterapi.io fetch failed — falling back to Apify',
        );
      }
    }

    if (apifyToken === null) {
      return FetchResultSchema.parse({
        provider: 'x',
        url,
        fetch_status: 'failed',
        fetch_error: 'No usable X backend (twitterapi.io failed or unset; no APIFY_API_TOKEN)',
      });
    }

    try {
      const result = await fetchViaApify(url, tweetIdValue, apifyToken);
      logger.info({ url: url.slice(0, 60), backend: 'apify' }, '[X] Fetch complete');
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return FetchResultSchema.parse({
        provider: 'x',
        url,
        fetch_status: 'failed',
        fetch_error: `X fetch failed: ${msg.slice(0, 200)}`,
      });
    }
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
