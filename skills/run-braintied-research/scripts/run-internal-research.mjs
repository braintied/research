#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { assessGrounding } from './grounding-quality.mjs';

const VALID_KINDS = ['answer', 'quick', 'standard', 'deep', 'managed', 'social'];
const PIPELINE_KINDS = new Set(['quick', 'standard', 'deep', 'social']);
const DEFAULT_ENDPOINT = 'https://ora-cortex-worker.fly.dev/internal/tools/execute';
const DEFAULT_KEYCHAIN_SERVICE = 'braintied-agent-auth';
const DEFAULT_KEYCHAIN_ACCOUNT = 'codex';
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
  --recency-days <integer>  Answer-kind recency window
  --endpoint <url>          Internal tool endpoint
  --timeout-seconds <n>     Request timeout, 1-3600 (default: 1200)
  --keychain-service <name> macOS Keychain service (default: braintied-agent-auth)
  --keychain-account <name> macOS Keychain account (default: codex)
  --output <path>           Required Markdown report output
  --metadata <path>         Required JSON run metadata output
  --allow-external          Acknowledge that the brief goes to external services
  --check, --dry-run        Local auth/configuration preflight; no network call
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
      'brief-file': { type: 'string' },
      brief: { type: 'string' },
      kind: { type: 'string', default: 'standard' },
      'max-cost-usd': { type: 'string' },
      'synthesis-model': { type: 'string' },
      'recency-days': { type: 'string' },
      endpoint: { type: 'string' },
      'timeout-seconds': { type: 'string', default: '1200' },
      'keychain-service': { type: 'string', default: DEFAULT_KEYCHAIN_SERVICE },
      'keychain-account': { type: 'string', default: DEFAULT_KEYCHAIN_ACCOUNT },
      output: { type: 'string' },
      metadata: { type: 'string' },
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
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
  return absolute;
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
  return result;
}

async function executeResearch({ endpoint, token, timeoutSeconds, requestId, input }) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({ tool: 'research.run', input }),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? `Internal research timed out after ${timeoutSeconds} seconds.`
      : 'Internal research endpoint is unavailable.';
    throw new Error(message);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Internal tool returned HTTP ${response.status} with invalid JSON.`);
  }

  if (!response.ok) {
    const serverMessage = payload?.error?.message;
    const message = typeof serverMessage === 'string' && serverMessage.length <= 500
      ? serverMessage
      : `Internal tool returned HTTP ${response.status}.`;
    throw new Error(message);
  }

  return validateResult(payload);
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
  const timeoutSeconds = parsePositiveInteger(values['timeout-seconds'], '--timeout-seconds');
  if (timeoutSeconds > 3_600) throw new Error('--timeout-seconds must not exceed 3600.');
  if (PIPELINE_KINDS.has(kind) && maxCostUsd === undefined) {
    throw new Error(`--max-cost-usd is required for ${kind} research.`);
  }
  if (!PIPELINE_KINDS.has(kind) && maxCostUsd !== undefined) {
    throw new Error(`--max-cost-usd is not enforced by ${kind} research; omit it.`);
  }
  if (recencyDays !== undefined && kind !== 'answer') {
    throw new Error('--recency-days is supported only by the answer kind.');
  }

  const endpoint = resolveEndpoint(values.endpoint);
  const auth = await resolveAgentToken(values['keychain-service'], values['keychain-account']);
  const check = {
    mode: 'internal',
    package_version: await packageVersion(),
    endpoint,
    kind,
    requested_max_cost_usd: maxCostUsd ?? null,
    agent_token_source: auth.source,
    agent_token_present: auth.token !== null,
    missing: auth.token === null ? ['BRAINTIED_AGENT_TOKEN or configured macOS Keychain item'] : [],
    ready: auth.token !== null,
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
  if (path.resolve(values.output) === path.resolve(values.metadata)) {
    throw new Error('--output and --metadata must be different paths.');
  }

  const brief = await readBrief(values);
  const requestId = randomUUID();
  const startedAt = new Date();
  const startedMonotonic = process.hrtime.bigint();
  const result = await executeResearch({
    endpoint,
    token: auth.token,
    timeoutSeconds,
    requestId,
    input: {
      brief,
      kind,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(values['synthesis-model'] !== undefined
        ? { synthesisModelOverride: values['synthesis-model'] }
        : {}),
      ...(recencyDays !== undefined ? { recencyDays } : {}),
    },
  });
  const finishedAt = new Date();
  const durationMs = Number(process.hrtime.bigint() - startedMonotonic) / 1_000_000;
  const groundingAssessment = assessGrounding(result.grounding ?? null);

  const metadata = {
    mode: 'internal',
    package_version: check.package_version,
    request_id: requestId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: Math.round(durationMs),
    kind: result.kind,
    engine: result.engine,
    requested_max_cost_usd: maxCostUsd ?? null,
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
  };

  const reportPath = await atomicWrite(values.output, `${result.report.full_markdown.trim()}\n`);
  const metadataPath = await atomicWrite(values.metadata, `${JSON.stringify(metadata, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: 'internal',
    report: reportPath,
    metadata: metadataPath,
    request_id: requestId,
    kind: metadata.kind,
    engine: metadata.engine,
    cost_usd: metadata.cost_usd,
    bibliography_count: metadata.bibliography_count,
    grounding_status: metadata.grounding_quality,
    grounding_check_status: metadata.grounding?.status ?? null,
    grounding_ratio: groundingAssessment.ratio,
    grounding_passed: metadata.grounding_passed,
  }, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`run-braintied-internal-research: ${message}\n`);
  process.exitCode = 1;
});
