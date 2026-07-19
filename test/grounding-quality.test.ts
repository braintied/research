import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGroundingQuality,
  validateGrounding,
} from '../src/grounding.js';
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
