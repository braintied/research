import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceIdentity, EvidenceItemSchema } from '../src/evidence.js';
import { providersForSubquery } from '../src/index.js';
import { compileProfileExecution } from '../src/profiles/registry.js';
import { runResearchProgram, SourcePlanUnavailableError } from '../src/research-program.js';
import {
  evaluateSourceModeCoverage,
  resolveSourceExecutionPlan,
  type TrustedSourceMode,
} from '../src/source-modes.js';
import { SearchResultSchema } from '../src/types.js';
import type { KindResearchResult, RunResearchInput } from '../src/kinds.js';

const question = 'How should Ora evolve long-running agent loops into observable work graphs?';
const coreProviders = ['tavily', 'x', 'reddit', 'youtube', 'github', 'hn'] as const;

test('all_public compiles to deterministic core searches and never exposes Crawl4AI as search', () => {
  const plan = resolveSourceExecutionPlan({
    question,
    modes: ['all_public'],
    availableProviders: [...coreProviders],
    requiredProviders: ['tavily'],
    asOf: '2026-07-21',
  });

  assert.equal(plan.ready, true);
  assert.deepEqual(plan.publicModes, ['web', 'x', 'reddit', 'youtube', 'github', 'community']);
  assert.equal(plan.seededSubqueries.length, 6);
  assert.ok(plan.seededSubqueries.every((subquery) => subquery.required));
  assert.ok(plan.seededSubqueries.every((subquery) => subquery.search_options.published_before === '2026-07-21T23:59:59.999Z'));
  assert.ok(!plan.providerAllowlist.includes('crawl4ai'));
  assert.deepEqual(plan.seededSubqueries.find((subquery) => subquery.source_mode === 'web')?.providers, ['tavily']);
});

test('source plan fails closed when one requested native lane is unavailable', () => {
  const plan = resolveSourceExecutionPlan({
    question,
    modes: ['web', 'x', 'reddit'],
    availableProviders: ['tavily', 'reddit'],
    asOf: '2026-07-21',
  });
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.missingModes, ['x']);
});

test('source plan normalizes an explicit timezone as-of boundary exactly', () => {
  const plan = resolveSourceExecutionPlan({
    question,
    modes: ['web'],
    availableProviders: ['tavily'],
    asOf: '2026-07-21T23:59:59-07:00',
  });
  assert.equal(
    plan.seededSubqueries[0]?.search_options.published_before,
    '2026-07-22T06:59:59.000Z',
  );
});

test('Ora profile source packs compile into executable searches with separate trusted packs', () => {
  const compiled = compileProfileExecution(
    'ora-agent-runtime@1',
    { question, asOf: '2026-07-21' },
    [...coreProviders, 'searxng', 'rss', 'podcasts'],
  );
  const packIds = new Set(compiled.seedSubqueries.map((subquery) => subquery.source_pack_id));
  assert.ok(packIds.has('official-runtime-docs'));
  assert.ok(packIds.has('youtube-practitioner-signal'));
  assert.ok(packIds.has('github-implementation-evidence'));
  assert.equal(compiled.trustedPacksByMode.cortex?.[0]?.id, 'ora-cortex-prior');
  assert.equal(compiled.trustedPacksByMode.telegram?.[0]?.id, 'braintied-telegram-prior');
  assert.ok(compiled.seedSubqueries.every((subquery) => !subquery.providers.includes('crawl4ai')));
});

test('profile query hints merge into one stable synthesis section per source pack', () => {
  const compiled = compileProfileExecution(
    'web-design-intelligence@1',
    { question: 'Which resources should Parlor agents use to build exceptional websites?', asOf: '2026-07-22' },
    [...coreProviders, 'searxng', 'rss', 'podcasts'],
  );
  const awardQueries = compiled.seedSubqueries.filter((subquery) =>
    subquery.source_pack_id === 'award-editorial-sources');
  assert.equal(awardQueries.length, 2);
  assert.deepEqual(
    new Set(awardQueries.map((subquery) => subquery.section_path)),
    new Set(['source.award-editorial-sources']),
  );
  const implementation = compiled.seedSubqueries.find((subquery) =>
    subquery.source_pack_id === 'open-implementation-sources');
  assert.deepEqual(implementation?.expected_source_types, ['repository', 'code']);
  const practitioner = compiled.seedSubqueries.find((subquery) =>
    subquery.source_pack_id === 'design-practitioner-signal');
  assert.deepEqual(practitioner?.providers, ['hn', 'rss', 'podcasts']);
  assert.ok(practitioner !== undefined);
  assert.deepEqual(providersForSubquery(practitioner), ['hn', 'rss', 'podcasts']);
  assert.equal(providersForSubquery(practitioner).includes('searxng'), false);
  assert.deepEqual(providersForSubquery({
    section_path: 'source.optional-community-pack',
    query: 'optional community design evidence',
    providers: ['hn'],
    expected_source_types: ['forum'],
    rationale: '',
    source_pack_id: 'optional-community-pack',
    required: false,
    search_options: {},
  }), ['hn']);
});

