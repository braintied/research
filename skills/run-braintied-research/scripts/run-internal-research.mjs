#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { assessGrounding } from './grounding-quality.mjs';

const VALID_KINDS = ['answer', 'quick', 'standard', 'deep', 'managed', 'social'];
const VALID_PROFILE_MODES = ['snapshot', 'update', 'monitor'];
const PIPELINE_KINDS = new Set(['quick', 'standard', 'deep', 'social']);
const DEFAULT_ENDPOINT = 'https://ora-cortex-worker.fly.dev/internal/tools/execute';
const DEFAULT_KEYCHAIN_SERVICE = 'braintied-agent-auth';
const DEFAULT_KEYCHAIN_ACCOUNT = 'codex';
const CHECKPOINT_SCHEMA_VERSION = 1;
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGE_JSON = path.join(PACKAGE_ROOT, 'package.json');
const execFileAsync = promisify(execFile);

const USAGE = `Usage:
  run-internal-research.mjs --check --kind <kind> [--max-cost-usd <number>]
  run-internal-research.mjs --brief-file <path> --kind <kind> [options]

Options:
  --brief-file <path>       UTF-8 research brief (recommended)
  --brief <text>            Inline brief; avoid for sensitive or complex text
  --kind <kind>             answer|quick|standard|deep|managed|social
                            (default: standard)
  --max-cost-usd <number>   Required for pipeline kinds; must be > 0
  --synthesis-model <id>    Optional server-supported synthesis override
  --recency-days <integer>  Recency window for answer or pipeline searches
  --profile <id@version>    Versioned investigation profile
  --profile-mode <mode>     snapshot|update|monitor (requires --profile)
  --as-of <ISO date/time>   Exact evidence boundary (required with --profile)
  --endpoint <url>          Internal tool endpoint
  --timeout-seconds <n>     Request timeout, 1-3600
                            (default: 3600 for deep, 1200 otherwise)
  --request-id <id>         Optional durable idempotency key for resuming a run
  --keychain-service <name> macOS Keychain service (default: braintied-agent-auth)
  --keychain-account <name> macOS Keychain account (default: codex)
  --output <path>           Required Markdown report output
  --metadata <path>         Required private JSON checkpoint/final metadata output
  --trusted-output <path>   Required for live profile runs; chmod-0600 JSON
                            trusted-local appendix (never public Markdown)
  --allow-external          Acknowledge that the brief goes to external services
  --check, --dry-run        Auth/configuration preflight; local unless --probe is set
  --probe                   With --check, authenticate and verify the remote tool catalog
  --help                    Show this help

Authentication:
  BRAINTIED_AGENT_TOKEN is used when inherited by the process. Otherwise, on
  macOS the token is read from Keychain using the configured service/account.
  Token values are never printed, written to result metadata, or put in argv.
`;

function parseCli() {
  return parseArgs({
    options: {
      help: { type: 'boolean' },
      check: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      probe: { type: 'boolean' },
      'brief-file': { type: 'string' },
      brief: { type: 'string' },
      kind: { type: 'string', default: 'standard' },
      'max-cost-usd': { type: 'string' },
      'synthesis-model': { type: 'string' },
      'recency-days': { type: 'string' },
      profile: { type: 'string' },
      'profile-mode': { type: 'string' },
      'as-of': { type: 'string' },
      endpoint: { type: 'string' },
      'timeout-seconds': { type: 'string' },
      'request-id': { type: 'string' },
      'keychain-service': { type: 'string', default: DEFAULT_KEYCHAIN_SERVICE },
      'keychain-account': { type: 'string', default: DEFAULT_KEYCHAIN_ACCOUNT },
      output: { type: 'string' },
      metadata: { type: 'string' },
      'trusted-output': { type: 'string' },
      'allow-external': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  }).values;
}

function parsePositiveNumber(raw, label) {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a number greater than zero.`);
  }
  return parsed;
}

function parsePositiveInteger(raw, label) {
  const parsed = parsePositiveNumber(raw, label);
  if (parsed === undefined || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be a whole number greater than zero.`);
  }
  return parsed;
}

function parseProfileRef(raw) {
  if (raw === undefined) return undefined;
  if (!/^[a-z0-9][a-z0-9-]{2,80}@[1-9][0-9]*$/.test(raw)) {
    throw new Error('--profile must be a versioned profile reference such as web-design-intelligence@2.');
  }
  return raw;
}

function parseProfileMode(raw) {
  if (raw === undefined) return undefined;
  if (!VALID_PROFILE_MODES.includes(raw)) {
    throw new Error(`Unknown --profile-mode ${raw}. Expected one of: ${VALID_PROFILE_MODES.join(', ')}.`);
  }
  return raw;
}

function parseAsOf(raw) {
  if (raw === undefined) return undefined;
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const isTimestamp = /^\d{4}-\d{2}-\d{2}T/.test(raw);
  const parsed = new Date(isDate ? `${raw}T23:59:59.999Z` : raw);
  if ((!isDate && !isTimestamp) || Number.isNaN(parsed.getTime())) {
    throw new Error('--as-of must be an ISO date or timestamp.');
  }
  if (isDate && parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error('--as-of must be a real calendar date.');
  }
  return raw;
}

