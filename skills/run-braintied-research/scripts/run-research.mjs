#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { assessGrounding } from './grounding-quality.mjs';

const VALID_KINDS = ['answer', 'quick', 'standard', 'deep', 'managed', 'social'];
const PIPELINE_KINDS = new Set(['quick', 'standard', 'deep', 'social']);
const GENERAL_SEARCH_PROVIDERS = new Set(['searxng', 'serper', 'tavily', 'exa', 'serpapi']);
const SYNTHESIS_DEFAULTS = new Map([
  ['answer', 'gemini-3-flash-preview'],
  ['quick', 'gemini-3-flash-preview'],
  ['standard', 'claude-sonnet-4-6'],
  ['deep', 'claude-sonnet-4-6'],
  ['social', 'claude-sonnet-4-6'],
]);
const SHELL_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'GEMINI_RESEARCH_KEY',
  'GEMINI_API_KEY',
  'VOYAGE_API_KEY',
  'PERPLEXITY_API_KEY',
  'SEARXNG_URLS',
  'SERPER_API_KEY',
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'SERPAPI_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
];
const SHELL_ENV_NAME_SET = new Set(SHELL_ENV_NAMES);
const BRAINTIED_SEARXNG_URLS = 'https://cortex-searxng-a.fly.dev,https://cortex-searxng-b.fly.dev';
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIST_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'index.mjs');
const PACKAGE_JSON = path.join(PACKAGE_ROOT, 'package.json');
const SOURCE_ROOT = path.join(PACKAGE_ROOT, 'src');
const BUILD_CONFIGS = [
  path.join(PACKAGE_ROOT, 'tsup.config.ts'),
  path.join(PACKAGE_ROOT, 'tsconfig.json'),
];
const execFileAsync = promisify(execFile);

const USAGE = `Usage:
  run-research.mjs --check --kind <pipeline-kind> --max-cost-usd <number>
  run-research.mjs --check --kind <answer|managed>
  run-research.mjs --brief-file <path> --kind <kind> [options]

Options:
  --brief-file <path>       UTF-8 research brief (recommended)
  --brief <text>            Inline brief; avoid for sensitive or complex text
  --kind <kind>             answer|quick|standard|deep|managed|social
                            (default: standard)
  --max-cost-usd <number>   Required for pipeline kinds; must be > 0
  --synthesis-model <id>    Override the synthesis model/provider
  --load-shell-env          Import allowlisted settings from an interactive shell
  --recency-days <integer>  Answer-kind recency window
  --output <path>           Required Markdown report output
  --metadata <path>         Required JSON run metadata output
  --allow-external          Acknowledge that the brief goes to external services
  --check, --dry-run        Offline credential/build preflight; no research call
  --help                    Show this help

Environment:
  Existing process variables take precedence. --load-shell-env imports only
  allowlisted research settings and supplies Braintied's SearXNG pool when no
  search provider is configured. Load only project-authorized credentials.
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
      'load-shell-env': { type: 'boolean' },
      'recency-days': { type: 'string' },
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
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be a whole number.`);
  }
  return parsed;
}

function hasEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

