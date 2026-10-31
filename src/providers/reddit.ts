/**
 * Reddit Search Provider
 *
 * Search + thread fetch over the shared Reddit client (./reddit-client.ts),
 * which owns OAuth, the per-client-id rate limiter and the 429/401 handling.
 */

import { logger } from '../logger.js';
import { MissingCredentialError, type RedditCredentials, type ResearchCredentials } from '../credentials.js';
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
import {
  createRedditClient,
  redditThreadApiUrl,
  RedditApiError,
  type RedditClient,
  type RedditComment,
  type RedditThread,
  type RedditTimeFilter,
} from './reddit-client.js';

// =============================================================================
// Helpers
// =============================================================================

function recencyToTimeFilter(recencyDays: number | undefined): RedditTimeFilter {
  if (recencyDays === undefined || recencyDays <= 0) return 'all';
  if (recencyDays <= 1) return 'day';
  if (recencyDays <= 7) return 'week';
  if (recencyDays <= 30) return 'month';
  if (recencyDays <= 365) return 'year';
  return 'all';
}

function requireReddit(credentials: ResearchCredentials): RedditCredentials {
  if (credentials.reddit === undefined) {
    throw new MissingCredentialError(
      'reddit',
      'required for the Reddit lane (clientId, clientSecret, and userAgent together)',
    );
  }
  return credentials.reddit;
}

// =============================================================================
// Comment tree flattening (markdown keeps depth 0..3, top 30 by upvotes)
// =============================================================================

interface FlatComment {
  id: string;
  author: string;
  body: string;
  ups: number;
  permalink: string;
}

const MARKDOWN_MAX_COMMENT_DEPTH = 3;

function flattenCommentTree(comments: readonly RedditComment[]): FlatComment[] {
  const flat: FlatComment[] = [];
  for (const comment of comments) {
    if (comment.depth > MARKDOWN_MAX_COMMENT_DEPTH) continue;
    if (comment.body !== '[deleted]' && comment.body !== '[removed]' && comment.body.length > 0) {
      flat.push({
        id: comment.id,
        author: comment.author,
        body: comment.body,
        ups: comment.ups,
        permalink: comment.permalink,
      });
    }
    flat.push(...flattenCommentTree(comment.replies));
  }
  return flat;
}

function redditSort(sort: SearchOpts['sort']): 'relevance' | 'top' | 'new' | 'comments' {
  if (sort === 'latest' || sort === 'new') return 'new';
  if (sort === 'top') return 'top';
  if (sort === 'comments' || sort === 'views') return 'comments';
  return 'relevance';
}

