/**
 * Reddit client — the one Reddit door for every fleet lane.
 *
 * Reddit answers unauthenticated JSON on www.reddit.com and old.reddit.com
 * with HTTP 403 (measured 2026-10-11). The supported path is the OAuth
 * client_credentials grant at https://www.reddit.com/api/v1/access_token,
 * then every read on https://oauth.reddit.com with a descriptive User-Agent.
 * The live budget is 1000 requests per 10-minute window per OAuth client id
 * (x-ratelimit-remaining 999, x-ratelimit-reset ~600s), i.e. 100 QPM.
 *
 * This module owns the token cache, the per-client-id rate limiter, the 429
 * backoff, the 401 token refresh, and response validation. Hosts (ora-ai
 * scripts, cortex-worker collectors, the research provider) build a client
 * from `RedditCredentials` instead of hand-rolling OAuth.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import {
  MissingCredentialError,
  type RedditCredentials,
  type ResearchCredentials,
} from '../credentials.js';
import { sleep as defaultSleep } from '../pipeline-core.js';

// =============================================================================
// Constants
// =============================================================================

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_HOST = 'oauth.reddit.com';
/** 100 QPM per client id is 600ms; 650ms keeps headroom for clock skew. */
const MIN_REQUEST_SPACING_MS = 650;
/** Refresh a token this long before Reddit says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** Total attempts for one request when Reddit answers 429. */
const MAX_RATE_LIMIT_ATTEMPTS = 3;
/** Used only when a 429 carries neither Retry-After nor x-ratelimit-reset. */
const FALLBACK_BACKOFF_MS = 2_000;
/** Transient server answers and network failures get this many attempts in all. */
const MAX_TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS = 1_000;
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
/** Reddit's window is 600s; never wait longer than one window. */
const MAX_WAIT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_TIMEOUT_MS = 15_000;
const SUBREDDIT_NAME = /^[A-Za-z0-9_]+$/;

/** Hosts a caller may hand us a thread URL on. Reads always go to oauth.reddit.com. */
const CANONICAL_REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'np.reddit.com',
  'oauth.reddit.com',
]);

/** Short-link host: `https://redd.it/<id>` names the post `/comments/<id>`. */
const SHORT_LINK_HOST = 'redd.it';
const POST_ID = /^[a-z0-9]+$/i;

// =============================================================================
// Public types
// =============================================================================

export type RedditSearchSort = 'relevance' | 'hot' | 'top' | 'new' | 'comments';
export type RedditListingSort = 'hot' | 'new' | 'top' | 'rising' | 'controversial';
export type RedditCommentSort = 'confidence' | 'top' | 'new' | 'controversial' | 'old' | 'qa';
export type RedditTimeFilter = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export interface RedditClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RedditSearchOptions {
  /** Restrict to these subreddits (with or without `r/`). Invalid names are dropped. */
  readonly subreddits?: readonly string[];
  readonly sort: RedditSearchSort;
  readonly t: RedditTimeFilter;
  /** 1..100 */
  readonly limit: number;
  readonly after?: string;
  readonly signal?: AbortSignal;
}

export interface RedditListSubredditOptions {
  readonly sort: RedditListingSort;
  readonly t?: RedditTimeFilter;
  /** 1..100; Reddit's default (25) when omitted. */
  readonly limit?: number;
  readonly after?: string;
  readonly signal?: AbortSignal;
}

export interface RedditFetchThreadOptions {
  /** Reddit's `depth` parameter; Reddit's default when omitted. */
  readonly depth?: number;
  /** Reddit's comment `limit`; 200 when omitted. */
  readonly limit?: number;
  /** Comment order; Reddit's default (`confidence`, shown as "best") when omitted. */
  readonly sort?: RedditCommentSort;
  readonly signal?: AbortSignal;
}

