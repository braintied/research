import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * A terminal durable status must end the runner AND rewrite its checkpoint.
 *
 * Measured 2026-10-23: a deep run sent with --max-cost-usd 6 failed server-side
 * as RESEARCH_INPUT_REJECTED one second after creation. The runner exited on the
 * status 500 but left `checkpoint_status: awaiting_terminal_result`, which
 * bt-research reads as "server still working", so it resumed the dead request
 * for 3 hours. These stubs replay the worker's real status shapes
 * (cortex-worker internal-tools/router.ts GET /runs/:runId).
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(
  packageRoot,
  'skills/run-braintied-research/scripts/run-internal-research.mjs',
);
const DURABLE_RUN_ID = '0b9f8c1e-5d3a-4f2b-9c7d-2e6a1b4c8d90';

interface StatusReply {
  status: number;
  body: (requestId: string) => Record<string, unknown>;
}

function queued(runStatus: 'queued' | 'running'): StatusReply {
  return {
    status: 202,
    body: (requestId) => ({
      ok: true,
      tool: 'research.run',
      run: {
        id: DURABLE_RUN_ID,
        requestId,
        status: runStatus,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pollAfterMs: 250,
      },
      meta: { requestId, durable: true },
    }),
  };
}

function failed(errorCode: string, message = `Tool execution failed (${errorCode})`): StatusReply {
  return {
    status: 500,
    body: (requestId) => ({
      ok: false,
      error: { code: errorCode, message },
      requestId,
      runId: DURABLE_RUN_ID,
    }),
  };
}

const completed: StatusReply = {
  status: 200,
  body: (requestId) => ({
    ok: true,
    tool: 'research.run',
    result: {
      kind: 'quick',
      engine: 'pipeline',
      report: {
        title: 'Feedback widget licenses',
        executive_summary: 'Formbricks is AGPL-3.0.',
        full_markdown: '# Feedback widget licenses\n\nFormbricks is AGPL-3.0 [^1].',
        sections: [],
        bibliography: ['https://github.com/formbricks/formbricks'],
        gaps: [],
        word_count: 8,
      },
      costUsd: 0.1,
      appliedMaxCostUsd: 1,
      quoteCount: 1,
    },
    meta: { requestId, runId: DURABLE_RUN_ID, durationMs: 20, durable: true },
  }),
};

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function headerRequestId(request: IncomingMessage): string {
  const value = request.headers['x-request-id'];
  assert.equal(typeof value, 'string');
  return String(value);
}

/**
 * Run the runner against a worker that accepts the submission with
 * `submitStatus` and then answers each status read with the next reply.
 */
async function runAgainst(
  t: test.TestContext,
  { submitStatus = 'queued', statusReplies }: {
    submitStatus?: 'queued' | 'running' | 'failed';
    statusReplies: StatusReply[];
  },
) {
  let statusReads = 0;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/internal/tools') {
      sendJson(response, 200, {
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
      });
      return;
    }
    const requestId = headerRequestId(request);
    if (request.method === 'POST' && request.url === '/internal/tools/runs') {
      request.resume();
      sendJson(response, 202, {
        ok: true,
        tool: 'research.run',
        run: { id: DURABLE_RUN_ID, requestId, status: submitStatus, pollAfterMs: 250 },
        meta: { requestId, durable: true },
      });
      return;
    }
    if (request.method === 'GET' && request.url === `/internal/tools/runs/${DURABLE_RUN_ID}`) {
      const reply = statusReplies[Math.min(statusReads, statusReplies.length - 1)];
      statusReads += 1;
      sendJson(response, reply.status, reply.body(requestId));
      return;
    }
    sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'braintied-terminal-'));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });
  const metadataPath = path.join(temporaryDirectory, 'metadata.json');

  const startedAt = Date.now();
  const outcome = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      runner,
      '--brief', 'Compare open-source feedback widgets by license.',
      '--kind', 'quick',
      '--max-cost-usd', '1',
      '--endpoint', `http://127.0.0.1:${address.port}/internal/tools/execute`,
      // Long enough that a runner which kept polling would be caught by the
      // elapsed-time assertion below rather than by its own deadline.
      '--timeout-seconds', '60',
      '--output', path.join(temporaryDirectory, 'report.md'),
      '--metadata', metadataPath,
      '--allow-external',
    ], {
      cwd: packageRoot,
      env: { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_terminal_status_test' }, // git-secret-allow: fake fixture token sent only to a local test server
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stderr }));
  });
  const metadata: Record<string, unknown> = JSON.parse(await readFile(metadataPath, 'utf8'));
  return { ...outcome, elapsedMs: Date.now() - startedAt, metadata, statusReads };
}

