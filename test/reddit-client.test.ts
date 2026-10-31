import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRedditClient,
  probeReddit,
  RedditApiError,
  REDDIT_VAULT_KEYS,
  redditCredentialsFromResolver,
} from '../src/providers/reddit-client.js';
import { createRedditProvider } from '../src/providers/reddit.js';

// Every test uses its own client id: the token cache and rate state are
// per client id at module level, as they are in production.
let idCounter = 0;
function credentials(): { clientId: string; clientSecret: string; userAgent: string } {
  idCounter += 1;
  return { clientId: `test-client-${idCounter}`, clientSecret: 'shh-secret-value', userAgent: 'braintied-test/1.0 (by u/test)' };
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
}

type Responder = (call: Call, index: number) => Response;

function harness(respond: Responder): {
  fetchImpl: typeof fetch;
  calls: Call[];
  sleeps: number[];
  now: () => number;
  advance: (ms: number) => void;
  sleep: (ms: number) => Promise<void>;
} {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 1_700_000_000_000;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const call: Call = {
      url,
      method: init?.method === undefined ? 'GET' : init.method,
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return {
    fetchImpl,
    calls,
    sleeps,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function tokenResponse(token: string, expiresIn = 86_400): Response {
  return json({ access_token: token, token_type: 'bearer', expires_in: expiresIn, scope: '*' });
}

function listing(posts: Array<Record<string, unknown>>, after: string | null = null): unknown {
  return { kind: 'Listing', data: { after, children: posts.map((data) => ({ kind: 't3', data })) } };
}

const POST = {
  id: 'abc123',
  title: 'Caring for my dad',
  selftext: 'Long story',
  permalink: '/r/AgingParents/comments/abc123/caring_for_my_dad/',
  author: 'someone',
  subreddit: 'AgingParents',
  created_utc: 1_760_000_000,
  ups: 42,
  num_comments: 7,
  url: 'https://www.reddit.com/r/AgingParents/comments/abc123/caring_for_my_dad/',
};

const isToken = (call: Call): boolean => call.url === 'https://www.reddit.com/api/v1/access_token';

test('token is cached per client id and reused across requests', async () => {
  const h = harness((call) => (isToken(call) ? tokenResponse('tok-1') : json(listing([POST]))));
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  await client.listSubreddit('AgingParents', { sort: 'new' });
  await client.listSubreddit('AgingParents', { sort: 'hot' });
  assert.equal(h.calls.filter(isToken).length, 1);
  const reads = h.calls.filter((call) => !isToken(call));
  assert.equal(reads.length, 2);
  for (const read of reads) {
    assert.equal(new URL(read.url).hostname, 'oauth.reddit.com');
    assert.equal(read.headers.get('authorization'), 'Bearer tok-1');
    assert.equal(read.headers.get('user-agent'), 'braintied-test/1.0 (by u/test)');
    assert.equal(read.redirect, 'error');
  }
  const tokenCall = h.calls.find(isToken);
  assert.ok(tokenCall !== undefined);
  assert.equal(tokenCall.method, 'POST');
  assert.equal(tokenCall.headers.get('user-agent'), 'braintied-test/1.0 (by u/test)');
});

test('token refreshes 60s before expiry', async () => {
  let tokens = 0;
  const h = harness((call) => {
    if (isToken(call)) { tokens += 1; return tokenResponse(`tok-${tokens}`, 120); }
    return json(listing([POST]));
  });
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  await client.listSubreddit('AgingParents', { sort: 'new' });
  h.advance(30_000);
  await client.listSubreddit('AgingParents', { sort: 'new' });
  assert.equal(tokens, 1);
  h.advance(31_000);
  await client.listSubreddit('AgingParents', { sort: 'new' });
  assert.equal(tokens, 2);
  assert.equal(h.calls.at(-1)?.headers.get('authorization'), 'Bearer tok-2');
});

test('a 401 drops the token and retries exactly once', async () => {
  let tokens = 0;
  let reads = 0;
  const h = harness((call) => {
    if (isToken(call)) { tokens += 1; return tokenResponse(`tok-${tokens}`); }
    reads += 1;
    return reads === 1 ? json({ message: 'Unauthorized' }, 401) : json(listing([POST]));
  });
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await client.listSubreddit('AgingParents', { sort: 'new' });
  assert.equal(result.posts.length, 1);
  assert.equal(tokens, 2);
  assert.equal(h.calls.at(-1)?.headers.get('authorization'), 'Bearer tok-2');

  const always401 = harness((call) => (isToken(call) ? tokenResponse('tok-x') : json({ message: 'Unauthorized' }, 401)));
  const failing = createRedditClient(credentials(), { fetchImpl: always401.fetchImpl, now: always401.now, sleep: always401.sleep });
  await assert.rejects(
    failing.listSubreddit('AgingParents', { sort: 'new' }),
    (error: unknown) => error instanceof RedditApiError && error.status === 401 && error.stage === 'api',
  );
  assert.equal(always401.calls.filter((call) => !isToken(call)).length, 2);
});

test('429 backs off for Retry-After, then succeeds', async () => {
  let reads = 0;
  const h = harness((call) => {
    if (isToken(call)) return tokenResponse('tok');
    reads += 1;
    return reads === 1 ? json({ message: 'Too Many Requests' }, 429, { 'retry-after': '7' }) : json(listing([POST]));
  });
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await client.search('dementia care', { sort: 'relevance', t: 'all', limit: 5 });
  assert.equal(result.posts.length, 1);
  assert.ok(h.sleeps.includes(7_000), `slept ${h.sleeps.join(',')}`);
});

test('429 uses x-ratelimit-reset when there is no Retry-After, and gives up after 3 attempts', async () => {
  const h = harness((call) => (isToken(call)
    ? tokenResponse('tok')
    : json({ message: 'Too Many Requests' }, 429, { 'x-ratelimit-reset': '12', 'x-ratelimit-remaining': '0' })));
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  await assert.rejects(
    client.search('dementia care', { sort: 'relevance', t: 'all', limit: 5 }),
    (error: unknown) => error instanceof RedditApiError && error.status === 429 && /3 attempts/.test(error.reason),
  );
  assert.equal(h.calls.filter((call) => !isToken(call)).length, 3);
  assert.ok(h.sleeps.includes(12_000), `slept ${h.sleeps.join(',')}`);
});

test('rate-limit headers: remaining < 1 waits until reset; otherwise requests keep 650ms spacing', async () => {
  let reads = 0;
  const h = harness((call) => {
    if (isToken(call)) return tokenResponse('tok');
    reads += 1;
    return reads === 1
      ? json(listing([POST]), 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '30', 'x-ratelimit-used': '1000' })
      : json(listing([POST]), 200, { 'x-ratelimit-remaining': '998', 'x-ratelimit-reset': '600' });
  });
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  await client.listSubreddit('AgingParents', { sort: 'new' });
  assert.deepEqual(h.sleeps, []);
  await client.listSubreddit('AgingParents', { sort: 'new' });
  assert.deepEqual(h.sleeps, [30_000]);
  await client.listSubreddit('AgingParents', { sort: 'new' });
  assert.deepEqual(h.sleeps, [30_000, 650]);
});

test('fetchThread refuses non-canonical URLs before any token is requested', async () => {
  const h = harness(() => { throw new Error('no request may be made'); });
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  for (const url of [
    'https://evil.example/r/research/comments/abc',
    'https://reddit.com.evil.example/r/research/comments/abc',
    'https://reddit.com@evil.example/r/research/comments/abc',
    'http://www.reddit.com/r/research/comments/abc',
    'https://www.reddit.com:8443/r/research/comments/abc',
    'not a url',
  ]) {
    await assert.rejects(
      client.fetchThread(url),
      (error: unknown) => error instanceof RedditApiError && error.stage === 'url',
      url,
    );
  }
  assert.equal(h.calls.length, 0);
});

test('fetchThread returns the full nested comment tree and counts unexpanded more children', async () => {
  const comment = (id: string, body: string, ups: number, replies: unknown): unknown => ({
    kind: 't1',
    data: { id, author: `a-${id}`, body, ups, created_utc: 1_760_000_100, permalink: `/r/x/comments/abc123/t/${id}/`, replies },
  });
  const repliesOf = (children: unknown[]): unknown => ({ kind: 'Listing', data: { children } });
  const deep = comment('d5', 'depth five', 1, '');
  let chain: unknown = deep;
  for (const id of ['d4', 'd3', 'd2', 'd1']) chain = comment(id, `depth ${id}`, 2, repliesOf([chain]));
  const thread = [
    listing([POST]),
    {
      kind: 'Listing',
      data: {
        children: [
          comment('c1', 'top one', 10, repliesOf([
            comment('c1r1', 'reply', 5, ''),
            { kind: 'more', data: { count: 3, children: ['m1', 'm2', 'm3'] } },
          ])),
          comment('c2', '[deleted]', 0, repliesOf([comment('c2r1', 'orphan reply', 3, '')])),
          chain,
          { kind: 'more', data: { count: 2, children: ['m4', 'm5'] } },
        ],
      },
    },
  ];
  const h = harness((call) => (isToken(call) ? tokenResponse('tok') : json(thread)));
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await client.fetchThread('https://old.reddit.com/r/AgingParents/comments/abc123/caring_for_my_dad/', { depth: 8 });

  const read = new URL(h.calls.at(-1)?.url ?? 'https://invalid.example');
  assert.equal(read.hostname, 'oauth.reddit.com');
  assert.equal(read.pathname, '/r/AgingParents/comments/abc123/caring_for_my_dad/.json');
  assert.equal(read.searchParams.get('depth'), '8');
  assert.equal(read.searchParams.get('limit'), '200');

  assert.equal(result.post.id, 'abc123');
  assert.equal(result.post.url, 'https://www.reddit.com/r/AgingParents/comments/abc123/caring_for_my_dad/');
  assert.equal(result.post.created, new Date(1_760_000_000 * 1000).toISOString());
  assert.equal(result.post.numComments, 7);
  assert.deepEqual(result.comments.map((c) => c.id), ['c1', 'c2', 'd1']);
  const [c1, c2, d1] = result.comments;
  assert.ok(c1 !== undefined && c2 !== undefined && d1 !== undefined);
  assert.deepEqual(c1.replies.map((c) => [c.id, c.depth]), [['c1r1', 1]]);
  assert.equal(c2.body, '[deleted]');
  assert.deepEqual(c2.replies.map((c) => c.body), ['orphan reply']);
  let node = d1;
  const depths: number[] = [node.depth];
  while (node.replies[0] !== undefined) { node = node.replies[0]; depths.push(node.depth); }
  assert.deepEqual(depths, [0, 1, 2, 3, 4]);
  assert.equal(node.id, 'd5');
  assert.equal(c1.permalink, 'https://www.reddit.com/r/x/comments/abc123/t/c1/');
  assert.equal(result.moreCount, 5);
  assert.equal(result.moreStubs, 2);
});

test('provider fetch keeps the depth-3 flatten, top comments by ups, and backend reddit_oauth_api', async () => {
  const deepReply = { kind: 't1', data: { id: 'd4', author: 'deep', body: 'too deep', ups: 999, permalink: '/p/d4/', replies: '' } };
  let tree: unknown = deepReply;
  for (const id of ['d3', 'd2', 'd1', 'd0']) {
    tree = { kind: 't1', data: { id, author: id, body: `body ${id}`, ups: 1, permalink: `/p/${id}/`, replies: { data: { children: [tree] } } } };
  }
  const thread = [listing([POST]), { kind: 'Listing', data: { children: [tree] } }];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    return url.includes('access_token') ? tokenResponse('tok') : json(thread);
  };
  try {
    const provider = createRedditProvider({ reddit: credentials() });
    const result = await provider.fetch?.('https://www.reddit.com/r/AgingParents/comments/abc123/caring_for_my_dad/');
    assert.ok(result !== undefined);
    assert.equal(result.fetch_status, 'ok');
    assert.equal(result.raw_metadata['backend'], 'reddit_oauth_api');
    const top = result.raw_metadata['top_comments'];
    assert.ok(Array.isArray(top));
    assert.deepEqual(top.map((c: { id: string }) => c.id), ['d0', 'd1', 'd2', 'd3']);
    assert.deepEqual(Object.keys(top[0]).sort(), ['author', 'body', 'id', 'permalink', 'ups']);
    assert.match(result.markdown, /^# Caring for my dad\n\n\*\*Author:\*\* u\/someone \| \*\*Subreddit:\*\* r\/AgingParents \| \*\*Upvotes:\*\* 42 \| \*\*Comments:\*\* 7/);
    assert.match(result.markdown, /## Top Comments/);
    assert.doesNotMatch(result.markdown, /too deep/);
  } finally {
    globalThis.fetch = original;
  }
});

test('probe reports ok with latency and the live remaining budget', async () => {
  const h = harness((call) => (isToken(call)
    ? tokenResponse('tok')
    : json(listing([POST]), 200, { 'x-ratelimit-remaining': '999.0', 'x-ratelimit-reset': '600' })));
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await client.probe();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.rateLimitRemaining, 999);
    assert.equal(typeof result.latencyMs, 'number');
  }
  const read = new URL(h.calls.at(-1)?.url ?? 'https://invalid.example');
  assert.equal(read.pathname, '/r/AgingParents/top.json');
  assert.equal(read.searchParams.get('t'), 'week');
  assert.equal(read.searchParams.get('limit'), '1');
});

test('probe never throws and never leaks a secret', async () => {
  const creds = credentials();
  const tokenFail = harness(() => json({ message: `Unauthorized ${creds.clientSecret}`, error: 401 }, 401));
  const tokenResult = await createRedditClient(creds, { fetchImpl: tokenFail.fetchImpl, now: tokenFail.now, sleep: tokenFail.sleep }).probe();
  assert.equal(tokenResult.ok, false);
  if (!tokenResult.ok) {
    assert.equal(tokenResult.stage, 'token');
    assert.equal(tokenResult.status, 401);
    assert.ok(!tokenResult.reason.includes(creds.clientSecret));
    assert.ok(!tokenResult.reason.includes(creds.clientId));
  }

  const listingFail = harness((call) => (isToken(call) ? tokenResponse('tok') : json({ message: 'Forbidden' }, 403)));
  const listingResult = await createRedditClient(credentials(), { fetchImpl: listingFail.fetchImpl, now: listingFail.now, sleep: listingFail.sleep }).probe();
  assert.deepEqual(listingResult.ok === false ? [listingResult.stage, listingResult.status] : [], ['listing', 403]);

  const networkFail = harness(() => { throw new Error('getaddrinfo ENOTFOUND'); });
  const networkResult = await createRedditClient(credentials(), { fetchImpl: networkFail.fetchImpl, now: networkFail.now, sleep: networkFail.sleep }).probe();
  assert.equal(networkResult.ok === false ? networkResult.stage : 'ok', 'token');

  const missing = await probeReddit({});
  assert.deepEqual(missing.ok === false ? missing.stage : 'ok', 'credentials');
});

test('redditCredentialsFromResolver reads the reddit platform rows by lowercase key name', async () => {
  const asked: Array<[string, string]> = [];
  const rows: Record<string, string> = { client_id: ' id ', client_secret: 'secret', user_agent: 'ua/1.0' };
  const result = await redditCredentialsFromResolver(async (provider, keyName) => {
    asked.push([provider, keyName]);
    const value = rows[keyName];
    if (value === undefined) throw new Error(`no row ${keyName}`);
    return value;
  });
  assert.deepEqual(asked.sort(), [['reddit', 'client_id'], ['reddit', 'client_secret'], ['reddit', 'user_agent']]);
  assert.deepEqual(result, { clientId: 'id', clientSecret: 'secret', userAgent: 'ua/1.0' });
  assert.deepEqual(REDDIT_VAULT_KEYS, { provider: 'reddit', clientId: 'client_id', clientSecret: 'client_secret', userAgent: 'user_agent' });

  await assert.rejects(
    redditCredentialsFromResolver(async (_provider, keyName) => (keyName === 'user_agent' ? '' : 'x')),
    /user_agent/,
  );
});

test('posts carry isSelf, score, flair and the gating flags; comments carry score', async () => {
  const link = {
    ...POST,
    id: 'lnk1',
    is_self: false,
    url: 'https://example.com/article',
    score: 40,
    link_flair_text: 'Discussion',
    over_18: true,
    quarantine: true,
  };
  const self = { ...POST, is_self: true };
  const h = harness((call) => (isToken(call) ? tokenResponse('tok') : json(listing([link, self]))));
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await client.listSubreddit('technology', { sort: 'controversial', limit: 2 });

  const read = new URL(h.calls.at(-1)?.url ?? 'https://invalid.example');
  assert.equal(read.pathname, '/r/technology/controversial.json');
  const [first, second] = result.posts;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.isSelf, false);
  assert.equal(first.externalUrl, 'https://example.com/article');
  assert.equal(first.score, 40);
  assert.equal(first.ups, 42);
  assert.equal(first.linkFlairText, 'Discussion');
  assert.equal(first.over18, true);
  assert.equal(first.quarantine, true);
  assert.equal(second.isSelf, true);
  assert.equal(second.score, 42, 'score falls back to ups when Reddit omits it');
  assert.equal(second.linkFlairText, null);
  assert.equal(second.over18, false);
  assert.equal(second.quarantine, false);

  const thread = [
    listing([POST]),
    {
      kind: 'Listing',
      data: {
        children: [
          { kind: 't1', data: { id: 'c1', author: 'a', body: 'scored', ups: 9, score: 7, replies: '' } },
          { kind: 't1', data: { id: 'c2', author: 'b', body: 'unscored', ups: 4, replies: '' } },
        ],
      },
    },
  ];
  const t = harness((call) => (isToken(call) ? tokenResponse('tok') : json(thread)));
  const threadClient = createRedditClient(credentials(), { fetchImpl: t.fetchImpl, now: t.now, sleep: t.sleep });
  const fetched = await threadClient.fetchThread('https://www.reddit.com/r/AgingParents/comments/abc123/x/', { sort: 'top' });
  assert.equal(new URL(t.calls.at(-1)?.url ?? 'https://invalid.example').searchParams.get('sort'), 'top');
  assert.deepEqual(fetched.comments.map((c) => [c.id, c.score]), [['c1', 7], ['c2', 4]]);
});

