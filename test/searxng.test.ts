import assert from 'node:assert/strict';
import test from 'node:test';

import { searxngSearch } from '../src/providers/searxng.js';

test('SearXNG fails over when an instance returns HTTP 200 with no results', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrls = process.env.SEARXNG_URLS;
  process.env.SEARXNG_URLS = 'https://empty.example,https://healthy.example';

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
    const outcome = await searxngSearch('test query');
    assert.equal(outcome.success, true);
    assert.deepEqual(outcome.triedUrls, ['https://empty.example', 'https://healthy.example']);
    assert.equal(outcome.results[0]?.url, 'https://docs.example/');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrls === undefined) delete process.env.SEARXNG_URLS;
    else process.env.SEARXNG_URLS = originalUrls;
  }
});