async function searchRedditListing(
  client: RedditClient,
  query: string,
  opts: SearchOpts,
  sort: 'relevance' | 'top' | 'new' | 'comments',
  target: number,
): Promise<SearchResult[]> {
  const maxPages = Math.max(1, Math.min(opts.max_pages ?? 1, 10));
  const perPage = Math.max(2, Math.min(100, Math.ceil(target / maxPages)));
  const results: SearchResult[] = [];
  let after: string | null = null;

  for (let page = 0; page < maxPages && results.length < target; page++) {
    const listing = await client.search(query, {
      ...(opts.communities === undefined ? {} : { subreddits: opts.communities }),
      sort,
      t: recencyToTimeFilter(opts.recency_days),
      limit: perPage,
      ...(after === null ? {} : { after }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    for (const post of listing.posts) {
      if (post.permalink.length === 0) continue;
      const candidate = SearchResultSchema.safeParse({
        provider: 'reddit',
        url: post.url,
        canonical_id: post.id.length > 0 ? post.id : undefined,
        title: post.title,
        snippet: post.selftext.slice(0, 500),
        author: post.author.length > 0 ? `u/${post.author}` : undefined,
        published_at: post.created,
        engagement: { upvotes: post.ups, comment_count: post.numComments },
        raw_metadata: {
          backend: 'reddit_oauth_api',
          subreddit: post.subreddit,
          external_url: post.externalUrl,
          search_sort: sort,
          page: page + 1,
        },
      });
      if (candidate.success) results.push(candidate.data);
      if (results.length >= target) break;
    }
    after = listing.after;
    if (after === null) break;
  }
  return results;
}

// =============================================================================
// Topic gate
// =============================================================================

const TOPIC_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'were', 'you', 'your',
  'what', 'which', 'when', 'how', 'why', 'who', 'not', 'but', 'has', 'have', 'had', 'can',
  'will', 'best', 'vs', 'about', 'into', 'over', 'than', 'then', 'them', 'their', 'there',
  'review', 'reviews', 'reddit',
]);
/** Below this many query tokens a query is too short to judge a thread against. */
const TOPIC_GATE_MIN_QUERY_TOKENS = 3;
/** A thread must share at least this many distinct query tokens. One word is never a topic. */
const TOPIC_GATE_MIN_SHARED = 2;

function topicTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || TOPIC_STOP.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

/**
 * Drop threads that match the query on a single incidental word. Reddit's
 * relevance sort is keyword-driven: a luggage brief that mentions "wheels"
 * returned a Mars-rover post and a wheeled-robot post, and both reached the
 * bibliography of a deep run (2026-09-30, run research-run-1790781140597).
 * Same rule the `research free` hit gate uses: at least two distinct query
 * tokens must appear in the title or the selftext excerpt.
 */
export function filterRedditByTopic(query: string, results: SearchResult[]): SearchResult[] {
  const wanted = topicTokens(query);
  if (wanted.size < TOPIC_GATE_MIN_QUERY_TOKENS) return results;
  return results.filter((result) => {
    const have = topicTokens(`${result.title} ${result.snippet}`);
    let shared = 0;
    for (const token of wanted) if (have.has(token)) shared += 1;
    return shared >= TOPIC_GATE_MIN_SHARED;
  });
}

/**
 * Subreddits that exist to rank one brand's products are not audience voice.
 * A luggage query returned threads from r/monos_reviews, r/Monosreviews and
 * r/Monosluggagereviews (2026-09-30), tiny brand-named review feeds posted by
 * a few accounts. Two signals, both on the subreddit name:
 *
 * - the name is a query word plus an optional short qualifier plus
 *   `review(s)` (`monosreviews`, `monosluggagereviews`, `awayreviews`);
 * - any review-named subreddit whose threads in one result batch all come
 *   from a single author.
 *
 * General communities (r/BuyItForLife, r/onebag, r/travel) and general review
 * subs whose name does not start with a query word are untouched.
 */
const REVIEW_SUFFIX = /reviews?$/u;
const MAX_BRAND_QUALIFIER_CHARS = 14;

function subredditKey(subreddit: string): string {
  return subreddit.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

export function isBrandReviewSpamSubreddit(subreddit: string, query: string): boolean {
  const key = subredditKey(subreddit);
  if (!REVIEW_SUFFIX.test(key)) return false;
  const stem = key.replace(REVIEW_SUFFIX, '');
  for (const token of topicTokens(query)) {
    if (token.length < 4 || !stem.startsWith(token)) continue;
    if (stem.length - token.length <= MAX_BRAND_QUALIFIER_CHARS) return true;
  }
  return false;
}

export function dropBrandReviewSpam(query: string, results: SearchResult[]): SearchResult[] {
  const authorsBySub = new Map<string, Set<string>>();
  const countBySub = new Map<string, number>();
  const subOf = (result: SearchResult): string => {
    const sub = result.raw_metadata['subreddit'];
    return typeof sub === 'string' ? subredditKey(sub) : '';
  };
  for (const result of results) {
    const sub = subOf(result);
    if (sub === '') continue;
    countBySub.set(sub, (countBySub.get(sub) ?? 0) + 1);
    const authors = authorsBySub.get(sub) ?? new Set<string>();
    authors.add(result.author ?? '');
    authorsBySub.set(sub, authors);
  }
  return results.filter((result) => {
    const raw = result.raw_metadata['subreddit'];
    if (typeof raw !== 'string') return true;
    if (isBrandReviewSpamSubreddit(raw, query)) return false;
    const sub = subredditKey(raw);
    const singleAuthorFeed = REVIEW_SUFFIX.test(sub)
      && (countBySub.get(sub) ?? 0) >= 2
      && (authorsBySub.get(sub)?.size ?? 0) === 1;
    return !singleAuthorFeed;
  });
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

function failedFetch(url: string, fetchError: string): FetchResult {
  return FetchResultSchema.parse({
    provider: 'reddit',
    url,
    fetch_status: 'failed',
    fetch_error: fetchError,
  });
}

export function createRedditProvider(credentials: ResearchCredentials): SearchProvider {
  let client: RedditClient | undefined;
  function redditClient(): RedditClient {
    if (client === undefined) client = createRedditClient(requireReddit(credentials));
    return client;
  }

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
      const reddit = redditClient();
      const limit = opts.limit !== undefined ? Math.min(opts.limit, 100) : 25;
      const sorts: Array<'relevance' | 'top' | 'new' | 'comments'> = opts.sort === 'mixed'
        ? ['relevance', 'top', 'new', 'comments']
        : [redditSort(opts.sort)];
      const groups: SearchResult[][] = [];
      const perSortLimit = Math.max(2, Math.ceil(limit / sorts.length));
      for (const sort of sorts) {
        groups.push(await searchRedditListing(reddit, query, opts, sort, perSortLimit));
      }
      const interleaved = interleaveRedditResults(groups, limit);
      const results = filterRedditByTopic(query, dropBrandReviewSpam(query, interleaved));

      logger.info(
        { query: query.slice(0, 60), count: results.length, offTopicDropped: interleaved.length - results.length, sorts, timeFilter: recencyToTimeFilter(opts.recency_days) },
        '[Reddit] Search complete',
      );

      return results;
    },

    async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
      // Prove the destination canonical before any credential is resolved. A
      // caller-controlled URL must never cause a bearer token to be attached to
      // an unreviewed origin, even if fetch/redirect behavior changes later.
      const target = redditThreadApiUrl(url);
      if (!target.ok) return failedFetch(url, target.reason);

      let thread: RedditThread;
      try {
        thread = await redditClient().fetchThread(url, {
          limit: 200,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (error instanceof RedditApiError && error.stage === 'api') {
          return failedFetch(
            url,
            error.status !== undefined ? `Reddit fetch error: ${error.status}` : `Reddit fetch failed: ${error.reason.slice(0, 200)}`,
          );
        }
        throw error;
      }

      const post = thread.post;

      // Sort comments by upvotes desc, take top 30
      const allComments = flattenCommentTree(thread.comments);
      allComments.sort((a, b) => b.ups - a.ups);
      const topComments = allComments.slice(0, 30);

      // Build markdown
      const postBody = post.selftext.length > 0 ? post.selftext : '';
      const lines: string[] = [
        `# ${post.title}`,
        '',
        `**Author:** u/${post.author} | **Subreddit:** r/${post.subreddit} | **Upvotes:** ${post.ups} | **Comments:** ${post.numComments}`,
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
        published_at: post.created,
        raw_content: postBody,
        markdown,
        engagement: {
          upvotes: post.ups,
          comment_count: post.numComments,
        },
        fetch_status: 'ok',
        raw_metadata: {
          backend: 'reddit_oauth_api',
          subreddit: post.subreddit,
          top_comments: topComments,
        },
      });

      logger.info(
        { url: url.slice(0, 60), title: post.title.slice(0, 40), comments: topComments.length, moreUnexpanded: thread.moreCount },
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
