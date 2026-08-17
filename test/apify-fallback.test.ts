import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isApifyFallbackAllowed,
  resolveResearchCredentials,
} from '../src/credentials.js';

// The flag is the documented opt-in for the Apify last-resort lanes
// (tiktok, facebook-groups): only the exact value '1' counts, token
// presence is checked separately by the callers.
test('APIFY_ALLOW_FALLBACK=1 opts the fallback in', () => {
  const credentials = resolveResearchCredentials({ APIFY_ALLOW_FALLBACK: '1' });
  assert.equal(isApifyFallbackAllowed(credentials), true);
});

test('an unset flag means the fallback is not allowed', () => {
  const credentials = resolveResearchCredentials({});
  assert.equal(isApifyFallbackAllowed(credentials), false);
});

test('values other than the documented 1 do not count', () => {
  for (const value of ['true', '0', 'yes', '']) {
    const credentials = resolveResearchCredentials({ APIFY_ALLOW_FALLBACK: value });
    assert.equal(isApifyFallbackAllowed(credentials), false, `value ${JSON.stringify(value)}`);
  }
});

test('surrounding whitespace is normalized like every other env value', () => {
  const credentials = resolveResearchCredentials({ APIFY_ALLOW_FALLBACK: ' 1 ' });
  assert.equal(isApifyFallbackAllowed(credentials), true);
});

test('the flag is independent of APIFY_API_TOKEN', () => {
  const credentials = resolveResearchCredentials({
    APIFY_ALLOW_FALLBACK: '1',
    APIFY_API_TOKEN: 'token-value',
  });
  assert.equal(isApifyFallbackAllowed(credentials), true);
  assert.equal(credentials.apifyApiToken, 'token-value');
});
