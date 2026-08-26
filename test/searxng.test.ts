import assert from 'node:assert/strict';
import test from 'node:test';

import { searxngSearch, searxngEnginesParam } from '../src/providers/searxng.js';
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
