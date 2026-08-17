import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleFinalReport,
  buildEvidenceBoundExecutiveSummary,
  buildSynthesisEvidenceUnits,
  EVIDENCE_GAP_NOTICE,
  EVIDENCE_TOKEN_RETRY_SUFFIX,
  renderEvidenceBoundMarkdown,
  synthesizeSection,
  SynthesisEvidenceBindingError,
} from '../src/synthesis.js';
import type { ResearchCredentials } from '../src/credentials.js';
import { buildGroundingEvidenceChunks, validateGrounding } from '../src/grounding.js';
import { isVerbatimQuoteSupportedBySource } from '../src/evidence-validation.js';

const sourceUrl = 'https://docs.example/evidence';
const evidence = 'The visual regression harness compares screenshots across three viewport sizes.';

function units() {
  return buildSynthesisEvidenceUnits(
    [{
      quote: evidence,
      context: '',
      source_url: sourceUrl,
      engagement: {},
    }],
    [{
      claim: evidence,
      source_url: sourceUrl,
      provider: 'tavily',
    }],
    new Map([[sourceUrl, 1]]),
  );
}

test('evidence units deduplicate the same exact source sentence', () => {
  assert.deepEqual(units(), [{
    id: 'E1',
    text: evidence,
    sourceUrl,
    citationAnchor: '[^1]',
  }]);
});

