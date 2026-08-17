import assert from 'node:assert/strict';
import test from 'node:test';

import {
  crawlWithCrawl4AI,
  fetchWithRetry,
} from '../src/pipeline-core.js';
import { CRAWL4AI_NETWORK_GUARD_VALUE, type ResearchCredentials } from '../src/credentials.js';

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
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error('unexpected request');
  }) as typeof fetch;

  // Three refusals, none of which may reach the network: no crawler config at
  // all, a config whose egress acknowledgement is absent, and one carrying a
  // stale acknowledgement value.
  const unconfigured: ResearchCredentials = {};
  const unacknowledged: ResearchCredentials = {
    crawl4ai: { baseUrl: 'https://scraper.example', allowedDomains: ['example.com'], networkGuard: '' },
  };
  const staleAcknowledgement: ResearchCredentials = {
    crawl4ai: {
      baseUrl: 'https://scraper.example',
      allowedDomains: ['example.com'],
      networkGuard: 'enforced-v0',
    },
  };

  try {
    assert.equal(await crawlWithCrawl4AI(unconfigured, 'https://example.com/'), null);
    assert.equal(await crawlWithCrawl4AI(unacknowledged, 'https://example.com/'), null);
    assert.equal(await crawlWithCrawl4AI(staleAcknowledgement, 'https://example.com/'), null);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an acknowledged crawler still refuses a host outside the reviewed allowlist', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error('unexpected request');
  }) as typeof fetch;

  const credentials: ResearchCredentials = {
    crawl4ai: {
      baseUrl: 'https://scraper.example',
      allowedDomains: ['allowed.example'],
      networkGuard: CRAWL4AI_NETWORK_GUARD_VALUE,
    },
  };

  try {
    assert.equal(await crawlWithCrawl4AI(credentials, 'https://denied.example/'), null);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// An IP-literal target skips DNS inside resolvePublicHttpUrl, so the positive
// path can be asserted without network access.
test("a bare '*' allowlist entry is the explicit open-web opt-in", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(
      JSON.stringify({
        success: true,
        results: [{
          markdown: 'x'.repeat(500),
          metadata: { url: 'http://93.184.216.34/', statusCode: 200 },
        }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const credentials: ResearchCredentials = {
    crawl4ai: {
      baseUrl: 'https://scraper.example',
      allowedDomains: ['*'],
      networkGuard: CRAWL4AI_NETWORK_GUARD_VALUE,
    },
  };

  try {
    const markdown = await crawlWithCrawl4AI(credentials, 'http://93.184.216.34/');
    assert.equal(markdown, 'x'.repeat(500));
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a bare '*' allowlist entry does not weaken the network guard", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error('unexpected request');
  }) as typeof fetch;

  const credentials: ResearchCredentials = {
    crawl4ai: {
      baseUrl: 'https://scraper.example',
      allowedDomains: ['*'],
      networkGuard: '',
    },
  };

  try {
    assert.equal(await crawlWithCrawl4AI(credentials, 'http://93.184.216.34/'), null);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