function parseRequestId(raw) {
  if (raw === undefined) return undefined;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(raw)) {
    throw new Error('--request-id must contain 1-128 URL-safe identifier characters.');
  }
  return raw;
}

function resolveEndpoint(raw) {
  const endpoint = new URL(raw ?? process.env.BRAINTIED_INTERNAL_TOOLS_URL ?? DEFAULT_ENDPOINT);
  if (endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('--endpoint must not contain credentials, a query, or a fragment.');
  }
  const httpAllowed = endpoint.hostname === 'localhost'
    || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === '::1'
    || endpoint.hostname.endsWith('.internal');
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && httpAllowed)) {
    throw new Error('--endpoint must use HTTPS (HTTP is allowed only for loopback or .internal hosts).');
  }
  return endpoint.toString();
}

function resolveCatalogEndpoint(executionEndpoint) {
  const catalog = new URL(executionEndpoint);
  catalog.pathname = catalog.pathname.replace(/\/execute\/?$/, '');
  return catalog.toString();
}

async function probeInternalCatalog({ endpoint, token, timeoutSeconds }) {
  const catalogEndpoint = resolveCatalogEndpoint(endpoint);
  let response;
  try {
    response = await fetch(catalogEndpoint, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': randomUUID(),
      },
      signal: AbortSignal.timeout(Math.min(timeoutSeconds, 15) * 1000),
    });
  } catch {
    return {
      ready: false,
      catalog_endpoint: catalogEndpoint,
      http_status: null,
      protocol_version: null,
      research_run_available: false,
      durable_execution: null,
      error: 'Internal tool catalog is unavailable.',
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      ready: false,
      catalog_endpoint: catalogEndpoint,
      http_status: response.status,
      protocol_version: null,
      research_run_available: false,
      durable_execution: null,
      error: `Internal tool catalog returned HTTP ${response.status} with invalid JSON.`,
    };
  }

  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const researchTool = tools.find((tool) => tool?.name === 'research.run');
  const researchRunAvailable = researchTool !== undefined;
  const execution = researchTool?.execution;
  const durableExecution = execution !== null && typeof execution === 'object'
    && execution.mode === 'durable-polling'
    && execution.submitPath === '/internal/tools/runs'
    && execution.statusPathTemplate === '/internal/tools/runs/{runId}'
    && Number.isSafeInteger(execution.pollAfterMs)
    && execution.pollAfterMs >= 250
    && execution.pollAfterMs <= 10_000
    && Number.isSafeInteger(execution.retentionHours)
    && execution.retentionHours >= 1;
  const ready = response.ok
    && payload?.ok === true
    && payload?.protocolVersion === '2'
    && researchRunAvailable
    && durableExecution;
  let error = null;
  if (!response.ok) error = `Internal tool catalog returned HTTP ${response.status}.`;
  else if (payload?.ok !== true) error = 'Internal tool catalog returned an invalid success envelope.';
  else if (!researchRunAvailable) error = 'Internal tool catalog does not advertise research.run.';
  else if (payload?.protocolVersion !== '2' || !durableExecution) {
    error = 'Internal tool catalog does not advertise durable research execution.';
  }

  return {
    ready,
    catalog_endpoint: catalogEndpoint,
    http_status: response.status,
    protocol_version: typeof payload?.protocolVersion === 'string' ? payload.protocolVersion : null,
    research_run_available: researchRunAvailable,
    durable_execution: durableExecution
      ? {
          mode: execution.mode,
          submit_path: execution.submitPath,
          status_path_template: execution.statusPathTemplate,
          poll_after_ms: execution.pollAfterMs,
          retention_hours: execution.retentionHours,
        }
      : null,
    error,
  };
}

async function packageVersion() {
  const parsed = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'));
  return typeof parsed.version === 'string' ? parsed.version : 'unknown';
}

async function resolveAgentToken(service, account) {
  const inherited = process.env.BRAINTIED_AGENT_TOKEN?.trim();
  if (inherited) return { token: inherited, source: 'environment:BRAINTIED_AGENT_TOKEN' };

  if (process.platform !== 'darwin') {
    return { token: null, source: 'missing' };
  }

  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password', '-w', '-s', service, '-a', account,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 });
    const token = stdout.trim();
    return token.length > 0
      ? { token, source: `keychain:${service}/${account}` }
      : { token: null, source: 'missing' };
  } catch {
    return { token: null, source: 'missing' };
  }
}

async function readBrief(values) {
  const briefFile = values['brief-file'];
  const inlineBrief = values.brief;
  if ((briefFile === undefined) === (inlineBrief === undefined)) {
    throw new Error('Provide exactly one of --brief-file or --brief.');
  }
  const brief = briefFile !== undefined
    ? await readFile(path.resolve(briefFile), 'utf8')
    : inlineBrief;
  if (brief.trim().length < 10) {
    throw new Error('Research brief must contain at least 10 non-whitespace characters.');
  }
  return brief.trim();
}

