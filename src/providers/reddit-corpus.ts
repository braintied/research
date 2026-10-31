/**
 * Reddit corpus collection — subreddits x queries -> threads with their full
 * comment trees, written one file per thread so a long run never loses work.
 *
 * Every read goes through `createRedditClient` (OAuth on oauth.reddit.com).
 * Unauthenticated Reddit answers HTTP 403 and is never used here.
 *
 * Guarantees:
 * - Full trees: `more` stubs are expanded with `/api/morechildren` and
 *   "continue this thread" stubs with the comment's own page, up to a per-thread
 *   call cap. Whatever is left is counted in `commentStats`, never hidden.
 * - No usernames by default. Authors are omitted and `u/name` mentions are
 *   redacted unless the caller opts in with `includeAuthors: true`.
 * - Nothing is silently dropped: every failed request lands in `errors` with
 *   its stage, target and HTTP status.
 * - Resumable: a thread already in the store is skipped; search pages are
 *   cached in the store too, so a restarted run does not repeat them.
 */

import {
  type RedditClient,
  type RedditComment,
  type RedditCommentSort,
  type RedditMoreStub,
  type RedditPost,
  type RedditSearchSort,
  type RedditSubredditInfo,
  type RedditTimeFilter,
  RedditApiError,
} from './reddit-client.js';

// =============================================================================
// Types
// =============================================================================

export const REDDIT_CORPUS_SCHEMA = 'braintied.reddit-thread/1';

export type RedditCorpusCommentMode = 'none' | 'top' | 'full';

export interface RedditCorpusComment {
  readonly id: string;
  /** `t3_<post>` for a top-level comment, `t1_<comment>` for a reply. */
  readonly parentId: string;
  /** 0 for a top-level comment. */
  readonly depth: number;
  readonly body: string;
  readonly score: number;
  readonly createdUtc: number;
  readonly permalink: string;
  /** Present only when the run set `includeAuthors`. */
  readonly author?: string;
}

export interface RedditCorpusCommentStats {
  /** Comments in `comments`. */
  readonly fetched: number;
  /** Reddit's `num_comments` for the post (includes removed and hidden ones). */
  readonly reported: number;
  /** Comment ids still behind unexpanded stubs when the cap was reached. */
  readonly unexpandedIds: number;
  /** "Continue this thread" stubs left unexpanded. */
  readonly unexpandedContinuations: number;
  /** morechildren + continuation requests spent on this thread. */
  readonly expansionCalls: number;
  /** True when the expansion cap stopped expansion before the tree was complete. */
  readonly truncated: boolean;
}

export interface RedditCorpusThread {
  readonly schema: typeof REDDIT_CORPUS_SCHEMA;
  readonly id: string;
  readonly subreddit: string;
  readonly title: string;
  readonly selftext: string;
  readonly url: string;
  readonly createdUtc: number;
  readonly score: number;
  readonly numComments: number;
  readonly flair: string | null;
  readonly isSelf: boolean;
  /** The link a link-post points at; absent for self posts. */
  readonly externalUrl?: string;
  /** Present only when the run set `includeAuthors`. */
  readonly author?: string;
  /** Every query that surfaced this thread in this run. */
  readonly matchedQueries: readonly string[];
  readonly fetchedAt: string;
  readonly commentMode: RedditCorpusCommentMode;
  /** Depth-first (parent before replies); the tree is `parentId` + `depth`. */
  readonly comments: readonly RedditCorpusComment[];
  readonly commentStats: RedditCorpusCommentStats;
}

export type RedditCorpusErrorStage = 'search' | 'thread' | 'morechildren' | 'continuation' | 'store' | 'discover';

export interface RedditCorpusError {
  readonly stage: RedditCorpusErrorStage;
  /** Subreddit/query, thread id, or stub parent the request was for. */
  readonly target: string;
  readonly status?: number;
  readonly reason: string;
}

/** One cached search page. */
export interface RedditCorpusSearchPage {
  readonly posts: readonly RedditPost[];
  readonly after: string | null;
}

