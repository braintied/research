import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GITHUB_PUBLIC_CACHE_POLICY,
  GITHUB_PUBLIC_VISIBILITY_ATTESTATION,
  parseCachedSearchResults,
  searchCachePolicyIdentity,
} from '../src/search-cache.js';
import { SearchResultSchema } from '../src/types.js';

const baseResult = {
  provider: 'github' as const,
  url: 'https://github.com/public-owner/public-repository',
  title: 'public-owner/public-repository',
  snippet: 'Repository description.',
  published_at: '2026-07-22T12:00:00.000Z',
  raw_metadata: {
    backend: 'github_rest_api',
    result_kind: 'repository',
  },
};

test('GitHub cache identity is permanently namespaced by the public-attestation contract', () => {
  assert.equal(searchCachePolicyIdentity('github'), GITHUB_PUBLIC_CACHE_POLICY);
  assert.equal(searchCachePolicyIdentity('tavily'), null);
});

test('pre-0.8.6 GitHub cache entries are rejected before discovery or fetch', () => {
  assert.equal(parseCachedSearchResults('github', JSON.stringify([baseResult])), null);
});

test('GitHub cache rejects hostile or cross-provider entries even with a forged marker', () => {
  const forged = {
    ...baseResult,
    url: 'https://private.example/repository',
    raw_metadata: {
      ...baseResult.raw_metadata,
      visibility_attestation: GITHUB_PUBLIC_VISIBILITY_ATTESTATION,
    },
  };
  assert.equal(parseCachedSearchResults('github', JSON.stringify([forged])), null);
  assert.equal(parseCachedSearchResults('tavily', JSON.stringify([baseResult])), null);
});

test('only current attested public GitHub identities may be reused', () => {
  const attested = SearchResultSchema.parse({
    ...baseResult,
    raw_metadata: {
      ...baseResult.raw_metadata,
      visibility_attestation: GITHUB_PUBLIC_VISIBILITY_ATTESTATION,
    },
  });
  assert.deepEqual(parseCachedSearchResults('github', JSON.stringify([attested])), [attested]);
});