async function atomicWrite(targetPath, contents) {
  const absolute = path.resolve(targetPath);
  const directory = path.dirname(absolute);
  await mkdir(directory, { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, absolute);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
  return absolute;
}

async function writeStderrLine(value) {
  await new Promise((resolve, reject) => {
    process.stderr.write(`${value}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createResearchCheckpoint({
  packageVersion: currentPackageVersion,
  requestId,
  run,
  protocolVersion,
  startedAt,
  kind,
  maxCostUsd,
  recencyDays,
  profileRef,
  profileMode,
  asOf,
  timeoutSeconds,
}) {
  return {
    artifact_type: 'braintied_internal_research_checkpoint',
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    mode: 'internal',
    package_version: currentPackageVersion,
    request_id: requestId,
    durable_run_id: run?.id ?? null,
    execution_protocol: protocolVersion,
    checkpoint_status: run === null
      ? 'submission_pending'
      : 'awaiting_terminal_result',
    durable_run_status: run?.status ?? null,
    started_at: startedAt.toISOString(),
    updated_at: new Date().toISOString(),
    kind,
    requested_max_cost_usd: maxCostUsd ?? null,
    requested_recency_days: recencyDays ?? null,
    profile_ref: profileRef ?? null,
    profile_mode: profileMode ?? null,
    as_of: asOf ?? null,
    timeout_seconds: timeoutSeconds,
  };
}

function validateResult(payload) {
  if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
    throw new Error('Internal tool returned an invalid success envelope.');
  }
  const result = payload.result;
  if (result === null || typeof result !== 'object') {
    throw new Error('Internal tool response is missing its result.');
  }
  const report = result.report;
  if (report === null || typeof report !== 'object'
    || typeof report.full_markdown !== 'string'
    || report.full_markdown.trim().length === 0) {
    throw new Error('Internal research completed without a non-empty Markdown report.');
  }
  validatePrivateManifest(result.privateManifest);
  validateTrustedLocalAppendix(result.trustedLocalAppendix);
  return result;
}

function validatePrivateManifest(manifest) {
  if (manifest === undefined) return;
  if (manifest === null || typeof manifest !== 'object'
      || manifest.visibility !== 'trusted_local'
      || !boundedString(manifest.adapterId, 100)
      || manifest.dataBoundary !== 'public_report_and_private_manifest_separate'
      || (manifest.profileRef !== null
        && !boundedString(manifest.profileRef, 100))
      || (manifest.asOf !== null && !boundedString(manifest.asOf, 100))
      || !Array.isArray(manifest.evidence)
      || manifest.coverage === null
      || typeof manifest.coverage !== 'object'
      || !Array.isArray(manifest.failures)) {
    throw new Error('Internal research returned an invalid private manifest.');
  }

  exactObjectKeys(manifest, new Set([
    'visibility',
    'adapterId',
    'dataBoundary',
    'profileRef',
    'asOf',
    'evidence',
    'coverage',
    'failures',
  ]), 'private manifest');

  const evidenceKeys = new Set([
    'id',
    'contentSha256',
    'sourceRef',
    'contentRef',
    'publishedAt',
    'retrievedAt',
    'lane',
    'sourcePackId',
    'visibility',
    'lineage',
  ]);
  const lineageKeys = new Set([
    'adapter_id',
    'record_type',
    'record_id',
    'rank_score',
    'channel_id',
    'corpus_key',
  ]);
  for (const evidence of manifest.evidence) {
    if (evidence === null || typeof evidence !== 'object') {
      throw new Error('Internal research returned an invalid private-manifest evidence reference.');
    }
    exactObjectKeys(evidence, evidenceKeys, 'private-manifest evidence reference');
    if (!boundedString(evidence.id, 200)
        || typeof evidence.contentSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(evidence.contentSha256)
        || !boundedString(evidence.sourceRef, 2_000)
        || !boundedString(evidence.contentRef, 2_000)
        || (evidence.publishedAt !== null
          && !boundedString(evidence.publishedAt, 100))
        || !boundedString(evidence.retrievedAt, 100)
        || !['private_cortex', 'private_telegram'].includes(evidence.lane)
        || !boundedString(evidence.sourcePackId, 100)
        || !['private', 'restricted'].includes(evidence.visibility)
        || evidence.lineage === null
        || typeof evidence.lineage !== 'object') {
      throw new Error('Internal research returned an invalid private-manifest evidence reference.');
    }
    exactObjectKeys(evidence.lineage, lineageKeys, 'private-manifest lineage');
    for (const value of Object.values(evidence.lineage)) {
      const validValue = value === null
        || (typeof value === 'string' && Array.from(value).length <= 2_000)
        || (typeof value === 'number' && Number.isFinite(value));
      if (!validValue) {
        throw new Error('Internal research returned invalid private-manifest lineage.');
      }
    }
  }

  exactObjectKeys(manifest.coverage, new Set([
    'evidenceCount',
    'uniqueSourceCount',
    'byMode',
    'bySourcePack',
  ]), 'private-manifest coverage');
  if (!validCoverageCounts(manifest.coverage)
      || manifest.coverage.evidenceCount !== manifest.evidence.length
      || manifest.coverage.byMode === null
      || typeof manifest.coverage.byMode !== 'object'
      || manifest.coverage.bySourcePack === null
      || typeof manifest.coverage.bySourcePack !== 'object') {
    throw new Error('Internal research returned invalid private-manifest coverage.');
  }
  exactObjectKeys(
    manifest.coverage.byMode,
    new Set(['cortex', 'telegram']),
    'private-manifest mode coverage',
  );
  validateCoverageMap(manifest.coverage.byMode, 'private-manifest mode coverage');
  validateCoverageMap(
    manifest.coverage.bySourcePack,
    'private-manifest source-pack coverage',
  );

  for (const failure of manifest.failures) {
    if (failure === null || typeof failure !== 'object') {
      throw new Error('Internal research returned an invalid private-manifest failure.');
    }
    exactObjectKeys(
      failure,
      new Set(['mode', 'adapterId', 'error']),
      'private-manifest failure',
    );
    if (!['cortex', 'telegram'].includes(failure.mode)
        || (failure.adapterId !== null
          && !boundedString(failure.adapterId, 100))
        || !boundedString(failure.error, 500)
        || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(failure.error)) {
      throw new Error('Internal research returned an invalid private-manifest failure.');
    }
  }
}

function validCoverageCounts(value) {
  return Number.isSafeInteger(value.evidenceCount)
    && value.evidenceCount >= 0
    && Number.isSafeInteger(value.uniqueSourceCount)
    && value.uniqueSourceCount >= 0
    && value.uniqueSourceCount <= value.evidenceCount;
}

function validateCoverageMap(value, label) {
  for (const [key, counts] of Object.entries(value)) {
    if (!boundedString(key, 100)
        || counts === null
        || typeof counts !== 'object') {
      throw new Error(`Internal research returned invalid ${label}.`);
    }
    exactObjectKeys(
      counts,
      new Set(['evidenceCount', 'uniqueSourceCount']),
      label,
    );
    if (!validCoverageCounts(counts)) {
      throw new Error(`Internal research returned invalid ${label}.`);
    }
  }
}

function exactObjectKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Internal research ${label} contains unsupported fields.`);
  }
}

function boundedString(value, maxCharacters) {
  return typeof value === 'string' && Array.from(value).length <= maxCharacters;
}

function validateTrustedLocalAppendix(appendix) {
  if (appendix === undefined) return;
  if (appendix === null || typeof appendix !== 'object') {
    throw new Error('Internal research returned an invalid trusted-local appendix.');
  }
  exactObjectKeys(appendix, new Set([
    'visibility',
    'handling',
    'adapterId',
    'profileRef',
    'asOf',
    'totalEvidenceCount',
    'includedFindingCount',
    'truncated',
    'limits',
    'findings',
  ]), 'trusted-local appendix');
  if (appendix.visibility !== 'trusted_local'
      || !boundedString(appendix.adapterId, 100)
      || (appendix.profileRef !== null
        && !boundedString(appendix.profileRef, 100))
      || (appendix.asOf !== null && !boundedString(appendix.asOf, 100))
      || appendix.handling === null
      || typeof appendix.handling !== 'object'
      || appendix.handling.access !== 'authenticated_agent_only'
      || appendix.handling.externalProviderUse !== 'prohibited'
      || appendix.handling.publicReportUse !== 'prohibited'
      || appendix.handling.storage !== 'restricted'
      || appendix.limits === null
      || typeof appendix.limits !== 'object'
      || !Array.isArray(appendix.findings)) {
    throw new Error('Internal research returned an invalid trusted-local appendix.');
  }
  exactObjectKeys(appendix.handling, new Set([
    'access',
    'externalProviderUse',
    'publicReportUse',
    'storage',
  ]), 'trusted-local handling policy');
  exactObjectKeys(appendix.limits, new Set([
    'maxFindings',
    'maxExcerptCharacters',
    'maxResourceUrlsPerFinding',
  ]), 'trusted-local limits');
  const { maxFindings, maxExcerptCharacters, maxResourceUrlsPerFinding } = appendix.limits;
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1 || maxFindings > 20
      || !Number.isSafeInteger(maxExcerptCharacters)
      || maxExcerptCharacters < 1
      || maxExcerptCharacters > 1_200
      || !Number.isSafeInteger(maxResourceUrlsPerFinding)
      || maxResourceUrlsPerFinding < 1
      || maxResourceUrlsPerFinding > 8
      || !Number.isSafeInteger(appendix.totalEvidenceCount)
      || appendix.totalEvidenceCount < 0
      || !Number.isSafeInteger(appendix.includedFindingCount)
      || appendix.includedFindingCount < 0
      || appendix.includedFindingCount !== appendix.findings.length
      || appendix.includedFindingCount > maxFindings
      || appendix.totalEvidenceCount < appendix.includedFindingCount
      || appendix.truncated !== (
        appendix.includedFindingCount < appendix.totalEvidenceCount
      )) {
    throw new Error('Internal research returned an unbounded trusted-local appendix.');
  }

  const findingKeys = new Set([
    'id',
    'contentSha256',
    'sourceRef',
    'contentRef',
    'title',
    'author',
    'publishedAt',
    'retrievedAt',
    'lane',
    'sourcePackId',
    'resourceUrls',
    'excerpt',
  ]);
  for (const finding of appendix.findings) {
    if (finding === null || typeof finding !== 'object') {
      throw new Error('Internal research returned an invalid trusted-local finding.');
    }
    exactObjectKeys(finding, findingKeys, 'trusted-local finding');
    if (!boundedString(finding.id, 200)
        || typeof finding.contentSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(finding.contentSha256)
        || !boundedString(finding.sourceRef, 2_000)
        || !boundedString(finding.contentRef, 2_000)
        || (finding.title !== null && !boundedString(finding.title, 1_000))
        || (finding.author !== null && !boundedString(finding.author, 500))
        || (finding.publishedAt !== null
          && !boundedString(finding.publishedAt, 100))
        || !boundedString(finding.retrievedAt, 100)
        || !['private_cortex', 'private_telegram'].includes(finding.lane)
        || !boundedString(finding.sourcePackId, 100)
        || !Array.isArray(finding.resourceUrls)
        || finding.resourceUrls.length > maxResourceUrlsPerFinding
        || finding.resourceUrls.some((url) =>
          !boundedString(url, 2_000) || !/^https?:\/\//.test(url))
        || (finding.excerpt !== null
          && !boundedString(finding.excerpt, maxExcerptCharacters))) {
      throw new Error('Internal research returned an invalid trusted-local finding.');
    }
  }
}

function sanitizedTransportDiagnostic(error) {
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : 'UnknownError';
  const rawCauseCode = error !== null && typeof error === 'object'
    && 'cause' in error && error.cause !== null && typeof error.cause === 'object'
    && 'code' in error.cause
    ? error.cause.code
    : null;
  const causeCode = typeof rawCauseCode === 'string'
    && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCauseCode)
    ? rawCauseCode
    : null;
  return causeCode === null ? errorName : `${errorName}/${causeCode}`;
}

function resolveDurableEndpoints(endpoint, probe) {
  const durable = probe?.durable_execution;
  if (durable === null || durable === undefined) {
    throw new Error('Internal tool catalog did not provide durable research endpoints.');
  }
  const execution = new URL(endpoint);
  const submit = new URL(durable.submit_path, execution);
  if (submit.origin !== execution.origin
      || submit.username !== ''
      || submit.password !== ''
      || submit.search !== ''
      || submit.hash !== '') {
    throw new Error('Internal tool catalog returned an unsafe durable submission endpoint.');
  }
  return {
    submit: submit.toString(),
    status(runId) {
      const path = durable.status_path_template.replace('{runId}', encodeURIComponent(runId));
      const status = new URL(path, execution);
      if (status.origin !== execution.origin
          || status.username !== ''
          || status.password !== ''
          || status.search !== ''
          || status.hash !== '') {
        throw new Error('Internal tool catalog returned an unsafe durable status endpoint.');
      }
      return status.toString();
    },
    pollAfterMs: durable.poll_after_ms,
  };
}

function retryableHttpStatus(status) {
  return [404, 408, 425, 429, 502, 503, 504].includes(status);
}

function retryDelayMs(attempt, requestedMs = null) {
  if (Number.isSafeInteger(requestedMs) && requestedMs >= 250 && requestedMs <= 10_000) {
    return requestedMs;
  }
  return Math.min(5_000, 500 * (2 ** Math.min(attempt, 4)));
}

async function waitForRetry(delayMs, deadlineMs) {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
}

function boundedServerMessage(response, payload) {
  const serverMessage = payload?.error?.message;
  if (typeof serverMessage === 'string' && serverMessage.length <= 500) {
    return serverMessage;
  }
  return response.ok
    ? 'Internal tool returned a failed execution envelope.'
    : `Internal tool returned HTTP ${response.status}.`;
}

async function fetchDurableJson({ url, method, token, requestId, body, deadlineMs }) {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return { kind: 'deadline' };
  try {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-request-id': requestId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, remainingMs))),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { kind: 'invalid-json', response };
    }
    return { kind: 'response', response, payload };
  } catch (error) {
    return {
      kind: 'transport',
      diagnostic: sanitizedTransportDiagnostic(error),
    };
  }
}

