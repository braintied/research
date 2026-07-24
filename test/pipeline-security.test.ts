import assert from 'node:assert/strict';
import test from 'node:test';

import {
  crawlWithCrawl4AI,
  fetchWithRetry,
} from '../src/pipeline-core.js';

test('retryable responses are cancelled before the next request', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let cancellations = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1;
      },
    });
    return new Response(stream, { status: 503 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      fetchWithRetry('https://fixed-provider.example/api', {}, 2, 0),
      /Request failed after 2 retries/,
    );
    assert.equal(requests, 2);
    assert.equal(cancellations, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('external browser crawling is disabled before any network request by default', async () => {
  const originalFetch = globalThis.fetch;
  const previousGuard = process.env.BRAINTIED_CRAWL4AI_NETWORK_GUARD;
  let requests = 0;
  delete process.env.BRAINTIED_CRAWL4AI_NETWORK_GUARD;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error('unexpected request');
  }) as typeof fetch;

  try {
    assert.equal(await crawlWithCrawl4AI('https://example.com/'), null);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousGuard === undefined) delete process.env.BRAINTIED_CRAWL4AI_NETWORK_GUARD;
    else process.env.BRAINTIED_CRAWL4AI_NETWORK_GUARD = previousGuard;
  }
});
