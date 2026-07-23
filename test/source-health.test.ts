import assert from 'node:assert/strict';
import test from 'node:test';

import { probePublicSourceHealth } from '../src/source-health.js';
import { SearchResultSchema } from '../src/types.js';
import type {
  ProviderName,
  SearchOpts,
  SearchProvider,
  SearchResult,
} from '../src/types.js';

const publicQuestion = 'How should Ora run durable agent work graphs?';

function mockResult(
  provider: ProviderName,
  index: number,
  backend: string,
  publishedAt = '2026-07-20T12:00:00.000Z',
): SearchResult {
  return SearchResultSchema.parse({
    provider,
    url: `https://example.com/${provider}/${index}`,
    title: `Result ${index}`,
    snippet: 'Offline fixture.',
    published_at: publishedAt,
    raw_metadata: { backend },
  });
}

function mockProvider(
  name: ProviderName,
  backend: string,
  results: SearchResult[],
  calls: Array<{ provider: ProviderName; query: string; options: SearchOpts }>,
): SearchProvider {
  return {
    name,
    enabled: true,
    capabilities: { search: true, fetch: true, extract: true, backends: [backend] },
    async search(query, options) {
      calls.push({ provider: name, query, options });
      return results;
    },
    async fetch() {
      throw new Error('source health must not fetch');
    },
    async extract() {
      throw new Error('source health must not extract');
    },
  };
}

test('public source health probes only selected lanes with bounded, metadata-only output', async () => {
  const calls: Array<{ provider: ProviderName; query: string; options: SearchOpts }> = [];
  const registry = {
    tavily: mockProvider(
      'tavily',
      'offline_web',
      [1, 2, 3, 4].map((index) => mockResult('tavily', index, 'offline_web')),
      calls,
    ),
    searxng: mockProvider(
      'searxng',
      'unused_backend',
      [mockResult('searxng', 1, 'unused_backend')],
      calls,
    ),
    x: mockProvider(
      'x',
      'offline_x',
      [1, 2].map((index) => mockResult('x', index, 'offline_x')),
      calls,
    ),
  };

  const report = await probePublicSourceHealth({
    question: publicQuestion,
    modes: ['web', 'x'],
    requiredProviders: ['tavily', 'x'],
    asOf: '2026-07-21',
    scopes: { x: { handles: ['openclaw'], maxPages: 10 } },
    limit: 100,
    maxPages: 10,
    timeoutMs: 60_000,
  }, { providerRegistry: registry });

  assert.deepEqual(calls.map((call) => call.provider).sort(), ['tavily', 'x']);
  assert.ok(!calls.some((call) => call.provider === 'searxng'));
  assert.ok(calls.every((call) => call.options.limit === 8));
  assert.ok(calls.every((call) => call.options.max_pages <= 2));
  assert.equal(calls.find((call) => call.provider === 'x')?.options.published_before,
    '2026-07-21T23:59:59.999Z');
  assert.deepEqual(calls.find((call) => call.provider === 'x')?.options.handles, ['openclaw']);

  assert.equal(report.overall.verdict, 'healthy');
  assert.equal(report.overall.ready, true);
  assert.equal(report.overall.healthy, true);
  assert.equal(report.overall.partial, false);
  assert.deepEqual(report.lanes.map((lane) => lane.backend), ['offline_web', 'offline_x']);
  assert.deepEqual(report.lanes.map((lane) => lane.resultCount), [4, 2]);
  assert.ok(report.lanes.every((lane) => /^[a-f0-9]{64}$/.test(lane.queryHash ?? '')));
  assert.ok(report.lanes.every((lane) => lane.newestPublishedAt === '2026-07-20T12:00:00.000Z'));

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /durable agent work graphs/i);
  assert.doesNotMatch(serialized, /implementation repository|agents loops graphs/i);
});

test('public source health returns sanitized partial failures without leaking errors or queries', async () => {
  const credential = 'sk-live-do-not-leak';
  const failingProvider: SearchProvider = {
    name: 'searxng',
    enabled: true,
    capabilities: { search: true, fetch: false, extract: false, backends: ['searxng'] },
    async search(query) {
      throw new Error(`${credential}: failed query ${query}`);
    },
  };

  const report = await probePublicSourceHealth({
    question: publicQuestion,
    modes: ['web', 'reddit'],
    requiredProviders: ['reddit'],
    asOf: '2026-07-21',
    timeoutMs: 50,
  }, { providerRegistry: { searxng: failingProvider } });

  assert.equal(report.overall.verdict, 'partial');
  assert.equal(report.overall.ready, false);
  assert.deepEqual(report.missingModes, ['reddit']);
  assert.deepEqual(report.missingRequiredProviders, ['reddit']);
  assert.equal(report.lanes.find((lane) => lane.mode === 'web')?.error?.code, 'provider_error');
  assert.equal(report.lanes.find((lane) => lane.mode === 'reddit')?.status, 'unavailable');

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(credential));
  assert.doesNotMatch(serialized, /durable agent work graphs/i);
  assert.doesNotMatch(serialized, /failed query/i);
});
