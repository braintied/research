import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EVIDENCE_GAP_NOTICE } from '../src/synthesis.js';
import {
  EVIDENCE_GAP_MARKER,
  assessEvidenceCoverage,
} from '../skills/run-braintied-research/scripts/evidence-coverage.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(
  packageRoot,
  'skills/run-braintied-research/scripts/run-internal-research.mjs',
);
const DURABLE_RUN_ID = '33333333-3333-4333-8333-333333333333';

function check(args: string[]) {
  return spawnSync(process.execPath, [runner, '--check', ...args], {
    cwd: packageRoot,
    env: { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_sources_test' },
    encoding: 'utf8',
  });
}

function section(heading: string, body: string, sourceUrls: string[]) {
  return {
    section_path: heading,
    heading,
    level: 2,
    body_md: body,
    source_urls: sourceUrls,
    inline_citations: [],
    word_count: body.split(/\s+/).length,
  };
}

test('the coverage marker matches the notice the engine actually writes', () => {
  // If synthesis ever rewords the gap notice, coverage silently reads every
  // report as complete. Pin the two together.
  assert.ok(EVIDENCE_GAP_NOTICE.includes(EVIDENCE_GAP_MARKER));
});

test('evidence coverage counts gap sections, not citations', () => {
  const report = {
    full_markdown: '',
    sections: [
      section('A', 'Formbricks is open source [^1].', ['https://github.com/formbricks/formbricks']),
      section('B', EVIDENCE_GAP_NOTICE, []),
      section('C', EVIDENCE_GAP_NOTICE, []),
    ],
  };
  const coverage = assessEvidenceCoverage(report);
  assert.equal(coverage.status, 'thin');
  assert.equal(coverage.passed, false);
  assert.equal(coverage.sections_total, 3);
  assert.equal(coverage.sections_with_evidence, 1);
  assert.equal(coverage.evidence_gap_sections, 2);
  assert.deepEqual(coverage.gap_headings, ['B', 'C']);
});

test('evidence coverage falls back to rendered markdown and skips summary/bibliography', () => {
  const markdown = [
    '# Evidence-Bound Research Report',
    '## Executive Summary', 'Summary.',
    '## Research Findings 1', 'Fact [^1].',
    '## Research Findings 2', 'Fact [^2].',
    '## Research Findings 3', 'Fact [^1].',
    '## Research Findings 4', 'Fact [^2].',
    '## Research Findings 5', EVIDENCE_GAP_NOTICE,
    '## Bibliography', '[^1]: https://a.example', '[^2]: https://b.example',
  ].join('\n\n');
  const coverage = assessEvidenceCoverage(markdown);
  assert.equal(coverage.sections_total, 5);
  assert.equal(coverage.evidence_gap_sections, 1);
  assert.equal(coverage.status, 'complete');
  assert.equal(coverage.passed, true);
});

test('a report with no sections is empty, never complete', () => {
  const coverage = assessEvidenceCoverage({ full_markdown: '# Title\n\nNothing.', sections: [] });
  assert.equal(coverage.status, 'empty');
  assert.equal(coverage.passed, false);
  assert.equal(coverage.ratio, null);
});

test('internal preflight reports requested source lanes', () => {
  const result = check([
    '--kind', 'standard', '--max-cost-usd', '2',
    '--sources', 'web,github', '--as-of', '2026-09-24',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { requested_source_modes: string[]; requested_as_of: string };
  assert.deepEqual(parsed.requested_source_modes, ['web', 'github']);
  assert.equal(parsed.requested_as_of, '2026-09-24');
});

test('--sources without --as-of fails closed', () => {
  const result = check(['--kind', 'standard', '--max-cost-usd', '2', '--sources', 'web,github']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--as-of is required with --sources/);
});

test('--sources refuses unknown, repeated, and trusted-only lanes', () => {
  const base = ['--kind', 'standard', '--max-cost-usd', '2', '--as-of', '2026-09-24'];
  assert.match(check([...base, '--sources', 'web,gitlab']).stderr, /Unknown --sources value\(s\): gitlab/);
  assert.match(check([...base, '--sources', 'web,web']).stderr, /must not repeat/);
  assert.match(check([...base, '--sources', 'cortex,telegram']).stderr, /at least one public lane/);
});

test('--as-of alone still requires --profile or --sources', () => {
  const result = check(['--kind', 'standard', '--max-cost-usd', '2', '--as-of', '2026-09-24']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--as-of requires --profile or --sources/);
});

test('a live run forwards sourceModes and records thin evidence coverage', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'braintied-sources-'));
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });
  const reportPath = path.join(temporaryDirectory, 'report.md');
  const metadataPath = path.join(temporaryDirectory, 'metadata.json');

  let submittedInput: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/internal/tools') {
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
      return;
    }
    const requestId = request.headers['x-request-id'];
    if (request.method === 'POST' && request.url === '/internal/tools/runs') {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      submittedInput = (JSON.parse(body) as { input: Record<string, unknown> }).input;
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        run: { id: DURABLE_RUN_ID, requestId, status: 'queued', pollAfterMs: 250 },
      }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    const sections = [
      section('Licenses', 'Formbricks is AGPL-3.0 [^1].', ['https://github.com/formbricks/formbricks']),
      section('Kanban', EVIDENCE_GAP_NOTICE, []),
      section('Webhooks', EVIDENCE_GAP_NOTICE, []),
    ];
    response.end(JSON.stringify({
      ok: true,
      tool: 'research.run',
      result: {
        kind: 'standard',
        engine: 'pipeline',
        report: {
          title: 'Evidence-Bound Research Report',
          executive_summary: 'One of three sections has evidence.',
          full_markdown: '# Evidence-Bound Research Report\n\nOne of three sections has evidence.',
          sections,
          bibliography: ['https://github.com/formbricks/formbricks'],
          gaps: [],
          word_count: 40,
        },
        grounding: {
          ratio: 1, total_citations: 1, valid_citations: 1, hallucinated: [],
          status: 'validated', quality: 'strong', passed: true,
        },
        costUsd: 0.1,
        appliedMaxCostUsd: 2,
        quoteCount: 1,
        briefSha256: 'b'.repeat(64),
        programStatus: 'complete',
        sourceCoverage: { passed: true, entries: [] },
      },
      meta: { requestId, runId: DURABLE_RUN_ID, durationMs: 20, durable: true },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [
        runner,
        '--brief', 'Compare open-source feedback widgets by license and activity.',
        '--kind', 'standard',
        '--max-cost-usd', '2',
        '--sources', 'web,github',
        '--as-of', '2026-09-24',
        '--endpoint', `http://127.0.0.1:${address.port}/internal/tools/execute`,
        '--timeout-seconds', '5',
        '--output', reportPath,
        '--metadata', metadataPath,
        '--allow-external',
      ], {
        cwd: packageRoot,
        env: { ...process.env, BRAINTIED_AGENT_TOKEN: 'sat_sources_test' },
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
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(submittedInput !== undefined);
  assert.deepEqual(submittedInput.sourceModes, ['web', 'github']);
  assert.equal(submittedInput.asOf, '2026-09-24');

  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
    source_modes: string[];
    grounding_quality: string;
    evidence_coverage: { status: string; sections_total: number; evidence_gap_sections: number };
  };
  assert.deepEqual(metadata.source_modes, ['web', 'github']);
  // Grounding stays "strong" — the one citation is real — and coverage says
  // what grounding cannot: two of three sections are empty.
  assert.equal(metadata.grounding_quality, 'strong');
  assert.equal(metadata.evidence_coverage.status, 'thin');
  assert.equal(metadata.evidence_coverage.sections_total, 3);
  assert.equal(metadata.evidence_coverage.evidence_gap_sections, 2);

  const summary = JSON.parse(result.stdout) as { evidence_coverage_status: string };
  assert.equal(summary.evidence_coverage_status, 'thin');
  assert.match(result.stderr, /braintied_internal_research_thin_report/);
});
