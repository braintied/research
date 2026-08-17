/**
 * Regression guard for the third-party-safe contract.
 *
 * `harness thirdparty` fails any package whose src/ reads the environment
 * directly, because that is an undeclared input a recipient cannot audit. This
 * test enforces the same rule inside the package's own suite so a reintroduced
 * read fails here first, long before the fleet audit runs.
 *
 * The process boundary lives OUTSIDE src/: the shipped runner
 * (skills/run-braintied-research/scripts/run-research.mjs) resolves env once
 * and passes a ResearchCredentials record in.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * A mention inside a comment is documentation, not coupling — the credential
 * resolver's doc block names `process.env` to tell a host what to pass. This
 * mirrors how the fleet audit itself skips comment lines.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

test('src/ never reads the ambient environment', () => {
  // Built dynamically so this file's own source cannot match itself.
  const ambientEnvPattern = new RegExp(['process', 'env\\b'].join('\\.'));
  const offenders: string[] = [];

  for (const file of sourceFiles(SRC_ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (ambientEnvPattern.test(line)) {
        offenders.push(`${relative(SRC_ROOT, file)}:${index + 1}`);
      }
    });
  }

  assert.deepEqual(offenders, []);
});
