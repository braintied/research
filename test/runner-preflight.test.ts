import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(packageRoot, 'skills/run-braintied-research/scripts/run-research.mjs');

test('Gemini-backed standard research does not require Anthropic or Voyage', () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.VOYAGE_API_KEY;
  delete env.GEMINI_RESEARCH_KEY;
  env.GEMINI_API_KEY = 'test-only-key';
  env.SEARXNG_URLS = 'https://search.example';

  const result = spawnSync(process.execPath, [
    runner,
    '--check',
    '--kind', 'standard',
    '--max-cost-usd', '1',
    '--synthesis-model', 'gemini-3-flash-preview',
  ], { cwd: packageRoot, env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const preflight = JSON.parse(result.stdout) as { ready: boolean; missing: string[]; warnings: string[] };
  assert.equal(preflight.ready, true);
  assert.deepEqual(preflight.missing, []);
  assert.ok(preflight.warnings.some((warning) => warning.includes('critique')));
  assert.ok(preflight.warnings.some((warning) => warning.includes('reranking')));
});
