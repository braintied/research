/**
 * The Reddit corpus surface, read from the BUILT package, and the runner's
 * refusal to start without OAuth credentials. A missing credential must be a
 * loud exit 2 before any request, never an empty "success" or a scrape of
 * unauthenticated Reddit (which answers 403).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as engine from '../dist/index.mjs';

const RUNNER = fileURLToPath(new URL('../skills/run-braintied-research/scripts/reddit-corpus.mjs', import.meta.url));

test('the Reddit corpus surface is exported from the built package', () => {
  for (const name of ['collectRedditCorpus', 'fetchExpandedThread', 'discoverSubreddits', 'createDirectoryThreadStore', 'redactUserMentions']) {
    assert.equal(typeof engine[name], 'function', `${name} missing from dist`);
  }
  assert.equal(engine.REDDIT_CORPUS_SCHEMA, 'braintied.reddit-thread/1');
});

test('the runner refuses to collect without Reddit credentials', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'reddit-cli-'));
  try {
    const env = { PATH: process.env.PATH, HOME: out };
    const result = spawnSync(process.execPath, [RUNNER, 'collect', '--subs', 'AgingParents', '--query', 'bank', '--out', out], {
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Reddit credentials missing \(REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT\)/);
    assert.match(result.stderr, /never scrapes/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
