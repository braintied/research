import assert from 'node:assert/strict';
import test from 'node:test';

import { getResearchProfile } from '../src/profiles/registry.js';
import { domainMatchedPublicPackIds, runResearchProgram } from '../src/research-program.js';
import type { KindResearchResult } from '../src/kinds.js';
import { SearchResultSchema } from '../src/types.js';

function discoveryAt(url: string) {
  return SearchResultSchema.parse({
    provider: 'tavily',
    url,
    title: 'Example',
    snippet: '',
  });
}

const profile = getResearchProfile('web-design-intelligence@2');

test('planner-found award authority pages attribute to the award pack', () => {
  assert.deepEqual(
    domainMatchedPublicPackIds(discoveryAt('https://www.awwwards.com/sites/example'), profile),
    ['award-editorial-sources'],
  );
  assert.deepEqual(
    domainMatchedPublicPackIds(discoveryAt('https://godly.website/'), profile),
    ['award-editorial-sources'],
  );
});

test('host matching is domain-boundary exact, never a bare suffix', () => {
  assert.deepEqual(
    domainMatchedPublicPackIds(discoveryAt('https://awwwards.com.evil.example/x'), profile),
    [],
  );
  assert.deepEqual(
    domainMatchedPublicPackIds(discoveryAt('https://notawwwards.com/x'), profile),
    [],
  );
});

test('github discoveries attribute only to packs that still list github.com', () => {
  const matched = domainMatchedPublicPackIds(
    discoveryAt('https://github.com/braintied/research'),
    profile,
  );
  assert.ok(matched.includes('open-implementation-sources'));
  // 1.2.3: guidance dropped github.com so implementation owns native GitHub hosts.
  assert.equal(matched.includes('ai-design-guidance'), false);
});

test('non-URL discovery ids keep seed-only attribution', () => {
  assert.deepEqual(domainMatchedPublicPackIds(discoveryAt('urn:example:1'), profile), []);
});

// Provider-compatible attribution (0.11.3): host matching alone is not enough —
// a discovery only becomes pack evidence when it was acquired through one of the
// pack's declared providers. The release canary's per-pack provider whitelist
// rejected the 0.11.2 manifest with public_manifest_invalid (2026-07-27): a
// tavily-found github.com page attributed to the github-only v2 pack, and a
// github-native repository record attributed to the tavily/searxng-only guidance
// pack. These tests pin both directions at the evidence-assembly boundary.

const allProviders = ['tavily', 'searxng', 'github', 'hn', 'rss', 'podcasts'] as const;

function plannerDiscovery(provider: string, url: string, sourcePackIds: string[] = [], publishedAt = '2026-07-20T12:00:00.000Z') {
  return SearchResultSchema.parse({
    provider,
    url,
    title: 'Planner-found source',
    snippet: '',
    published_at: publishedAt,
    source_pack_ids: sourcePackIds,
    source_modes: [provider === 'github' ? 'github' : 'web'],
    raw_metadata: { backend: `${provider}_search` },
  });
}

async function evidencePackIdsFor(discovery: ReturnType<typeof plannerDiscovery>) {
  const result = await runResearchProgram({
    brief: 'Which resources should Parlor agents use to build exceptional websites?',
    asOf: '2026-07-22',
    profileRef: 'web-design-intelligence@2',
    availableProviders: [...allProviders],
    trustedAdapters: [{
      id: 'ora-cortex-braintied',
      modes: ['cortex', 'telegram'] as const,
      async recall() { return []; },
    }],
    publicRunner: async (): Promise<KindResearchResult> => ({
      kind: 'deep',
      engine: 'pipeline',
      report: {
        title: 'Public report',
        executive_summary: 'Public evidence.',
        full_markdown: '# Public report\n\nPublic evidence.',
        sections: [],
        bibliography: [],
        gaps: [],
        word_count: 4,
      },
      quotes: [],
      costUsd: 0,
      grounding: {
        ratio: 1,
        total_citations: 1,
        valid_citations: 1,
        hallucinated: [],
        status: 'validated',
        quality: 'strong',
        passed: true,
      },
      discoveries: [discovery],
      validatedEvidence: [{
        source_url: discovery.url,
        content: 'A complete validated source sentence with factual evidence.',
        kind: 'verbatim_quote',
      }],
    }),
  });
  return result.publicEvidence;
}

