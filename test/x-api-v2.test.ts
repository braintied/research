import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { xProvider } from '../src/providers/x.js';

const twitterApiAdvancedSearchFixture: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/twitterapi-advanced-search.json', import.meta.url), 'utf8'),
);

const X_ENV_KEYS = [
  'X_BEARER_TOKEN',
  'X_APP_BEARER_TOKEN',
  'TWITTER_BEARER_TOKEN',
  'TWITTERAPI_IO_KEY',
  'TWITTERAPI_KEY',
  'APIFY_API_TOKEN',
] as const;

type XEnvKey = (typeof X_ENV_KEYS)[number];

function preserveXEnvironment(): Record<XEnvKey, string | undefined> {
  return Object.fromEntries(X_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    XEnvKey,
    string | undefined
  >;
}

function clearXEnvironment(): void {
  for (const key of X_ENV_KEYS) delete process.env[key];
}

function restoreXEnvironment(original: Record<XEnvKey, string | undefined>): void {
  for (const key of X_ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('official X recent search maps exact dates, Top/Latest sorts, pagination, and provenance', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = preserveXEnvironment();
  clearXEnvironment();
  process.env.X_BEARER_TOKEN = 'official-test-token';

  const end = new Date(Date.now() - 60_000);
  const start = new Date(end.getTime() - 2 * 86_400_000);
  const calls: Array<{ url: URL; authorization: string | null }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
    });

    const sortOrder = url.searchParams.get('sort_order');
    const nextToken = url.searchParams.get('next_token');
    assert.ok(sortOrder === 'relevancy' || sortOrder === 'recency');
    const page = nextToken === null ? 1 : 2;
    const prefix = sortOrder === 'relevancy' ? '10' : '20';
    const postId = `${prefix}${page}`;
    const authorId = `author-${postId}`;

    return Response.json({
      data: [{
        id: postId,
        text: `${sortOrder} result ${page}`,
        author_id: authorId,
        conversation_id: `conversation-${postId}`,
        created_at: new Date(end.getTime() - page * 1_000).toISOString(),
        lang: 'en',
        public_metrics: {
          retweet_count: page,
          reply_count: page + 1,
          like_count: page + 2,
          quote_count: page + 3,
          impression_count: page * 100,
        },
      }],
      includes: {
        users: [{ id: authorId, name: `Author ${postId}`, username: `user${postId}` }],
      },
      meta: page === 1 ? { next_token: `${sortOrder}-page-2` } : {},
    });
  }) as typeof fetch;

  try {
    assert.equal(xProvider.enabled, true);
    const results = await xProvider.search('agent loops', {
      limit: 3,
      recency_days: 2,
      published_before: end.toISOString(),
      sort: 'mixed',
      handles: ['@peter', 'swyx'],
      max_pages: 2,
    });

    assert.equal(calls.length, 4);
    assert.deepEqual(
      calls.map((call) => call.url.searchParams.get('sort_order')),
      ['relevancy', 'relevancy', 'recency', 'recency'],
    );
    assert.deepEqual(
      calls.map((call) => call.url.searchParams.get('next_token')),
      [null, 'relevancy-page-2', null, 'recency-page-2'],
    );

    for (const call of calls) {
      assert.equal(call.url.origin, 'https://api.x.com');
      assert.equal(call.url.pathname, '/2/tweets/search/recent');
      assert.equal(call.authorization, 'Bearer official-test-token');
      assert.equal(
        call.url.searchParams.get('query'),
        'agent loops lang:en (from:peter OR from:swyx)',
      );
      assert.equal(call.url.searchParams.get('start_time'), start.toISOString());
      assert.equal(call.url.searchParams.get('end_time'), end.toISOString());
      assert.equal(call.url.searchParams.get('max_results'), '10');
      assert.equal(call.url.searchParams.get('expansions'), 'author_id');
      assert.equal(call.url.searchParams.get('user.fields'), 'id,name,username');
      assert.match(call.url.searchParams.get('tweet.fields') ?? '', /conversation_id/);
      assert.match(call.url.searchParams.get('tweet.fields') ?? '', /public_metrics/);
    }

    assert.deepEqual(results.map((result) => result.canonical_id), ['101', '201', '102']);
    assert.equal(results[0]?.author, '@user101');
    assert.equal(results[0]?.engagement.like_count, 3);
    assert.equal(results[0]?.engagement.view_count, 100);
    assert.equal(results[0]?.raw_metadata['backend'], 'x_api_v2');
    assert.equal(results[0]?.raw_metadata['sort_order'], 'relevancy');
    assert.equal(results[0]?.raw_metadata['conversation_id'], 'conversation-101');
    assert.equal(results[1]?.raw_metadata['sort_order'], 'recency');
  } finally {
    globalThis.fetch = originalFetch;
    restoreXEnvironment(originalEnv);
  }
});