export interface RedditPost {
  readonly id: string;
  readonly title: string;
  readonly selftext: string;
  /** Path as Reddit returns it, e.g. `/r/x/comments/abc/title/`. Empty when absent. */
  readonly permalink: string;
  /** Absolute https://www.reddit.com permalink URL. Empty when Reddit gave no permalink. */
  readonly url: string;
  readonly author: string;
  readonly subreddit: string;
  /** Seconds since epoch; 0 when Reddit gave none. */
  readonly createdUtc: number;
  /** ISO timestamp, absent when Reddit gave no creation time. */
  readonly created?: string;
  readonly ups: number;
  /** Net score as Reddit reports it; equals `ups` when Reddit omits it. */
  readonly score: number;
  readonly numComments: number;
  /** The link a link-post points at (for self posts Reddit repeats the permalink). */
  readonly externalUrl?: string;
  /** True for a text (self) post, whose `externalUrl` is its own permalink. */
  readonly isSelf: boolean;
  /** Link flair text; null when the post has none. */
  readonly linkFlairText: string | null;
  /** NSFW: Reddit withholds the body and comments from app-only tokens. */
  readonly over18: boolean;
  /** Quarantined subreddit: same restriction as `over18`. */
  readonly quarantine: boolean;
}

export interface RedditListing {
  readonly posts: RedditPost[];
  /** Cursor for the next page; null when Reddit says there is none. */
  readonly after: string | null;
}

export interface RedditComment {
  readonly id: string;
  readonly author: string;
  /** Raw body; `[deleted]` / `[removed]` are kept so their replies stay attached. */
  readonly body: string;
  readonly ups: number;
  /** Net score as Reddit reports it; equals `ups` when Reddit omits it. */
  readonly score: number;
  readonly createdUtc: number;
  readonly created?: string;
  /** Absolute permalink URL; empty when Reddit gave none. */
  readonly permalink: string;
  /** 0 for a top-level comment. */
  readonly depth: number;
  /** Reddit fullname of the parent: `t3_<post>` for a top-level comment, `t1_<comment>` otherwise. Empty when absent. */
  readonly parentId: string;
  readonly replies: RedditComment[];
}

/**
 * A `more` stub Reddit left in a comment tree. `ids` non-empty means
 * "load more comments" (expand with `moreChildren`); empty `ids` under a
 * `t1_` parent is "continue this thread" (fetch that comment's own page).
 */
export interface RedditMoreStub {
  /** Fullname of the comment or post the hidden replies belong under. */
  readonly parentId: string;
  readonly ids: readonly string[];
  /** Reddit's own count of comments behind the stub. */
  readonly count: number;
}

export interface RedditMoreChildrenOptions {
  readonly sort?: RedditCommentSort;
  readonly signal?: AbortSignal;
}

export interface RedditMoreChildrenResult {
  /** Flat, in Reddit's order (parents before their replies); `replies` is always empty. */
  readonly comments: RedditComment[];
  /** Further stubs Reddit returned inside this batch. */
  readonly more: RedditMoreStub[];
}

export interface RedditSubredditInfo {
  readonly name: string;
  readonly title: string;
  readonly subscribers: number;
  readonly publicDescription: string;
  readonly url: string;
  readonly over18: boolean;
}

export interface RedditSearchSubredditsOptions {
  /** 1..100 */
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface RedditThread {
  readonly post: RedditPost;
  readonly comments: RedditComment[];
  /** Comment ids Reddit listed in unexpanded `more` stubs anywhere in the tree. */
  readonly moreCount: number;
  /** Number of `more` stubs (including "continue this thread" stubs with no ids). */
  readonly moreStubs: number;
  /** Every stub, with its parent, so a caller can expand the tree. */
  readonly more: RedditMoreStub[];
}

export type RedditProbeResult =
  | { readonly ok: true; readonly latencyMs: number; readonly rateLimitRemaining: number | undefined }
  | {
    readonly ok: false;
    readonly stage: 'credentials' | 'token' | 'listing';
    readonly status?: number;
    readonly reason: string;
  };

export interface RedditClient {
  search(query: string, opts: RedditSearchOptions): Promise<RedditListing>;
  listSubreddit(subreddit: string, opts: RedditListSubredditOptions): Promise<RedditListing>;
  fetchThread(url: string, opts?: RedditFetchThreadOptions): Promise<RedditThread>;
  /**
   * Expand up to 100 comment ids from a `more` stub via `/api/morechildren`.
   * `linkId` is the post id with or without `t3_`.
   */
  moreChildren(linkId: string, ids: readonly string[], opts?: RedditMoreChildrenOptions): Promise<RedditMoreChildrenResult>;
  /** Subreddits matching a topic, via `/subreddits/search`. NSFW subreddits are excluded. */
  searchSubreddits(query: string, opts: RedditSearchSubredditsOptions): Promise<RedditSubredditInfo[]>;
  probe(): Promise<RedditProbeResult>;
}

export type RedditErrorStage = 'url' | 'token' | 'api';

/** Every failure the client raises. `status` is the HTTP status when there was one. */
export class RedditApiError extends Error {
  readonly status: number | undefined;
  readonly reason: string;
  readonly stage: RedditErrorStage;