/**
 * Where threads and search pages persist. `createDirectoryThreadStore` (in
 * reddit-corpus-store.ts) is the on-disk one; tests use memory.
 */
export interface RedditThreadStore {
  hasThread(id: string): Promise<boolean>;
  writeThread(thread: RedditCorpusThread): Promise<void>;
  readSearch(key: string): Promise<RedditCorpusSearchPage | undefined>;
  writeSearch(key: string, page: RedditCorpusSearchPage): Promise<void>;
}

export interface RedditCorpusProgress {
  readonly phase: 'search' | 'thread';
  readonly done: number;
  readonly total: number;
  readonly label: string;
}

export interface RedditCorpusOptions {
  readonly subreddits: readonly string[];
  readonly queries: readonly string[];
  /** Search orders to run per (subreddit, query); several widen recall. Default `['relevance']`. */
  readonly sorts?: readonly RedditSearchSort[];
  /** Reddit's coarse search window. Default `all`; combine with `sinceUtc` for an exact floor. */
  readonly timeFilter?: RedditTimeFilter;
  /** Drop posts created before this epoch second. */
  readonly sinceUtc?: number;
  /** Posts to take per (subreddit, query, sort); pages of 100 are followed. Default 25. */
  readonly perQuery?: number;
  /** Skip posts with fewer comments. Default 1. */
  readonly minComments?: number;
  /** Explicit thread URLs to collect in addition to search results. */
  readonly threadUrls?: readonly string[];
  /** Stop after this many new threads are written. Unlimited when absent. */
  readonly maxThreads?: number;
  /** `full` expands the tree; `top` keeps what one thread page returns; `none` stores the post only. Default `full`. */
  readonly comments?: RedditCorpusCommentMode;
  /** Comment order for the thread page. Default `top`. */
  readonly commentSort?: RedditCommentSort;
  /** Max morechildren/continuation requests per thread. Default 25. */
  readonly expansionCap?: number;
  /** Opt in to author names. Off by default: authors omitted, `u/` mentions redacted. */
  readonly includeAuthors?: boolean;
  /** Threads fetched concurrently. The client's rate limiter still spaces requests. Default 2. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RedditCorpusProgress) => void;
  /** Clock for `fetchedAt`; tests pin it. */
  readonly now?: () => Date;
}

export interface RedditCorpusResult {
  readonly searches: { readonly run: number; readonly cached: number; readonly failed: number };
  readonly candidates: number;
  readonly threads: {
    readonly written: number;
    readonly skippedExisting: number;
    readonly failed: number;
    readonly filteredOut: number;
  };
  readonly comments: number;
  readonly subreddits: readonly string[];
  readonly errors: readonly RedditCorpusError[];
}

// =============================================================================
// Helpers
// =============================================================================

const USER_MENTION = /(^|[^A-Za-z0-9_])\/?u\/[A-Za-z0-9_-]{3,20}/g;
const DELETED_BODIES = new Set(['[deleted]', '[removed]']);
const POST_ID = /^[a-z0-9]+$/i;

/** Replace `u/name` and `/u/name` mentions with `u/[redacted]`. */
export function redactUserMentions(text: string): string {
  return text.replace(USER_MENTION, '$1u/[redacted]');
}

function errorOf(stage: RedditCorpusErrorStage, target: string, error: unknown): RedditCorpusError {
  if (error instanceof RedditApiError) {
    return { stage, target, ...(error.status === undefined ? {} : { status: error.status }), reason: error.reason };
  }
  return { stage, target, reason: error instanceof Error ? error.message : String(error) };
}

export function redditSearchCacheKey(subreddit: string, query: string, sort: RedditSearchSort, t: RedditTimeFilter, page: number): string {
  return JSON.stringify([subreddit.toLowerCase(), query, sort, t, page]);
}

interface Node {
  comment: RedditCorpusComment;
  children: string[];
}

interface TreeBuilder {
  readonly nodes: Map<string, Node>;
  readonly roots: string[];
}

