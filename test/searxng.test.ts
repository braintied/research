import assert from 'node:assert/strict';
import test from 'node:test';

import {
  searxngSearch,
  searxngEnginesParam,
  resetSearxngDeadInstanceMemoryForTests,
  resetSearxngRoundRobinForTests,
} from '../src/providers/searxng.js';
import type { ResearchCredentials } from '../src/credentials.js';

test('SearXNG fails over when an instance returns HTTP 200 with no results', async () => {
  const originalFetch = globalThis.fetch;
  const credentials: ResearchCredentials = {
    searxngUrls: ['https://empty.example', 'https://healthy.example'],
  };

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'empty.example') {
      return Response.json({ results: [], unresponsive_engines: [['duckduckgo', 'CAPTCHA']] });
    }
    return Response.json({
      results: [{ title: 'Official documentation', url: 'https://docs.example/', content: 'Primary source' }],
    });
  }) as typeof fetch;

  try {
    const outcome = await searxngSearch(credentials, 'test query');
    assert.equal(outcome.success, true);
    assert.deepEqual(outcome.triedUrls, ['https://empty.example', 'https://healthy.example']);
    assert.equal(outcome.results[0]?.url, 'https://docs.example/');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxngEnginesParam drops junk and joins unique names', () => {
  assert.equal(searxngEnginesParam(undefined), undefined);
  assert.equal(searxngEnginesParam([]), undefined);
  assert.equal(searxngEnginesParam(['YOUTUBE', 'youtube', 'reddit!', 'reddit']), 'youtube,reddit');
});

test('SearXNG search passes engines= into the request URL', async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  const credentials: ResearchCredentials = {
    searxngUrls: ['https://searx.example'],
  };

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    seen.push(url.searchParams.get('engines') ?? '');
    return Response.json({
      results: [{ title: 'A thread', url: 'https://www.reddit.com/r/x/comments/1', content: 'post' }],
    });
  }) as typeof fetch;

  try {
    const outcome = await searxngSearch(credentials, 'first burn', { engines: ['reddit'] });
    assert.equal(outcome.success, true);
    assert.deepEqual(seen, ['reddit']);
    assert.equal(outcome.results[0]?.url, 'https://www.reddit.com/r/x/comments/1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a transport failure marks the instance dead so the NEXT query skips it', async () => {
  const originalFetch = globalThis.fetch;
  resetSearxngDeadInstanceMemoryForTests();
  resetSearxngRoundRobinForTests();
  const credentials: ResearchCredentials = {
    searxngUrls: ['https://dead.example', 'https://healthy.example'],
  };
  const requestedHosts: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    requestedHosts.push(url.hostname);
    if (url.hostname === 'dead.example') {
      throw new Error('fetch failed: connection refused');
    }
    return Response.json({
      results: [{ title: 'Reachable', url: 'https://docs.example/', content: 'ok' }],
    });
  }) as typeof fetch;

  try {
    // First query: dead.example is tried (and fails), then falls over to healthy.example.
    const first = await searxngSearch(credentials, 'first query');
    assert.equal(first.success, true);
    assert.deepEqual(first.triedUrls, ['https://dead.example', 'https://healthy.example']);
    assert.deepEqual(requestedHosts, ['dead.example', 'healthy.example']);

    // Second query: dead.example must be skipped entirely — no second wasted
    // round trip to a host already known unreachable in this process.
    requestedHosts.length = 0;
    const second = await searxngSearch(credentials, 'second query');
    assert.equal(second.success, true);
    assert.deepEqual(second.triedUrls, ['https://healthy.example']);
    assert.deepEqual(requestedHosts, ['healthy.example']);

    // Third query: round-robin makes dead.example the PRIMARY pick again
    // (idx cycles 0,1,0). It must still be skipped — proving the skip is the
    // dead-instance memory, not an accident of round-robin ordering.
    requestedHosts.length = 0;
    const third = await searxngSearch(credentials, 'third query');
    assert.equal(third.success, true);
    assert.deepEqual(third.triedUrls, ['https://healthy.example']);
    assert.deepEqual(requestedHosts, ['healthy.example']);
  } finally {
    globalThis.fetch = originalFetch;
    resetSearxngDeadInstanceMemoryForTests();
  }
});

test('an empty-but-200 instance is a content signal, not reachability — it stays eligible', async () => {
  const originalFetch = globalThis.fetch;
  resetSearxngDeadInstanceMemoryForTests();
  resetSearxngRoundRobinForTests();
  const credentials: ResearchCredentials = {
    searxngUrls: ['https://empty.example', 'https://healthy.example'],
  };
  const requestedHosts: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    requestedHosts.push(url.hostname);
    if (url.hostname === 'empty.example') {
      return Response.json({ results: [] });
    }
    return Response.json({
      results: [{ title: 'Reachable', url: 'https://docs.example/', content: 'ok' }],
    });
  }) as typeof fetch;

  try {
    // Round-robin alternates the primary pick between calls (empty.example,
    // then healthy.example), so the third call is the first one where
    // empty.example is primary again — the one that actually proves whether
    // it got marked dead by the first call's empty result.
    await searxngSearch(credentials, 'first query');
    await searxngSearch(credentials, 'second query');
    requestedHosts.length = 0;
    const third = await searxngSearch(credentials, 'third query');
    // empty.example is still tried — an empty result set never marks an
    // instance dead, only a transport failure does.
    assert.deepEqual(third.triedUrls, ['https://empty.example', 'https://healthy.example']);
    assert.deepEqual(requestedHosts, ['empty.example', 'healthy.example']);
  } finally {
    globalThis.fetch = originalFetch;
    resetSearxngDeadInstanceMemoryForTests();
  }
});

test('when every instance is marked dead, all are still tried rather than none', async () => {
  const originalFetch = globalThis.fetch;
  resetSearxngDeadInstanceMemoryForTests();
  resetSearxngRoundRobinForTests();
  const credentials: ResearchCredentials = {
    searxngUrls: ['https://dead-a.example', 'https://dead-b.example'],
  };
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('fetch failed: connection refused');
  }) as typeof fetch;

  try {
    const first = await searxngSearch(credentials, 'first query');
    assert.equal(first.success, false);
    assert.equal(calls, 2);

    calls = 0;
    const second = await searxngSearch(credentials, 'second query');
    assert.equal(second.success, false);
    // Both instances are marked dead by now, but the fallback must still try
    // all of them — a total outage is observed, not silently short-circuited.
    assert.equal(calls, 2);
    assert.equal(second.triedUrls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetSearxngDeadInstanceMemoryForTests();
  }
});