  constructor(stage: RedditErrorStage, reason: string, status?: number) {
    super(`Reddit ${stage} error${status === undefined ? '' : ` ${status}`}: ${reason}`);
    this.name = 'RedditApiError';
    this.stage = stage;
    this.reason = reason;
    this.status = status;
  }
}

// =============================================================================
// Vault key contract
// =============================================================================

/**
 * Platform vault rows that hold the fleet Reddit app: provider `reddit`,
 * key names `client_id`, `client_secret`, `user_agent` (lowercase).
 */
export const REDDIT_VAULT_KEYS = {
  provider: 'reddit',
  clientId: 'client_id',
  clientSecret: 'client_secret',
  userAgent: 'user_agent',
} as const;

/**
 * Build `RedditCredentials` from a host-supplied resolver (for example one
 * backed by @braintied/vault-client's ProviderKeyResolver). The package stays
 * vault-agnostic: it only names the rows.
 */
export async function redditCredentialsFromResolver(
  resolve: (provider: string, keyName: string) => Promise<string>,
): Promise<RedditCredentials> {
  const [clientId, clientSecret, userAgent] = await Promise.all([
    resolve(REDDIT_VAULT_KEYS.provider, REDDIT_VAULT_KEYS.clientId),
    resolve(REDDIT_VAULT_KEYS.provider, REDDIT_VAULT_KEYS.clientSecret),
    resolve(REDDIT_VAULT_KEYS.provider, REDDIT_VAULT_KEYS.userAgent),
  ]);
  const missing: string[] = [];
  if (clientId.trim() === '') missing.push(REDDIT_VAULT_KEYS.clientId);
  if (clientSecret.trim() === '') missing.push(REDDIT_VAULT_KEYS.clientSecret);
  if (userAgent.trim() === '') missing.push(REDDIT_VAULT_KEYS.userAgent);
  if (missing.length > 0) {
    throw new MissingCredentialError(
      'reddit',
      `vault rows ${REDDIT_VAULT_KEYS.provider}/${missing.join(', ')} resolved empty`,
    );
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim(), userAgent: userAgent.trim() };
}

// =============================================================================
// Thread URL guard
// =============================================================================

export type RedditThreadUrlResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string };

/**
 * Map a caller-supplied Reddit URL onto its oauth.reddit.com JSON endpoint,
 * refusing anything that is not https on a canonical Reddit host with no
 * userinfo and no port. Runs before any credential is touched, so a
 * caller-controlled URL can never carry a bearer token to another origin.
 */
export function redditThreadApiUrl(url: string): RedditThreadUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'Reddit fetch requires a valid Reddit HTTPS URL' };
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.port !== ''
      || (!CANONICAL_REDDIT_HOSTS.has(host) && host !== SHORT_LINK_HOST)) {
    return { ok: false, reason: 'Reddit fetch requires a canonical Reddit HTTPS URL' };
  }
  if (host === SHORT_LINK_HOST) {
    const id = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (!POST_ID.test(id)) {
      return { ok: false, reason: 'redd.it link does not name a post' };
    }
    parsed.pathname = `/comments/${id}`;
    parsed.search = '';
  }
  parsed.hostname = API_HOST;
  if (!parsed.pathname.endsWith('.json')) parsed.pathname += '.json';
  return { ok: true, url: parsed };
}

// =============================================================================
// Response schemas
// =============================================================================

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const RedditPostDataSchema = z.object({
  id: z.string().default(''),
  title: z.string().default(''),
  selftext: z.string().default(''),
  permalink: z.string().default(''),
  author: z.string().default(''),
  created_utc: z.number().default(0),
  ups: z.number().default(0),
  score: z.number().optional(),
  num_comments: z.number().default(0),
  url: z.string().optional(),
  subreddit: z.string().default(''),
  is_self: z.boolean().default(false),
  link_flair_text: z.string().nullable().default(null),
  over_18: z.boolean().default(false),
  quarantine: z.boolean().default(false),
}).passthrough();

