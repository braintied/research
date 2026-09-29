import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGeminiApiKey, resolveResearchCredentials } from '../src/credentials.js';

test('neutral RESEARCH_* names are read before the legacy BRAINTIED_* ones', () => {
  const creds = resolveResearchCredentials({
    RESEARCH_GITHUB_PUBLIC_TOKEN: 'neutral-token', // git-secret-allow: fake fixture value
    BRAINTIED_GITHUB_PUBLIC_TOKEN: 'legacy-token', // git-secret-allow: fake fixture value
    RESEARCH_GITHUB_REQUIRE_AUTH: 'true',
    CRAWL4AI_URL: 'http://crawl.local',
    RESEARCH_CRAWL4AI_ALLOWED_DOMAINS: 'a.example, b.example',
    BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS: 'legacy.example',
    RESEARCH_CRAWL4AI_NETWORK_GUARD: 'enforced-v1',
  });
  assert.equal(creds.github?.publicToken, 'neutral-token');
  assert.equal(creds.github?.requireAuth, true);
  assert.deepEqual(creds.crawl4ai?.allowedDomains, ['a.example', 'b.example']);
  assert.equal(creds.crawl4ai?.networkGuard, 'enforced-v1');
});

test('the legacy BRAINTIED_* names still work on their own', () => {
  const creds = resolveResearchCredentials({
    BRAINTIED_GITHUB_PUBLIC_TOKEN: 'legacy-token', // git-secret-allow: fake fixture value
    BRAINTIED_GITHUB_REQUIRE_AUTH: 'true',
    CRAWL4AI_URL: 'http://crawl.local',
    BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS: 'legacy.example',
    BRAINTIED_CRAWL4AI_NETWORK_GUARD: 'enforced-v1',
  });
  assert.equal(creds.github?.publicToken, 'legacy-token');
  assert.equal(creds.github?.requireAuth, true);
  assert.deepEqual(creds.crawl4ai?.allowedDomains, ['legacy.example']);
});

test('the Gemini key is selected by the neutral name or the legacy one', () => {
  const names = ['GEMINI_RESEARCH_KEY', 'GEMINI_API_KEY'];
  const aliases = Object.fromEntries(names.map((name) => [name, `value-of-${name}`]));
  assert.equal(
    resolveGeminiApiKey({ ...aliases, RESEARCH_GEMINI_KEY_NAME: 'GEMINI_API_KEY' }),
    'value-of-GEMINI_API_KEY',
  );
  assert.equal(
    resolveGeminiApiKey({ ...aliases, BRAINTIED_GEMINI_KEY_NAME: 'GEMINI_RESEARCH_KEY' }),
    'value-of-GEMINI_RESEARCH_KEY',
  );
});
