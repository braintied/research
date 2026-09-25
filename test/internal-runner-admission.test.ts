import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(
  packageRoot,
  'skills/run-braintied-research/scripts/run-internal-research.mjs',
);

/** Run the runner against a worker that refuses every submission with `errorCode`. */
async function refusedRun(t: test.TestContext, errorCode: string) {
  const server = createServer((request, response) => {
    response.writeHead(
      request.method === 'GET' ? 200 : 429,
      { 'content-type': 'application/json' },
    );
    if (request.method === 'GET' && request.url === '/internal/tools') {
      response.end(JSON.stringify({
        ok: true,
        protocolVersion: '2',
        tools: [{
          name: 'research.run',
          version: '2',
          execution: {
            mode: 'durable-polling',
            submitPath: '/internal/tools/runs',
            statusPathTemplate: '/internal/tools/runs/{runId}',
            pollAfterMs: 250,
            retentionHours: 24,
          },
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      ok: false,
      error: { code: errorCode, message: 'Durable research admission limit reached' },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'braintied-admission-'));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });

  return new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      runner,
      '--brief', 'Compare open-source feedback widgets by license.',
      '--kind', 'quick',
      '--max-cost-usd', '1',
      '--endpoint', `http://127.0.0.1:${address.port}/internal/tools/execute`,
      '--timeout-seconds', '5',
      '--output', path.join(temporaryDirectory, 'report.md'),
      '--metadata', path.join(temporaryDirectory, 'metadata.json'),
      '--allow-external',
    ], {
      cwd: packageRoot,
      env: { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_admission_test' }, // git-secret-allow: fake fixture token sent only to a local test server
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stderr }));
  });
}

test('ADMISSION_LIMIT_REACHED names concurrency first and every limit behind the code', async (t) => {
  const result = await refusedRun(t, 'ADMISSION_LIMIT_REACHED');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\(ADMISSION_LIMIT_REACHED\)/);
  assert.match(result.stderr, /Usually CONCURRENCY, not budget/);
  for (const limit of [
    'max_active_per_principal',
    'max_active_per_organization',
    'max_submissions_per_principal_minute',
    'max_run_cost_usd',
  ]) {
    assert.ok(result.stderr.includes(limit), `missing ${limit}: ${result.stderr}`);
  }
  assert.match(result.stderr, /internal_tool_admission_policies where tool_name='research\.run'/);
  assert.match(result.stderr, /same --request-id/);
  // The old text sent operators to the budget window first.
  assert.doesNotMatch(result.stderr, /daily reserved-cost window to roll/);
});

test('ADMISSION_PAUSED says paused, not over a limit', async (t) => {
  const result = await refusedRun(t, 'ADMISSION_PAUSED');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\(ADMISSION_PAUSED\)/);
  assert.match(result.stderr, /paused, not over a limit/);
  assert.doesNotMatch(result.stderr, /CONCURRENCY/);
});