async function loadInteractiveShellEnvironment(enabled) {
  if (!enabled) return { source: null, loadedNames: [], defaultedNames: [] };

  const shell = process.env.SHELL !== undefined && process.env.SHELL.trim().length > 0
    ? process.env.SHELL
    : '/bin/zsh';
  const supportedShells = new Set(['bash', 'fish', 'sh', 'zsh']);
  if (!supportedShells.has(path.basename(shell))) {
    throw new Error(`Unsupported interactive shell for --load-shell-env: ${shell}.`);
  }

  const { stdout } = await execFileAsync(shell, ['-ilc', 'env -0'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const loadedNames = [];
  for (const entry of stdout.split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!SHELL_ENV_NAME_SET.has(name) || hasEnv(name) || value.trim().length === 0) continue;
    process.env[name] = value;
    loadedNames.push(name);
  }

  const defaultedNames = [];
  if (!hasEnv('SEARXNG_URLS')) {
    process.env.SEARXNG_URLS = BRAINTIED_SEARXNG_URLS;
    defaultedNames.push('SEARXNG_URLS');
  }
  return { source: 'interactive-shell', loadedNames, defaultedNames };
}

function applyGeminiAlias() {
  if (!hasEnv('GEMINI_API_KEY') && hasEnv('GEMINI_RESEARCH_KEY')) {
    process.env.GEMINI_API_KEY = process.env.GEMINI_RESEARCH_KEY;
  }
}

async function loadPackage() {
  try {
    await access(DIST_ENTRY);
  } catch {
    throw new Error(`Built package not found at ${DIST_ENTRY}. Run npm run build first.`);
  }

  applyGeminiAlias();
  const research = await import(pathToFileURL(DIST_ENTRY).href);
  if (typeof research.runResearch !== 'function') {
    throw new Error('Built package does not export runResearch. Run npm run build from current source.');
  }
  return research;
}

function effectiveSynthesisModel(kind, override) {
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return SYNTHESIS_DEFAULTS.get(kind) ?? null;
}

function addMissing(missing, name) {
  if (!missing.includes(name)) missing.push(name);
}

function requireSynthesisCredential(model, missing) {
  if (model === null) return;
  if (model.startsWith('gemini-')) {
    if (!hasEnv('GEMINI_RESEARCH_KEY') && !hasEnv('GEMINI_API_KEY')) {
      addMissing(missing, 'GEMINI_RESEARCH_KEY or GEMINI_API_KEY');
    }
  } else if (model.startsWith('deepseek-')) {
    if (!hasEnv('DEEPSEEK_API_KEY')) addMissing(missing, 'DEEPSEEK_API_KEY');
  } else if (model.startsWith('qwen')) {
    if (!hasEnv('OPENROUTER_API_KEY')) addMissing(missing, 'OPENROUTER_API_KEY');
  } else if (!hasEnv('ANTHROPIC_API_KEY')) {
    addMissing(missing, 'ANTHROPIC_API_KEY');
  }
}

function requiredConfiguration(kind, enabledProviders, synthesisModel) {
  const missing = [];
  const warnings = [];
  const geminiPresent = hasEnv('GEMINI_RESEARCH_KEY') || hasEnv('GEMINI_API_KEY');
  const generalSearchPresent = enabledProviders.some((provider) => GENERAL_SEARCH_PROVIDERS.has(provider));
  const socialProviders = new Set(['reddit', 'youtube', 'x', 'tiktok', 'instagram', 'facebook_groups', 'podcasts']);
  const socialSearchPresent = enabledProviders.some((provider) => socialProviders.has(provider));

  if (kind === 'managed') {
    if (!hasEnv('PERPLEXITY_API_KEY')) addMissing(missing, 'PERPLEXITY_API_KEY');
  } else if (kind === 'answer') {
    if (!generalSearchPresent) addMissing(missing, 'at least one enabled general search provider');
    requireSynthesisCredential(synthesisModel, missing);
  } else {
    if (!geminiPresent) addMissing(missing, 'GEMINI_RESEARCH_KEY or GEMINI_API_KEY');
    requireSynthesisCredential(synthesisModel, missing);
    if (!hasEnv('VOYAGE_API_KEY')) {
      warnings.push('VOYAGE_API_KEY is absent; quote reranking will use stable provider order.');
    }
    if (!hasEnv('ANTHROPIC_API_KEY')) {
      warnings.push(kind === 'quick'
        ? 'ANTHROPIC_API_KEY is absent; Gemini planner retries have no Claude fallback.'
        : 'ANTHROPIC_API_KEY is absent; critique will use its permissive fallback.');
    }
    if (kind === 'social') {
      if (!socialSearchPresent) addMissing(missing, 'at least one enabled social search provider');
      if (!generalSearchPresent) warnings.push('No general web-search provider is enabled; corroboration may be narrow.');
    } else if (!generalSearchPresent) {
      addMissing(missing, 'at least one enabled general search provider');
    }
  }

  return { missing, warnings };
}

async function packageVersion() {
  const parsed = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'));
  return typeof parsed.version === 'string' ? parsed.version : 'unknown';
}

async function latestTypeScriptMtime(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let latest = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await latestTypeScriptMtime(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      latest = Math.max(latest, (await stat(entryPath)).mtimeMs);
    }
  }
  return latest;
}

async function buildFreshness() {
  const distStats = await stat(DIST_ENTRY);
  try {
    await access(SOURCE_ROOT);
  } catch {
    return {
      status: 'unavailable',
      reason: 'package source is not installed; kind/export checks still apply',
      dist_built_at: distStats.mtime.toISOString(),
      latest_build_input_at: null,
      build_input_newer_than_dist: false,
    };
  }

  const [latestSource, ...configStats] = await Promise.all([
    latestTypeScriptMtime(SOURCE_ROOT),
    ...BUILD_CONFIGS.map((configPath) => stat(configPath)),
  ]);
  const latestBuildInput = Math.max(latestSource, ...configStats.map((entry) => entry.mtimeMs));
  return {
    status: 'checked',
    reason: null,
    dist_built_at: distStats.mtime.toISOString(),
    latest_build_input_at: new Date(latestBuildInput).toISOString(),
    build_input_newer_than_dist: latestBuildInput > distStats.mtimeMs,
  };
}

