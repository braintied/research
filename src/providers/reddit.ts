/**
 * Reddit Search Provider
 *
 * Uses Reddit OAuth2 client_credentials for search + JSON comment fetching.
 * Token cached for 1 hour. Rate limit: 60 req/min.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { MissingCredentialError, type RedditCredentials, type ResearchCredentials } from '../credentials.js';
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
// Rate limiter — 60 req/min = 1 req per ~1000ms
// =============================================================================

const REDDIT_RATE_LIMIT_MS = 1050;
let lastRedditCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRedditCallAt;
  if (elapsed < REDDIT_RATE_LIMIT_MS) {
    await sleep(REDDIT_RATE_LIMIT_MS - elapsed);
  }
  lastRedditCallAt = Date.now();
}

// =============================================================================
// OAuth2 token cache
// =============================================================================

interface TokenCache {
  /** Cached per client id: one process may be handed different credentials. */
  clientId: string;
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

function requireReddit(credentials: ResearchCredentials): RedditCredentials {
  if (credentials.reddit === undefined) {
    throw new MissingCredentialError(
      'reddit',
      'required for the Reddit lane (clientId, clientSecret, and userAgent together)',
    );
  }
  return credentials.reddit;
}

async function getAccessToken(credentials: ResearchCredentials): Promise<string> {
  const { clientId, clientSecret, userAgent } = requireReddit(credentials);
  const now = Date.now();

  if (tokenCache !== null && tokenCache.clientId === clientId && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Reddit OAuth2 token error: ${response.status}`);
  }

  const TokenResponseSchema = z.object({
    access_token: z.string(),
    expires_in: z.number(),
  });

  const rawJson: unknown = await response.json();
  const parsed = TokenResponseSchema.safeParse(rawJson);

  if (!parsed.success) {
    throw new Error(`Reddit token response invalid: ${parsed.error.message}`);
  }

  tokenCache = {
    clientId,
    accessToken: parsed.data.access_token,
    expiresAt: now + parsed.data.expires_in * 1000,
  };

  logger.info({}, '[Reddit] OAuth2 token refreshed');
  return tokenCache.accessToken;
}

// =============================================================================
// Reddit API response schemas
// =============================================================================

const RedditPostDataSchema = z.object({
  id: z.string().default(''),
  title: z.string().default(''),
  selftext: z.string().default(''),
  permalink: z.string().default(''),
  author: z.string().default(''),
  created_utc: z.number().default(0),
  ups: z.number().default(0),
  num_comments: z.number().default(0),
  url: z.string().optional(),
  subreddit: z.string().default(''),
}).passthrough();

const RedditChildSchema = z.object({
  kind: z.string(),
  data: RedditPostDataSchema,
});

const RedditListingSchema = z.object({
  data: z.object({
    children: z.array(RedditChildSchema).default([]),
    after: z.string().nullable().optional(),
  }),
});

// Comment schema (recursive-ish — we only go 2 levels deep for simplicity)
const RedditCommentDataSchema = z.object({
  id: z.string().default(''),
  author: z.string().default(''),
  body: z.string().default(''),
  ups: z.number().default(0),
  created_utc: z.number().default(0),
  permalink: z.string().default(''),
  replies: z.unknown().optional(),
}).passthrough();

// =============================================================================
// Helpers
// =============================================================================

function unixToIso(utc: number): string {
  return new Date(utc * 1000).toISOString();
}

function recencyToTimeFilter(recencyDays: number | undefined): string {
  if (recencyDays === undefined || recencyDays <= 0) return 'all';
  if (recencyDays <= 1) return 'day';
  if (recencyDays <= 7) return 'week';
  if (recencyDays <= 30) return 'month';
  if (recencyDays <= 365) return 'year';
  return 'all';
}

function permalinkToUrl(permalink: string): string {
  if (permalink.startsWith('http')) return permalink;
  return `https://www.reddit.com${permalink}`;
}

// =============================================================================
// Comment tree flattening
// =============================================================================

interface FlatComment {
  id: string;
  author: string;
  body: string;
  ups: number;
  permalink: string;
}

function flattenCommentTree(children: unknown[], maxDepth: number, currentDepth: number): FlatComment[] {
  if (currentDepth > maxDepth) return [];

  const flat: FlatComment[] = [];

  for (const child of children) {
    if (child === null || child === undefined || typeof child !== 'object') continue;

    // Use Zod to parse the comment child — validates kind + data fields
    const ChildSchema = z.object({ kind: z.string(), data: z.unknown() });
    const childParsed = ChildSchema.safeParse(child);
    if (!childParsed.success) continue;
    if (childParsed.data.kind !== 't1') continue;

    const parsed = RedditCommentDataSchema.safeParse(childParsed.data.data);
    if (!parsed.success) continue;

    const comment = parsed.data;
    if (comment.body !== '[deleted]' && comment.body !== '[removed]' && comment.body.length > 0) {
      flat.push({
        id: comment.id,
        author: comment.author,
        body: comment.body,
        ups: comment.ups,
        permalink: comment.permalink.length > 0 ? permalinkToUrl(comment.permalink) : '',
      });
    }

    // Recurse into replies — parse with Zod to avoid casts
    if (comment.replies !== undefined && comment.replies !== null) {
      const RepliesSchema = z.object({
        data: z.object({
          children: z.array(z.unknown()).default([]),
        }),
      });
      const repliesParsed = RepliesSchema.safeParse(comment.replies);
      if (repliesParsed.success) {
        flat.push(...flattenCommentTree(repliesParsed.data.data.children, maxDepth, currentDepth + 1));
      }
    }
  }

  return flat;
}

function redditSort(sort: SearchOpts['sort']): 'relevance' | 'top' | 'new' | 'comments' {
  if (sort === 'latest' || sort === 'new') return 'new';
  if (sort === 'top') return 'top';
  if (sort === 'comments' || sort === 'views') return 'comments';
  return 'relevance';
}

function redditSearchEndpoint(opts: SearchOpts): string {
  const communities = (opts.communities ?? [])
    .map((community) => community.replace(/^r\//, '').trim())
    .filter((community) => /^[A-Za-z0-9_]+$/.test(community));
  if (communities.length === 0) return 'https://oauth.reddit.com/search.json';
  return `https://oauth.reddit.com/r/${communities.join('+')}/search.json`;
}

async function searchRedditListing(
  query: string,
  opts: SearchOpts,
  token: string,
  userAgent: string,
  sort: 'relevance' | 'top' | 'new' | 'comments',
  target: number,
): Promise<SearchResult[]> {
  const maxPages = Math.max(1, Math.min(opts.max_pages ?? 1, 10));
  const perPage = Math.max(2, Math.min(100, Math.ceil(target / maxPages)));
  const results: SearchResult[] = [];
  let after: string | null = null;

  for (let page = 0; page < maxPages && results.length < target; page++) {
    await rateLimit();
    const params = new URLSearchParams({
      q: query,
      sort,
      limit: String(perPage),
      t: recencyToTimeFilter(opts.recency_days),
      type: 'link',
      raw_json: '1',
    });
    if ((opts.communities ?? []).length > 0) params.set('restrict_sr', 'on');
    if (after !== null) params.set('after', after);

    const response = await fetch(`${redditSearchEndpoint(opts)}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
      },
      signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Reddit search error: ${response.status} ${body.slice(0, 200)}`);
    }

    const rawJson: unknown = await response.json();
    const parsed = RedditListingSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new Error(`Reddit search response invalid: ${parsed.error.message}`);
    }
    for (const child of parsed.data.data.children) {
      const post = child.data;
      if (post.permalink.length === 0) continue;
      const candidate = SearchResultSchema.safeParse({
        provider: 'reddit',
        url: permalinkToUrl(post.permalink),
        canonical_id: post.id.length > 0 ? post.id : undefined,
        title: post.title,
        snippet: post.selftext.slice(0, 500),
        author: post.author.length > 0 ? `u/${post.author}` : undefined,
        published_at: post.created_utc > 0 ? unixToIso(post.created_utc) : undefined,
        engagement: { upvotes: post.ups, comment_count: post.num_comments },
        raw_metadata: {
          backend: 'reddit_oauth_api',
          subreddit: post.subreddit,
          external_url: post.url,
          search_sort: sort,
          page: page + 1,
        },
      });
      if (candidate.success) results.push(candidate.data);
      if (results.length >= target) break;
    }
    after = parsed.data.data.after ?? null;
    if (after === null) break;
  }
  return results;
}

function interleaveRedditResults(groups: SearchResult[][], limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (results.length < limit) {
    let found = false;
    for (const group of groups) {
      const item = group[index];
      if (item === undefined || seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
      found = true;
      if (results.length >= limit) break;
    }
    if (!found && groups.every((group) => index >= group.length)) break;
    index += 1;
  }
  return results;
}

// =============================================================================
// Provider
// =============================================================================

export function createRedditProvider(credentials: ResearchCredentials): SearchProvider {
  return {
    name: 'reddit',

    capabilities: {
      search: true,
      fetch: true,
      extract: true,
      backends: ['reddit_oauth_api'],
    },

    enabled: credentials.reddit !== undefined,

    async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
      const token = await getAccessToken(credentials);
      const userAgent = requireReddit(credentials).userAgent;
      const limit = opts.limit !== undefined ? Math.min(opts.limit, 100) : 25;
      const sorts: Array<'relevance' | 'top' | 'new' | 'comments'> = opts.sort === 'mixed'
        ? ['relevance', 'top', 'new', 'comments']
        : [redditSort(opts.sort)];
      const groups: SearchResult[][] = [];
      const perSortLimit = Math.max(2, Math.ceil(limit / sorts.length));
      for (const sort of sorts) {
        groups.push(await searchRedditListing(query, opts, token, userAgent, sort, perSortLimit));
      }
      const results = interleaveRedditResults(groups, limit);

      logger.info(
        { query: query.slice(0, 60), count: results.length, sorts, timeFilter: recencyToTimeFilter(opts.recency_days) },
        '[Reddit] Search complete',
      );

      return results;
    },

    async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return FetchResultSchema.parse({
          provider: 'reddit',
          url,
          fetch_status: 'failed',
          fetch_error: 'Reddit fetch requires a valid Reddit HTTPS URL',
        });
      }
      const redditHosts = new Set([
        'reddit.com',
        'www.reddit.com',
        'old.reddit.com',
        'np.reddit.com',
        'oauth.reddit.com',
      ]);
      if (parsedUrl.protocol !== 'https:'
          || parsedUrl.username !== ''
          || parsedUrl.password !== ''
          || parsedUrl.port !== ''
          || !redditHosts.has(parsedUrl.hostname.toLowerCase())) {
        return FetchResultSchema.parse({
          provider: 'reddit',
          url,
          fetch_status: 'failed',
          fetch_error: 'Reddit fetch requires a canonical Reddit HTTPS URL',
        });
      }
      parsedUrl.hostname = 'oauth.reddit.com';
      if (!parsedUrl.pathname.endsWith('.json')) parsedUrl.pathname += '.json';
      parsedUrl.searchParams.set('limit', '200');

      // Resolve credentials only after the destination is proven canonical. A
      // caller-controlled URL must never cause a bearer token to be attached to
      // an unreviewed origin, even if fetch/redirect behavior changes later.
      const token = await getAccessToken(credentials);
      const userAgent = requireReddit(credentials).userAgent;
      await rateLimit();

      const response = await fetch(parsedUrl, {
        redirect: 'error',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': userAgent,
        },
        signal: signal !== undefined ? signal : AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        const result = FetchResultSchema.parse({
          provider: 'reddit',
          url,
          fetch_status: 'failed',
          fetch_error: `Reddit fetch error: ${response.status}`,
        });
        return result;
      }

      const rawJson: unknown = await response.json();

      // Reddit returns an array: [post_listing, comments_listing]
      if (!Array.isArray(rawJson) || rawJson.length < 2) {
        return FetchResultSchema.parse({
          provider: 'reddit',
          url,
          fetch_status: 'failed',
          fetch_error: 'Unexpected Reddit JSON structure',
        });
      }

      // Parse post
      const PostListingSchema = z.array(z.object({
        data: z.object({
          children: z.array(z.object({
            kind: z.string(),
            data: RedditPostDataSchema,
          })).default([]),
        }),
      }));

      const listingParsed = PostListingSchema.safeParse(rawJson);
      if (!listingParsed.success) {
        return FetchResultSchema.parse({
          provider: 'reddit',
          url,
          fetch_status: 'failed',
          fetch_error: `Parse error: ${listingParsed.error.message.slice(0, 200)}`,
        });
      }

      const postListing = listingParsed.data[0];
      const commentsListing = listingParsed.data[1];

      if (postListing === undefined || commentsListing === undefined) {
        return FetchResultSchema.parse({
          provider: 'reddit',
          url,
          fetch_status: 'failed',
          fetch_error: 'Missing post or comments listing',
        });
      }

      const postChild = postListing.data.children[0];
      if (postChild === undefined) {
        return FetchResultSchema.parse({
          provider: 'reddit',
          url,
          fetch_status: 'failed',
          fetch_error: 'No post found',
        });
      }

      const post = postChild.data;

      // Flatten comments
      const CommentListingChildrenSchema = z.array(z.object({
        data: z.object({
          children: z.array(z.unknown()).default([]),
        }),
      }));

      const commentsParsed = CommentListingChildrenSchema.safeParse(rawJson);
      let allComments: FlatComment[] = [];

      if (commentsParsed.success && commentsParsed.data.length >= 2) {
        const commentSection = commentsParsed.data[1];
        if (commentSection !== undefined) {
          allComments = flattenCommentTree(commentSection.data.children, 3, 0);
        }
      }

      // Sort comments by upvotes desc, take top 30
      allComments.sort((a, b) => b.ups - a.ups);
      const topComments = allComments.slice(0, 30);

      // Build markdown
      const postBody = post.selftext.length > 0 ? post.selftext : '';
      const lines: string[] = [
        `# ${post.title}`,
        '',
        `**Author:** u/${post.author} | **Subreddit:** r/${post.subreddit} | **Upvotes:** ${post.ups} | **Comments:** ${post.num_comments}`,
        '',
      ];

      if (postBody.length > 0) {
        lines.push('## Post Body', '', postBody, '');
      }

      if (topComments.length > 0) {
        lines.push('## Top Comments', '');
        for (const comment of topComments) {
          lines.push(`**u/${comment.author}** (${comment.ups} upvotes)`);
          lines.push('');
          lines.push(comment.body);
          lines.push('');
          lines.push('---');
          lines.push('');
        }
      }

      const markdown = lines.join('\n');

      const result = FetchResultSchema.parse({
        provider: 'reddit',
        url,
        canonical_id: post.id.length > 0 ? post.id : undefined,
        title: post.title,
        author: post.author.length > 0 ? `u/${post.author}` : undefined,
        published_at: post.created_utc > 0 ? unixToIso(post.created_utc) : undefined,
        raw_content: postBody,
        markdown,
        engagement: {
          upvotes: post.ups,
          comment_count: post.num_comments,
        },
        fetch_status: 'ok',
        raw_metadata: {
          backend: 'reddit_oauth_api',
          subreddit: post.subreddit,
          top_comments: topComments,
        },
      });

      logger.info(
        { url: url.slice(0, 60), title: post.title.slice(0, 40), comments: topComments.length },
        '[Reddit] Fetch complete',
      );

      return result;
    },

    async extract(raw: FetchResult): Promise<ExtractedQuotes> {
      const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
      return extractQuotesWithGemini({
        credentials,
        provider: 'reddit',
        url: raw.url,
        content,
        mode: 'reddit',
      });
    },
  };
}
