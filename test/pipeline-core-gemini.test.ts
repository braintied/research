import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGeminiApiKey, type ResearchEnvironment } from '../src/credentials.js';

test('shared Gemini resolver accepts the Google Gemini alias', () => {
  const env: ResearchEnvironment = { GOOGLE_GEMINI_API_KEY: 'google-gemini-test-key' };  // git-secret-allow: fake fixture value, never a live credential
  assert.equal(resolveGeminiApiKey(env), 'google-gemini-test-key');
});

test('shared Gemini resolver fails on conflicting aliases without an explicit selector', () => {
  const env: ResearchEnvironment = {
    GOOGLE_GEMINI_API_KEY: 'working-google-gemini-test-key',  // git-secret-allow: fake fixture value, never a live credential
    GOOGLE_GENERATIVE_AI_API_KEY: 'legacy-google-generative-test-key',  // git-secret-allow: fake fixture value, never a live credential
  };
  assert.throws(() => resolveGeminiApiKey(env), /Conflicting Gemini aliases/);
});

test('shared Gemini resolver honors an explicit alias selector', () => {
  const env: ResearchEnvironment = {
    BRAINTIED_GEMINI_KEY_NAME: 'GOOGLE_GEMINI_API_KEY',
    GOOGLE_GEMINI_API_KEY: 'working-google-gemini-test-key',  // git-secret-allow: fake fixture value, never a live credential
    GOOGLE_GENERATIVE_AI_API_KEY: 'legacy-google-generative-test-key',  // git-secret-allow: fake fixture value, never a live credential
  };
  assert.equal(resolveGeminiApiKey(env), 'working-google-gemini-test-key');
});

test('an unknown selector names the accepted aliases instead of guessing', () => {
  const env: ResearchEnvironment = { BRAINTIED_GEMINI_KEY_NAME: 'MY_OWN_KEY', GEMINI_API_KEY: 'k' };
  assert.throws(() => resolveGeminiApiKey(env), /must name one of/);
});

test('an unconfigured environment resolves to no Gemini key rather than throwing', () => {
  assert.equal(resolveGeminiApiKey({}), undefined);
});