async function submitDurableResearch({
  endpoint,
  token,
  requestId,
  input,
  deadlineMs,
}) {
  let attempt = 0;
  let lastDiagnostic = 'UnknownError';
  while (Date.now() < deadlineMs) {
    const outcome = await fetchDurableJson({
      url: endpoint,
      method: 'POST',
      token,
      requestId,
      body: { tool: 'research.run', input },
      deadlineMs,
    });
    if (outcome.kind === 'response') {
      const { response, payload } = outcome;
      const run = payload?.run;
      const validRun = payload?.ok === true
        && run !== null
        && typeof run === 'object'
        && typeof run.id === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(run.id)
        && run.requestId === requestId
        && ['queued', 'running', 'completed', 'failed'].includes(run.status);
      if ((response.status === 202 || response.status === 200) && validRun) {
        return run;
      }
      // Admission / deploy pauses are operator-actionable — do not spin for the full
      // deadline while the local checkpoint stays submission_pending (2026-08-01).
      const errorCode = payload?.error?.code;
      if (
        response.status === 429
        && (errorCode === 'ADMISSION_LIMIT_REACHED'
          || errorCode === 'ADMISSION_PAUSED')
      ) {
        throw new Error(
          `${boundedServerMessage(response, payload)} (${errorCode}). `
            + 'Raise ora_core.internal_tool_admission_policies limits or wait for the '
            + 'daily reserved-cost window to roll, then re-run with the same --request-id.',
        );
      }
      if (!retryableHttpStatus(response.status)) {
        throw new Error(boundedServerMessage(response, payload));
      }
      lastDiagnostic = `HTTP_${response.status}${errorCode ? `_${errorCode}` : ''}`;
      // Surface retry progress so operators see the hang is admission/retry, not silence.
      if (attempt === 0 || attempt % 5 === 0) {
        process.stderr.write(
          `run-braintied-internal-research: submit retry attempt=${attempt} diagnostic=${lastDiagnostic} request=${requestId}\n`,
        );
      }
    } else if (outcome.kind === 'invalid-json') {
      if (!retryableHttpStatus(outcome.response.status)) {
        throw new Error(`Internal durable submission returned HTTP ${outcome.response.status} with invalid JSON.`);
      }
      lastDiagnostic = `HTTP_${outcome.response.status}_INVALID_JSON`;
    } else if (outcome.kind === 'transport') {
      lastDiagnostic = outcome.diagnostic;
    }
    await waitForRetry(retryDelayMs(attempt), deadlineMs);
    attempt += 1;
  }
  throw new Error(
    `Internal research submission timed out (request ${requestId}; last transport ${lastDiagnostic}). Re-run with --request-id ${requestId} to resume the same durable run.`,
  );
}

