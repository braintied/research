import assert from 'node:assert/strict';
import test from 'node:test';

import { createGithubProvider, queryTermLadder } from '../src/providers/github.js';

// GitHub ANDs every free-text term, so verbose natural-language queries return
// 200 with zero items. The provider must walk the term ladder (full query,
// first 6 terms, first 3 terms) before declaring zero results. These tests
// pin that contract: the 13-term web-design-intelligence pack hint is the
// regression case (verified against the live API 2026-07-27: total_count 0 for
// the full hint, 8,102 for "design system components").

const LONG_PACK_HINT =
  'website design component library animation creative frontend design system license maintained stars release';

const repoItem = {
  id: 42,
  html_url: 'https://github.com/public-owner/public-repository',
  full_name: 'public-owner/public-repository',
  description: 'Repository description.',
  updated_at: '2026-07-20T00:00:00.000Z',
  pushed_at: '2026-07-20T00:00:00.000Z',
  stargazers_count: 10,
  forks_count: 2,
  open_issues_count: 1,
  language: 'TypeScript',
  private: false,
  visibility: 'public',
  owner: { login: 'public-owner' },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function freeTextTermCount(q: string): number {
  return q
    .split(/\s+/)
    .filter((term) => term.length > 0 && term !== 'is:public').length;
}

function installFetchStub(hitWhenTermsAtMost: number): string[] {
  const recorded: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const q = url.searchParams.get('q') ?? '';
    recorded.push(q);
    const items = freeTextTermCount(q) <= hitWhenTermsAtMost ? [repoItem] : [];
    return jsonResponse({ items });
  }) as typeof fetch;
  return recorded;
}

const githubProvider = createGithubProvider({
  github: {
    publicToken: `test-token-${'0'.repeat(20)}`,
    requireAuth: false,
    ambientCredentialsPresent: false,
  },
});

test('queryTermLadder shortens verbose queries and leaves short ones alone', () => {
  assert.deepEqual(queryTermLadder(LONG_PACK_HINT), [
    LONG_PACK_HINT,
    'website design component library animation creative',
    'website design component',
  ]);
  assert.deepEqual(queryTermLadder('one two three four five six'), [
    'one two three four five six',
    'one two three',
  ]);
  assert.deepEqual(queryTermLadder('design system components'), ['design system components']);
});

test('empty verbose search relaxes to leading terms and returns matches', async () => {
  const recorded = installFetchStub(6);
  const results = await githubProvider.search(LONG_PACK_HINT, {
    limit: 5,
    expected_source_types: ['repository'],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.url, 'https://github.com/public-owner/public-repository');
  assert.equal(recorded.length, 2);
  assert.equal(freeTextTermCount(recorded[0] ?? ''), 13);
  assert.equal(recorded[1], 'website design component library animation creative is:public');
});

test('short queries are searched once with no relaxation', async () => {
  const recorded = installFetchStub(6);
  const results = await githubProvider.search('design system', {
    limit: 5,
    expected_source_types: ['repository'],
  });
  assert.equal(results.length, 1);
  assert.deepEqual(recorded, ['design system is:public']);
});

test('queries that stay empty through the whole ladder return zero results', async () => {
  const recorded = installFetchStub(0);
  const results = await githubProvider.search(LONG_PACK_HINT, {
    limit: 5,
    expected_source_types: ['repository'],
  });
  assert.deepEqual(results, []);
  assert.equal(recorded.length, 3);
});
