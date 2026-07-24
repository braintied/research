import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveGitHubSearchKinds } from '../src/providers/github.js';

test('repository/code searches exclude GitHub issues and pull requests', () => {
  assert.deepEqual(
    resolveGitHubSearchKinds({ expected_source_types: ['repository', 'code'] }),
    { repositories: true, issues: false },
  );
});

test('issue searches exclude repository results unless explicitly requested', () => {
  assert.deepEqual(
    resolveGitHubSearchKinds({ expected_source_types: ['issue'] }),
    { repositories: false, issues: true },
  );
  assert.deepEqual(
    resolveGitHubSearchKinds({ expected_source_types: ['issue', 'repository'] }),
    { repositories: true, issues: true },
  );
});

test('legacy GitHub searches preserve mixed results when no GitHub kind is supplied', () => {
  assert.deepEqual(resolveGitHubSearchKinds({}), { repositories: true, issues: true });
  assert.deepEqual(
    resolveGitHubSearchKinds({ expected_source_types: ['documentation'] }),
    { repositories: true, issues: true },
  );
});
