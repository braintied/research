import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(
  packageRoot,
  'skills/run-braintied-research/scripts/run-internal-research.mjs',
);

test('internal preflight detects inherited Agent Auth without disclosing the token', () => {
  const token = 'sat_test_secret_that_must_not_be_printed';
  const result = spawnSync(process.execPath, [
    runner,
    '--check',
    '--kind', 'quick',
    '--max-cost-usd', '1',
    '--endpoint', 'https://tools.example/internal/tools/execute',
  ], {
    cwd: packageRoot,
    env: { ...process.env, BRAINTIED_AGENT_TOKEN: token },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(token), false);
  const check = JSON.parse(result.stdout) as {
    ready: boolean;
    mode: string;
    agent_token_source: string;
  };
  assert.equal(check.ready, true);
  assert.equal(check.mode, 'internal');
  assert.equal(check.agent_token_source, 'environment:BRAINTIED_AGENT_TOKEN');
});

test('internal preflight fails closed when Agent Auth is unavailable', () => {
  const env = { ...process.env };
  delete env.BRAINTIED_AGENT_TOKEN;
  const result = spawnSync(process.execPath, [
    runner,
    '--check',
    '--kind', 'quick',
    '--max-cost-usd', '1',
    '--keychain-service', `missing-test-service-${process.pid}`,
    '--keychain-account', 'missing-test-account',
  ], { cwd: packageRoot, env, encoding: 'utf8' });

  assert.equal(result.status, 2, result.stderr);
  const check = JSON.parse(result.stdout) as { ready: boolean; agent_token_present: boolean };
  assert.equal(check.ready, false);
  assert.equal(check.agent_token_present, false);
});