const RedditListingSchema = z.object({
  data: z.object({
    children: z.array(z.object({ kind: z.string(), data: z.unknown() })).default([]),
    after: z.string().nullable().optional(),
  }),
});

const RedditCommentDataSchema = z.object({
  id: z.string().default(''),
  author: z.string().default(''),
  body: z.string().default(''),
  ups: z.number().default(0),
  score: z.number().optional(),
  created_utc: z.number().default(0),
  permalink: z.string().default(''),
  parent_id: z.string().default(''),
  replies: z.unknown().optional(),
}).passthrough();

const RedditMoreDataSchema = z.object({
  children: z.array(z.string()).default([]),
  parent_id: z.string().default(''),
  count: z.number().default(0),
}).passthrough();

const MoreChildrenResponseSchema = z.object({
  json: z.object({
    errors: z.array(z.unknown()).default([]),
    data: z.object({
      things: z.array(z.object({ kind: z.string(), data: z.unknown() })).default([]),
    }).optional(),
  }),
});

const SubredditDataSchema = z.object({
  display_name: z.string(),
  title: z.string().default(''),
  subscribers: z.number().nullable().default(0),
  public_description: z.string().default(''),
  url: z.string().default(''),
  over18: z.boolean().default(false),
}).passthrough();

const ThreadResponseSchema = z.tuple([RedditListingSchema, RedditListingSchema]).rest(z.unknown());

// =============================================================================
// Normalisation
// =============================================================================

function unixToIso(utc: number): string {
  return new Date(utc * 1000).toISOString();
}

function permalinkToUrl(permalink: string): string {
  if (permalink.startsWith('http')) return permalink;
  return `https://www.reddit.com${permalink}`;
}

function normalizePost(data: z.infer<typeof RedditPostDataSchema>): RedditPost {
  return {
    id: data.id,
    title: data.title,
    selftext: data.selftext,
    permalink: data.permalink,
    url: data.permalink.length > 0 ? permalinkToUrl(data.permalink) : '',
    author: data.author,
    subreddit: data.subreddit,
    createdUtc: data.created_utc,
    ...(data.created_utc > 0 ? { created: unixToIso(data.created_utc) } : {}),
    ups: data.ups,
    score: data.score === undefined ? data.ups : data.score,
    numComments: data.num_comments,
    ...(data.url === undefined ? {} : { externalUrl: data.url }),
    isSelf: data.is_self,
    linkFlairText: data.link_flair_text,
    over18: data.over_18,
    quarantine: data.quarantine,
  };
}

function parseListing(raw: unknown, what: string): RedditListing {
  const parsed = RedditListingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RedditApiError('api', `${what} response invalid: ${parsed.error.message.slice(0, 200)}`);
  }
  const posts: RedditPost[] = [];
  for (const child of parsed.data.data.children) {
    if (child.kind !== 't3') continue;
    const post = RedditPostDataSchema.safeParse(child.data);
    if (post.success) posts.push(normalizePost(post.data));
  }
  const after = parsed.data.data.after;
  return { posts, after: after === undefined ? null : after };
}

interface TreeTally {
  moreCount: number;
  moreStubs: number;
  stubs: RedditMoreStub[];
}

function normalizeComment(
  data: z.infer<typeof RedditCommentDataSchema>,
  depth: number,
  replies: RedditComment[],
): RedditComment {
  return {
    id: data.id,
    author: data.author,
    body: data.body,
    ups: data.ups,
    score: data.score === undefined ? data.ups : data.score,
    createdUtc: data.created_utc,
    ...(data.created_utc > 0 ? { created: unixToIso(data.created_utc) } : {}),
    permalink: data.permalink.length > 0 ? permalinkToUrl(data.permalink) : '',
    depth,
    parentId: data.parent_id,
    replies,
  };
}

