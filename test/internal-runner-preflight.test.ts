import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(
  packageRoot,
  'skills/run-braintied-research/scripts/run-internal-research.mjs',
);
const DURABLE_RUN_ID = '22222222-2222-4222-8222-222222222222';

function sendDurableCatalog(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'application/json' });
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
}

function runRunner(args: string[], env: NodeJS.ProcessEnv): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], {
      cwd: packageRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

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

test('internal pipeline preflight accepts and reports a recency window', () => {
  const result = spawnSync(process.execPath, [
    runner,
    '--check',
    '--kind', 'deep',
    '--max-cost-usd', '2',
    '--recency-days', '30',
  ], {
    cwd: packageRoot,
    env: { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_recency_test' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const check = JSON.parse(result.stdout) as {
    ready: boolean;
    requested_recency_days: number;
    timeout_seconds: number;
  };
  assert.equal(check.ready, true);
  assert.equal(check.requested_recency_days, 30);
  assert.equal(check.timeout_seconds, 3600);
});

test('internal preflight accepts an exact versioned profile boundary', () => {
  const result = spawnSync(process.execPath, [
    runner,
    '--check',
    '--kind', 'deep',
    '--max-cost-usd', '5',
    '--profile', 'web-design-intelligence@1',
    '--profile-mode', 'snapshot',
    '--as-of', '2026-07-22',
  ], {
    cwd: packageRoot,
    env: { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_profile_test' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const check = JSON.parse(result.stdout) as {
    requested_profile_ref: string;
    requested_profile_mode: string;
    requested_as_of: string;
  };
  assert.equal(check.requested_profile_ref, 'web-design-intelligence@1');
  assert.equal(check.requested_profile_mode, 'snapshot');
  assert.equal(check.requested_as_of, '2026-07-22');
});

test('internal profile preflight fails closed without an as-of boundary', () => {
  const result = spawnSync(process.execPath, [
    runner,
    '--check',
    '--kind', 'deep',
    '--max-cost-usd', '5',
    '--profile', 'web-design-intelligence@1',
  ], {
    cwd: packageRoot,
    env: { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_profile_test' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--as-of is required with --profile/);
});

test('live profile runner requires a distinct trusted-local artifact path', () => {
  const result = spawnSync(process.execPath, [
    runner,
    '--brief', 'Research beautiful sunny website design resources.',
    '--kind', 'deep',
    '--max-cost-usd', '5',
    '--profile', 'web-design-intelligence@1',
    '--as-of', '2026-07-22',
    '--output', '/tmp/public.md',
    '--metadata', '/tmp/metadata.json',
    '--allow-external',
  ], {
    cwd: packageRoot,
    env: { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_profile_test' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--trusted-output is required/);
});

test('profile runner separates public Markdown, reference metadata, and trusted-local findings', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'braintied-profile-'));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });
  const reportPath = path.join(temporaryDirectory, 'report.md');
  const metadataPath = path.join(temporaryDirectory, 'metadata.json');
  const trustedOutputPath = path.join(temporaryDirectory, 'trusted.json');

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/internal/tools') {
      sendDurableCatalog(response);
      return;
    }
    if (request.method === 'POST' && request.url === '/internal/tools/runs') {
      let requestBody = '';
      for await (const chunk of request) requestBody += chunk.toString();
      const parsed = JSON.parse(requestBody) as {
        input: {
          profileRef: string;
          profileMode: string;
          asOf: string;
        };
      };
      assert.equal(parsed.input.profileRef, 'web-design-intelligence@1');
      assert.equal(parsed.input.profileMode, 'snapshot');
      assert.equal(parsed.input.asOf, '2026-07-22');
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        run: {
          id: DURABLE_RUN_ID,
          requestId: request.headers['x-request-id'],
          status: 'queued',
          pollAfterMs: 250,
        },
      }));
      return;
    }
    assert.equal(request.method, 'GET');
    assert.equal(request.url, `/internal/tools/runs/${DURABLE_RUN_ID}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      result: {
        kind: 'deep',
        engine: 'pipeline',
        report: {
          title: 'Public profile result',
          executive_summary: 'Public evidence only.',
          full_markdown: '# Public profile result\n\nPublic evidence only.',
          sections: [],
          bibliography: [],
          gaps: [],
          word_count: 6,
        },
        grounding: null,
        costUsd: 0.25,
        appliedMaxCostUsd: 5,
        quoteCount: 0,
        briefSha256: 'a'.repeat(64),
        programStatus: 'complete',
        sourceCoverage: { passed: true, entries: [], missingModes: [] },
        profileCoverage: {
          profileRef: 'web-design-intelligence@1',
          asOf: '2026-07-22T23:59:59.999Z',
          passed: true,
          requirements: [],
          missingRequiredRequirementIds: [],
        },
        privateManifest: {
          visibility: 'trusted_local',
          adapterId: 'ora-cortex-braintied',
          dataBoundary: 'public_report_and_private_manifest_separate',
          profileRef: 'web-design-intelligence@1',
          asOf: '2026-07-22',
          evidence: [{
            id: `ev_${'b'.repeat(24)}`,
            contentSha256: 'c'.repeat(64),
            sourceRef:
              'cortex://research-reports/11111111-1111-4111-8111-111111111111',
            contentRef:
              'cortex://research-reports/11111111-1111-4111-8111-111111111111',
            publishedAt: '2026-07-20T12:00:00.000Z',
            retrievedAt: '2026-07-23T08:00:00.000Z',
            lane: 'private_cortex',
            sourcePackId: 'parlor-cortex-design-prior',
            visibility: 'private',
            lineage: {
              adapter_id: 'ora-cortex-braintied',
              record_type: 'research_report',
              record_id: '11111111-1111-4111-8111-111111111111',
            },
          }],
          coverage: {
            evidenceCount: 1,
            uniqueSourceCount: 1,
            byMode: {
              cortex: { evidenceCount: 1, uniqueSourceCount: 1 },
            },
            bySourcePack: {
              'parlor-cortex-design-prior': {
                evidenceCount: 1,
                uniqueSourceCount: 1,
              },
            },
          },
          failures: [],
        },
        trustedLocalAppendix: {
          visibility: 'trusted_local',
          handling: {
            access: 'authenticated_agent_only',
            externalProviderUse: 'prohibited',
            publicReportUse: 'prohibited',
            storage: 'restricted',
          },
          adapterId: 'ora-cortex-braintied',
          profileRef: 'web-design-intelligence@1',
          asOf: '2026-07-22',
          totalEvidenceCount: 1,
          includedFindingCount: 1,
          truncated: false,
          limits: {
            maxFindings: 20,
            maxExcerptCharacters: 1200,
            maxResourceUrlsPerFinding: 8,
          },
          findings: [{
            id: `ev_${'b'.repeat(24)}`,
            contentSha256: 'c'.repeat(64),
            sourceRef:
              'cortex://research-reports/11111111-1111-4111-8111-111111111111',
            contentRef:
              'cortex://research-reports/11111111-1111-4111-8111-111111111111',
            title: 'Private design precedent',
            author: null,
            publishedAt: '2026-07-20T12:00:00.000Z',
            retrievedAt: '2026-07-23T08:00:00.000Z',
            lane: 'private_cortex',
            sourcePackId: 'parlor-cortex-design-prior',
            resourceUrls: ['https://example.com/design-precedent'],
            excerpt: 'TRUSTED-LOCAL-FINDING',
          }],
        },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  const result = await runRunner([
    '--brief', 'Research beautiful sunny website design resources.',
    '--kind', 'deep',
    '--max-cost-usd', '5',
    '--profile', 'web-design-intelligence@1',
    '--profile-mode', 'snapshot',
    '--as-of', '2026-07-22',
    '--endpoint', `http://127.0.0.1:${address.port}/internal/tools/execute`,
    '--timeout-seconds', '5',
    '--output', reportPath,
    '--metadata', metadataPath,
    '--trusted-output', trustedOutputPath,
    '--allow-external',
  ], { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_profile_test' });

  assert.equal(result.status, 0, result.stderr);
  const report = await readFile(reportPath, 'utf8');
  assert.match(report, /Public profile result/);
  assert.doesNotMatch(report, /cortex:\/\/|privateManifest|private_manifest/);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
    profile_ref: string;
    as_of: string;
    program_status: string;
    private_manifest: {
      visibility: string;
      evidence: Array<{ sourcePackId: string }>;
    };
    trusted_output: string;
  };
  assert.equal(metadata.profile_ref, 'web-design-intelligence@1');
  assert.equal(metadata.as_of, '2026-07-22');
  assert.equal(metadata.program_status, 'complete');
  assert.equal(metadata.private_manifest.visibility, 'trusted_local');
  assert.equal(
    metadata.private_manifest.evidence[0]?.sourcePackId,
    'parlor-cortex-design-prior',
  );
  assert.equal(metadata.trusted_output, trustedOutputPath);
  assert.doesNotMatch(
    JSON.stringify(metadata),
    /TRUSTED-LOCAL-FINDING|excerpt/,
  );
  const trustedArtifact = JSON.parse(
    await readFile(trustedOutputPath, 'utf8'),
  ) as {
    schema_version: number;
    appendix: {
      handling: { externalProviderUse: string };
      findings: Array<{ excerpt: string }>;
    };
  };
  assert.equal(trustedArtifact.schema_version, 1);
  assert.equal(
    trustedArtifact.appendix.handling.externalProviderUse,
    'prohibited',
  );
  assert.equal(
    trustedArtifact.appendix.findings[0]?.excerpt,
    'TRUSTED-LOCAL-FINDING',
  );
  assert.equal((await stat(trustedOutputPath)).mode & 0o777, 0o600);
});

test('profile runner rejects unknown private-text fields in a server manifest', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'braintied-profile-leak-'));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/internal/tools') {
      sendDurableCatalog(response);
      return;
    }
    if (request.method === 'POST' && request.url === '/internal/tools/runs') {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        run: {
          id: DURABLE_RUN_ID,
          requestId: request.headers['x-request-id'],
          status: 'queued',
          pollAfterMs: 250,
        },
      }));
      return;
    }
    assert.equal(request.method, 'GET');
    assert.equal(request.url, `/internal/tools/runs/${DURABLE_RUN_ID}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      result: {
        kind: 'deep',
        engine: 'pipeline',
        report: {
          full_markdown: '# Public result',
          sections: [],
          bibliography: [],
          gaps: [],
          word_count: 2,
        },
        privateManifest: {
          visibility: 'trusted_local',
          adapterId: 'ora-cortex-braintied',
          dataBoundary: 'public_report_and_private_manifest_separate',
          profileRef: 'web-design-intelligence@1',
          asOf: '2026-07-22',
          evidence: [{
            id: `ev_${'b'.repeat(24)}`,
            contentSha256: 'c'.repeat(64),
            sourceRef:
              'cortex://research-reports/11111111-1111-4111-8111-111111111111',
            contentRef:
              'cortex://research-reports/11111111-1111-4111-8111-111111111111',
            publishedAt: '2026-07-20T12:00:00.000Z',
            retrievedAt: '2026-07-23T08:00:00.000Z',
            lane: 'private_cortex',
            sourcePackId: 'parlor-cortex-design-prior',
            visibility: 'private',
            lineage: {
              adapter_id: 'ora-cortex-braintied',
              record_type: 'research_report',
              record_id: '11111111-1111-4111-8111-111111111111',
            },
            excerpt: 'PRIVATE-MUST-NOT-BE-WRITTEN',
          }],
          coverage: {
            evidenceCount: 1,
            uniqueSourceCount: 1,
            byMode: {
              cortex: { evidenceCount: 1, uniqueSourceCount: 1 },
            },
            bySourcePack: {
              'parlor-cortex-design-prior': {
                evidenceCount: 1,
                uniqueSourceCount: 1,
              },
            },
          },
          failures: [],
        },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  const result = await runRunner([
    '--brief', 'Research beautiful sunny website design resources.',
    '--kind', 'deep',
    '--max-cost-usd', '5',
    '--profile', 'web-design-intelligence@1',
    '--as-of', '2026-07-22',
    '--endpoint', `http://127.0.0.1:${address.port}/internal/tools/execute`,
    '--timeout-seconds', '5',
    '--output', path.join(temporaryDirectory, 'report.md'),
    '--metadata', path.join(temporaryDirectory, 'metadata.json'),
    '--trusted-output', path.join(temporaryDirectory, 'trusted.json'),
    '--allow-external',
  ], { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_profile_test' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /private-manifest evidence reference contains unsupported fields/);
  assert.equal(result.stderr.includes('PRIVATE-MUST-NOT-BE-WRITTEN'), false);
});

