import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGroundingQuality,
  buildGroundingEvidenceChunks,
  validateGrounding,
} from '../src/grounding.js';
import { SECTION_SYNTHESIS_SYSTEM_PROMPT } from '../src/synthesis.js';
import { assessGrounding } from '../skills/run-braintied-research/scripts/grounding-quality.mjs';

const bibliography = [{
  citation_anchor: '[^1]',
  source_url: 'https://docs.example/source',
  title: 'Primary source',
  author: '',
  provider: 'searxng' as const,
}];

function quoteChunk(content: string) {
  return {
    chunk_kind: 'quote' as const,
    section_path: '',
    heading: null,
    content,
    source_url: 'https://docs.example/source',
    source_provider: null,
    source_author: null,
    source_published_at: null,
    source_engagement: {},
    citation_anchor: null,
    metadata: {},
  };
}

test('grounding quality uses an explicit 60% pass threshold', () => {
  assert.deepEqual(assessGroundingQuality(0.8, 5), { quality: 'strong', passed: true });
  assert.deepEqual(assessGroundingQuality(0.6, 5), { quality: 'acceptable', passed: true });
  assert.deepEqual(assessGroundingQuality(0.59, 5), { quality: 'weak', passed: false });
  assert.deepEqual(assessGroundingQuality(1, 0), { quality: 'ungrounded', passed: false });
});

test('a checked report with zero citation matches is weak, not evidence-validated', () => {
  const result = validateGrounding({
    fullMarkdown: 'The documented context window is one million tokens [^1].',
    bibliography,
    chunks: [quoteChunk('This unrelated source text does not support the claim.')],
  });

  assert.equal(result.status, 'validated');
  assert.equal(result.ratio, 0);
  assert.equal(result.quality, 'weak');
  assert.equal(result.passed, false);
});

test('a directly supported citation is reported as strong evidence quality', () => {
  const claim = 'The documented context window is one million tokens';
  const result = validateGrounding({
    fullMarkdown: `${claim} [^1].`,
    bibliography,
    chunks: [quoteChunk(claim)],
  });

  assert.equal(result.ratio, 1);
  assert.equal(result.quality, 'strong');
  assert.equal(result.passed, true);
});

test('grounding evidence mirrors the quotes and source-bound key claims offered to synthesis', () => {
  const chunks = buildGroundingEvidenceChunks({
    sourceQuotesByUrl: {
      'https://docs.example/source': [{
        quote: 'The guideline is an international standard.',
        context: '',
        source_url: 'https://docs.example/source',
        engagement: {},
      }],
    },
    claimsBySection: {
      'A.1': [{
        claim: 'WCAG 2.2 was approved as ISO/IEC 40500:2025.',
        source_url: 'https://docs.example/source',
        provider: 'searxng',
      }],
    },
  });

  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((chunk) => [chunk.chunk_kind, chunk.source_url, chunk.metadata['grounding_basis']]),
    [
      ['quote', 'https://docs.example/source', 'verbatim_quote'],
      ['source_summary', 'https://docs.example/source', 'extracted_key_claim'],
    ],
  );
});

test('a conservative paraphrase of a source-bound key claim validates without lowering the threshold', () => {
  const chunks = buildGroundingEvidenceChunks({
    sourceQuotesByUrl: {},
    claimsBySection: {
      'A.1': [{
        claim: 'WCAG 2.2 was approved as ISO/IEC 40500:2025, an international standard.',
        source_url: 'https://docs.example/source',
        provider: 'searxng',
      }],
    },
  });
  const result = validateGrounding({
    fullMarkdown: 'The international standards body formally recognizes WCAG 2.2 under ISO/IEC 40500:2025 [^1].',
    bibliography,
    chunks,
  });

  assert.equal(result.ratio, 1);
  assert.equal(result.quality, 'strong');
  assert.equal(result.passed, true);
});