async function pollDurableResearch({
  endpoint,
  token,
  requestId,
  runId,
  pollAfterMs,
  deadlineMs,
}) {
  let attempt = 0;
  let lastDiagnostic = 'UnknownError';
  while (Date.now() < deadlineMs) {
    const outcome = await fetchDurableJson({
      url: endpoint,
      method: 'GET',
      token,
      requestId,
      deadlineMs,
    });
    if (outcome.kind === 'response') {
      const { response, payload } = outcome;
      if (response.status === 200 && payload?.ok === true) {
        return validateResult(payload);
      }
      if (response.status === 202
          && payload?.ok === true
          && payload?.run?.id === runId
          && ['queued', 'running'].includes(payload.run.status)) {
        await waitForRetry(
          retryDelayMs(attempt, payload.run.pollAfterMs ?? pollAfterMs),
          deadlineMs,
        );
        attempt = 0;
        continue;
      }
      if (!retryableHttpStatus(response.status)) {
        throw new Error(boundedServerMessage(response, payload));
      }
      lastDiagnostic = `HTTP_${response.status}`;
    } else if (outcome.kind === 'invalid-json') {
      if (!retryableHttpStatus(outcome.response.status)) {
        throw new Error(`Internal durable status returned HTTP ${outcome.response.status} with invalid JSON.`);
      }
      lastDiagnostic = `HTTP_${outcome.response.status}_INVALID_JSON`;
    } else if (outcome.kind === 'transport') {
      lastDiagnostic = outcome.diagnostic;
    }
    await waitForRetry(retryDelayMs(attempt), deadlineMs);
    attempt += 1;
  }
  throw new Error(
    `Internal research timed out before its durable result was ready (request ${requestId}; run ${runId}; last transport ${lastDiagnostic}). Re-run with --request-id ${requestId} to resume.`,
  );
}

