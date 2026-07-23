import assert from 'node:assert/strict';
import test from 'node:test';
import { getGeminiKey } from '../src/pipeline-core.js';

const geminiKeyNames = [
  'GEMINI_RESEARCH_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
] as const;
const geminiSelectorName = 'BRAINTIED_GEMINI_KEY_NAME' as const;
const geminiEnvironmentNames = [...geminiKeyNames, geminiSelectorName] as const;

function withGeminiEnvironment(
  values: Partial<Record<(typeof geminiEnvironmentNames)[number], string>>,
  callback: () => void,
): void {
  const previous = new Map(geminiEnvironmentNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of geminiEnvironmentNames) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    callback();
  } finally {
    for (const name of geminiEnvironmentNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('shared Gemini resolver accepts the Google Gemini alias', () => {
  withGeminiEnvironment({ GOOGLE_GEMINI_API_KEY: 'google-gemini-test-key' }, () => {
    assert.equal(getGeminiKey(), 'google-gemini-test-key');
  });
});

test('shared Gemini resolver fails on conflicting aliases without an explicit selector', () => {
  withGeminiEnvironment({
    GOOGLE_GEMINI_API_KEY: 'working-google-gemini-test-key',
    GOOGLE_GENERATIVE_AI_API_KEY: 'legacy-google-generative-test-key',
  }, () => {
    assert.throws(() => getGeminiKey(), /Conflicting Gemini aliases/);
  });
});

test('shared Gemini resolver honors an explicit alias selector', () => {
  withGeminiEnvironment({
    BRAINTIED_GEMINI_KEY_NAME: 'GOOGLE_GEMINI_API_KEY',
    GOOGLE_GEMINI_API_KEY: 'working-google-gemini-test-key',
    GOOGLE_GENERATIVE_AI_API_KEY: 'legacy-google-generative-test-key',
  }, () => {
    assert.equal(getGeminiKey(), 'working-google-gemini-test-key');
  });
});