function toCorpusComment(comment: RedditComment, depth: number, includeAuthors: boolean): RedditCorpusComment {
  return {
    id: comment.id,
    parentId: comment.parentId,
    depth,
    body: includeAuthors || DELETED_BODIES.has(comment.body) ? comment.body : redactUserMentions(comment.body),
    score: comment.score,
    createdUtc: comment.createdUtc,
    permalink: comment.permalink,
    ...(includeAuthors ? { author: comment.author } : {}),
  };
}

/**
 * Add a comment under its parent. Depth is recomputed from the parent chain
 * because a continuation page restarts Reddit's depth at 0. A comment already
 * present is left as is (continuation pages repeat their root).
 */
function addComment(tree: TreeBuilder, comment: RedditComment, includeAuthors: boolean): void {
  const fullname = `t1_${comment.id}`;
  if (tree.nodes.has(fullname)) return;
  const parent = tree.nodes.get(comment.parentId);
  const depth = parent === undefined ? 0 : parent.comment.depth + 1;
  tree.nodes.set(fullname, { comment: toCorpusComment(comment, depth, includeAuthors), children: [] });
  if (parent === undefined) tree.roots.push(fullname);
  else parent.children.push(fullname);
}

function addTree(tree: TreeBuilder, comments: readonly RedditComment[], includeAuthors: boolean): void {
  for (const comment of comments) {
    addComment(tree, comment, includeAuthors);
    addTree(tree, comment.replies, includeAuthors);
  }
}

