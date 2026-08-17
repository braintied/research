import assert from 'node:assert/strict';
import test from 'node:test';

import { MODEL_PRICING, getModelPricing, tryGetModelPricing } from '../src/depth-config.js';

// Regression: gemini-3.6-flash is the default synthesis model for the 'quick'
// kind, and it was absent from MODEL_PRICING. Every call fell through to the
// conservative fallback and was recorded at Sonnet's $3/$15 with provider
// 'anthropic'. cortex-worker forwarded that number to the Cortex ledger as
// vendorReportedCostUsd — the tier that outranks the catalog — so Gemini
// synthesis was booked at ~2x the real rate under the wrong provider, and no
// catalog correction could override it.
//
// Rates asserted here are the live Cortex catalog values read 2026-07-31.
const SYNTHESIS_MODELS: ReadonlyArray<readonly [string, number, number, string]> = [
  ['gemini-3.6-flash', 1.5, 7.5, 'google'],
  ['gemini-3.5-flash-lite', 0.25, 1.5, 'google'],
  ['gemini-3.1-flash-lite', 0.25, 1.5, 'google'],
  ['claude-sonnet-5', 2, 10, 'anthropic'],
  ['claude-sonnet-4-6', 3, 15, 'anthropic'],
  ['claude-haiku-4-5', 1, 5, 'anthropic'],
];

test('every synthesis model has real published rates, not the fallback', () => {
  for (const [model, inputUsdPerM, outputUsdPerM, provider] of SYNTHESIS_MODELS) {
    const pricing = tryGetModelPricing(model);
    assert.notEqual(pricing, null, `${model} has no rates and would be priced by the fallback`);
    assert.equal(pricing?.inputUsdPerM, inputUsdPerM, `${model} input rate`);
    assert.equal(pricing?.outputUsdPerM, outputUsdPerM, `${model} output rate`);
    assert.equal(pricing?.provider, provider, `${model} provider tag`);
  }
});

test('a model is never tagged with a provider its id contradicts', () => {
  for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith('gemini-')) {
      assert.equal(pricing.provider, 'google', `${model} is tagged ${pricing.provider}`);
    }
    if (model.startsWith('claude-')) {
      assert.equal(pricing.provider, 'anthropic', `${model} is tagged ${pricing.provider}`);
    }
    if (model.startsWith('deepseek-')) {
      assert.equal(pricing.provider, 'deepseek', `${model} is tagged ${pricing.provider}`);
    }
  }
});

test('tryGetModelPricing returns null for an unknown model instead of guessing', () => {
  assert.equal(tryGetModelPricing('some-model-that-does-not-exist'), null);
});

test('getModelPricing still bounds an unknown model so the spend cap holds', () => {
  const pricing = getModelPricing('some-model-that-does-not-exist');
  assert.equal(pricing.inputUsdPerM, 3);
  assert.equal(pricing.outputUsdPerM, 15);
});

test('a dated model id resolves to its undated rates', () => {
  const dated = tryGetModelPricing('claude-haiku-4-5-20251001');
  assert.deepEqual(dated, tryGetModelPricing('claude-haiku-4-5'));
});