test('tavily-found github.com page is not attributed to the github-only v2 pack', async () => {
  const evidence = await evidencePackIdsFor(
    plannerDiscovery('tavily', 'https://github.com/braintied/research'),
  );
  // v2 open-implementation is github-provider-only; guidance no longer lists
  // github.com (implementation owns that host). Tavily on github.com is dropped.
  assert.deepEqual(evidence.map((item) => item.sourcePackId), []);
});

test('github-native repository record is not attributed to the web-only guidance pack', async () => {
  const evidence = await evidencePackIdsFor(
    plannerDiscovery('github', 'https://github.com/braintied/research'),
  );
  assert.deepEqual(
    evidence.map((item) => item.sourcePackId),
    ['open-implementation-sources'],
  );
  assert.equal(evidence[0]?.provider, 'github');
  assert.equal(evidence[0]?.lane, 'developer_github');
});

test('seed-listed provider-incompatible attribution is dropped at assembly', async () => {
  const evidence = await evidencePackIdsFor(
    plannerDiscovery('tavily', 'https://github.com/braintied/research', ['open-implementation-sources']),
  );
  // Seed claims open-implementation but tavily is not a declared provider for
  // that pack, and github.com is no longer domain-matched to guidance.
  assert.deepEqual(evidence.map((item) => item.sourcePackId), []);
});

test('provider-compatible domain-matched attribution still lands', async () => {
  const evidence = await evidencePackIdsFor(
    plannerDiscovery('tavily', 'https://www.anthropic.com/engineering/design'),
  );
  assert.deepEqual(
    evidence.map((item) => item.sourcePackId),
    ['ai-design-guidance'],
  );
  assert.equal(evidence[0]?.provider, 'tavily');
});

// Snapshot as-of boundary (0.11.3): a profile program assembles the evidence
// ledger as of its date boundary. Providers enforce published_before only when
// the subquery carries it — planner queries do not — so a planner-found
// repository stamped with a post-as-of pushed_at would otherwise enter the
// manifest and trip the canary's publishedAt check (public_manifest_invalid,
// 2026-07-27). Assembly enforces the boundary once, for every path.

test('evidence dated after the as-of boundary never enters the ledger', async () => {
  const evidence = await evidencePackIdsFor(
    plannerDiscovery('github', 'https://github.com/braintied/research', [], '2026-07-26T14:46:19.000Z'),
  );
  assert.deepEqual(evidence, []);
});

test('evidence dated exactly at the as-of boundary is kept', async () => {
  const evidence = await evidencePackIdsFor(
    plannerDiscovery('github', 'https://github.com/braintied/research', [], '2026-07-22T23:59:59.999Z'),
  );
  assert.deepEqual(
    evidence.map((item) => item.sourcePackId),
    ['open-implementation-sources'],
  );
});

test('HN seed discoveries become pack evidence from title+snippet without re-fetch', async () => {
  const discovery = SearchResultSchema.parse({
    provider: 'hn',
    url: 'https://news.ycombinator.com/item?id=42424242',
    title: 'AI websites all look the same now',
    snippet: 'Practitioner thread on generic AI aesthetics and design systems.',
    published_at: '2026-07-10T12:00:00.000Z',
    source_pack_ids: ['design-practitioner-signal'],
    source_modes: ['community'],
    raw_metadata: { backend: 'hn_search' },
  });
  const result = await runResearchProgram({
    brief: 'Which resources should Parlor agents use to build exceptional websites?',
    asOf: '2026-07-22',
    profileRef: 'web-design-intelligence@2',
    availableProviders: [...allProviders],
    trustedAdapters: [{
      id: 'ora-cortex-braintied',
      modes: ['cortex', 'telegram'] as const,
      async recall() { return []; },
    }],
    publicRunner: async (): Promise<KindResearchResult> => ({
      kind: 'deep',
      engine: 'pipeline',
      report: {
        title: 'Public report',
        executive_summary: 'Public evidence.',
        full_markdown: '# Public report\n\nPublic evidence.',
        sections: [],
        bibliography: [],
        gaps: [],
        word_count: 4,
      },
      quotes: [],
      costUsd: 0,
      grounding: {
        ratio: 1,
        total_citations: 1,
        valid_citations: 1,
        hallucinated: [],
        status: 'validated',
        quality: 'strong',
        passed: true,
      },
      // No validatedEvidence — the re-fetch path is empty on purpose.
      discoveries: [discovery],
      validatedEvidence: [],
    }),
  });
  assert.equal(result.publicEvidence.length, 1);
  assert.equal(result.publicEvidence[0]?.sourcePackId, 'design-practitioner-signal');
  assert.equal(result.publicEvidence[0]?.provider, 'hn');
  assert.equal(result.publicEvidence[0]?.metadata['validation'], 'provider_native_discovery');
});

