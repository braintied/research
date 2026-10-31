import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRedditClient } from '../src/providers/reddit-client.js';
import {
  collectRedditCorpus,
  discoverSubreddits,
  fetchExpandedThread,
  redactUserMentions,
  type RedditCorpusSearchPage,
  type RedditCorpusThread,
  type RedditThreadStore,
} from '../src/providers/reddit-corpus.js';
import { createDirectoryThreadStore } from '../src/providers/reddit-corpus-store.js';

// Fixtures are Reddit's response shapes (thread page, /api/morechildren, a
// "continue this thread" page, search, subreddit search) with invented content.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reddit-corpus');
async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));
}

let idCounter = 0;
function credentials(): { clientId: string; clientSecret: string; userAgent: string } {
  idCounter += 1;
  return { clientId: `corpus-client-${idCounter}`, clientSecret: 'corpus-secret', userAgent: 'braintied-test/1.0 (by u/test)' };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

interface Harness {
  fetchImpl: typeof fetch;
  urls: URL[];
  sleeps: number[];
  tokens: () => number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Routes by path; `override` can answer first (for 401/429/500 scripts). */
async function harness(override?: (url: URL, index: number) => Response | undefined): Promise<Harness> {
  const thread = await fixture('thread-p1.json');
  const more = await fixture('morechildren-p1.json');
  const continuation = await fixture('continuation-p1-c3.json');
  const search = await fixture('search-agingparents.json');
  const subs = await fixture('subreddits-search.json');
  const urls: URL[] = [];
  const sleeps: number[] = [];
  let tokenCount = 0;
  let clock = 1_700_000_000_000;
  const fetchImpl: typeof fetch = async (input) => {
    const raw = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (raw === TOKEN_URL) {
      tokenCount += 1;
      return json({ access_token: `tok-${tokenCount}`, token_type: 'bearer', expires_in: 86_400 });
    }
    const url = new URL(raw);
    urls.push(url);
    const scripted = override === undefined ? undefined : override(url, urls.length - 1);
    if (scripted !== undefined) return scripted;
    if (url.pathname === '/api/morechildren') return json(more);
    if (url.pathname === '/comments/p1/_/c3.json') return json(continuation);
    if (url.pathname.endsWith('/search.json') && url.pathname.startsWith('/subreddits/')) return json(subs);
    if (url.pathname.endsWith('/search.json')) return json(search);
    if (url.pathname.includes('/comments/')) return json(thread);
    return json({ message: 'not found' }, 404);
  };
  return {
    fetchImpl,
    urls,
    sleeps,
    tokens: () => tokenCount,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  };
}

function memoryStore(): RedditThreadStore & { threads: Map<string, RedditCorpusThread> } {
  const threads = new Map<string, RedditCorpusThread>();
  const searches = new Map<string, RedditCorpusSearchPage>();
  return {
    threads,
    async hasThread(id) { return threads.has(id); },
    async writeThread(thread) { threads.set(thread.id, thread); },
    async readSearch(key) { return searches.get(key); },
    async writeSearch(key, page) { searches.set(key, page); },
  };
}

const FIXED_NOW = (): Date => new Date('2026-10-12T00:00:00Z');
/** Keeps the fixture's p1 and drops its 2017 post. */
const SINCE = 1_600_000_000;

test('full mode expands morechildren and continuation stubs into one depth-first tree', async () => {
  const h = await harness();
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await fetchExpandedThread(client, 'https://www.reddit.com/r/AgingParents/comments/p1/t/', {
    mode: 'full', commentSort: 'top', expansionCap: 10, includeAuthors: false,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.comments.map((c) => [c.id, c.parentId, c.depth]),
    [
      ['c1', 't3_p1', 0],
      ['c2', 't1_c1', 1],
      ['c3', 't1_c2', 2],
      ['c8', 't1_c3', 3],
      ['c7', 't3_p1', 0],
      ['c4', 't3_p1', 0],
      ['c6', 't1_c4', 1],
      ['c5', 't3_p1', 0],
    ],
  );
  assert.equal(result.stats.expansionCalls, 2);
  assert.equal(result.stats.truncated, false);
  assert.equal(result.stats.fetched, 8);
  const moreCall = h.urls.find((u) => u.pathname === '/api/morechildren');
  assert.ok(moreCall !== undefined);
  assert.equal(moreCall.hostname, 'oauth.reddit.com');
  assert.equal(moreCall.searchParams.get('link_id'), 't3_p1');
  assert.equal(moreCall.searchParams.get('children'), 'c4,c5');
});

test('the expansion cap stops expansion and counts what is left', async () => {
  const h = await harness();
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await fetchExpandedThread(client, 'https://www.reddit.com/r/AgingParents/comments/p1/t/', {
    mode: 'full', commentSort: 'top', expansionCap: 0, includeAuthors: false,
  });
  assert.equal(result.stats.expansionCalls, 0);
  assert.equal(result.stats.truncated, true);
  assert.equal(result.stats.unexpandedIds, 2);
  assert.equal(result.stats.unexpandedContinuations, 1);
  assert.equal(result.comments.length, 4);
});

test('usernames are off by default: no author fields and u/ mentions redacted', async () => {
  const h = await harness();
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const store = memoryStore();
  await collectRedditCorpus(client, store, {
    subreddits: ['AgingParents'], queries: ['bank'], sinceUtc: SINCE, now: FIXED_NOW,
  });
  const thread = store.threads.get('p1');
  assert.ok(thread !== undefined);
  const serialized = JSON.stringify(thread);
  for (const name of ['alice_writer', 'op_person', 'scammer_guy', 'helpful_hank', 'bank_rep_99']) {
    assert.equal(serialized.includes(name), false, `${name} leaked`);
  }
  assert.equal('author' in thread, false);
  assert.ok(thread.comments.every((c) => !('author' in c)));
  assert.equal(thread.title, 'Mom gave her bank login to u/[redacted]');
  assert.equal(thread.comments[0]?.body, 'Call the bank fraud line. Ask u/[redacted] too.');
  assert.equal(redactUserMentions('see /u/some_one and u/ab'), 'see u/[redacted] and u/ab');
});

test('includeAuthors is an explicit opt-in', async () => {
  const h = await harness();
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const store = memoryStore();
  await collectRedditCorpus(client, store, {
    subreddits: ['AgingParents'], queries: ['bank'], includeAuthors: true, sinceUtc: SINCE, now: FIXED_NOW,
  });
  const thread = store.threads.get('p1');
  assert.ok(thread !== undefined);
  assert.equal(thread.author, 'op_person');
  assert.equal(thread.comments[0]?.author, 'alice_writer');
  assert.equal(thread.title, 'Mom gave her bank login to u/scammer_guy');
});

test('search results are filtered by date, comment count and NSFW, and metadata is kept', async () => {
  const h = await harness();
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const store = memoryStore();
  const result = await collectRedditCorpus(client, store, {
    subreddits: ['AgingParents'], queries: ['bank', 'scam'], sinceUtc: 1_600_000_000, now: FIXED_NOW,
  });
  assert.equal(result.candidates, 1);
  assert.equal(result.threads.written, 1);
  assert.equal(result.threads.filteredOut, 6);
  const thread = store.threads.get('p1');
  assert.ok(thread !== undefined);
  assert.deepEqual(thread.matchedQueries, ['bank', 'scam']);
  assert.equal(thread.subreddit, 'AgingParents');
  assert.equal(thread.flair, 'Finances');
  assert.equal(thread.score, 118);
  assert.equal(thread.numComments, 9);
  assert.equal(thread.createdUtc, 1_700_000_000);
  assert.equal(thread.url, 'https://www.reddit.com/r/AgingParents/comments/p1/t/');
  assert.equal(thread.fetchedAt, '2026-10-12T00:00:00.000Z');
  const searchCall = h.urls.find((u) => u.pathname === '/r/AgingParents/search.json');
  assert.ok(searchCall !== undefined);
  assert.equal(searchCall.searchParams.get('restrict_sr'), 'on');
});

test('a 429 backs off on x-ratelimit-reset and the run completes', async () => {
  let limited = false;
  const h = await harness((url) => {
    if (!limited && url.pathname.endsWith('/search.json')) {
      limited = true;
      return json({ message: 'Too Many Requests' }, 429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '7' });
    }
    return undefined;
  });
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await collectRedditCorpus(client, memoryStore(), {
    subreddits: ['AgingParents'], queries: ['bank'], sinceUtc: SINCE, now: FIXED_NOW,
  });
  assert.ok(h.sleeps.includes(7_000), `expected a 7s backoff, saw ${h.sleeps.join(',')}`);
  assert.equal(result.searches.failed, 0);
  assert.equal(result.threads.written, 1);
  assert.deepEqual(result.errors, []);
});

test('a 401 mid-run refreshes the token once and continues', async () => {
  let rejected = false;
  const h = await harness((url) => {
    if (!rejected && url.pathname.includes('/comments/p1/')) {
      rejected = true;
      return json({ message: 'Unauthorized' }, 401);
    }
    return undefined;
  });
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await collectRedditCorpus(client, memoryStore(), {
    subreddits: ['AgingParents'], queries: ['bank'], sinceUtc: SINCE, now: FIXED_NOW,
  });
  assert.equal(h.tokens(), 2);
  assert.equal(result.threads.written, 1);
  assert.deepEqual(result.errors, []);
});

test('failed requests are reported, never silently dropped', async () => {
  const h = await harness((url) => {
    if (url.pathname === '/api/morechildren') return json({ message: 'Forbidden' }, 403);
    if (url.pathname === '/r/AgingParents/comments/p2/t.json') return json({ message: 'Not Found' }, 404);
    return undefined;
  });
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const store = memoryStore();
  const result = await collectRedditCorpus(client, store, {
    subreddits: ['AgingParents'],
    queries: ['bank'],
    sinceUtc: SINCE,
    threadUrls: ['https://www.reddit.com/r/AgingParents/comments/p2/t', 'https://example.com/not-a-thread'],
    now: FIXED_NOW,
  });
  assert.equal(result.threads.written, 1);
  assert.equal(result.threads.failed, 1);
  const stages = result.errors.map((e) => [e.stage, e.status]);
  assert.deepEqual(stages.sort(), [['morechildren', 403], ['thread', 404], ['thread', undefined]].sort());
});

test('a resumed run skips stored threads and cached search pages', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reddit-corpus-'));
  try {
    const first = await harness();
    const options = { subreddits: ['AgingParents'], queries: ['bank'], sinceUtc: SINCE, now: FIXED_NOW };
    const r1 = await collectRedditCorpus(
      createRedditClient(credentials(), { fetchImpl: first.fetchImpl, now: first.now, sleep: first.sleep }),
      createDirectoryThreadStore(dir),
      options,
    );
    assert.equal(r1.threads.written, 1);
    assert.deepEqual(await readdir(path.join(dir, 'threads')), ['p1.json']);
    const saved: unknown = JSON.parse(await readFile(path.join(dir, 'threads', 'p1.json'), 'utf8'));
    assert.equal(typeof saved === 'object' && saved !== null && 'schema' in saved ? saved.schema : '', 'braintied.reddit-thread/1');

    const second = await harness();
    const r2 = await collectRedditCorpus(
      createRedditClient(credentials(), { fetchImpl: second.fetchImpl, now: second.now, sleep: second.sleep }),
      createDirectoryThreadStore(dir),
      options,
    );
    assert.equal(second.urls.length, 0, `resume made requests: ${second.urls.map((u) => u.pathname).join(',')}`);
    assert.equal(r2.searches.cached, 1);
    assert.equal(r2.threads.skippedExisting, 1);
    assert.equal(r2.threads.written, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('subreddit discovery dedupes across topics, drops small ones, sorts by size', async () => {
  const h = await harness();
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await discoverSubreddits(client, ['aging parents', 'caregiving'], { minSubscribers: 1_000 });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.subreddits.map((s) => [s.name, s.subscribers, s.topics.length]), [
    ['AgingParents', 120_000, 2],
    ['CaregiverSupport', 90_000, 2],
  ]);
  const call = h.urls[0];
  assert.ok(call !== undefined);
  assert.equal(call.pathname, '/subreddits/search.json');
  assert.equal(call.searchParams.get('include_over_18'), 'false');
});
