import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { crawlUrl, crawlUrlDetailed } from '../src/pipeline-core.js';
import { CRAWL4AI_NETWORK_GUARD_VALUE, type ResearchCredentials } from '../src/credentials.js';

// An IP-literal target skips DNS resolution inside the SSRF guard, so these
// tests never depend on a resolver.
const TARGET = 'http://93.184.216.34/';
// Reserved by RFC 2606: never resolves, online or offline, so the direct-fetch
// lane fails without a socket ever being opened.
const UNRESOLVABLE = 'http://nonexistent.invalid/';

const CRAWL_OK: ResearchCredentials = {
  crawl4ai: {
    baseUrl: 'https://scraper.example',
    allowedDomains: ['*'],
    networkGuard: CRAWL4AI_NETWORK_GUARD_VALUE,
  },
};

function crawlResponse(markdown: string): Response {
  // The real Crawl4AI 0.8.9 wire shape, measured against ora-scraper on
  // 2026-08-16: the served URL lives at top level (`redirected_url`,
  // falling back to the requested `url`), `status_code` is top-level,
  // `metadata` carries title/description/keywords only, and `markdown`
  // is a dict. Older revisions put the served URL in `metadata.url`.
  return new Response(
    JSON.stringify({
      success: true,
      results: [{
        markdown: {
          raw_markdown: markdown,
          markdown_with_citations: markdown,
          references_markdown: '',
          fit_markdown: '',
        },
        url: TARGET,
        redirected_url: TARGET,
        status_code: 200,
        metadata: { title: 'Example Domain' },
      }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const FAT_HTML = `<html><head><title>Example</title></head><body><p>${'lorem ipsum dolor sit amet '.repeat(40)}</p></body></html>`;

type HttpRequest = typeof http.request;

function blockSockets(): () => void {
  const originalRequest = http.request;
  const fake = (() => {
    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error?: Error) => void;
      write: () => boolean;
      setTimeout: () => void;
    };
    request.end = () => {
      process.nextTick(() => request.emit('error', new Error('test-blocked socket')));
    };
    request.destroy = () => undefined;
    request.write = () => true;
    request.setTimeout = () => undefined;
    return request;
  }) as unknown as HttpRequest;
  http.request = fake;
  return () => {
    http.request = originalRequest;
  };
}

function serveSockets(html: string): () => void {
  const originalRequest = http.request;
  const fake = ((_options: unknown, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error?: Error) => void;
      write: () => boolean;
      setTimeout: () => void;
    };
    request.end = () => {
      process.nextTick(() => {
        const response = new EventEmitter() as EventEmitter & {
          headers: Record<string, string>;
          statusCode: number;
          destroy: () => void;
        };
        response.headers = { 'content-type': 'text/html' };
        response.statusCode = 200;
        response.destroy = () => undefined;
        callback(response);
        response.emit('data', Buffer.from(html));
        response.emit('end');
      });
    };
    request.destroy = () => undefined;
    request.write = () => true;
    request.setTimeout = () => undefined;
    return request;
  }) as unknown as HttpRequest;
  http.request = fake;
  return () => {
    http.request = originalRequest;
  };
}

test('a served crawl reports method crawl4ai and no decline reason', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return crawlResponse('x'.repeat(500));
  }) as typeof fetch;
  try {
    const result = await crawlUrlDetailed(CRAWL_OK, TARGET);
    assert.equal(result.method, 'crawl4ai');
    assert.equal(result.text, 'x'.repeat(500));
    assert.equal(result.declinedReason, undefined);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a legacy response with the served URL only in metadata.url still matches', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      success: true,
      results: [{ markdown: 'w'.repeat(500), metadata: { url: TARGET, statusCode: 200 } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  try {
    const result = await crawlUrlDetailed(CRAWL_OK, TARGET);
    assert.equal(result.method, 'crawl4ai');
    assert.equal(result.text, 'w'.repeat(500));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a crawl redirected to a different host is refused as target_mismatch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      success: true,
      results: [{
        markdown: {
          raw_markdown: 'v'.repeat(500),
          markdown_with_citations: '',
          references_markdown: '',
          fit_markdown: '',
        },
        url: TARGET,
        // A public IP literal on another host: the hostname comparison, not a
        // public-IP refusal, is what must reject this.
        redirected_url: 'http://1.1.1.1/',
        status_code: 200,
        metadata: {},
      }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  const restoreSockets = blockSockets();
  try {
    const result = await crawlUrlDetailed(CRAWL_OK, TARGET);
    assert.equal(result.text, null);
    assert.equal(result.method, null);
    assert.equal(result.declinedReason, 'target_mismatch');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSockets();
  }
});

test('an unconfigured crawl lane is reported by name when nothing else serves', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error('unexpected request');
  }) as typeof fetch;
  try {
    const result = await crawlUrlDetailed({}, UNRESOLVABLE);
    assert.equal(result.text, null);
    assert.equal(result.method, null);
    assert.equal(result.declinedReason, 'not_configured');
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an unenforced network guard is reported by name', async () => {
  const unacknowledged: ResearchCredentials = {
    crawl4ai: { baseUrl: 'https://scraper.example', allowedDomains: ['*'], networkGuard: '' },
  };
  const result = await crawlUrlDetailed(unacknowledged, UNRESOLVABLE);
  assert.equal(result.method, null);
  assert.equal(result.declinedReason, 'network_guard_not_enforced');
});

test('crawl content under the orchestrator floor is content_too_short, not a crawl success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => crawlResponse('y'.repeat(150))) as typeof fetch;
  const restoreSockets = blockSockets();
  try {
    const result = await crawlUrlDetailed(CRAWL_OK, TARGET);
    assert.equal(result.text, null);
    assert.equal(result.method, null);
    assert.equal(result.declinedReason, 'content_too_short');
  } finally {
    globalThis.fetch = originalFetch;
    restoreSockets();
  }
});

test('a served fallback names method direct_fetch with the primary lane decline attached', async () => {
  const restoreSockets = serveSockets(FAT_HTML);
  try {
    const result = await crawlUrlDetailed({}, TARGET);
    assert.equal(result.method, 'direct_fetch');
    assert.equal(result.declinedReason, 'not_configured');
    assert.ok(result.text !== null && result.text.includes('lorem ipsum'));
  } finally {
    restoreSockets();
  }
});

test('crawlUrl keeps its exact legacy contract over the detailed lane', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => crawlResponse('z'.repeat(500))) as typeof fetch;
  try {
    assert.equal(await crawlUrl(CRAWL_OK, TARGET), 'z'.repeat(500));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(await crawlUrl({}, UNRESOLVABLE), null);
});