test('renderer isolates exact evidence and produces a mechanically grounded citation', () => {
  const rendered = renderEvidenceBoundMarkdown(
    'Use deterministic visual checks.\n\n{{EVIDENCE:E1}}\n\nThis supports a repeatable review loop.',
    units(),
  );

  assert.equal(rendered.usedUnits.length, 1);
  assert.match(rendered.bodyMd, /three viewport sizes \[\^1\]\./);
  assert.equal(
    (rendered.bodyMd.match(/Editorial synthesis — inference, not source-validated/gu) ?? []).length,
    2,
  );
  assert.doesNotMatch(rendered.bodyMd, /\{\{EVIDENCE:/);

  const grounding = validateGrounding({
    fullMarkdown: rendered.bodyMd,
    bibliography: [{
      citation_anchor: '[^1]',
      source_url: sourceUrl,
      title: 'Evidence',
      author: '',
      provider: 'tavily',
    }],
    chunks: [{
      chunk_kind: 'quote',
      section_path: '',
      heading: null,
      content: evidence,
      source_url: sourceUrl,
      source_provider: null,
      source_author: null,
      source_published_at: null,
      source_engagement: {},
      citation_anchor: null,
      metadata: {},
    }],
  });
  assert.equal(grounding.ratio, 1);
  assert.equal(grounding.passed, true);
});

test('renderer strips model-authored citations and fails closed without an evidence handle', () => {
  assert.throws(
    () => renderEvidenceBoundMarkdown(
      'The harness is perfect and never misses a regression [^1].',
      units(),
    ),
    SynthesisEvidenceBindingError,
  );
});

test('renderer fails closed on invented evidence IDs', () => {
  assert.throws(
    () => renderEvidenceBoundMarkdown('{{EVIDENCE:E999}}', units()),
    /unknown evidence IDs: E999/,
  );
});

test('renderer emits a repeated evidence handle only once', () => {
  const rendered = renderEvidenceBoundMarkdown(
    '{{EVIDENCE:E1}}\n\n{{EVIDENCE:E1}}',
    units(),
  );
  assert.equal(rendered.usedUnits.length, 1);
  assert.equal((rendered.bodyMd.match(/\[\^1\]/gu) ?? []).length, 1);
});

test('renderer visibly quarantines unsupported model facts outside evidence tokens', () => {
  const invented =
    'Product X launched on July 22, 2026 for $99 and supports MagicMode.';
  const rendered = renderEvidenceBoundMarkdown(
    `${invented}\n\n{{EVIDENCE:E1}}`,
    units(),
  );

  assert.match(
    rendered.bodyMd,
    /> \*\*Editorial synthesis — inference, not source-validated:\*\*/u,
  );
  assert.match(rendered.bodyMd, /> Product X launched on July 22, 2026 for \$99/u);
  assert.doesNotMatch(rendered.bodyMd, /MagicMode[^\n]*\[\^1\]/u);
  assert.match(rendered.bodyMd, /three viewport sizes \[\^1\]\./u);
});

test('executive summary reuses complete exact evidence with its citation', () => {
  const summary = buildEvidenceBoundExecutiveSummary([{
    section_path: 'QA.1',
    heading: 'Visual QA',
    level: 2,
    body_md: `${evidence} [^1].`,
    source_urls: [sourceUrl],
    inline_citations: [{
      anchor: '[^1]',
      source_url: sourceUrl,
      quote_excerpt: evidence,
    }],
    word_count: 10,
  }]);

  assert.match(summary, /source-validated findings across 1 section/u);
  assert.match(summary, /three viewport sizes \[\^1\]\./u);
});

const emptyCredentials: ResearchCredentials = {};

function sectionInput(
  generate: NonNullable<Parameters<typeof synthesizeSection>[0]['generate']>,
) {
  return {
    credentials: emptyCredentials,
    sectionPath: 'QA.1',
    sectionGoal: 'Explain a deterministic visual QA loop.',
    quotes: [{
      quote: evidence,
      context: '',
      source_url: sourceUrl,
      engagement: {},
    }],
    keyClaims: [],
    targetWords: 120,
    generate,
  };
}

test('unbound first draft retries once and keeps the bound retry', async () => {
  const users: string[] = [];
  const section = await synthesizeSection(sectionInput(async ({ user }) => {
    users.push(user);
    if (users.length === 1) {
      return {
        text: 'Fluent prose with no evidence handle.',
        inputTokens: 11,
        cachedReadTokens: 0,
        outputTokens: 7,
      };
    }
    return {
      text: 'Use repeatable checks.\n\n{{EVIDENCE:E1}}\n',
      inputTokens: 13,
      cachedReadTokens: 0,
      outputTokens: 9,
    };
  }));

  assert.equal(users.length, 2);
  assert.match(users[1] ?? '', new RegExp(EVIDENCE_TOKEN_RETRY_SUFFIX.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(section.draft.body_md, /three viewport sizes \[\^1\]\./);
  assert.equal(section.inputTokens, 24);
  assert.equal(section.outputTokens, 16);
});

test('two unbound drafts become a section gap, not a thrown run failure', async () => {
  let calls = 0;
  const section = await synthesizeSection(sectionInput(async () => {
    calls += 1;
    return {
      text: 'The harness is perfect and never misses a regression.',
      inputTokens: 5,
      cachedReadTokens: 0,
      outputTokens: 4,
    };
  }));

  assert.equal(calls, 2);
  assert.equal(section.draft.body_md, EVIDENCE_GAP_NOTICE);
  assert.equal(section.draft.source_urls.length, 0);
  assert.equal(section.inputTokens, 10);
  assert.equal(section.outputTokens, 8);
});

test('mutation: a process-level throw on unbound synthesis is the 2026-08-15 outage', async () => {
  const section = await synthesizeSection(sectionInput(async () => ({
    text: 'No tokens here either.',
    inputTokens: 1,
    cachedReadTokens: 0,
    outputTokens: 1,
  })));
  if (section.draft.body_md !== EVIDENCE_GAP_NOTICE) {
    throw new Error(
      'unbound synthesis escaped as a process failure — TOOL_EXECUTION_FAILED is back',
    );
  }
  assert.equal(section.draft.body_md, EVIDENCE_GAP_NOTICE);
});

test('non-binding generate failures still propagate', async () => {
  await assert.rejects(
    () => synthesizeSection(sectionInput(async () => {
      throw new Error('gemini-3.6-flash is not found');
    })),
    /gemini-3\.6-flash is not found/,
  );
});

test('validated evidence survives synthesis, assembly, and final grounding end to end', async () => {
  const fetchedSource = `Documentation introduction. ${evidence} Closing note.`;
  assert.equal(isVerbatimQuoteSupportedBySource(evidence, fetchedSource), true);

  const section = await synthesizeSection({
    sectionPath: 'QA.1',
    sectionGoal: 'Explain a deterministic visual QA loop.',
    quotes: [{
      quote: evidence,
      context: '',
      source_url: sourceUrl,
      engagement: {},
    }],
    keyClaims: [],
    targetWords: 120,
    generate: async () => ({
      text:
        '## Deterministic visual QA\n\n' +
        'Use repeatable checks before human review.\n\n' +
        '{{EVIDENCE:E1}}\n\n' +
        'This makes the evidence boundary visible.',
      inputTokens: 10,
      cachedReadTokens: 0,
      outputTokens: 20,
    }),
  });
  assert.equal(section.draft.heading, 'Research Findings 1');

  const assembly = await assembleFinalReport({
    promptMd: 'Design a visual QA loop.',
    sections: [{ ...section.draft, heading: 'OpenAI price $99' }],
    gaps: [],
    sourceMeta: {
      [sourceUrl]: { provider: 'tavily', title: 'Evidence' },
    },
  });

  assert.equal(assembly.report.bibliography.length, 1);
  assert.equal(assembly.report.title, 'Evidence-Bound Research Report');
  assert.equal(assembly.report.sections[0]?.heading, 'Research Findings 1');
  assert.doesNotMatch(assembly.report.full_markdown, /OpenAI price \$99/u);
  assert.equal(assembly.inputTokens, 0);
  assert.match(assembly.report.executive_summary, /three viewport sizes \[\^1\]\./);
  assert.match(assembly.report.sections[0]?.body_md ?? '', /three viewport sizes \[\^1\]\./);

  const grounding = validateGrounding({
    fullMarkdown: assembly.report.full_markdown,
    bibliography: assembly.report.bibliography,
    chunks: buildGroundingEvidenceChunks({
      sourceQuotesByUrl: {
        [sourceUrl]: [{
          quote: evidence,
          context: '',
          source_url: sourceUrl,
          engagement: {},
        }],
      },
      claimsBySection: {},
    }),
  });
  assert.deepEqual(
    { ratio: grounding.ratio, total: grounding.total_citations, valid: grounding.valid_citations, passed: grounding.passed },
    { ratio: 1, total: 1, valid: 1, passed: true },
  );
});