function buildCommentTree(children: readonly unknown[], depth: number, tally: TreeTally): RedditComment[] {
  const out: RedditComment[] = [];
  for (const child of children) {
    const node = z.object({ kind: z.string(), data: z.unknown() }).safeParse(child);
    if (!node.success) continue;
    if (node.data.kind === 'more') {
      const more = RedditMoreDataSchema.safeParse(node.data.data);
      tally.moreStubs += 1;
      if (more.success) {
        tally.moreCount += more.data.children.length;
        tally.stubs.push({ parentId: more.data.parent_id, ids: more.data.children, count: more.data.count });
      }
      continue;
    }
    if (node.data.kind !== 't1') continue;
    const comment = RedditCommentDataSchema.safeParse(node.data.data);
    if (!comment.success) continue;
    const data = comment.data;
    // Reddit sends `replies: ""` for a leaf and a Listing otherwise.
    const replyListing = z.object({
      data: z.object({ children: z.array(z.unknown()).default([]) }),
    }).safeParse(data.replies);
    out.push(normalizeComment(
      data,
      depth,
      replyListing.success ? buildCommentTree(replyListing.data.data.children, depth + 1, tally) : [],
    ));
  }
  return out;
}

function parseThread(raw: unknown): RedditThread {
  const parsed = ThreadResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RedditApiError('api', `thread response invalid: ${parsed.error.message.slice(0, 200)}`);
  }
  const [postListing, commentListing] = parsed.data;
  const first = postListing.data.children[0];
  if (first === undefined) throw new RedditApiError('api', 'thread response has no post');
  const postData = RedditPostDataSchema.safeParse(first.data);
  if (!postData.success) {
    throw new RedditApiError('api', `thread post invalid: ${postData.error.message.slice(0, 200)}`);
  }
  const tally: TreeTally = { moreCount: 0, moreStubs: 0, stubs: [] };
  const comments = buildCommentTree(commentListing.data.children, 0, tally);
  return {
    post: normalizePost(postData.data),
    comments,
    moreCount: tally.moreCount,
    moreStubs: tally.moreStubs,
    more: tally.stubs,
  };
}

function parseMoreChildren(raw: unknown): RedditMoreChildrenResult {
  const parsed = MoreChildrenResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RedditApiError('api', `morechildren response invalid: ${parsed.error.message.slice(0, 200)}`);
  }
  if (parsed.data.json.errors.length > 0) {
    throw new RedditApiError('api', `morechildren errors: ${JSON.stringify(parsed.data.json.errors).slice(0, 200)}`);
  }
  const comments: RedditComment[] = [];
  const more: RedditMoreStub[] = [];
  const things = parsed.data.json.data === undefined ? [] : parsed.data.json.data.things;
  for (const thing of things) {
    if (thing.kind === 'more') {
      const stub = RedditMoreDataSchema.safeParse(thing.data);
      if (stub.success) more.push({ parentId: stub.data.parent_id, ids: stub.data.children, count: stub.data.count });
      continue;
    }
    if (thing.kind !== 't1') continue;
    const comment = RedditCommentDataSchema.safeParse(thing.data);
    if (!comment.success) continue;
    // morechildren returns a flat list; Reddit's `depth` field is relative to
    // the thread, but callers place each comment by `parentId`.
    const depthField = z.object({ depth: z.number() }).safeParse(thing.data);
    comments.push(normalizeComment(comment.data, depthField.success ? depthField.data.depth : 0, []));
  }
  return { comments, more };
}

const POST_ID_PREFIX = /^t3_/;
const COMMENT_ID = /^[a-z0-9]+$/i;

