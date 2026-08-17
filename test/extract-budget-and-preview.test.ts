import assert from 'node:assert/strict';
import test from 'node:test';

import { DEPTH_CONFIG, getDepthConfig } from '../src/depth-config.js';
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
  assert.ok(DEPTH_CONFIG.standard.critiqueMaxPasses <= 1);
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
