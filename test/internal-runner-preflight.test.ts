import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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

  const server = createServer((_request, response) => {
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

test('live internal runner accepts whitespace heartbeats before the final JSON envelope', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'braintied-heartbeat-'));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });
  const reportPath = path.join(temporaryDirectory, 'report.md');
  const metadataPath = path.join(temporaryDirectory, 'metadata.json');

  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/internal/tools/execute');
    assert.equal(request.headers.authorization, 'Bearer sat_heartbeat_test');
    let requestBody = '';
    for await (const chunk of request) requestBody += chunk.toString();
    const parsed = JSON.parse(requestBody) as { tool: string; input: { kind: string } };
    assert.equal(parsed.tool, 'research.run');
    assert.equal(parsed.input.kind, 'quick');

    response.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' });
    response.write(' \n');
    setTimeout(() => {
      response.end(JSON.stringify({
        ok: true,
        tool: 'research.run',
        result: {
          kind: 'quick',
          engine: 'pipeline',
          report: {
            title: 'Heartbeat result',
            executive_summary: 'The connection stayed open.',
            full_markdown: '# Heartbeat result\n\nThe connection stayed open.',
            sections: [],
            bibliography: [],
            gaps: [],
            word_count: 6,
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
        meta: { requestId: 'heartbeat-request', durationMs: 20 },
      }));
    }, 20);
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
  assert.match(await readFile(reportPath, 'utf8'), /Heartbeat result/);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
    timeout_seconds: number;
  };
  assert.equal(metadata.timeout_seconds, 5);
});

test('live internal runner preserves a sanitized transport diagnostic and request ID', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'braintied-transport-'));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });
  const server = createServer((request) => {
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
    '--output', path.join(temporaryDirectory, 'report.md'),
    '--metadata', path.join(temporaryDirectory, 'metadata.json'),
    '--allow-external',
  ], { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_transport_test' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /connection closed before completion/);
  assert.match(result.stderr, /request [a-f0-9-]{36}; transport TypeError(?:\/[A-Z0-9_]+)?/);
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
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      protocolVersion: '1',
      tools: [{ name: 'research.run' }],
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

  assert.equal(result.status, 0, result.stderr);
  const check = JSON.parse(result.stdout) as {
    ready: boolean;
    probe: { http_status: number; research_run_available: boolean };
  };
  assert.equal(check.ready, true);
  assert.equal(check.probe.http_status, 200);
  assert.equal(check.probe.research_run_available, true);
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
