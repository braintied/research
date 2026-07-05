/**
 * Reddit Search Provider
 *
 * Uses Reddit OAuth2 client_credentials for search + JSON comment fetching.
 * Token cached for 1 hour. Rate limit: 60 req/min.
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
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();

  if (tokenCache !== null && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT;

  if (clientId === undefined || clientId === '') {
    throw new Error('REDDIT_CLIENT_ID environment variable is not configured');
  }
  if (clientSecret === undefined || clientSecret === '') {
    throw new Error('REDDIT_CLIENT_SECRET environment variable is not configured');
  }
  if (userAgent === undefined || userAgent === '') {
    throw new Error('REDDIT_USER_AGENT environment variable is not configured');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Reddit OAuth2 token error: ${response.status} ${body.slice(0, 200)}`);
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

function getUserAgent(): string {
  const ua = process.env.REDDIT_USER_AGENT;
  if (ua === undefined || ua === '') {
    throw new Error('REDDIT_USER_AGENT environment variable is not configured');
  }
  return ua;
}

function isEnabled(): boolean {
  const cid = process.env.REDDIT_CLIENT_ID;
  const cs = process.env.REDDIT_CLIENT_SECRET;
  return cid !== undefined && cid !== '' && cs !== undefined && cs !== '';
}

function recencyToSort(recencyDays: number | undefined): string {
  if (recencyDays === undefined) return 'year';
  if (recencyDays <= 7) return 'week';
  if (recencyDays <= 30) return 'month';
  return 'year';
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

// =============================================================================
// Provider
// =============================================================================

export const redditProvider: SearchProvider = {
  name: 'reddit',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const token = await getAccessToken();
    const userAgent = getUserAgent();
    await rateLimit();

    const timeFilter = recencyToSort(opts.recency_days);
    const limit = opts.limit !== undefined ? Math.min(opts.limit, 100) : 25;

    const params = new URLSearchParams({
      q: query,
      sort: 'relevance',
      limit: String(limit),
      t: timeFilter,
      type: 'link',
    });

    const response = await fetch(`https://oauth.reddit.com/search.json?${params.toString()}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': userAgent,
      },
      signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Reddit search error: ${response.status} ${body.slice(0, 200)}`);
    }

    const rawJson: unknown = await response.json();
    const parsed = RedditListingSchema.safeParse(rawJson);

    if (!parsed.success) {
      logger.warn({ query: query.slice(0, 60), errors: parsed.error.message }, '[Reddit] Invalid response shape');
      return [];
    }

    const results: SearchResult[] = [];

    for (const child of parsed.data.data.children) {
      const post = child.data;
      if (post.permalink.length === 0) continue;

      const postUrl = permalinkToUrl(post.permalink);
      const snippet = post.selftext.slice(0, 500);

      const candidate = {
        provider: 'reddit' as const,
        url: postUrl,
        canonical_id: post.id.length > 0 ? post.id : undefined,
        title: post.title,
        snippet,
        author: post.author.length > 0 ? `u/${post.author}` : undefined,
        published_at: post.created_utc > 0 ? unixToIso(post.created_utc) : undefined,
        engagement: {
          upvotes: post.ups,
          comment_count: post.num_comments,
        },
        raw_metadata: {
          subreddit: post.subreddit,
          external_url: post.url,
        },
      };

      const validated = SearchResultSchema.safeParse(candidate);
      if (validated.success) {
        results.push(validated.data);
      }
    }

    logger.info(
      { query: query.slice(0, 60), count: results.length, timeFilter },
      '[Reddit] Search complete',
    );

    return results;
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    const token = await getAccessToken();
    const userAgent = getUserAgent();
    await rateLimit();

    // Normalize to API JSON endpoint
    let jsonUrl = url;
    if (!jsonUrl.endsWith('.json')) {
      const separator = jsonUrl.includes('?') ? '&' : '?';
      jsonUrl = `${jsonUrl}.json${separator}limit=200`;
    }

    // Ensure we're using oauth.reddit.com for authenticated requests
    jsonUrl = jsonUrl.replace('www.reddit.com', 'oauth.reddit.com');

    const response = await fetch(jsonUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': userAgent,
      },
      signal: signal !== undefined ? signal : AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const result = FetchResultSchema.parse({
        provider: 'reddit',
        url,
        fetch_status: 'failed',
        fetch_error: `Reddit fetch error: ${response.status} ${errorBody.slice(0, 100)}`,
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
      provider: 'reddit',
      url: raw.url,
      content,
      mode: 'reddit',
    });
  },
};