test('web-design v2 makes implementation evidence native-GitHub-only', () => {
  const compiled = compileProfileExecution(
    'web-design-intelligence@2',
    {
      question: 'Which resources should Parlor agents use to build exceptional websites?',
      asOf: '2026-07-22',
    },
    [...coreProviders, 'searxng', 'rss', 'podcasts'],
  );
  const implementationSeeds = compiled.seedSubqueries.filter((subquery) =>
    subquery.source_pack_id === 'open-implementation-sources');
  assert.deepEqual(compiled.requiredProviders, ['github']);
  assert.equal(implementationSeeds.length, 2);
  assert.ok(implementationSeeds.every((subquery) =>
    subquery.providers.length === 1 && subquery.providers[0] === 'github'));
});

test('web-design v2 fails before public research when GitHub is absent', async () => {
  let publicRunnerCalled = false;
  await assert.rejects(
    runResearchProgram({
      brief: 'Which resources should Parlor agents use to build exceptional websites?',
      asOf: '2026-07-22',
      profileRef: 'web-design-intelligence@2',
      availableProviders: ['tavily', 'searxng', 'hn', 'rss', 'podcasts'],
      trustedAdapters: [{
        id: 'ora-cortex-braintied',
        modes: ['cortex', 'telegram'] as const,
        async recall() { return []; },
      }],
      publicRunner: async () => {
        publicRunnerCalled = true;
        return mockPublicResult();
      },
    }),
    (error: unknown) => error instanceof SourcePlanUnavailableError
      && error.plan.missingRequiredProviders.includes('github'),
  );
  assert.equal(publicRunnerCalled, false);
});

test('profile and caller required providers are unioned without weakening v1 compatibility', async () => {
  const v1 = compileProfileExecution(
    'web-design-intelligence@1',
    {
      question: 'Which resources should Parlor agents use to build exceptional websites?',
      asOf: '2026-07-22',
    },
    ['tavily', 'searxng', 'hn', 'rss', 'podcasts'],
  );
  const v1Implementation = v1.seedSubqueries.filter((subquery) =>
    subquery.source_pack_id === 'open-implementation-sources');
  assert.deepEqual(v1.requiredProviders, []);
  assert.ok(v1Implementation.every((subquery) =>
    subquery.providers.includes('tavily') && subquery.providers.includes('searxng')));

  await assert.rejects(
    runResearchProgram({
      brief: 'Which resources should Parlor agents use to build exceptional websites?',
      asOf: '2026-07-22',
      profileRef: 'web-design-intelligence@2',
      requiredProviders: ['x'],
      availableProviders: ['github', 'tavily', 'searxng', 'hn', 'rss', 'podcasts'],
      trustedAdapters: [{
        id: 'ora-cortex-braintied',
        modes: ['cortex', 'telegram'] as const,
        async recall() { return []; },
      }],
      publicRunner: async () => mockPublicResult(),
    }),
    (error: unknown) => error instanceof SourcePlanUnavailableError
      && error.plan.requiredProviders.includes('github')
      && error.plan.requiredProviders.includes('x')
      && error.plan.missingRequiredProviders.includes('x'),
  );
});

test('profile execution applies the exact timestamp boundary to every seeded search', async () => {
  let publicInput: RunResearchInput | null = null;
  await runResearchProgram({
    brief: question,
    asOf: '2026-07-21T23:59:59-07:00',
    profileRef: 'ora-agent-runtime@1',
    availableProviders: [...coreProviders, 'searxng', 'rss', 'podcasts'],
    trustedAdapters: [{
      id: 'ora-cortex-braintied',
      modes: ['cortex', 'telegram'] as const,
      async recall() { return []; },
    }],
    publicRunner: async (input) => {
      publicInput = input;
      return mockPublicResult();
    },
  });

  assert.ok(publicInput !== null);
  assert.ok((publicInput as RunResearchInput).seedSubqueries?.every((subquery) =>
    subquery.search_options.published_before === '2026-07-22T06:59:59.000Z'));
});

test('profile evidence contains exact accepted source text rather than search snippets', async () => {
  const validatedSentence =
    'The documented design review process compares complete layouts at multiple viewport sizes.';
  const packedDiscovery = SearchResultSchema.parse({
    ...discovery(1),
    snippet: 'A search-provider summary that was never fetched evidence.',
    source_pack_ids: ['award-editorial-sources'],
    source_modes: ['web'],
  });
  const result = await runResearchProgram({
    brief: question,
    asOf: '2026-07-21',
    profileRef: 'web-design-intelligence@1',
    availableProviders: [...coreProviders, 'searxng', 'rss', 'podcasts'],
    trustedAdapters: [{
      id: 'ora-cortex-braintied',
      modes: ['cortex', 'telegram'] as const,
      async recall() { return []; },
    }],
    publicRunner: async () => ({
      ...mockPublicResult(),
      discoveries: [packedDiscovery],
      validatedEvidence: [{
        source_url: packedDiscovery.url,
        content: validatedSentence,
        kind: 'verbatim_quote',
      }],
    }),
  });

  assert.equal(result.publicEvidence.length, 1);
  assert.equal(result.publicEvidence[0]?.exactQuote, validatedSentence);
  assert.notEqual(result.publicEvidence[0]?.exactQuote, packedDiscovery.snippet);
  assert.equal(
    result.publicEvidence[0]?.metadata['validation'],
    'exact_fetched_source_sentence',
  );
});