async function preflight(research, kind, maxCostUsd, synthesisModel, runtimeEnvironment) {
  const builtKinds = Array.isArray(research.RESEARCH_KINDS) ? research.RESEARCH_KINDS : [];
  if (!builtKinds.includes(kind)) {
    throw new Error(`Kind ${kind} is absent from built dist (available: ${builtKinds.join(', ') || 'none'}). Run npm run build.`);
  }

  const enabled = typeof research.getEnabledProviders === 'function'
    ? Object.keys(research.getEnabledProviders()).sort()
    : [];
  const config = requiredConfiguration(kind, enabled, synthesisModel);
  const freshness = await buildFreshness();
  if (freshness.build_input_newer_than_dist) {
    config.missing.push('dist/index.mjs is older than a package build input; run npm run build');
  }
  return {
    package_root: PACKAGE_ROOT,
    package_version: await packageVersion(),
    dist_entry: DIST_ENTRY,
    kind,
    requested_max_cost_usd: maxCostUsd ?? null,
    synthesis_model: synthesisModel,
    built_kinds: builtKinds,
    build_freshness: freshness,
    enabled_providers: enabled,
    configured_key_names: SHELL_ENV_NAMES.filter(hasEnv),
    runtime_environment: {
      source: runtimeEnvironment.source,
      loaded_names: runtimeEnvironment.loadedNames,
      defaulted_names: runtimeEnvironment.defaultedNames,
    },
    missing: config.missing,
    warnings: config.warnings,
    ready: config.missing.length === 0,
  };
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
  const recencyDays = parsePositiveInteger(values['recency-days'], '--recency-days');
  const synthesisModel = effectiveSynthesisModel(kind, values['synthesis-model']);
  if (PIPELINE_KINDS.has(kind) && maxCostUsd === undefined) {
    throw new Error(`--max-cost-usd is required for ${kind} research.`);
  }
  if (!PIPELINE_KINDS.has(kind) && maxCostUsd !== undefined) {
    throw new Error(`--max-cost-usd is not enforced by ${kind} research; omit it and choose this kind deliberately.`);
  }
  if (recencyDays !== undefined && kind !== 'answer') {
    throw new Error('--recency-days is supported only by the answer kind.');
  }

  const runtimeEnvironment = await loadInteractiveShellEnvironment(values['load-shell-env'] === true);
  const research = await loadPackage();
  const check = await preflight(research, kind, maxCostUsd, synthesisModel, runtimeEnvironment);
  if (values.check === true || values['dry-run'] === true) {
    process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
    if (!check.ready) process.exitCode = 2;
    return;
  }

  if (!check.ready) {
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
  const startedAt = new Date();
  const startedMonotonic = process.hrtime.bigint();
  const result = await research.runResearch({
    brief,
    kind,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(recencyDays !== undefined ? { recencyDays } : {}),
    ...(synthesisModel !== null ? { synthesisModelOverride: synthesisModel } : {}),
  });
  const finishedAt = new Date();
  const durationMs = Number(process.hrtime.bigint() - startedMonotonic) / 1_000_000;

  if (typeof result?.report?.full_markdown !== 'string' || result.report.full_markdown.trim().length === 0) {
    throw new Error('Research completed without a non-empty Markdown report.');
  }
  const groundingAssessment = assessGrounding(result.grounding ?? null);

  const metadata = {
    package_version: check.package_version,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: Math.round(durationMs),
    kind: result.kind,
    engine: result.engine,
    requested_max_cost_usd: maxCostUsd ?? null,
    cost_usd: result.costUsd,
    synthesis_model: synthesisModel,
    word_count: result.report.word_count,
    quote_count: Array.isArray(result.quotes) ? result.quotes.length : 0,
    bibliography_count: Array.isArray(result.report.bibliography) ? result.report.bibliography.length : 0,
    bibliography: result.report.bibliography,
    gaps: result.report.gaps,
    grounding: result.grounding,
    grounding_quality: groundingAssessment.quality,
    grounding_passed: groundingAssessment.passed,
    warnings: check.warnings,
  };

  const reportPath = await atomicWrite(values.output, `${result.report.full_markdown.trim()}\n`);
  const metadataPath = await atomicWrite(values.metadata, `${JSON.stringify(metadata, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    report: reportPath,
    metadata: metadataPath,
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
  process.stderr.write(`run-braintied-research: ${message}\n`);
  process.exitCode = 1;
});