function cleanSubreddit(name: string): string | undefined {
  const cleaned = name.replace(/^\/?r\//, '').trim();
  return SUBREDDIT_NAME.test(cleaned) ? cleaned : undefined;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

// =============================================================================
// Shared per-client-id state (one process may hold several credentials)
// =============================================================================

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

interface RateState {
  /** Earliest time the next request may start. */
  nextAt: number;
  remaining: number | undefined;
  resetAt: number | undefined;
}

const tokenCache = new Map<string, CachedToken>();
const tokenInflight = new Map<string, Promise<CachedToken>>();
const rateStates = new Map<string, RateState>();

function rateStateFor(clientId: string): RateState {
  const existing = rateStates.get(clientId);
  if (existing !== undefined) return existing;
  const created: RateState = { nextAt: 0, remaining: undefined, resetAt: undefined };
  rateStates.set(clientId, created);
  return created;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

// =============================================================================
// Client
// =============================================================================

export function createRedditClient(
  credentials: RedditCredentials,
  opts: RedditClientOptions = {},
): RedditClient {
  const fetchImpl = opts.fetchImpl !== undefined ? opts.fetchImpl : fetch;
  const now = opts.now !== undefined ? opts.now : Date.now;
  const sleep = opts.sleep !== undefined ? opts.sleep : defaultSleep;
  const { clientId, clientSecret, userAgent } = credentials;
  const rate = rateStateFor(clientId);

  /** Strip anything secret from a string before it leaves the client. */
  function scrub(text: string): string {
    let out = text;
    for (const secret of [clientSecret, clientId]) {
      if (secret.length > 0) out = out.split(secret).join('[redacted]');
    }
    return out;
  }

  async function requestToken(): Promise<CachedToken> {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': userAgent,
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (error) {
      throw new RedditApiError('token', scrub(error instanceof Error ? error.message : String(error)));
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new RedditApiError('token', scrub(`token request refused ${body.slice(0, 200)}`.trim()), response.status);
    }
    const rawJson: unknown = await response.json().catch(() => undefined);
    const parsed = TokenResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new RedditApiError('token', 'token response invalid', response.status);
    }
    const token: CachedToken = {
      accessToken: parsed.data.access_token,
      expiresAt: now() + parsed.data.expires_in * 1000,
    };
    tokenCache.set(clientId, token);
    logger.info({}, '[Reddit] OAuth2 token refreshed');
    return token;
  }

  async function getToken(): Promise<string> {
    const cached = tokenCache.get(clientId);
    if (cached !== undefined && now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return cached.accessToken;
    }
    const pending = tokenInflight.get(clientId);
    if (pending !== undefined) return (await pending).accessToken;
    const request = requestToken();
    tokenInflight.set(clientId, request);
    try {
      return (await request).accessToken;
    } finally {
      tokenInflight.delete(clientId);
    }
  }

  /** Reserve the next request slot for this client id and wait for it. */
  async function waitForSlot(): Promise<void> {
    const current = now();
    let startAt = Math.max(current, rate.nextAt);
    if (rate.remaining !== undefined && rate.remaining < 1
        && rate.resetAt !== undefined && rate.resetAt > startAt) {
      startAt = Math.min(rate.resetAt, current + MAX_WAIT_MS);
    }
    rate.nextAt = startAt + MIN_REQUEST_SPACING_MS;
    if (rate.remaining !== undefined) rate.remaining -= 1;
    const wait = startAt - current;
    if (wait > 0) await sleep(wait);
  }

  function recordRateHeaders(headers: Headers): void {
    const remaining = headerNumber(headers, 'x-ratelimit-remaining');
    const reset = headerNumber(headers, 'x-ratelimit-reset');
    if (remaining !== undefined) rate.remaining = remaining;
    if (reset !== undefined) rate.resetAt = now() + reset * 1000;
  }

  function backoffMs(headers: Headers, attempt: number): number {
    const retryAfter = headerNumber(headers, 'retry-after');
    if (retryAfter !== undefined) return Math.min(retryAfter * 1000, MAX_WAIT_MS);
    const reset = headerNumber(headers, 'x-ratelimit-reset');
    if (reset !== undefined) return Math.min(reset * 1000, MAX_WAIT_MS);
    return FALLBACK_BACKOFF_MS * 2 ** attempt;
  }

  async function getJson(url: URL, signal: AbortSignal | undefined): Promise<unknown> {
    if (url.protocol !== 'https:' || url.hostname !== API_HOST || url.username !== '' || url.port !== '') {
      throw new RedditApiError('url', 'Reddit reads only go to https://oauth.reddit.com');
    }
    let refreshedOn401 = false;
    let rateLimitedAttempts = 0;
    let transientAttempts = 0;
    for (;;) {
      const token = await getToken();
      await waitForSlot();
      let response: Response;
      try {
        response = await fetchImpl(url, {
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent },
          signal: signal !== undefined ? signal : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const reason = scrub(error instanceof Error ? error.message : String(error));
        // A caller's abort is final; a dropped connection or timeout is not.
        transientAttempts += 1;
        if ((signal !== undefined && signal.aborted) || transientAttempts >= MAX_TRANSIENT_ATTEMPTS) {
          throw new RedditApiError('api', reason);
        }
        const wait = TRANSIENT_BACKOFF_MS * 2 ** (transientAttempts - 1);
        logger.warn({ waitMs: wait, attempt: transientAttempts }, '[Reddit] network error; retrying');
        await sleep(wait);
        continue;
      }
      recordRateHeaders(response.headers);

      if (response.status === 401 && !refreshedOn401) {
        refreshedOn401 = true;
        const cached = tokenCache.get(clientId);
        if (cached !== undefined && cached.accessToken === token) tokenCache.delete(clientId);
        logger.warn({}, '[Reddit] 401 from oauth.reddit.com; dropping token and retrying once');
        continue;
      }

      if (response.status === 429) {
        rateLimitedAttempts += 1;
        if (rateLimitedAttempts >= MAX_RATE_LIMIT_ATTEMPTS) {
          throw new RedditApiError('api', `rate limited after ${rateLimitedAttempts} attempts`, 429);
        }
        const wait = backoffMs(response.headers, rateLimitedAttempts - 1);
        rate.nextAt = Math.max(rate.nextAt, now() + wait);
        logger.warn({ waitMs: wait, attempt: rateLimitedAttempts }, '[Reddit] 429; backing off');
        await sleep(wait);
        continue;
      }

      if (TRANSIENT_STATUSES.has(response.status)) {
        transientAttempts += 1;
        if (transientAttempts < MAX_TRANSIENT_ATTEMPTS) {
          await response.body?.cancel().catch(() => undefined);
          const wait = TRANSIENT_BACKOFF_MS * 2 ** (transientAttempts - 1);
          logger.warn({ waitMs: wait, attempt: transientAttempts, status: response.status }, '[Reddit] server error; retrying');
          await sleep(wait);
          continue;
        }
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new RedditApiError('api', scrub(`${url.pathname} ${body.slice(0, 200)}`.trim()), response.status);
      }

      try {
        const json: unknown = await response.json();
        return json;
      } catch {
        throw new RedditApiError('api', `${url.pathname} returned invalid JSON`, response.status);
      }
    }
  }

  async function listSubreddit(subreddit: string, listOpts: RedditListSubredditOptions): Promise<RedditListing> {
    const name = cleanSubreddit(subreddit);
    if (name === undefined) throw new RedditApiError('url', `invalid subreddit name "${subreddit.slice(0, 40)}"`);
    const url = new URL(`https://${API_HOST}/r/${name}/${listOpts.sort}.json`);
    url.searchParams.set('raw_json', '1');
    if (listOpts.limit !== undefined) url.searchParams.set('limit', String(clampLimit(listOpts.limit)));
    if (listOpts.t !== undefined) url.searchParams.set('t', listOpts.t);
    if (listOpts.after !== undefined) url.searchParams.set('after', listOpts.after);
    return parseListing(await getJson(url, listOpts.signal), `r/${name}/${listOpts.sort}`);
  }

  return {
    async search(query, searchOpts) {
      const subs: string[] = [];
      for (const raw of searchOpts.subreddits !== undefined ? searchOpts.subreddits : []) {
        const name = cleanSubreddit(raw);
        if (name !== undefined) subs.push(name);
      }
      const url = new URL(subs.length === 0
        ? `https://${API_HOST}/search.json`
        : `https://${API_HOST}/r/${subs.join('+')}/search.json`);
      url.searchParams.set('q', query);
      url.searchParams.set('sort', searchOpts.sort);
      url.searchParams.set('limit', String(clampLimit(searchOpts.limit)));
      url.searchParams.set('t', searchOpts.t);
      url.searchParams.set('type', 'link');
      url.searchParams.set('raw_json', '1');
      if (subs.length > 0) url.searchParams.set('restrict_sr', 'on');
      if (searchOpts.after !== undefined) url.searchParams.set('after', searchOpts.after);
      return parseListing(await getJson(url, searchOpts.signal), 'search');
    },

    listSubreddit,

    async fetchThread(url, threadOpts = {}) {
      const target = redditThreadApiUrl(url);
      if (!target.ok) throw new RedditApiError('url', target.reason);
      target.url.searchParams.set('limit', String(threadOpts.limit !== undefined ? threadOpts.limit : 200));
      if (threadOpts.depth !== undefined) target.url.searchParams.set('depth', String(threadOpts.depth));
      if (threadOpts.sort !== undefined) target.url.searchParams.set('sort', threadOpts.sort);
      target.url.searchParams.set('raw_json', '1');
      return parseThread(await getJson(target.url, threadOpts.signal));
    },

    async moreChildren(linkId, ids, moreOpts = {}) {
      const postId = linkId.replace(POST_ID_PREFIX, '');
      if (!POST_ID.test(postId)) throw new RedditApiError('url', `invalid link id "${linkId.slice(0, 40)}"`);
      if (ids.length === 0) return { comments: [], more: [] };
      if (ids.length > 100) throw new RedditApiError('url', `morechildren takes at most 100 ids, got ${ids.length}`);
      for (const id of ids) {
        if (!COMMENT_ID.test(id)) throw new RedditApiError('url', `invalid comment id "${id.slice(0, 40)}"`);
      }
      const url = new URL(`https://${API_HOST}/api/morechildren`);
      url.searchParams.set('api_type', 'json');
      url.searchParams.set('link_id', `t3_${postId}`);
      url.searchParams.set('children', ids.join(','));
      url.searchParams.set('limit_children', 'false');
      url.searchParams.set('raw_json', '1');
      if (moreOpts.sort !== undefined) url.searchParams.set('sort', moreOpts.sort);
      return parseMoreChildren(await getJson(url, moreOpts.signal));
    },

    async searchSubreddits(query, subOpts) {
      const url = new URL(`https://${API_HOST}/subreddits/search.json`);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(clampLimit(subOpts.limit)));
      url.searchParams.set('include_over_18', 'false');
      url.searchParams.set('raw_json', '1');
      const parsed = RedditListingSchema.safeParse(await getJson(url, subOpts.signal));
      if (!parsed.success) {
        throw new RedditApiError('api', `subreddit search response invalid: ${parsed.error.message.slice(0, 200)}`);
      }
      const out: RedditSubredditInfo[] = [];
      for (const child of parsed.data.data.children) {
        if (child.kind !== 't5') continue;
        const sub = SubredditDataSchema.safeParse(child.data);
        if (!sub.success || sub.data.over18) continue;
        out.push({
          name: sub.data.display_name,
          title: sub.data.title,
          subscribers: sub.data.subscribers === null ? 0 : sub.data.subscribers,
          publicDescription: sub.data.public_description,
          url: sub.data.url.length > 0 ? permalinkToUrl(sub.data.url) : '',
          over18: sub.data.over18,
        });
      }
      return out;
    },

    async probe() {
      const started = now();
      try {
        await getToken();
      } catch (error) {
        return probeFailure('token', error, scrub);
      }
      try {
        await listSubreddit('AgingParents', { sort: 'top', t: 'week', limit: 1 });
      } catch (error) {
        return probeFailure('listing', error, scrub);
      }
      return { ok: true, latencyMs: now() - started, rateLimitRemaining: rate.remaining };
    },
  };
}

function probeFailure(
  stage: 'token' | 'listing',
  error: unknown,
  scrub: (text: string) => string,
): RedditProbeResult {
  if (error instanceof RedditApiError) {
    return {
      ok: false,
      stage,
      ...(error.status === undefined ? {} : { status: error.status }),
      reason: scrub(error.reason),
    };
  }
  return { ok: false, stage, reason: scrub(error instanceof Error ? error.message : String(error)) };
}

/**
 * Health check for a host's Reddit credentials: one token fetch and one
 * one-post listing. Never throws and never puts a secret in `reason`.
 */
export async function probeReddit(
  credentials: ResearchCredentials,
  opts: RedditClientOptions = {},
): Promise<RedditProbeResult> {
  const reddit = credentials.reddit;
  if (reddit === undefined) {
    return {
      ok: false,
      stage: 'credentials',
      reason: 'ResearchCredentials.reddit is not configured (clientId, clientSecret and userAgent together)',
    };
  }
  if (reddit.clientId.trim() === '' || reddit.clientSecret.trim() === '' || reddit.userAgent.trim() === '') {
    return { ok: false, stage: 'credentials', reason: 'ResearchCredentials.reddit has an empty field' };
  }
  return createRedditClient(reddit, opts).probe();
}