test('official X fetch uses post lookup and best-effort conversation search', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = preserveXEnvironment();
  clearXEnvironment();
  process.env.TWITTER_BEARER_TOKEN = 'official-alias-token';
  const calls: URL[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(url);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer official-alias-token');

    if (url.pathname === '/2/tweets/555') {
      return Response.json({
        data: {
          id: '555',
          text: 'Root post',
          author_id: 'root-author',
          conversation_id: '555',
          created_at: new Date(Date.now() - 120_000).toISOString(),
          public_metrics: { like_count: 9, reply_count: 1, impression_count: 90 },
        },
        includes: { users: [{ id: 'root-author', username: 'rootuser', name: 'Root User' }] },
      });
    }

    assert.equal(url.pathname, '/2/tweets/search/recent');
    assert.equal(url.searchParams.get('query'), 'conversation_id:555');
    return Response.json({
      data: [{
        id: '556',
        text: 'Useful reply',
        author_id: 'reply-author',
        conversation_id: '555',
        created_at: new Date(Date.now() - 60_000).toISOString(),
        public_metrics: { like_count: 4, reply_count: 0, impression_count: 20 },
        referenced_tweets: [{ type: 'replied_to', id: '555' }],
      }],
      includes: { users: [{ id: 'reply-author', username: 'replyuser', name: 'Reply User' }] },
      meta: {},
    });
  }) as typeof fetch;

  try {
    const result = await xProvider.fetch?.('https://x.com/rootuser/status/555');
    assert.ok(result !== undefined);
    assert.equal(result.fetch_status, 'ok');
    assert.equal(result.raw_metadata['backend'], 'x_api_v2');
    assert.equal(result.raw_metadata['conversation_id'], '555');
    assert.match(result.markdown, /Useful reply/);
    assert.deepEqual(calls.map((call) => call.pathname), [
      '/2/tweets/555',
      '/2/tweets/search/recent',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreXEnvironment(originalEnv);
  }
});

test('twitterapi.io is preferred over official X when both are configured', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = preserveXEnvironment();
  clearXEnvironment();
  process.env.TWITTERAPI_IO_KEY = 'lower-cost-test-token';
  process.env.X_BEARER_TOKEN = 'official-test-token';
  const calls: URL[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(url);
    assert.equal(url.origin, 'https://api.twitterapi.io');
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'lower-cost-test-token');
    return Response.json({
      tweets: [{
        id: '7001',
        text: 'Lower-cost primary result',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        author: { userName: 'primary' },
      }],
      has_next_page: false,
      next_cursor: '',
    });
  }) as typeof fetch;

  try {
    const results = await xProvider.search('agent loops', {
      limit: 3,
      recency_days: 2,
      sort: 'top',
    });
    assert.equal(calls.length, 1);
    assert.equal(results[0]?.raw_metadata['backend'], 'twitterapi_io');
  } finally {
    globalThis.fetch = originalFetch;
    restoreXEnvironment(originalEnv);
  }
});

test('twitterapi.io accepts the current status-less cursor envelope and paginates', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = preserveXEnvironment();
  clearXEnvironment();
  process.env.TWITTERAPI_IO_KEY = 'current-envelope-test-token';
  const calls: URL[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(url);
    if (calls.length === 1) return Response.json(twitterApiAdvancedSearchFixture);
    return Response.json({
      has_next_page: false,
      next_cursor: '',
      tweets: [{
        id: '8002',
        text: 'Fixture page two',
        author: { id: 'fixture-author-2', name: 'Second Author', userName: 'second_author' },
        conversationId: '8002',
        createdAt: '2026-07-21T18:01:00.000Z',
        likeCount: 4,
        viewCount: 40,
        replyCount: 1,
        retweetCount: 1,
        quoteCount: 0,
      }],
    });
  }) as typeof fetch;

  try {
    const results = await xProvider.search('agent loops', {
      limit: 2,
      recency_days: 2,
      sort: 'latest',
      max_pages: 2,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.searchParams.has('cursor'), false);
    assert.equal(calls[1]?.searchParams.get('cursor'), 'fixture-page-2');
    assert.deepEqual(results.map((result) => result.canonical_id), ['8001', '8002']);
    assert.equal(results[0]?.raw_metadata['backend'], 'twitterapi_io');
    assert.equal(results[0]?.raw_metadata['query_type'], 'Latest');
  } finally {
    globalThis.fetch = originalFetch;
    restoreXEnvironment(originalEnv);
  }
});

test('twitterapi.io fetch is preferred over official X when both are configured', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = preserveXEnvironment();
  clearXEnvironment();
  process.env.TWITTERAPI_IO_KEY = 'lower-cost-test-token';
  process.env.X_BEARER_TOKEN = 'official-test-token';
  const calls: URL[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(url);
    assert.equal(url.origin, 'https://api.twitterapi.io');
    if (url.pathname === '/twitter/tweets') {
      return Response.json({
        tweets: [{
          id: '7002',
          text: 'Primary fetched post',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          author: { userName: 'primary' },
        }],
      });
    }
    assert.equal(url.pathname, '/twitter/tweet/replies');
    return Response.json({ tweets: [] });
  }) as typeof fetch;

  try {
    const result = await xProvider.fetch?.('https://x.com/primary/status/7002');
    assert.ok(result !== undefined);
    assert.equal(result.fetch_status, 'ok');
    assert.equal(result.raw_metadata['backend'], 'twitterapi_io');
    assert.deepEqual(calls.map((call) => call.pathname), [
      '/twitter/tweets',
      '/twitter/tweet/replies',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreXEnvironment(originalEnv);
  }
});

test('official recent search falls through instead of truncating a requested 90-day window', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = preserveXEnvironment();
  clearXEnvironment();
  process.env.X_BEARER_TOKEN = 'official-test-token';
  process.env.TWITTERAPI_IO_KEY = 'historical-test-token';
  const calls: URL[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(url);
    assert.equal(url.origin, 'https://api.twitterapi.io');
    return Response.json({
      tweets: [{
        id: '9001',
        text: 'Historical result',
        createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        author: { userName: 'historian' },
      }],
      has_next_page: false,
      next_cursor: '',
    });
  }) as typeof fetch;

  try {
    const results = await xProvider.search('agent history', {
      limit: 5,
      recency_days: 90,
      sort: 'top',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.pathname, '/twitter/tweet/advanced_search');
    assert.equal(results[0]?.raw_metadata['backend'], 'twitterapi_io');
  } finally {
    globalThis.fetch = originalFetch;
    restoreXEnvironment(originalEnv);
  }
});