test('github-native repository discoveries become pack evidence without HTML extract', async () => {
  // 2026-08-04 canary: implementation-coverage at 0e/0s while REST search
  // returned repos — github.com SPA extract empties, so title+description
  // must admit as provider-native for open-implementation-sources.
  const discovery = SearchResultSchema.parse({
    provider: 'github',
    url: 'https://github.com/public-owner/design-system',
    title: 'public-owner/design-system',
    snippet: 'Accessible React design system with Storybook tokens and license.',
    published_at: '2026-07-10T12:00:00.000Z',
    source_pack_ids: ['open-implementation-sources'],
    source_modes: ['github'],
    raw_metadata: {
      backend: 'github_rest_api',
      visibility_attestation: 'github-public-rest-v2',
      result_kind: 'repository',
    },
  });
  const result = await runResearchProgram({
    brief: 'Which resources should Parlor agents use to build exceptional websites?',
    asOf: '2026-07-22',
    profileRef: 'web-design-intelligence@2',
    availableProviders: [...allProviders],
    trustedAdapters: [{
      id: 'ora-cortex-braintied',
      modes: ['cortex', 'telegram'] as const,
      async recall() { return []; },
    }],
    publicRunner: async (): Promise<KindResearchResult> => ({
      kind: 'deep',
      engine: 'pipeline',
      report: {
        title: 'Public report',
        executive_summary: 'Public evidence.',
        full_markdown: '# Public report\n\nPublic evidence.',
        sections: [],
        bibliography: [],
        gaps: [],
        word_count: 4,
      },
      quotes: [],
      costUsd: 0,
      grounding: {
        ratio: 1,
        total_citations: 1,
        valid_citations: 1,
        hallucinated: [],
        status: 'validated',
        quality: 'strong',
        passed: true,
      },
      discoveries: [discovery],
      validatedEvidence: [],
    }),
  });
  assert.equal(result.publicEvidence.length, 1);
  assert.equal(result.publicEvidence[0]?.sourcePackId, 'open-implementation-sources');
  assert.equal(result.publicEvidence[0]?.provider, 'github');
  assert.equal(result.publicEvidence[0]?.lane, 'developer_github');
  assert.equal(result.publicEvidence[0]?.metadata['validation'], 'provider_native_discovery');
});

test('tavily discovery with empty extract still becomes pack evidence via provider-native path', async () => {
  // webaim.org is guidance-only (not practitioner/award), so domain match is exact.
  const discovery = SearchResultSchema.parse({
    provider: 'tavily',
    url: 'https://webaim.org/articles/accessible',
    title: 'Accessible design patterns',
    snippet: 'Accessible design patterns for responsive websites and evaluation harnesses.',
    published_at: '2026-07-10T12:00:00.000Z',
    source_pack_ids: ['ai-design-guidance'],
    source_modes: ['web'],
    raw_metadata: { backend: 'tavily_search' },
  });
  const result = await runResearchProgram({
    brief: 'Which resources should Parlor agents use to build exceptional websites?',
    asOf: '2026-07-22',
    profileRef: 'web-design-intelligence@2',
    availableProviders: [...allProviders],
    trustedAdapters: [{
      id: 'ora-cortex-braintied',
      modes: ['cortex', 'telegram'] as const,
      async recall() { return []; },
    }],
    publicRunner: async (): Promise<KindResearchResult> => ({
      kind: 'deep',
      engine: 'pipeline',
      report: {
        title: 'Public report',
        executive_summary: 'Public evidence.',
        full_markdown: '# Public report\n\nPublic evidence.',
        sections: [],
        bibliography: [],
        gaps: [],
        word_count: 4,
      },
      quotes: [],
      costUsd: 0,
      grounding: {
        ratio: 1,
        total_citations: 1,
        valid_citations: 1,
        hallucinated: [],
        status: 'validated',
        quality: 'strong',
        passed: true,
      },
      discoveries: [discovery],
      validatedEvidence: [],
    }),
  });
  assert.equal(result.publicEvidence.length, 1);
  assert.equal(result.publicEvidence[0]?.sourcePackId, 'ai-design-guidance');
  assert.equal(result.publicEvidence[0]?.provider, 'tavily');
  assert.equal(result.publicEvidence[0]?.metadata['validation'], 'provider_native_discovery');
});