test('live internal runner reattaches to a durable run after submission transport loss', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'braintied-heartbeat-'));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });
  const reportPath = path.join(temporaryDirectory, 'report.md');
  const metadataPath = path.join(temporaryDirectory, 'metadata.json');

  let submissionAttempts = 0;
  let statusReads = 0;
  let acceptedRequestId: string | undefined;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer sat_heartbeat_test');
    if (request.method === 'GET' && request.url === '/internal/tools') {
      sendDurableCatalog(response);
      return;
    }
    if (request.method === 'GET'
        && request.url === `/internal/tools/runs/${DURABLE_RUN_ID}`) {
      statusReads += 1;
      response.writeHead(statusReads === 1 ? 202 : 200, {
        'content-type': 'application/json',
      });
      if (statusReads === 1) {
        response.end(JSON.stringify({
          ok: true,
          run: {
            id: DURABLE_RUN_ID,
            requestId: acceptedRequestId,
            status: 'running',
            pollAfterMs: 250,
          },
        }));
        return;
      }
      response.end(JSON.stringify({
        ok: true,
        tool: 'research.run',
        result: {
          kind: 'quick',
          engine: 'pipeline',
          report: {
            title: 'Durable result',
            executive_summary: 'The run survived a lost submission response.',
            full_markdown: '# Durable result\n\nThe run survived a lost submission response.',
            sections: [],
            bibliography: [],
            gaps: [],
            word_count: 9,
          },
          grounding: {
            ratio: 0,
            total_citations: 0,
            valid_citations: 0,
            hallucinated: [],
            status: 'ungrounded',
          },
          costUsd: 0,
          appliedMaxCostUsd: 0.25,
          quoteCount: 0,
          briefSha256: 'a'.repeat(64),
        },
        meta: {
          requestId: acceptedRequestId,
          runId: DURABLE_RUN_ID,
          durationMs: 20,
          durable: true,
        },
      }));
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/internal/tools/runs');
    let requestBody = '';
    for await (const chunk of request) requestBody += chunk.toString();
    const parsed = JSON.parse(requestBody) as { tool: string; input: { kind: string } };
    assert.equal(parsed.tool, 'research.run');
    assert.equal(parsed.input.kind, 'quick');
    submissionAttempts += 1;
    const requestId = request.headers['x-request-id'];
    assert.equal(typeof requestId, 'string');
    if (acceptedRequestId === undefined) acceptedRequestId = requestId;
    assert.equal(requestId, acceptedRequestId);
    if (submissionAttempts === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      run: {
        id: DURABLE_RUN_ID,
        requestId,
        status: 'queued',
        pollAfterMs: 250,
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  const result = await runRunner([
    '--brief', 'Prove a streamed heartbeat response remains valid JSON.',
    '--kind', 'quick',
    '--max-cost-usd', '0.25',
    '--endpoint', `http://127.0.0.1:${address.port}/internal/tools/execute`,
    '--timeout-seconds', '5',
    '--output', reportPath,
    '--metadata', metadataPath,
    '--allow-external',
  ], { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_heartbeat_test' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(reportPath, 'utf8'), /Durable result/);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
    timeout_seconds: number;
    durable_run_id: string;
    execution_protocol: string;
  };
  assert.equal(metadata.timeout_seconds, 5);
  assert.equal(metadata.durable_run_id, DURABLE_RUN_ID);
  assert.equal(metadata.execution_protocol, '2');
  assert.equal(submissionAttempts, 2);
  assert.equal(statusReads, 2);
});

test('an interrupted live runner preserves its generated request ID and reattaches explicitly', {
  timeout: 15_000,
}, async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'braintied-interrupted-'));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });
  const reportPath = path.join(temporaryDirectory, 'report.md');
  const metadataPath = path.join(temporaryDirectory, 'metadata.json');
  const token = 'sat_interrupted_test';
  const brief = 'Prove a locally interrupted paid run can reattach without duplicate execution.';

  let acceptedRequestId: string | undefined;
  let completeStatus = false;
  let firstStatusSeenResolve: (() => void) | undefined;
  const firstStatusSeen = new Promise<void>((resolve) => {
    firstStatusSeenResolve = resolve;
  });
  const submissionRequestIds: string[] = [];
  const submissionCheckpointStatuses: string[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.method === 'GET' && request.url === '/internal/tools') {
      sendDurableCatalog(response);
      return;
    }
    if (request.method === 'POST' && request.url === '/internal/tools/runs') {
      const requestId = request.headers['x-request-id'];
      assert.equal(typeof requestId, 'string');
      acceptedRequestId ??= requestId;
      assert.equal(requestId, acceptedRequestId);
      submissionRequestIds.push(requestId);

      const checkpoint = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        artifact_type: string;
        schema_version: number;
        request_id: string;
        durable_run_id: string | null;
        checkpoint_status: string;
      };
      assert.equal(checkpoint.artifact_type, 'braintied_internal_research_checkpoint');
      assert.equal(checkpoint.schema_version, 1);
      assert.equal(checkpoint.request_id, requestId);
      assert.equal(checkpoint.durable_run_id, null);
      submissionCheckpointStatuses.push(checkpoint.checkpoint_status);

      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        run: {
          id: DURABLE_RUN_ID,
          requestId,
          status: 'running',
          pollAfterMs: 250,
        },
      }));
      return;
    }

    assert.equal(request.method, 'GET');
    assert.equal(request.url, `/internal/tools/runs/${DURABLE_RUN_ID}`);
    if (!completeStatus) {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        run: {
          id: DURABLE_RUN_ID,
          requestId: acceptedRequestId,
          status: 'running',
          pollAfterMs: 250,
        },
      }));
      firstStatusSeenResolve?.();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      result: {
        kind: 'quick',
        engine: 'pipeline',
        report: {
          full_markdown: '# Resumed result\n\nThe original durable run completed.',
          bibliography: [],
          gaps: [],
          word_count: 7,
        },
        grounding: {
          ratio: 0,
          total_citations: 0,
          valid_citations: 0,
          hallucinated: [],
          status: 'ungrounded',
        },
        costUsd: 0.1,
        appliedMaxCostUsd: 0.25,
        quoteCount: 0,
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}/internal/tools/execute`;
  const baseArgs = [
    '--brief', brief,
    '--kind', 'quick',
    '--max-cost-usd', '0.25',
    '--endpoint', endpoint,
    '--timeout-seconds', '10',
    '--output', reportPath,
    '--metadata', metadataPath,
    '--allow-external',
  ];

  const interruptedChild = spawn(process.execPath, [runner, ...baseArgs], {
    cwd: packageRoot,
    env: { ...process.env, BRAINTIED_AGENT_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { interruptedChild.kill('SIGKILL'); });
  let interruptedStderr = '';
  interruptedChild.stderr.setEncoding('utf8');
  interruptedChild.stderr.on('data', (chunk: string) => {
    interruptedStderr += chunk;
  });
  const interruptedClose = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      interruptedChild.once('error', reject);
      interruptedChild.once('close', (status, signal) => resolve({ status, signal }));
    },
  );

  await firstStatusSeen;
  assert.equal(interruptedChild.kill('SIGINT'), true);
  const interrupted = await interruptedClose;
  assert.equal(interrupted.status, null);
  assert.equal(interrupted.signal, 'SIGINT');
  assert.ok(acceptedRequestId);
  assert.match(acceptedRequestId, /^[0-9a-f-]{36}$/i);
  assert.match(interruptedStderr, /"event":"braintied_internal_research_checkpoint"/);
  assert.match(interruptedStderr, new RegExp(`--request-id ${acceptedRequestId}`));

  const interruptedMetadataText = await readFile(metadataPath, 'utf8');
  const interruptedMetadata = JSON.parse(interruptedMetadataText) as {
    artifact_type: string;
    request_id: string;
    durable_run_id: string;
    execution_protocol: string;
    checkpoint_status: string;
    durable_run_status: string;
  };
  assert.equal(interruptedMetadata.artifact_type, 'braintied_internal_research_checkpoint');
  assert.equal(interruptedMetadata.request_id, acceptedRequestId);
  assert.equal(interruptedMetadata.durable_run_id, DURABLE_RUN_ID);
  assert.equal(interruptedMetadata.execution_protocol, '2');
  assert.equal(interruptedMetadata.checkpoint_status, 'awaiting_terminal_result');
  assert.equal(interruptedMetadata.durable_run_status, 'running');
  assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
  assert.equal(interruptedMetadataText.includes(token), false);
  assert.equal(interruptedMetadataText.includes(brief), false);

  completeStatus = true;
  const resumed = await runRunner([
    ...baseArgs,
    '--request-id', acceptedRequestId,
  ], { ...process.env, BRAINTIED_AGENT_TOKEN: token });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stderr, new RegExp(`--request-id ${acceptedRequestId}`));
  assert.match(await readFile(reportPath, 'utf8'), /original durable run completed/);
  const completedMetadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
    request_id: string;
    durable_run_id: string;
    execution_protocol: string;
  };
  assert.equal(completedMetadata.request_id, acceptedRequestId);
  assert.equal(completedMetadata.durable_run_id, DURABLE_RUN_ID);
  assert.equal(completedMetadata.execution_protocol, '2');
  assert.deepEqual(submissionRequestIds, [acceptedRequestId, acceptedRequestId]);
  assert.deepEqual(submissionCheckpointStatuses, ['submission_pending', 'submission_pending']);
});

test('live internal runner preserves a sanitized transport diagnostic and request ID', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'braintied-transport-'));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/internal/tools') {
      sendDurableCatalog(response);
      return;
    }
    request.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  const result = await runRunner([
    '--brief', 'Prove transport failures remain diagnosable without leaking secrets.',
    '--kind', 'quick',
    '--max-cost-usd', '0.25',
    '--endpoint', `http://127.0.0.1:${address.port}/internal/tools/execute`,
    '--timeout-seconds', '5',
    '--request-id', 'request-transport-1',
    '--output', path.join(temporaryDirectory, 'report.md'),
    '--metadata', path.join(temporaryDirectory, 'metadata.json'),
    '--allow-external',
  ], { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_transport_test' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /submission timed out/);
  assert.match(result.stderr, /request request-transport-1; last transport TypeError(?:\/[A-Z0-9_]+)?/);
  assert.match(result.stderr, /--request-id request-transport-1/);
  assert.equal(result.stderr.includes('sat_transport_test'), false);
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

test('authenticated catalog probe confirms research.run is deployed', async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer sat_probe_test');
    sendDurableCatalog(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  const result = await runRunner([
    '--check', '--probe',
    '--kind', 'quick',
    '--max-cost-usd', '1',
    '--endpoint', `http://127.0.0.1:${address.port}/internal/tools/execute`,
  ], { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_probe_test' });

  assert.equal(result.status, 0, result.stderr);
  const check = JSON.parse(result.stdout) as {
    ready: boolean;
    probe: {
      http_status: number;
      research_run_available: boolean;
      durable_execution: { mode: string };
    };
  };
  assert.equal(check.ready, true);
  assert.equal(check.probe.http_status, 200);
  assert.equal(check.probe.research_run_available, true);
  assert.equal(check.probe.durable_execution.mode, 'durable-polling');
});

test('catalog probe rejects legacy streaming-only execution', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      protocolVersion: '1',
      tools: [{ name: 'research.run', version: '1' }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  const result = await runRunner([
    '--check', '--probe',
    '--kind', 'quick',
    '--max-cost-usd', '1',
    '--endpoint', `http://127.0.0.1:${address.port}/internal/tools/execute`,
  ], { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_probe_test' });

  assert.equal(result.status, 2, result.stderr);
  const check = JSON.parse(result.stdout) as {
    ready: boolean;
    probe: { error: string };
  };
  assert.equal(check.ready, false);
  assert.match(check.probe.error, /does not advertise durable research execution/);
});

test('catalog probe fails readiness when deployment returns 404 HTML', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<h1>Not Found</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  const result = await runRunner([
    '--check', '--probe',
    '--kind', 'quick',
    '--max-cost-usd', '1',
    '--endpoint', `http://127.0.0.1:${address.port}/internal/tools/execute`,
  ], { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_probe_test' });

  assert.equal(result.status, 2, result.stderr);
  const check = JSON.parse(result.stdout) as {
    ready: boolean;
    probe: { http_status: number; error: string };
  };
  assert.equal(check.ready, false);
  assert.equal(check.probe.http_status, 404);
  assert.match(check.probe.error, /invalid JSON/);
});