/** Depth-first flattening: every parent precedes its replies. */
export function flattenCorpusTree(tree: TreeBuilder): RedditCorpusComment[] {
  const out: RedditCorpusComment[] = [];
  const visit = (fullname: string): void => {
    const node = tree.nodes.get(fullname);
    if (node === undefined) return;
    out.push(node.comment);
    for (const child of node.children) visit(child);
  };
  for (const root of tree.roots) visit(root);
  return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

// =============================================================================
// Thread expansion
// =============================================================================

export interface ExpandThreadOptions {
  readonly mode: RedditCorpusCommentMode;
  readonly commentSort: RedditCommentSort;
  readonly expansionCap: number;
  readonly includeAuthors: boolean;
  readonly signal?: AbortSignal;
}

export interface ExpandedThread {
  readonly post: RedditPost;
  readonly comments: RedditCorpusComment[];
  readonly stats: RedditCorpusCommentStats;
  readonly errors: RedditCorpusError[];
}

/** Fetch one thread and, in `full` mode, expand its `more` stubs up to the cap. */
export async function fetchExpandedThread(
  client: RedditClient,
  threadUrl: string,
  opts: ExpandThreadOptions,
): Promise<ExpandedThread> {
  const thread = await client.fetchThread(threadUrl, {
    limit: opts.mode === 'none' ? 1 : 500,
    sort: opts.commentSort,
    ...(opts.mode === 'top' ? { depth: 1 } : {}),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  const post = thread.post;
  const tree: TreeBuilder = { nodes: new Map(), roots: [] };
  const errors: RedditCorpusError[] = [];
  if (opts.mode === 'none') {
    return {
      post,
      comments: [],
      stats: { fetched: 0, reported: post.numComments, unexpandedIds: 0, unexpandedContinuations: 0, expansionCalls: 0, truncated: false },
      errors,
    };
  }
  addTree(tree, thread.comments, opts.includeAuthors);
  if (opts.mode === 'top') {
    // Top level only: drop any replies Reddit sent despite depth=1.
    const topOnly: TreeBuilder = { nodes: new Map(), roots: [] };
    for (const root of tree.roots) {
      const node = tree.nodes.get(root);
      if (node !== undefined) {
        topOnly.nodes.set(root, { comment: node.comment, children: [] });
        topOnly.roots.push(root);
      }
    }
    const comments = flattenCorpusTree(topOnly);
    return {
      post,
      comments,
      stats: {
        fetched: comments.length,
        reported: post.numComments,
        unexpandedIds: 0,
        unexpandedContinuations: 0,
        expansionCalls: 0,
        truncated: false,
      },
      errors,
    };
  }

  const queue: RedditMoreStub[] = [...thread.more];
  let calls = 0;
  const signalOpts = opts.signal === undefined ? {} : { signal: opts.signal };
  while (queue.length > 0 && calls < opts.expansionCap) {
    // Biggest stub first: one morechildren call on a 300-id top-level stub
    // returns far more comments than a deep 1-id stub, so a capped run keeps
    // the widest part of the conversation.
    let best = 0;
    for (let index = 1; index < queue.length; index += 1) {
      const candidate = queue[index];
      const current = queue[best];
      if (candidate !== undefined && current !== undefined && candidate.ids.length > current.ids.length) best = index;
    }
    const [stub] = queue.splice(best, 1);
    if (stub === undefined) break;
    if (stub.ids.length > 0) {
      const batches = chunk(stub.ids, 100);
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        if (batch === undefined) continue;
        if (calls >= opts.expansionCap) {
          // Put the unspent ids back so they are counted as unexpanded.
          queue.push({ parentId: stub.parentId, ids: batches.slice(index).flat(), count: stub.count });
          break;
        }
        calls += 1;
        try {
          const result = await client.moreChildren(post.id, batch, { sort: opts.commentSort, ...signalOpts });
          for (const comment of result.comments) addComment(tree, comment, opts.includeAuthors);
          queue.push(...result.more);
        } catch (error) {
          errors.push(errorOf('morechildren', `${post.id}:${stub.parentId}`, error));
        }
      }
      continue;
    }
    // "Continue this thread": the hidden replies live on the parent comment's own page.
    if (!stub.parentId.startsWith('t1_')) continue;
    const commentId = stub.parentId.slice(3);
    calls += 1;
    try {
      const page = await client.fetchThread(`https://www.reddit.com/comments/${post.id}/_/${commentId}`, {
        limit: 500,
        sort: opts.commentSort,
        ...signalOpts,
      });
      addTree(tree, page.comments, opts.includeAuthors);
      queue.push(...page.more);
    } catch (error) {
      errors.push(errorOf('continuation', `${post.id}:${stub.parentId}`, error));
    }
  }

  let unexpandedIds = 0;
  let unexpandedContinuations = 0;
  for (const stub of queue) {
    if (stub.ids.length > 0) unexpandedIds += stub.ids.length;
    else if (stub.parentId.startsWith('t1_')) unexpandedContinuations += 1;
  }
  const comments = flattenCorpusTree(tree);
  return {
    post,
    comments,
    stats: {
      fetched: comments.length,
      reported: post.numComments,
      unexpandedIds,
      unexpandedContinuations,
      expansionCalls: calls,
      truncated: unexpandedIds > 0 || unexpandedContinuations > 0,
    },
    errors,
  };
}

// =============================================================================
// Corpus run
// =============================================================================

interface Candidate {
  readonly id: string;
  readonly url: string;
  readonly queries: Set<string>;
}

async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<boolean>): Promise<void> {
  let next = 0;
  let stopped = false;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (!stopped) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      const keepGoing = await worker(item);
      if (!keepGoing) stopped = true;
    }
  });
  await Promise.all(lanes);
}

