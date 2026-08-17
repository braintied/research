import assert from 'node:assert/strict';
import test from 'node:test';

import { scrapeDataset, unlockUrl } from '../src/providers/brightdata.js';
import { MissingCredentialError, type ResearchCredentials } from '../src/credentials.js';

const credentials: ResearchCredentials = {
  brightdata: { apiToken: 'brightdata-test-token' },  // git-secret-allow: fake fixture value, never a live credential
};

test('Bright Data scrape follows an accepted asynchronous snapshot to records', async () => {
  const originalFetch = globalThis.fetch;
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
      credentials,
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
  }
});

test('Bright Data scrape preserves immediate record responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([
    { url: 'https://example.com/immediate', title: 'Immediate record' },
  ])) as typeof fetch;

  try {
    const records = await scrapeDataset(credentials, 'dataset-test', [{ url: 'https://example.com/immediate' }]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.title, 'Immediate record');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Web Unlocker refuses a token with no zone', async () => {
  await assert.rejects(
    () => unlockUrl(credentials, 'https://aeon.co/essays/example'),
    (error: unknown) => error instanceof MissingCredentialError
      && error.field === 'brightdata.unlockerZone',
  );
});

test('Web Unlocker POSTs /request and returns raw HTML', async () => {
  const originalFetch = globalThis.fetch;
  const html = '<html><article><p>Unlocked essay body long enough to keep.</p></article></html>';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.brightdata.com/request');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer brightdata-test-token');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      zone: 'web_unlocker1',
      url: 'https://aeon.co/essays/example',
      format: 'raw',
      country: 'us',
      render: 'true',
    });
    return new Response(html, { status: 200 });
  }) as typeof fetch;

  try {
    const page = await unlockUrl(
      { brightdata: { apiToken: 'brightdata-test-token', unlockerZone: 'web_unlocker1' } },  // git-secret-allow: fake fixture value, never a live credential
      'https://aeon.co/essays/example',
      { render: true },
    );
    assert.equal(page.html, html);
    assert.equal(page.url, 'https://aeon.co/essays/example');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
