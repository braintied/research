import assert from 'node:assert/strict';
import test from 'node:test';

import { createSerpapiProvider } from '../src/providers/serpapi.js';
import type { ResearchCredentials } from '../src/credentials.js';

async function queryParamsFor(searchLocale?: { language: string; region: string }): Promise<URLSearchParams> {
  const original = globalThis.fetch;
  let seen = '';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    seen = String(input);
    return new Response(JSON.stringify({ organic_results: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const creds: ResearchCredentials = { serpapiKey: 'fixture-key' };
    await createSerpapiProvider(creds).search('q', searchLocale === undefined ? { limit: 1 } : { limit: 1, search_locale: searchLocale });
  } finally {
    globalThis.fetch = original;
  }
  return new URL(seen).searchParams;
}

test('serpapi searches en/us by default and any locale the caller names', async () => {
  const defaults = await queryParamsFor();
  assert.equal(defaults.get('hl'), 'en');
  assert.equal(defaults.get('gl'), 'us');
  const german = await queryParamsFor({ language: 'de', region: 'de' });
  assert.equal(german.get('hl'), 'de');
  assert.equal(german.get('gl'), 'de');
});