test('queued then failed RESEARCH_INPUT_REJECTED exits with the code and a reason, not a resumable checkpoint', async (t) => {
  const result = await runAgainst(t, {
    statusReplies: [queued('queued'), failed('RESEARCH_INPUT_REJECTED')],
  });
  assert.notEqual(result.status, 0);
  assert.ok(result.elapsedMs < 20_000, `runner kept polling for ${result.elapsedMs} ms`);
  assert.equal(result.statusReads, 2, 'runner must stop at the first terminal status');
  assert.match(result.stderr, /\(RESEARCH_INPUT_REJECTED\)/);
  assert.match(result.stderr, /cost ceiling/);
  assert.match(result.stderr, /INTERNAL_RESEARCH_MAX_COST_USD/);
  assert.match(result.stderr, /new --request-id/);
  // bt-research resumes only while this says awaiting_terminal_result.
  assert.equal(result.metadata.checkpoint_status, 'terminal_failure');
  assert.equal(result.metadata.durable_run_status, 'failed');
  assert.equal(result.metadata.durable_run_id, DURABLE_RUN_ID);
  assert.equal(result.metadata.error_code, 'RESEARCH_INPUT_REJECTED');
  assert.equal(typeof result.metadata.error_reason, 'string');
});

test('RESEARCH_INPUT_REJECTED names the server cap when the body carries it', async (t) => {
  const result = await runAgainst(t, {
    statusReplies: [failed(
      'RESEARCH_INPUT_REJECTED',
      'Requested maxCostUsd $6.00 exceeds INTERNAL_RESEARCH_MAX_COST_USD=$5.00 on this worker.',
    )],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /the server cap is \$5\.00/);
  assert.match(String(result.metadata.error_reason), /\$5\.00/);
});

test('a resubmitted request whose run already failed stops on the first status read', async (t) => {
  const result = await runAgainst(t, {
    submitStatus: 'failed',
    statusReplies: [failed('EXECUTION_DEADLINE_EXCEEDED')],
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.statusReads, 1);
  assert.match(result.stderr, /\(EXECUTION_DEADLINE_EXCEEDED\)/);
  assert.match(result.stderr, /hard execution deadline/);
  assert.equal(result.metadata.checkpoint_status, 'terminal_failure');
});

test('RUN_EXPIRED (410) is terminal', async (t) => {
  const result = await runAgainst(t, {
    statusReplies: [{
      status: 410,
      body: (requestId) => ({
        ok: false,
        error: { code: 'RUN_EXPIRED', message: 'Research run result has expired' },
        requestId,
      }),
    }],
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.statusReads, 1);
  assert.match(result.stderr, /expired \(RUN_EXPIRED\)/);
  assert.equal(result.metadata.checkpoint_status, 'terminal_failure');
  assert.equal(result.metadata.durable_run_status, 'expired');
});

test('queued and running runs are still polled through to their result', async (t) => {
  const result = await runAgainst(t, {
    statusReplies: [queued('queued'), queued('running'), queued('running'), completed],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.statusReads, 4);
  assert.notEqual(result.metadata.artifact_type, 'braintied_internal_research_checkpoint');
  assert.equal(result.metadata.durable_run_id, DURABLE_RUN_ID);
  assert.equal(result.metadata.cost_usd, 0.1);
});
