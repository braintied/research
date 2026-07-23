import assert from 'node:assert/strict';
import test from 'node:test';

import { scrapeDataset } from '../src/providers/brightdata.js';

test('Bright Data scrape follows an accepted asynchronous snapshot to records', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.BRIGHTDATA_API_TOKEN;
  process.env.BRIGHTDATA_API_TOKEN = 'brightdata-test-token';
  const calls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer brightdata-test-token');
    if (url.includes('/scrape?')) {
      assert.deepEqual(JSON.parse(String(init?.body)), [{ url: 'https://example.com/video' }]);
      return Response.json({ snapshot_id: 'snapshot-async-1' }, { status: 202 });
    }
    if (url.includes('/progress/')) return Response.json({ status: 'ready' });
    if (url.includes('/snapshot/')) {
      return Response.json([{ url: 'https://example.com/video', title: 'Collected record' }]);
    }
    throw new Error(`Unexpected test URL: ${url}`);
  }) as typeof fetch;

  try {
    const records = await scrapeDataset(
      'dataset-test',
      [{ url: 'https://example.com/video' }],
      { initialIntervalMs: 1, maxIntervalMs: 1, maxWaitMs: 100 },
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]?.title, 'Collected record');
    assert.deepEqual(calls.map((url) => new URL(url).pathname), [
      '/datasets/v3/scrape',
      '/datasets/v3/progress/snapshot-async-1',
      '/datasets/v3/snapshot/snapshot-async-1',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.BRIGHTDATA_API_TOKEN;
    else process.env.BRIGHTDATA_API_TOKEN = originalToken;
  }
});

test('Bright Data scrape preserves immediate record responses', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.BRIGHTDATA_API_TOKEN;
  process.env.BRIGHTDATA_API_TOKEN = 'brightdata-test-token';
  globalThis.fetch = (async () => Response.json([
    { url: 'https://example.com/immediate', title: 'Immediate record' },
  ])) as typeof fetch;

  try {
    const records = await scrapeDataset('dataset-test', [{ url: 'https://example.com/immediate' }]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.title, 'Immediate record');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.BRIGHTDATA_API_TOKEN;
    else process.env.BRIGHTDATA_API_TOKEN = originalToken;
  }
});