async function executeResearch({
  endpoint,
  token,
  timeoutSeconds,
  requestId,
  input,
  probe,
  onSubmitted,
}) {
  const durable = resolveDurableEndpoints(endpoint, probe);
  const deadlineMs = Date.now() + timeoutSeconds * 1000;
  const run = await submitDurableResearch({
    endpoint: durable.submit,
    token,
    requestId,
    input,
    deadlineMs,
  });
  await onSubmitted(run);
  const result = await pollDurableResearch({
    endpoint: durable.status(run.id),
    token,
    requestId,
    runId: run.id,
    pollAfterMs: durable.pollAfterMs,
    deadlineMs,
  });
  return { result, runId: run.id };
}

async function main() {
  let values;
  try {
    values = parseCli();
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }

  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  const kind = values.kind;
  if (!VALID_KINDS.includes(kind)) {
    throw new Error(`Unknown --kind ${kind}. Expected one of: ${VALID_KINDS.join(', ')}.`);
  }

  const maxCostUsd = parsePositiveNumber(values['max-cost-usd'], '--max-cost-usd');
  const recencyDays = values['recency-days'] === undefined
    ? undefined
    : parsePositiveInteger(values['recency-days'], '--recency-days');
  const timeoutSeconds = values['timeout-seconds'] === undefined
    ? kind === 'deep' ? 3_600 : 1_200
    : parsePositiveInteger(values['timeout-seconds'], '--timeout-seconds');
  const profileRef = parseProfileRef(values.profile);
  const profileMode = parseProfileMode(values['profile-mode']);
  const asOf = parseAsOf(values['as-of']);
  const requestedRequestId = parseRequestId(values['request-id']);
  if (values.probe === true && values.check !== true && values['dry-run'] !== true) {
    throw new Error('--probe is supported only with --check or --dry-run.');
  }
  if (timeoutSeconds > 3_600) throw new Error('--timeout-seconds must not exceed 3600.');
  if (PIPELINE_KINDS.has(kind) && maxCostUsd === undefined) {
    throw new Error(`--max-cost-usd is required for ${kind} research.`);
  }
  if (!PIPELINE_KINDS.has(kind) && maxCostUsd !== undefined) {
    throw new Error(`--max-cost-usd is not enforced by ${kind} research; omit it.`);
  }
  if (profileMode !== undefined && profileRef === undefined) {
    throw new Error('--profile-mode requires --profile.');
  }
  if (profileRef !== undefined && asOf === undefined) {
    throw new Error('--as-of is required with --profile.');
  }
  if (profileRef === undefined && asOf !== undefined) {
    throw new Error('--as-of currently requires --profile on the internal runner.');
  }
  const endpoint = resolveEndpoint(values.endpoint);
  const auth = await resolveAgentToken(values['keychain-service'], values['keychain-account']);
  const probe = values.probe === true && auth.token !== null
    ? await probeInternalCatalog({ endpoint, token: auth.token, timeoutSeconds })
    : null;
  const missing = auth.token === null
    ? ['BRAINTIED_AGENT_TOKEN or configured macOS Keychain item']
    : probe !== null && !probe.ready
      ? [probe.error ?? 'internal tool catalog probe failed']
      : [];
  const check = {
    mode: 'internal',
    package_version: await packageVersion(),
    endpoint,
    kind,
    requested_max_cost_usd: maxCostUsd ?? null,
    requested_recency_days: recencyDays ?? null,
    requested_profile_ref: profileRef ?? null,
    requested_profile_mode: profileMode ?? null,
    requested_as_of: asOf ?? null,
    requested_request_id: requestedRequestId ?? null,
    timeout_seconds: timeoutSeconds,
    agent_token_source: auth.source,
    agent_token_present: auth.token !== null,
    probe_requested: values.probe === true,
    probe,
    missing,
    ready: auth.token !== null && (probe === null || probe.ready),
  };

  if (values.check === true || values['dry-run'] === true) {
    process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
    if (!check.ready) process.exitCode = 2;
    return;
  }

  if (!check.ready || auth.token === null) {
    throw new Error(`Preflight failed: ${check.missing.join('; ')}.`);
  }
  if (values['allow-external'] !== true) {
    throw new Error('Refusing network research without --allow-external acknowledgement.');
  }
  if (values.output === undefined || values.metadata === undefined) {
    throw new Error('--output and --metadata are required for a live run.');
  }
  if (profileRef !== undefined && values['trusted-output'] === undefined) {
    throw new Error('--trusted-output is required for a live profile run.');
  }
  if (profileRef === undefined && values['trusted-output'] !== undefined) {
    throw new Error('--trusted-output requires --profile.');
  }
  const artifactPaths = [
    path.resolve(values.output),
    path.resolve(values.metadata),
    ...(values['trusted-output'] === undefined
      ? []
      : [path.resolve(values['trusted-output'])]),
  ];
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    throw new Error('--output, --metadata, and --trusted-output must be different paths.');
  }

  const liveProbe = probe
    ?? await probeInternalCatalog({ endpoint, token: auth.token, timeoutSeconds });
  if (!liveProbe.ready) {
    throw new Error(`Preflight failed: ${liveProbe.error ?? 'durable internal tool catalog probe failed'}.`);
  }

  const brief = await readBrief(values);
  const requestId = requestedRequestId ?? randomUUID();
  const startedAt = new Date();
  const startedMonotonic = process.hrtime.bigint();
  const checkpointContext = {
    packageVersion: check.package_version,
    requestId,
    protocolVersion: liveProbe.protocol_version,
    startedAt,
    kind,
    maxCostUsd,
    recencyDays,
    profileRef,
    profileMode,
    asOf,
    timeoutSeconds,
  };
  const persistCheckpoint = async (run) => atomicWrite(
    values.metadata,
    `${JSON.stringify(createResearchCheckpoint({
      ...checkpointContext,
      run,
    }), null, 2)}\n`,
  );
  const checkpointPath = await persistCheckpoint(null);
  await writeStderrLine(JSON.stringify({
    event: 'braintied_internal_research_checkpoint',
    request_id: requestId,
    metadata: checkpointPath,
    resume_with: `--request-id ${requestId}`,
  }));
  const execution = await executeResearch({
    endpoint,
    token: auth.token,
    timeoutSeconds,
    requestId,
    probe: liveProbe,
    onSubmitted: persistCheckpoint,
    input: {
      brief,
      kind,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(values['synthesis-model'] !== undefined
        ? { synthesisModelOverride: values['synthesis-model'] }
        : {}),
      ...(recencyDays !== undefined ? { recencyDays } : {}),
      ...(profileRef !== undefined ? { profileRef } : {}),
      ...(profileMode !== undefined ? { profileMode } : {}),
      ...(asOf !== undefined ? { asOf } : {}),
    },
  });
  const result = execution.result;
  if (profileRef !== undefined && result.privateManifest === undefined) {
    throw new Error('Profile research completed without its required trusted-local private manifest.');
  }
  if (profileRef !== undefined && result.trustedLocalAppendix === undefined) {
    throw new Error('Profile research completed without its required trusted-local findings appendix.');
  }
  const finishedAt = new Date();
  const durationMs = Number(process.hrtime.bigint() - startedMonotonic) / 1_000_000;
  const groundingAssessment = assessGrounding(result.grounding ?? null);

  const metadata = {
    mode: 'internal',
    package_version: check.package_version,
    request_id: requestId,
    durable_run_id: execution.runId,
    execution_protocol: liveProbe.protocol_version,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: Math.round(durationMs),
    kind: result.kind,
    engine: result.engine,
    requested_max_cost_usd: maxCostUsd ?? null,
    requested_recency_days: recencyDays ?? null,
    profile_ref: profileRef ?? null,
    profile_mode: profileMode ?? null,
    as_of: asOf ?? null,
    timeout_seconds: timeoutSeconds,
    applied_max_cost_usd: result.appliedMaxCostUsd ?? null,
    cost_usd: result.costUsd,
    synthesis_model: values['synthesis-model'] ?? null,
    word_count: result.report.word_count,
    quote_count: result.quoteCount ?? 0,
    bibliography_count: Array.isArray(result.report.bibliography)
      ? result.report.bibliography.length
      : 0,
    bibliography: result.report.bibliography ?? [],
    gaps: result.report.gaps ?? [],
    grounding: result.grounding ?? null,
    grounding_quality: groundingAssessment.quality,
    grounding_passed: groundingAssessment.passed,
    program_status: result.programStatus ?? null,
    source_coverage: result.sourceCoverage ?? null,
    profile_coverage: result.profileCoverage ?? null,
    private_manifest: result.privateManifest ?? null,
    trusted_output: values['trusted-output'] === undefined
      ? null
      : path.resolve(values['trusted-output']),
  };

  const trustedArtifact = result.trustedLocalAppendix === undefined
    ? null
    : {
        schema_version: 1,
        request_id: requestId,
        profile_ref: profileRef,
        as_of: asOf,
        appendix: result.trustedLocalAppendix,
      };
  const [reportPath, metadataPath, trustedOutputPath] = await Promise.all([
    atomicWrite(values.output, `${result.report.full_markdown.trim()}\n`),
    atomicWrite(values.metadata, `${JSON.stringify(metadata, null, 2)}\n`),
    values['trusted-output'] === undefined || trustedArtifact === null
      ? Promise.resolve(null)
      : atomicWrite(
          values['trusted-output'],
          `${JSON.stringify(trustedArtifact, null, 2)}\n`,
        ),
  ]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: 'internal',
    report: reportPath,
    metadata: metadataPath,
    trusted_output: trustedOutputPath,
    request_id: requestId,
    durable_run_id: execution.runId,
    kind: metadata.kind,
    engine: metadata.engine,
    cost_usd: metadata.cost_usd,
    bibliography_count: metadata.bibliography_count,
    grounding_status: metadata.grounding_quality,
    grounding_check_status: metadata.grounding?.status ?? null,
    grounding_ratio: groundingAssessment.ratio,
    grounding_passed: metadata.grounding_passed,
    program_status: metadata.program_status,
    private_evidence_count:
      metadata.private_manifest?.coverage?.evidenceCount ?? 0,
    trusted_finding_count:
      result.trustedLocalAppendix?.includedFindingCount ?? 0,
  }, null, 2)}\n`);

  if (metadata.program_status === 'partial'
      || metadata.source_coverage?.passed === false
      || metadata.profile_coverage?.passed === false) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`run-braintied-internal-research: ${message}\n`);
  process.exitCode = 1;
});