test('fetchThread resolves redd.it short links to the post and refuses ones that name nothing', async () => {
  const h = harness((call) => (isToken(call) ? tokenResponse('tok') : json([listing([POST]), listing([])])));
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await client.fetchThread('https://redd.it/abc123?utm_source=share');
  const read = new URL(h.calls.at(-1)?.url ?? 'https://invalid.example');
  assert.equal(read.hostname, 'oauth.reddit.com');
  assert.equal(read.pathname, '/comments/abc123.json');
  assert.equal(read.searchParams.get('utm_source'), null);
  assert.equal(result.post.id, 'abc123');

  const none = harness(() => { throw new Error('no request may be made'); });
  const refusing = createRedditClient(credentials(), { fetchImpl: none.fetchImpl, now: none.now, sleep: none.sleep });
  for (const url of ['https://redd.it/', 'https://redd.it/abc/def', 'http://redd.it/abc123']) {
    await assert.rejects(
      refusing.fetchThread(url),
      (error: unknown) => error instanceof RedditApiError && error.stage === 'url',
      url,
    );
  }
  assert.equal(none.calls.length, 0);
});

test('5xx answers and network failures are retried with backoff, then surface the last status', async () => {
  let reads = 0;
  const h = harness((call) => {
    if (isToken(call)) return tokenResponse('tok');
    reads += 1;
    if (reads === 1) return json({ error: 'busy' }, 503);
    if (reads === 2) throw new TypeError('fetch failed');
    return json(listing([POST]));
  });
  const client = createRedditClient(credentials(), { fetchImpl: h.fetchImpl, now: h.now, sleep: h.sleep });
  const result = await client.listSubreddit('AgingParents', { sort: 'hot' });
  assert.equal(result.posts.length, 1);
  assert.equal(reads, 3);
  assert.ok(h.sleeps.includes(1_000) && h.sleeps.includes(2_000), `backoff sleeps: ${h.sleeps.join(',')}`);

  const down = harness((call) => (isToken(call) ? tokenResponse('tok') : json({ error: 'down' }, 502)));
  const failing = createRedditClient(credentials(), { fetchImpl: down.fetchImpl, now: down.now, sleep: down.sleep });
  await assert.rejects(
    failing.listSubreddit('AgingParents', { sort: 'hot' }),
    (error: unknown) => error instanceof RedditApiError && error.status === 502,
  );
  assert.equal(down.calls.filter((c) => !isToken(c)).length, 3);
});