export async function collectRedditCorpus(
  client: RedditClient,
  store: RedditThreadStore,
  opts: RedditCorpusOptions,
): Promise<RedditCorpusResult> {
  const sorts = opts.sorts !== undefined && opts.sorts.length > 0 ? opts.sorts : (['relevance'] as const);
  const t = opts.timeFilter !== undefined ? opts.timeFilter : 'all';
  const perQuery = opts.perQuery !== undefined ? Math.max(1, Math.floor(opts.perQuery)) : 25;
  const minComments = opts.minComments !== undefined ? opts.minComments : 1;
  const mode = opts.comments !== undefined ? opts.comments : 'full';
  const commentSort = opts.commentSort !== undefined ? opts.commentSort : 'top';
  const expansionCap = opts.expansionCap !== undefined ? Math.max(0, Math.floor(opts.expansionCap)) : 25;
  const includeAuthors = opts.includeAuthors === true;
  const concurrency = opts.concurrency !== undefined ? Math.max(1, Math.floor(opts.concurrency)) : 2;
  const now = opts.now !== undefined ? opts.now : () => new Date();
  const signalOpts = opts.signal === undefined ? {} : { signal: opts.signal };

  const errors: RedditCorpusError[] = [];
  const candidates = new Map<string, Candidate>();
  let searchesRun = 0;
  let searchesCached = 0;
  let searchesFailed = 0;
  let filteredOut = 0;

  // ---- Phase 1: search -------------------------------------------------------
  const searchJobs: Array<{ sub: string; query: string; sort: RedditSearchSort }> = [];
  for (const sub of opts.subreddits) {
    for (const query of opts.queries) {
      for (const sort of sorts) searchJobs.push({ sub, query, sort });
    }
  }
  let searchDone = 0;
  for (const job of searchJobs) {
    if (opts.signal !== undefined && opts.signal.aborted) break;
    let taken = 0;
    let after: string | null = null;
    for (let page = 0; taken < perQuery; page += 1) {
      const key = redditSearchCacheKey(job.sub, job.query, job.sort, t, page);
      let result: RedditCorpusSearchPage | undefined;
      try {
        result = await store.readSearch(key);
      } catch (error) {
        errors.push(errorOf('store', key, error));
      }
      if (result !== undefined) {
        searchesCached += 1;
      } else {
        try {
          const listing = await client.search(job.query, {
            subreddits: [job.sub],
            sort: job.sort,
            t,
            limit: Math.min(100, perQuery - taken),
            ...(after === null ? {} : { after }),
            ...signalOpts,
          });
          searchesRun += 1;
          result = { posts: listing.posts, after: listing.after };
          try {
            await store.writeSearch(key, result);
          } catch (error) {
            errors.push(errorOf('store', key, error));
          }
        } catch (error) {
          searchesFailed += 1;
          errors.push(errorOf('search', `r/${job.sub} "${job.query}" sort=${job.sort} page=${page}`, error));
          break;
        }
      }
      for (const post of result.posts) {
        taken += 1;
        if (!POST_ID.test(post.id) || post.url === '') { filteredOut += 1; continue; }
        if (post.over18 || post.quarantine) { filteredOut += 1; continue; }
        if (opts.sinceUtc !== undefined && post.createdUtc < opts.sinceUtc) { filteredOut += 1; continue; }
        if (post.numComments < minComments) { filteredOut += 1; continue; }
        const existing = candidates.get(post.id);
        if (existing !== undefined) existing.queries.add(job.query);
        else candidates.set(post.id, { id: post.id, url: post.url, queries: new Set([job.query]) });
      }
      after = result.after;
      if (after === null || result.posts.length === 0) break;
    }
    searchDone += 1;
    if (opts.onProgress !== undefined) {
      opts.onProgress({ phase: 'search', done: searchDone, total: searchJobs.length, label: `r/${job.sub} "${job.query}" (${job.sort})` });
    }
  }
  for (const url of opts.threadUrls !== undefined ? opts.threadUrls : []) {
    const match = /\/comments\/([a-z0-9]+)/i.exec(url);
    const id = match === null ? undefined : match[1];
    if (id === undefined) {
      errors.push({ stage: 'thread', target: url.slice(0, 120), reason: 'URL does not name a Reddit thread' });
      continue;
    }
    if (!candidates.has(id)) candidates.set(id, { id, url, queries: new Set() });
  }

  // ---- Phase 2: threads ------------------------------------------------------
  const list = [...candidates.values()];
  const subreddits = new Set<string>();
  let written = 0;
  let skippedExisting = 0;
  let failed = 0;
  let commentCount = 0;
  let threadDone = 0;
  await runPool(list, concurrency, async (candidate) => {
    if (opts.signal !== undefined && opts.signal.aborted) return false;
    if (opts.maxThreads !== undefined && written >= opts.maxThreads) return false;
    let exists = false;
    try {
      exists = await store.hasThread(candidate.id);
    } catch (error) {
      errors.push(errorOf('store', candidate.id, error));
    }
    if (exists) {
      skippedExisting += 1;
    } else {
      try {
        const expanded = await fetchExpandedThread(client, candidate.url, {
          mode,
          commentSort,
          expansionCap,
          includeAuthors,
          ...signalOpts,
        });
        errors.push(...expanded.errors);
        const post = expanded.post;
        const record: RedditCorpusThread = {
          schema: REDDIT_CORPUS_SCHEMA,
          id: post.id,
          subreddit: post.subreddit,
          title: includeAuthors ? post.title : redactUserMentions(post.title),
          selftext: includeAuthors ? post.selftext : redactUserMentions(post.selftext),
          url: post.url,
          createdUtc: post.createdUtc,
          score: post.score,
          numComments: post.numComments,
          flair: post.linkFlairText,
          isSelf: post.isSelf,
          ...(post.isSelf || post.externalUrl === undefined ? {} : { externalUrl: post.externalUrl }),
          ...(includeAuthors ? { author: post.author } : {}),
          matchedQueries: [...candidate.queries],
          fetchedAt: now().toISOString(),
          commentMode: mode,
          comments: expanded.comments,
          commentStats: expanded.stats,
        };
        await store.writeThread(record);
        written += 1;
        commentCount += expanded.comments.length;
        subreddits.add(post.subreddit);
      } catch (error) {
        failed += 1;
        errors.push(errorOf('thread', candidate.id, error));
      }
    }
    threadDone += 1;
    if (opts.onProgress !== undefined) {
      opts.onProgress({ phase: 'thread', done: threadDone, total: list.length, label: candidate.id });
    }
    return true;
  });

  return {
    searches: { run: searchesRun, cached: searchesCached, failed: searchesFailed },
    candidates: list.length,
    threads: { written, skippedExisting, failed, filteredOut },
    comments: commentCount,
    subreddits: [...subreddits].sort(),
    errors,
  };
}

