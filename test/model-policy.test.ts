import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveResearchAssemblyModel,
  resolveResearchCritiqueModel,
  resolveResearchExtractionModel,
  resolveResearchSynthesisModel,
  researchModelRates,
  researchStageCostFields,
} from '../src/model-policy.js';

test('research extract resolves an active google wire id via @braintied/models', () => {
  const id = resolveResearchExtractionModel();
  assert.ok(id.length > 0);
  assert.match(id, /^gemini-/);
  // Retired generations must not be returned as the live pick.
  assert.notEqual(id, 'gemini-2.0-flash');
  assert.notEqual(id, 'gemini-2.0-flash-lite');
  assert.notEqual(id, 'gemini-2.5-flash-lite');
  const rates = researchModelRates(id);
  assert.ok(rates.inputUsdPerM > 0);
  assert.ok(rates.outputUsdPerM > 0);
});

test('research synthesis defaults stay on google for pipeline cohesion', () => {
  const quick = resolveResearchSynthesisModel('quick');
  const standard = resolveResearchSynthesisModel('standard');
  const deep = resolveResearchSynthesisModel('deep');
  const social = resolveResearchSynthesisModel('social');
  for (const id of [quick, standard, deep, social]) {
    assert.ok(id.length > 0);
    assert.match(id, /^gemini-/);
    assert.notEqual(id, 'gemini-2.0-flash');
  }
  // Deep/social use fast (flash); answer/quick use cheap (flash-lite).
  assert.match(deep, /flash/);
  assert.match(quick, /flash/);
});

test('research critique and assembly resolve google wire ids', () => {
  const critique = resolveResearchCritiqueModel();
  const assembly = resolveResearchAssemblyModel();
  assert.match(critique, /^gemini-/);
  assert.match(assembly, /^gemini-/);
  assert.notEqual(critique, 'deepseek-v4-flash');
  assert.notEqual(assembly, 'claude-sonnet-5');
});

test('research stage cost fields attribute the live google wire id', () => {
  const extract = researchStageCostFields('extract');
  const deep = researchStageCostFields('synthesis-deep');
  const critique = researchStageCostFields('critique');
  assert.equal(extract.model, resolveResearchExtractionModel());
  assert.equal(deep.model, resolveResearchSynthesisModel('deep'));
  assert.equal(critique.model, resolveResearchCritiqueModel());
});
