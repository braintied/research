import assert from 'node:assert/strict';
import test from 'node:test';

import { ingestSource } from '../src/ingestion/ingest-source.js';
import type { ResearchCredentials } from '../src/credentials.js';
import type { KnowledgeSource } from '../src/ingestion/types.js';

test('web_search uses SearXNG when URLs are configured, even if a Tavily key is present', async () => {
  const originalFetch = globalThis.fetch;
  let searxCalls = 0;
  let tavilyCalls = 0;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(href);
    if (url.hostname === 'searx.example') {
      searxCalls += 1;
      return Response.json({
        results: [{
          title: 'First burn',
          url: 'https://www.reddit.com/r/BurningMan/comments/abc/first_burn/',
          content: 'Baker Beach',
        }],
      });
    }
    if (url.hostname.includes('tavily')) {
      tavilyCalls += 1;
      return Response.json({ results: [] });
    }
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;

  const credentials: ResearchCredentials = {
    searxngUrls: ['https://searx.example'],
    tavilyApiKey: 'disabled-for-test', // git-secret-allow: fixture proving Tavily is not called
  };
  const source: KnowledgeSource = {
    id: 'src-1',
    workspaceId: 'ws-1',
    sourceType: 'web_search',
    identifier: 'burning man first burn',
    label: null,
    topics: [],
    isActive: true,
    pollIntervalHours: 24,
    lastPolledAt: null,
    config: {},
  };

  try {
    const result = await ingestSource(credentials, source, { maxItems: 5, recencyDays: 0 });
    assert.equal(result.error, null);
    assert.ok(searxCalls > 0, 'SearXNG must run');
    assert.equal(tavilyCalls, 0);
    assert.equal(result.costUsd, 0);
    assert.equal(result.items.length > 0, true);
    assert.equal(
      result.items[0]?.url,
      'https://www.reddit.com/r/BurningMan/comments/abc/first_burn/',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
