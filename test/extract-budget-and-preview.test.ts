import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEPTH_CONFIG,
  getDepthConfig,
  refinementExtractReserve,
  refinementRounds,
} from '../src/depth-config.js';
import {
  EXTRACTION_MODEL,
  extractionModelId,
  resolveGeminiRequestModel,
} from '../src/pipeline-core.js';

test('every depth defines extract page + concurrency caps', () => {
  for (const depth of ['quick', 'blog', 'standard', 'wide'] as const) {
    const cfg = getDepthConfig(depth);
    assert.ok(cfg.maxExtractPages > 0, `${depth} maxExtractPages`);
    assert.ok(cfg.extractConcurrency > 0, `${depth} extractConcurrency`);
    assert.ok(cfg.extractConcurrency <= 8, `${depth} concurrency stays bounded`);
  }
});

test('standard extract budget stays well under the old unbounded class', () => {
  // Pre-fix CUMULATIVE_URL_CEILING was 400 and extract ran every URL with
  // concurrency 8 and no run budget — critique multiplied that. One brief
  // minted ~7k extract ledger rows (Aug 2026 GCP incident class).
  // 2026-08-01 cost program: tighter still (research-agents ~$393/30d).
  assert.ok(DEPTH_CONFIG.standard.maxExtractPages <= 24);
  // Wide must stay below the pre-program 80, but above the sum of
  // web-design-intelligence@2 public coverage floors (~41) so the release
  // canary can complete. 64 is the reviewed band.
  assert.ok(DEPTH_CONFIG.wide.maxExtractPages >= 48);
  assert.ok(DEPTH_CONFIG.wide.maxExtractPages <= 72);
  assert.ok(DEPTH_CONFIG.standard.hardCapUsd <= 3.5);
  // Cost program bound: at most ONE refinement round at standard. The raw
  // knob counts critique calls, so one round is critiqueMaxPasses === 2.
  assert.equal(refinementRounds(DEPTH_CONFIG.standard), 1);
});

test('critiqueMaxPasses counts critique calls; the last pass never refines', () => {
  assert.equal(refinementRounds({ critiqueMaxPasses: 0 }), 0);
  // The 2026-08-01 trap: 1 pass reads like "one round" and is zero.
  assert.equal(refinementRounds({ critiqueMaxPasses: 1 }), 0);
  assert.equal(refinementRounds({ critiqueMaxPasses: 2 }), 1);
  assert.equal(refinementRounds({ critiqueMaxPasses: 3 }), 2);
});

test('every depth with a critique loop can actually refine', () => {
  // A depth that pays for a critique but can never act on it is the
  // 2026-09-24 regression: gaps found, labelled "after refinement", never refilled.
  for (const depth of ['blog', 'standard', 'wide'] as const) {
    assert.ok(refinementRounds(DEPTH_CONFIG[depth]) >= 1, `${depth} refines at least once`);
  }
  assert.equal(refinementRounds(DEPTH_CONFIG.quick), 0);
});

test('refinement extract reserve holds pages back only when a round can use them', () => {
  assert.equal(refinementExtractReserve(DEPTH_CONFIG.quick), 0);
  assert.equal(refinementExtractReserve({ critiqueMaxPasses: 1, maxExtractPages: 20 }), 0);

  const standard = refinementExtractReserve(DEPTH_CONFIG.standard);
  assert.ok(standard > 0, 'standard reserves pages for refinement');
  // The main pass keeps at least half the budget.
  assert.ok(DEPTH_CONFIG.standard.maxExtractPages - standard >= DEPTH_CONFIG.standard.maxExtractPages / 2);
  assert.equal(standard, 6);

  // Tiny budgets never hand the whole budget to refinement.
  assert.equal(refinementExtractReserve({ critiqueMaxPasses: 2, maxExtractPages: 1 }), 0);
  assert.equal(refinementExtractReserve({ critiqueMaxPasses: 2, maxExtractPages: 3 }), 1);
});

test('standard extract budget is below theoretical natural URL fan-out', () => {
  const cfg = DEPTH_CONFIG.standard;
  const theoretical = cfg.subqueriesMax * cfg.urlsPerSubquery;
  assert.ok(cfg.maxExtractPages < theoretical);
});

test('quick is cheaper than standard on extract pages and hard cap', () => {
  assert.ok(DEPTH_CONFIG.quick.maxExtractPages < DEPTH_CONFIG.standard.maxExtractPages);
  assert.ok(DEPTH_CONFIG.quick.hardCapUsd < DEPTH_CONFIG.standard.hardCapUsd);
  assert.equal(DEPTH_CONFIG.quick.critiqueMaxPasses, 0);
});

test('EXTRACTION_MODEL is not a banned preview id', () => {
  assert.equal(EXTRACTION_MODEL.includes('preview'), false);
  assert.equal(extractionModelId().includes('preview'), false);
  assert.equal(extractionModelId(), resolveGeminiRequestModel(EXTRACTION_MODEL));
});

test('resolveGeminiRequestModel rewrites the July tax id', () => {
  assert.equal(
    resolveGeminiRequestModel('gemini-3.1-flash-lite-preview'),
    'gemini-3.5-flash-lite',
  );
});

test('resolveGeminiRequestModel leaves image previews alone', () => {
  assert.equal(
    resolveGeminiRequestModel('gemini-3-pro-image-preview'),
    'gemini-3-pro-image-preview',
  );
});
