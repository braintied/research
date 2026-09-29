import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveForStyle } from '@braintied/models';

import {
  resolveResearchAssemblyModel,
  resolveResearchCritiqueModel,
  resolveResearchExtractionModel,
  resolveResearchSynthesisModel,
  researchModelRates,
  researchStageCostFields,
  researchStageResolution,
  type ResearchModelStage,
} from '../src/model-policy.js';

const STAGES: readonly ResearchModelStage[] = [
  'extract',
  'synthesis-answer',
  'synthesis-quick',
  'synthesis-standard',
  'synthesis-deep',
  'critique',
  'assembly',
];

test('no research stage is provider-bound, so the fleet profile moves every one', () => {
  for (const stage of STAGES) {
    const resolution = researchStageResolution(stage);
    assert.ok(
      !resolution.costTags.includes('profile_bypass:provider_bound'),
      `${stage} is still provider-bound: ${resolution.costTags.join(', ')}`,
    );
    // The same pin any unbound caller of that style gets under the active profile.
    assert.equal(resolution.apiModelId, resolveForStyle(resolution.style).apiModelId, stage);
  }
});

test('under the deepseek_flash default every research stage runs DeepSeek V4.1 Flash', () => {
  for (const stage of STAGES) {
    const resolution = researchStageResolution(stage);
    assert.equal(resolution.provider, 'deepseek', stage);
    assert.equal(resolution.apiModelId, 'deepseek-flash', stage);
  }
});

test('the string resolvers agree with the stage resolutions', () => {
  assert.equal(resolveResearchExtractionModel(), researchStageResolution('extract').apiModelId);
  assert.equal(resolveResearchCritiqueModel(), researchStageResolution('critique').apiModelId);
  assert.equal(resolveResearchAssemblyModel(), researchStageResolution('assembly').apiModelId);
  assert.equal(resolveResearchSynthesisModel('deep'), researchStageResolution('synthesis-deep').apiModelId);
  assert.equal(resolveResearchSynthesisModel('social'), researchStageResolution('synthesis-deep').apiModelId);
  assert.equal(resolveResearchSynthesisModel('quick'), researchStageResolution('synthesis-quick').apiModelId);
  assert.equal(resolveResearchSynthesisModel('answer'), researchStageResolution('synthesis-answer').apiModelId);
  assert.equal(resolveResearchSynthesisModel('standard'), researchStageResolution('synthesis-standard').apiModelId);
});

test('the extract model has catalog rates for the spend cap', () => {
  const rates = researchModelRates(resolveResearchExtractionModel());
  assert.ok(rates.inputUsdPerM > 0);
  assert.ok(rates.outputUsdPerM > 0);
});

test('research stage cost fields attribute the resolved provider and wire id', () => {
  for (const stage of STAGES) {
    const resolution = researchStageResolution(stage);
    const fields = researchStageCostFields(stage);
    assert.equal(fields.model, resolution.apiModelId, stage);
    assert.equal(fields.provider, resolution.provider, stage);
  }
});
