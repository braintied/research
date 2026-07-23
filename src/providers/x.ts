/**
 * X (Twitter) Search Provider
 *
 * Primary backend: twitterapi.io — the established, lower-cost X read path
 * across Braintied repos (datacenter-safe, no actor spin-up, NOT gated by the
 * Apify account cap). Endpoints verified live in cortex-worker's
 * twitterapi-client and Swishh's scrape stack:
 *   GET /twitter/tweet/advanced_search?queryType=Top&query=...  → { tweets[] }
 *   GET /twitter/tweets?tweet_ids=<id>                          → { tweets[] }
 *   GET /twitter/tweet/replies?tweetId=<id>                     → { tweets[] } (replies arrive under `tweets`)
 *
 * Secondary backend: official X API v2 when X_BEARER_TOKEN (or its
 * X_APP_BEARER_TOKEN / TWITTER_BEARER_TOKEN aliases) is configured. Discovery
 * uses recent search with exact RFC3339 bounds, native relevancy/recency
 * ordering, and pagination; fetch uses post lookup plus best-effort
 * recent-conversation retrieval. The seven-day endpoint fails closed when it
 * cannot cover a requested historical window.
 *
 * Final fallback: Apify actor `apidojo/tweet-scraper` (legacy path) when the
 * twitterapi.io and official transports are absent or fail.
 *
 * Rate limits: 350ms courtesy gap between twitterapi.io calls; 5-second queue
 * between Apify calls (shared convention with other Apify providers).
 * Env: X_BEARER_TOKEN (aliases X_APP_BEARER_TOKEN and TWITTER_BEARER_TOKEN),
 * TWITTERAPI_IO_KEY (legacy alias TWITTERAPI_KEY), and/or APIFY_API_TOKEN. The
 * provider is enabled when any backend is configured.
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

type XBackend = 'x_api_v2' | 'twitterapi_io' | 'apify';

// =============================================================================
// Official X API v2 transport (secondary backend)
// =============================================================================

const OFFICIAL_X_BASE_URL = 'https://api.x.com/2';
const OFFICIAL_X_TIMEOUT_MS = 30_000;
const X_RECENT_WINDOW_MS = 7 * 86_400_000;
// X recent search deliberately trails real time. Keeping the implicit upper
// boundary 30 seconds behind now avoids transient "end_time too recent" errors.
const X_RECENT_SAFETY_LAG_MS = 30_000;

function getOfficialXBearerToken(): string | null {
  const token = process.env.X_BEARER_TOKEN;
  if (token !== undefined && token.trim() !== '') return token.trim();
  const deployedAlias = process.env.X_APP_BEARER_TOKEN;
  if (deployedAlias !== undefined && deployedAlias.trim() !== '') return deployedAlias.trim();
  const legacy = process.env.TWITTER_BEARER_TOKEN;
  if (legacy !== undefined && legacy.trim() !== '') return legacy.trim();
  return null;
}

const OfficialXPublicMetricsSchema = z.object({
  retweet_count: z.number().nonnegative().optional(),
  reply_count: z.number().nonnegative().optional(),
  like_count: z.number().nonnegative().optional(),
  quote_count: z.number().nonnegative().optional(),
  bookmark_count: z.number().nonnegative().optional(),
  impression_count: z.number().nonnegative().optional(),
}).passthrough();

const OfficialXReferencedPostSchema = z.object({
  type: z.string(),
  id: z.string(),
}).passthrough();

const OfficialXPostSchema = z.object({
  id: z.string(),
  text: z.string().default(''),
  author_id: z.string().optional(),
  conversation_id: z.string().optional(),
  created_at: z.string().optional(),
  lang: z.string().optional(),
  public_metrics: OfficialXPublicMetricsSchema.optional(),
  referenced_tweets: z.array(OfficialXReferencedPostSchema).optional(),
}).passthrough();

const OfficialXUserSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  username: z.string().optional(),
}).passthrough();

const OfficialXEnvelopeSchema = z.object({
  data: z.union([OfficialXPostSchema, z.array(OfficialXPostSchema)]).optional(),
  includes: z.object({
    users: z.array(OfficialXUserSchema).optional(),
  }).passthrough().optional(),
  meta: z.object({
    next_token: z.string().optional(),
  }).passthrough().optional(),
  errors: z.array(z.unknown()).optional(),
}).passthrough();

type OfficialXEnvelope = z.infer<typeof OfficialXEnvelopeSchema>;
type OfficialXPost = z.infer<typeof OfficialXPostSchema>;
type OfficialXUser = z.infer<typeof OfficialXUserSchema>;

async function officialXGet(
  path: string,
  params: Record<string, string>,
  bearerToken: string,
  signal?: AbortSignal,
): Promise<OfficialXEnvelope> {
  const search = new URLSearchParams(params);
  const url = `${OFFICIAL_X_BASE_URL}${path}?${search.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: 'application/json',
    },
    signal: signal !== undefined ? signal : AbortSignal.timeout(OFFICIAL_X_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`X API v2 error (${path}): HTTP ${response.status} ${body.slice(0, 150)}`);
  }

  const raw: unknown = await response.json();
  const parsed = OfficialXEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`X API v2 envelope failed validation (${path})`);
  }
  if (parsed.data.data === undefined && parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
    throw new Error(`X API v2 returned errors without data (${path})`);
  }
  return parsed.data;
}

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

// Fetch envelopes vary by endpoint: /twitter/tweets returns the array under
// `tweets`; /twitter/tweet/replies ALSO returns it under `tweets` (verified live
// in cortex-worker — `replies` is accepted defensively if the service ever
// emits it); user endpoints nest under `data.tweets`. Advanced search has its
// own stricter, status-less cursor envelope below.
const TwitterApiEnvelopeSchema = z.object({
  status: z.string().optional(),
  msg: z.string().optional(),
  tweets: z.array(z.unknown()).optional(),
  replies: z.array(z.unknown()).optional(),
  data: z.object({
    tweets: z.array(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough();

// Live shape verified from ora-cortex-worker with a single masked request on
// 2026-07-21: { tweets, has_next_page, next_cursor }, with no status/msg field.
// Keep optional legacy status/msg typed if the service reintroduces them, but
// require the actual cursor contract and minimally validate every tweet before
// the full variant-tolerant TweetItemSchema is applied downstream.
const TwitterApiSearchTweetSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
}).passthrough();

const TwitterApiSearchEnvelopeSchema = z.object({
  tweets: z.array(TwitterApiSearchTweetSchema),
  has_next_page: z.boolean(),
  next_cursor: z.string(),
  status: z.string().optional(),
  msg: z.string().optional(),
}).passthrough().refine(
  (envelope) => !envelope.has_next_page || envelope.next_cursor.length > 0,
  { message: 'next_cursor must be non-empty when has_next_page is true' },
);

interface TwitterApiSearchPage {
  tweets: unknown[];
  hasNextPage: boolean;
  nextCursor: string;
}

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

async function twitterApiSearchPage(
  query: string,
  queryType: 'Top' | 'Latest',
  cursor: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<TwitterApiSearchPage> {
  await twitterApiRateLimit();

  const search = new URLSearchParams({ query, queryType });
  if (cursor.length > 0) search.set('cursor', cursor);
  const url = `${TWITTERAPI_BASE_URL}/twitter/tweet/advanced_search?${search.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'X-API-Key': apiKey },
    signal: signal !== undefined ? signal : AbortSignal.timeout(TWITTERAPI_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `twitterapi.io error (/twitter/tweet/advanced_search): ` +
      `HTTP ${response.status} ${body.slice(0, 150)}`,
    );
  }

  const raw: unknown = await response.json();
  const parsed = TwitterApiSearchEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('twitterapi.io advanced_search envelope failed validation');
  }
  if (parsed.data.status !== undefined && parsed.data.status !== 'success') {
    const detail = parsed.data.msg !== undefined ? parsed.data.msg : parsed.data.status;
    throw new Error(`twitterapi.io advanced_search status was not success: ${detail.slice(0, 100)}`);
  }

  return {
    tweets: parsed.data.tweets,
    hasNextPage: parsed.data.has_next_page,
    nextCursor: parsed.data.next_cursor,
  };
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
  return getOfficialXBearerToken() !== null
    || getTwitterApiKey() !== null
    || getApifyToken() !== null;
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
  authorId: z.string().nullable().optional(),
  author_id: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  conversation_id: z.string().nullable().optional(),
  referenced_tweets: z.array(OfficialXReferencedPostSchema).nullable().optional(),
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

function tweetAuthorId(item: TweetItem): string | undefined {
  if (typeof item.authorId === 'string' && item.authorId.length > 0) return item.authorId;
  if (typeof item.author_id === 'string' && item.author_id.length > 0) return item.author_id;
  const author = tweetAuthorRecord(item);
  if (author !== undefined && typeof author.id === 'string' && author.id.length > 0) return author.id;
  if (author !== undefined && typeof author.id === 'number') return String(author.id);
  return undefined;
}

function tweetConversationId(item: TweetItem): string | undefined {
  if (typeof item.conversationId === 'string' && item.conversationId.length > 0) return item.conversationId;
  if (typeof item.conversation_id === 'string' && item.conversation_id.length > 0) return item.conversation_id;
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

function mapTweetToSearchResult(
  item: TweetItem,
  backend: XBackend,
  backendMetadata: Record<string, unknown> = {},
): SearchResult | null {
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
      backend,
      ...backendMetadata,
      author_id: tweetAuthorId(item),
      conversation_id: tweetConversationId(item),
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
  backend: XBackend,
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
      backend,
      author_id: tweetAuthorId(rootTweet),
      conversation_id: tweetConversationId(rootTweet),
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

function officialEnvelopePosts(envelope: OfficialXEnvelope): OfficialXPost[] {
  if (envelope.data === undefined) return [];
  return Array.isArray(envelope.data) ? envelope.data : [envelope.data];
}

function officialEnvelopeUsers(envelope: OfficialXEnvelope): Map<string, OfficialXUser> {
  const users = new Map<string, OfficialXUser>();
  for (const user of envelope.includes?.users ?? []) users.set(user.id, user);
  return users;
}

function officialPostToTweetItem(
  post: OfficialXPost,
  users: Map<string, OfficialXUser>,
): TweetItem {
  const user = post.author_id !== undefined ? users.get(post.author_id) : undefined;
  const repliedTo = post.referenced_tweets?.find((reference) => reference.type === 'replied_to');
  return TweetItemSchema.parse({
    id: post.id,
    text: post.text,
    author_id: post.author_id,
    conversation_id: post.conversation_id,
    created_at: post.created_at,
    lang: post.lang,
    author: user !== undefined
      ? { id: user.id, name: user.name, username: user.username }
      : post.author_id !== undefined
        ? { id: post.author_id }
        : undefined,
    like_count: post.public_metrics?.like_count,
    view_count: post.public_metrics?.impression_count,
    reply_count: post.public_metrics?.reply_count,
    retweet_count: post.public_metrics?.retweet_count,
    quote_count: post.public_metrics?.quote_count,
    referenced_tweets: post.referenced_tweets,
    isReply: repliedTo !== undefined,
    inReplyToId: repliedTo?.id,
  });
}

const OFFICIAL_X_TWEET_FIELDS = [
  'author_id',
  'conversation_id',
  'created_at',
  'lang',
  'public_metrics',
  'referenced_tweets',
].join(',');

function buildOfficialXQuery(query: string, opts: SearchOpts, includeLanguage = true): string {
  const parts = [query.trim()];
  if (includeLanguage) parts.push('lang:en');
  if (opts.handles !== undefined && opts.handles.length > 0) {
    const handles = opts.handles
      .map((handle) => handle.replace(/^@/, '').trim())
      .filter((handle) => handle.length > 0)
      .map((handle) => `from:${handle}`);
    if (handles.length === 1 && handles[0] !== undefined) parts.push(handles[0]);
    else if (handles.length > 1) parts.push(`(${handles.join(' OR ')})`);
  }
  return parts.filter((part) => part.length > 0).join(' ');
}

function officialXSortOrders(sort: SearchOpts['sort']): Array<'relevancy' | 'recency'> {
  if (sort === 'mixed') return ['relevancy', 'recency'];
  if (sort === 'latest' || sort === 'new') return ['recency'];
  return ['relevancy'];
}

function officialXTimeBounds(opts: SearchOpts, now = new Date()): {
  startTime: string;
  endTime: string;
} {
  const safeNowMs = now.getTime() - X_RECENT_SAFETY_LAG_MS;
  let requestedEndMs = safeNowMs;
  if (opts.published_before !== undefined) {
    requestedEndMs = new Date(opts.published_before).getTime();
    if (!Number.isFinite(requestedEndMs)) {
      throw new Error(`Invalid X published_before timestamp: ${opts.published_before}`);
    }
  }

  // Future as-of values cannot be sent to recent search. The safe-now clamp is
  // the only case where the requested upper boundary is adjusted.
  const endMs = Math.min(requestedEndMs, safeNowMs);
  const recentFloorMs = safeNowMs - X_RECENT_WINDOW_MS;
  if (endMs <= recentFloorMs) {
    throw new Error(
      'Official X recent search cannot cover an as-of timestamp older than seven days',
    );
  }

  const requestedWindowDays = opts.recency_days !== undefined ? opts.recency_days : 7;
  const requestedWindowMs = requestedWindowDays * 86_400_000;
  const requestedStartMs = endMs - requestedWindowMs;
  if (requestedStartMs < recentFloorMs) {
    throw new Error(
      `Official X recent search cannot cover the requested ${requestedWindowDays}-day window; ` +
      'falling back to a historical-capable backend',
    );
  }
  const startMs = requestedStartMs;
  if (!Number.isFinite(startMs) || startMs >= endMs) {
    throw new Error('Official X recent search received an invalid time range');
  }

  return {
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
  };
}

async function collectOfficialXPosts(
  searchQuery: string,
  opts: SearchOpts,
  bearerToken: string,
  sortOrder: 'relevancy' | 'recency',
  requestedLimit: number,
): Promise<TweetItem[]> {
  const limit = Math.max(1, Math.min(requestedLimit, 100));
  const maxPages = Math.max(1, opts.max_pages !== undefined ? opts.max_pages : 1);
  const bounds = officialXTimeBounds(opts);
  const posts: TweetItem[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < maxPages && posts.length < limit; page += 1) {
    const remaining = limit - posts.length;
    const params: Record<string, string> = {
      query: searchQuery,
      start_time: bounds.startTime,
      end_time: bounds.endTime,
      sort_order: sortOrder,
      max_results: String(Math.max(10, Math.min(remaining, 100))),
      'tweet.fields': OFFICIAL_X_TWEET_FIELDS,
      expansions: 'author_id',
      'user.fields': 'id,name,username',
    };
    if (nextToken !== undefined) params.next_token = nextToken;

    const envelope = await officialXGet(
      '/tweets/search/recent',
      params,
      bearerToken,
      opts.signal,
    );
    const users = officialEnvelopeUsers(envelope);
    for (const post of officialEnvelopePosts(envelope)) {
      posts.push(officialPostToTweetItem(post, users));
      if (posts.length >= limit) break;
    }

    nextToken = envelope.meta?.next_token;
    if (nextToken === undefined || nextToken.length === 0) break;
  }

  return posts;
}

// =============================================================================
// Backend implementations
// =============================================================================

async function searchViaOfficialX(
  query: string,
  opts: SearchOpts,
  bearerToken: string,
): Promise<SearchResult[]> {
  const limit = opts.limit !== undefined ? opts.limit : 20;
  const searchQuery = buildOfficialXQuery(query, opts);
  const groups: SearchResult[][] = [];

  for (const sortOrder of officialXSortOrders(opts.sort)) {
    const posts = await collectOfficialXPosts(searchQuery, opts, bearerToken, sortOrder, limit);
    const group: SearchResult[] = [];
    for (const post of posts) {
      const mapped = mapTweetToSearchResult(post, 'x_api_v2', { sort_order: sortOrder });
      if (mapped !== null) group.push(mapped);
    }
    groups.push(group);
  }

  return interleaveXResults(groups, limit);
}

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
  const limit = opts.limit !== undefined ? opts.limit : 20;
  const maxPages = Math.max(1, opts.max_pages !== undefined ? opts.max_pages : 1);
  const queryTypes: Array<'Top' | 'Latest'> = opts.sort === 'mixed'
    ? ['Top', 'Latest']
    : [opts.sort === 'latest' || opts.sort === 'new' ? 'Latest' : 'Top'];
  const searchQuery = buildXSearchQuery(query, opts);
  const groups: SearchResult[][] = [];
  for (const queryType of queryTypes) {
    const group: SearchResult[] = [];
    let cursor = '';
    for (let page = 0; page < maxPages && group.length < limit; page += 1) {
      const searchPage = await twitterApiSearchPage(
        searchQuery,
        queryType,
        cursor,
        apiKey,
        opts.signal,
      );
      const parsedItems = parseTweetItems(searchPage.tweets);
      for (const item of parsedItems) {
        const mapped = mapTweetToSearchResult(item, 'twitterapi_io', {
          query_type: queryType,
        });
        if (mapped !== null) group.push(mapped);
        if (group.length >= limit) break;
      }
      if (!searchPage.hasNextPage || searchPage.nextCursor.length === 0 || parsedItems.length === 0) {
        break;
      }
      cursor = searchPage.nextCursor;
    }
    groups.push(group);
  }
  return interleaveXResults(groups, limit);
}

function xDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildXSearchQuery(query: string, opts: SearchOpts): string {
  const parts = [query.trim(), 'lang:en'];
  if (opts.handles !== undefined && opts.handles.length > 0) {
    const handles = opts.handles
      .map((handle) => handle.replace(/^@/, '').trim())
      .filter((handle) => handle.length > 0)
      .map((handle) => `from:${handle}`);
    if (handles.length === 1 && handles[0] !== undefined) parts.push(handles[0]);
    else if (handles.length > 1) parts.push(`(${handles.join(' OR ')})`);
  }
  const upper = opts.published_before !== undefined ? new Date(opts.published_before) : new Date();
  if (!Number.isNaN(upper.getTime())) {
    // X's `until` operator is exclusive, so advance by one UTC day; the
    // pipeline applies the exact timestamp upper bound after retrieval.
    const exclusiveUpper = new Date(upper.getTime() + 86_400_000);
    parts.push(`until:${xDateOnly(exclusiveUpper)}`);
    if (opts.recency_days !== undefined) {
      parts.push(`since:${xDateOnly(new Date(upper.getTime() - opts.recency_days * 86_400_000))}`);
    }
  }
  return parts.join(' ');
}

function interleaveXResults(groups: SearchResult[][], limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (results.length < limit) {
    let found = false;
    for (const group of groups) {
      const result = group[index];
      if (result === undefined || seen.has(result.url)) continue;
      seen.add(result.url);
      results.push(result);
      found = true;
      if (results.length >= limit) break;
    }
    if (!found && groups.every((group) => index >= group.length)) break;
    index += 1;
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
    searchTerms: [buildXSearchQuery(query, opts)],
    tweetLanguage: 'en',
    maxTweets,
  };

  const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
  await pollRunUntilDone(runId, token);
  const items = await fetchDatasetItems(datasetId, token);

  const results: SearchResult[] = [];
  for (const item of parseTweetItems(items)) {
    const mapped = mapTweetToSearchResult(item, 'apify');
    if (mapped !== null) results.push(mapped);
  }
  return results;
}

async function fetchViaOfficialX(
  url: string,
  tweetIdValue: string,
  bearerToken: string,
  signal?: AbortSignal,
): Promise<FetchResult | null> {
  const envelope = await officialXGet(
    `/tweets/${encodeURIComponent(tweetIdValue)}`,
    {
      'tweet.fields': OFFICIAL_X_TWEET_FIELDS,
      expansions: 'author_id',
      'user.fields': 'id,name,username',
    },
    bearerToken,
    signal,
  );
  const post = officialEnvelopePosts(envelope)[0];
  if (post === undefined) return null;

  const rootTweet = officialPostToTweetItem(post, officialEnvelopeUsers(envelope));
  const conversationId = tweetConversationId(rootTweet) ?? tweetIdValue;

  // Conversation search is limited to X's recent window and is therefore
  // best-effort. The root lookup remains useful for older posts.
  let replies: TweetItem[] = [];
  try {
    const conversationPosts = await collectOfficialXPosts(
      `conversation_id:${conversationId}`,
      { limit: 50, recency_days: 7, sort: 'relevance', max_pages: 1, signal },
      bearerToken,
      'relevancy',
      50,
    );
    replies = conversationPosts.filter((candidate) => tweetId(candidate) !== tweetIdValue);
  } catch (err) {
    if (signal?.aborted === true) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { url: url.slice(0, 60), error: msg.slice(0, 100) },
      '[X] Official API conversation fetch failed (continuing without)',
    );
  }

  return buildTweetFetchResult(url, rootTweet, replies, 'x_api_v2');
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

  return buildTweetFetchResult(url, rootTweet, replies, 'twitterapi_io');
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

  return buildTweetFetchResult(url, root, replies, 'apify');
}

// =============================================================================
// Provider
// =============================================================================

export const xProvider: SearchProvider = {
  name: 'x',

  capabilities: {
    search: true,
    fetch: true,
    extract: true,
    backends: ['twitterapi_io', 'x_api_v2', 'apify'],
  },

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const officialBearerToken = getOfficialXBearerToken();
    const twitterApiKey = getTwitterApiKey();
    const apifyToken = getApifyToken();

    if (twitterApiKey !== null) {
      try {
        const results = await searchViaTwitterApi(query, opts, twitterApiKey);
        logger.info(
          { query: query.slice(0, 60), count: results.length, backend: 'twitterapi_io' },
          '[X] Search complete',
        );
        return results;
      } catch (err) {
        if (opts.signal?.aborted === true) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { query: query.slice(0, 60), error: msg.slice(0, 120) },
          '[X] twitterapi.io search failed — falling back',
        );
      }
    }

    if (officialBearerToken !== null) {
      try {
        const results = await searchViaOfficialX(query, opts, officialBearerToken);
        logger.info(
          { query: query.slice(0, 60), count: results.length, backend: 'x_api_v2' },
          '[X] Search complete',
        );
        return results;
      } catch (err) {
        if (opts.signal?.aborted === true) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { query: query.slice(0, 60), error: msg.slice(0, 120) },
          '[X] Official API search failed — falling back',
        );
      }
    }

    if (apifyToken === null) {
      throw new Error(
        'No usable X backend (twitterapi.io and official X API failed or unset; no APIFY_API_TOKEN)',
      );
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
      throw err;
    }
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    const tweetIdMatch = /\/status\/(\d+)/.exec(url);
    const tweetIdValue = tweetIdMatch !== null ? tweetIdMatch[1] : null;

    const officialBearerToken = getOfficialXBearerToken();
    const twitterApiKey = getTwitterApiKey();
    const apifyToken = getApifyToken();

    if (twitterApiKey !== null && tweetIdValue !== null) {
      try {
        const result = await fetchViaTwitterApi(url, tweetIdValue, twitterApiKey);
        if (result !== null) {
          logger.info({ url: url.slice(0, 60), backend: 'twitterapi_io' }, '[X] Fetch complete');
          return result;
        }
        logger.warn(
          { url: url.slice(0, 60) },
          '[X] twitterapi.io returned no tweet for id — falling back',
        );
      } catch (err) {
        if (signal?.aborted === true) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { url: url.slice(0, 60), error: msg.slice(0, 120) },
          '[X] twitterapi.io fetch failed — falling back',
        );
      }
    }

    if (officialBearerToken !== null && tweetIdValue !== null) {
      try {
        const result = await fetchViaOfficialX(url, tweetIdValue, officialBearerToken, signal);
        if (result !== null) {
          logger.info({ url: url.slice(0, 60), backend: 'x_api_v2' }, '[X] Fetch complete');
          return result;
        }
        logger.warn(
          { url: url.slice(0, 60) },
          '[X] Official API returned no post for id — falling back',
        );
      } catch (err) {
        if (signal?.aborted === true) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { url: url.slice(0, 60), error: msg.slice(0, 120) },
          '[X] Official API fetch failed — falling back to Apify',
        );
      }
    }

    if (apifyToken === null) {
      return FetchResultSchema.parse({
        provider: 'x',
        url,
        fetch_status: 'failed',
        fetch_error:
          'No usable X backend (twitterapi.io and official X API failed or unset; no APIFY_API_TOKEN)',
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