function discovery(index: number) {
  return SearchResultSchema.parse({
    provider: 'tavily',
    url: `https://example.com/source-${index}`,
    title: `Source ${index}`,
    snippet: 'Public evidence only.',
    published_at: '2026-07-20T12:00:00.000Z',
    source_pack_ids: ['mode-web'],
    source_modes: ['web'],
    raw_metadata: { backend: 'tavily_search' },
  });
}

function trustedEvidence(mode: TrustedSourceMode, index: number) {
  const sourceRef = `internal://${mode}/${index}`;
  const content = `PRIVATE-${mode.toUpperCase()}-${index}`;
  const identity = createEvidenceIdentity({ sourceRef, content });
  return EvidenceItemSchema.parse({
    ...identity,
    sourceRef,
    retrievedAt: '2026-07-21T12:00:00.000Z',
    provider: 'internal',
    sourceClass: 'internal_record',
    lane: mode === 'cortex' ? 'private_cortex' : 'private_telegram',
    sourcePackId: `mode-${mode}`,
    visibility: 'private',
    exactQuote: content,
  });
}

function mockPublicResult(): KindResearchResult {
  return {
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
    discoveries: [1, 2, 3, 4].map(discovery),
    validatedEvidence: [1, 2, 3, 4].map((index) => ({
      source_url: `https://example.com/source-${index}`,
      content: `Validated source sentence number ${index} contains complete factual evidence.`,
      kind: 'verbatim_quote' as const,
    })),
  };
}

test('research program keeps private recall out of the public model boundary', async () => {
  let publicInput: RunResearchInput | null = null;
  const adapter = {
    id: 'ora-cortex-braintied',
    modes: ['cortex', 'telegram'] as const,
    async recall(input: { mode: TrustedSourceMode }) {
      return [1, 2, 3].map((index) => trustedEvidence(input.mode, index));
    },
  };

  const result = await runResearchProgram({
    brief: question,
    asOf: '2026-07-21',
    sourceModes: ['web', 'cortex', 'telegram'],
    availableProviders: ['tavily'],
    trustedAdapters: [adapter],
    publicRunner: async (input) => {
      publicInput = input;
      return mockPublicResult();
    },
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.sourceCoverage.passed, true);
  assert.equal(result.trustedEvidence.length, 6);
  assert.equal(result.dataBoundary, 'public_report_and_private_manifest_separate');
  assert.ok(publicInput !== null);
  const outbound = (publicInput as RunResearchInput).brief;
  assert.doesNotMatch(outbound, /PRIVATE-CORTEX|PRIVATE-TELEGRAM/);
});

test('public program research cannot complete when grounding is missing', async () => {
  const result = await runResearchProgram({
    brief: question,
    asOf: '2026-07-21',
    sourceModes: ['web'],
    availableProviders: ['tavily'],
    publicRunner: async () => ({ ...mockPublicResult(), grounding: null }),
  });

  assert.equal(result.sourceCoverage.passed, true);
  assert.equal(result.status, 'partial');
});

test('search discoveries cannot satisfy source coverage without validated fetched evidence', async () => {
  const result = await runResearchProgram({
    brief: question,
    asOf: '2026-07-21',
    sourceModes: ['web'],
    availableProviders: ['tavily'],
    publicRunner: async () => ({ ...mockPublicResult(), validatedEvidence: [] }),
  });

  assert.equal(result.sourceCoverage.passed, false);
  assert.deepEqual(result.sourceCoverage.missingModes, ['web']);
  assert.equal(result.status, 'partial');
});

test('trusted adapters cannot cross-tag Cortex and Telegram evidence', async () => {
  const result = await runResearchProgram({
    brief: question,
    asOf: '2026-07-21',
    sourceModes: ['cortex'],
    availableProviders: [],
    trustedAdapters: [{
      id: 'ora-cortex-braintied',
      modes: ['cortex'] as const,
      async recall() {
        return [trustedEvidence('telegram', 1)];
      },
    }],
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.trustedEvidence.length, 0);
  assert.equal(result.trustedRecallFailures.length, 1);
  assert.match(result.trustedRecallFailures[0]?.error ?? '', /expected private_cortex/);
});

test('coverage reports an explicitly missing source lane', () => {
  const plan = resolveSourceExecutionPlan({
    question,
    modes: ['web', 'x'],
    availableProviders: ['tavily', 'x'],
    asOf: '2026-07-21',
  });
  const coverage = evaluateSourceModeCoverage(plan, [1, 2, 3, 4].map(discovery));
  assert.equal(coverage.passed, false);
  assert.deepEqual(coverage.missingModes, ['x']);
});