test('lexically similar evidence cannot validate a changed number', () => {
  const result = validateGrounding({
    fullMarkdown: 'Industry research found that AI adoption among designers reached 81 percent [^1].',
    bibliography,
    chunks: [quoteChunk('Industry research found that AI adoption among designers reached 91%.')],
  });

  assert.equal(result.ratio, 0);
  assert.equal(result.passed, false);
});

test('topically related but unsupported evidence remains a grounding failure', () => {
  const result = validateGrounding({
    fullMarkdown: 'The accessibility scanner uses artificial intelligence to generate color palettes [^1].',
    bibliography,
    chunks: [quoteChunk('The maturity model evaluates organizational accessibility policies and governance.')],
  });

  assert.equal(result.ratio, 0);
  assert.equal(result.passed, false);
});

test('evidence in an adjacent sentence cannot validate the cited sentence', () => {
  const result = validateGrounding({
    fullMarkdown:
      'The maturity model evaluates organizational accessibility policies and governance. ' +
      'The scanner automatically generates brand color palettes [^1].',
    bibliography,
    chunks: [quoteChunk('The maturity model evaluates organizational accessibility policies and governance.')],
  });

  assert.equal(result.ratio, 0);
  assert.equal(result.passed, false);
});

test('source-near wording for the canary evidence is verifiable with its exact status code', () => {
  const evidence =
    'Traditional software has unit tests, integration tests, and well-defined pass/fail criteria. ' +
    'AI systems have none of that by default. An LLM can return a 200 response in under a second ' +
    'and still hallucinate, contradict its own context, leak PII, or give a technically correct ' +
    'answer that is completely wrong for your domain.';
  const result = validateGrounding({
    fullMarkdown:
      'Traditional software has well-defined pass/fail criteria, while AI systems have none by default; ' +
      'an LLM can return a 200 response and still hallucinate or contradict its own context [^1].',
    bibliography,
    chunks: [quoteChunk(evidence)],
  });

  assert.equal(result.ratio, 1);
  assert.equal(result.passed, true);
});

test('lossy wording that omits an evidence status code remains unverifiable', () => {
  const result = validateGrounding({
    fullMarkdown:
      'Generative AI systems lack standardized pass/fail criteria, as an LLM can return successful ' +
      'HTTP responses while still producing context contradictions or hallucinations [^1].',
    bibliography,
    chunks: [quoteChunk(
      'Traditional software has well-defined pass/fail criteria, while AI systems have none by default. ' +
      'An LLM can return a 200 response and still hallucinate or contradict its own context.',
    )],
  });

  assert.equal(result.ratio, 0);
  assert.equal(result.passed, false);
});

test('every distinct use of one source must validate and bibliography definitions are ignored', () => {
  const supportedClaim = 'The documented context window is one million tokens';
  const result = validateGrounding({
    fullMarkdown:
      `${supportedClaim} [^1].\n\n` +
      'The same model automatically generates branded color palettes [^1].\n\n' +
      '## Bibliography\n\n' +
      '[^1]: https://docs.example/source',
    bibliography,
    chunks: [quoteChunk(supportedClaim)],
  });

  assert.equal(result.total_citations, 1);
  assert.equal(result.valid_citations, 0);
  assert.equal(result.hallucinated.length, 1);
  assert.match(result.hallucinated[0]?.expected_substring ?? '', /color palettes/);
});

test('section synthesis requires source-near claims and exact evidence details', () => {
  assert.match(SECTION_SYNTHESIS_SYSTEM_PROMPT, /mechanically traceable/);
  assert.match(SECTION_SYNTHESIS_SYSTEM_PROMPT, /status code/);
  assert.match(SECTION_SYNTHESIS_SYSTEM_PROMPT, /exactly as stated/);
  assert.match(SECTION_SYNTHESIS_SYSTEM_PROMPT, /smallest sentence fully supported/);
});

test('runner assessment treats legacy validated plus zero matches as weak', () => {
  assert.deepEqual(assessGrounding({
    status: 'validated',
    ratio: 0,
    total_citations: 4,
    valid_citations: 0,
  }), {
    quality: 'weak',
    passed: false,
    ratio: 0,
  });
});