// =============================================================================
// Subreddit discovery
// =============================================================================

export interface DiscoverSubredditsOptions {
  /** Results per topic, 1..100. Default 25. */
  readonly perTopic?: number;
  /** Drop subreddits smaller than this. Default 0. */
  readonly minSubscribers?: number;
  readonly signal?: AbortSignal;
}

export interface DiscoverSubredditsResult {
  /** Deduplicated by name, largest first; `topics` lists which topics found each. */
  readonly subreddits: ReadonlyArray<RedditSubredditInfo & { readonly topics: readonly string[] }>;
  readonly errors: readonly RedditCorpusError[];
}

export async function discoverSubreddits(
  client: RedditClient,
  topics: readonly string[],
  opts: DiscoverSubredditsOptions = {},
): Promise<DiscoverSubredditsResult> {
  const perTopic = opts.perTopic !== undefined ? opts.perTopic : 25;
  const minSubscribers = opts.minSubscribers !== undefined ? opts.minSubscribers : 0;
  const found = new Map<string, { info: RedditSubredditInfo; topics: Set<string> }>();
  const errors: RedditCorpusError[] = [];
  for (const topic of topics) {
    try {
      const subs = await client.searchSubreddits(topic, {
        limit: perTopic,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      for (const info of subs) {
        if (info.subscribers < minSubscribers) continue;
        const key = info.name.toLowerCase();
        const existing = found.get(key);
        if (existing !== undefined) existing.topics.add(topic);
        else found.set(key, { info, topics: new Set([topic]) });
      }
    } catch (error) {
      errors.push(errorOf('discover', topic, error));
    }
  }
  const subreddits = [...found.values()]
    .map(({ info, topics: matched }) => ({ ...info, topics: [...matched] }))
    .sort((a, b) => b.subscribers - a.subscribers);
  return { subreddits, errors };
}
