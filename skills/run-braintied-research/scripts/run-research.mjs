#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { assessGrounding } from './grounding-quality.mjs';
import { parseAllowlistedEnvFile } from './research-env-file.mjs';

const VALID_KINDS = ['answer', 'quick', 'standard', 'deep', 'managed', 'social'];
const PIPELINE_KINDS = new Set(['quick', 'standard', 'deep', 'social']);
const GENERAL_SEARCH_PROVIDERS = new Set(['searxng', 'serper', 'tavily', 'exa', 'serpapi']);
const VALID_SOURCE_MODES = new Set([
  'web', 'x', 'reddit', 'youtube', 'github', 'community', 'instagram', 'tiktok',
  'facebook_groups', 'cortex', 'telegram', 'all_public', 'all_social', 'all',
]);
const SYNTHESIS_DEFAULTS = new Map([
  ['answer', 'gemini-3-flash-preview'],
  ['quick', 'gemini-3-flash-preview'],
  ['standard', 'claude-sonnet-4-6'],
  ['deep', 'claude-sonnet-4-6'],
  ['social', 'claude-sonnet-4-6'],
]);
const GEMINI_KEY_NAMES = [
  'GEMINI_RESEARCH_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
];
const RESEARCH_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  ...GEMINI_KEY_NAMES,
  'VOYAGE_API_KEY',
  'PERPLEXITY_API_KEY',
  'SEARXNG_URLS',
  'SERPER_API_KEY',
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'SERPAPI_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'REDDIT_USER_AGENT',
  'YOUTUBE_API_KEY',
  'X_BEARER_TOKEN',
  'TWITTER_BEARER_TOKEN',
  'X_APP_BEARER_TOKEN',
  'TWITTERAPI_IO_KEY',
  'TWITTERAPI_KEY',
  'APIFY_API_TOKEN',
  'BRIGHTDATA_API_TOKEN',
  'JINA_API_KEY',
  'CRAWL4AI_URL',
  'BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS',
  'BRAINTIED_CRAWL4AI_NETWORK_GUARD',
  'BRAINTIED_GITHUB_PUBLIC_TOKEN',
  'BRAINTIED_GITHUB_REQUIRE_AUTH',
];
const SHARED_ENV_FILE_VARIABLE = 'BRAINTIED_RESEARCH_ENV_FILE';
const GEMINI_KEY_NAME_VARIABLE = 'BRAINTIED_GEMINI_KEY_NAME';
const IMPORTABLE_ENV_NAMES = [...RESEARCH_ENV_NAMES, GEMINI_KEY_NAME_VARIABLE];
const IMPORTABLE_ENV_NAME_SET = new Set(IMPORTABLE_ENV_NAMES);
const SHELL_CAPTURE_NAME_SET = new Set([...IMPORTABLE_ENV_NAMES, SHARED_ENV_FILE_VARIABLE]);
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
  --research-env-file <path>
                            Import allowlisted settings from a secure dotenv file
  --gemini-key-name <name>  Select one Gemini alias when configured values conflict
  --load-shell-env          Import allowlisted settings from an interactive shell
  --recency-days <integer>  Recency window for answer or pipeline searches
  --sources <csv>           Explicit lanes: web,x,reddit,youtube,github,community,...
  --require-providers <csv> Fail preflight unless these providers are enabled
  --as-of <ISO date/time>   Reproducible upper boundary (required with --sources/profile)
  --profile <ref>           Versioned research profile (for example ora-agent-runtime@1)
  --output <path>           Required Markdown report output
  --metadata <path>         Required JSON run metadata output
  --allow-external          Acknowledge that the brief goes to external services
  --check, --dry-run        Offline credential/build preflight; no research call
  --help                    Show this help

Environment:
  --research-env-file (or BRAINTIED_RESEARCH_ENV_FILE) accepts an absolute path
  and imports only allowlisted research settings. Do not use Node's --env-file,
  which loads every entry before this runner starts. Every supplied file must be
  owner-only and regular; blank assignments explicitly disable inherited values.
  --load-shell-env fills unmasked gaps and can discover the shared file pointer.
  Use --gemini-key-name (or BRAINTIED_GEMINI_KEY_NAME) when aliases differ.
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
      'research-env-file': { type: 'string' },
      'gemini-key-name': { type: 'string' },
      'load-shell-env': { type: 'boolean' },
      'recency-days': { type: 'string' },
      sources: { type: 'string' },
      'require-providers': { type: 'string' },
      'as-of': { type: 'string' },
      profile: { type: 'string' },
      output: { type: 'string' },
      metadata: { type: 'string' },
      'allow-external': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  }).values;
}

function parseCsv(raw, label) {
  if (raw === undefined) return [];
  const values = [...new Set(raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0))];
  if (values.length === 0) throw new Error(`${label} must contain at least one value.`);
  return values;
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

function emptyRuntimeEnvironment() {
  return {
    source: null,
    loadedNames: [],
    overriddenNames: [],
    maskedNames: [],
    defaultedNames: [],
    envFiles: [],
  };
}

async function captureInteractiveShellEnvironment(enabled) {
  if (!enabled) return new Map();

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
  const captured = new Map();
  for (const entry of stdout.split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    if (!SHELL_CAPTURE_NAME_SET.has(name)) continue;
    captured.set(name, entry.slice(separator + 1));
  }
  return captured;
}

function resolveEnvironmentFilePath(cliPath, shellEnvironment) {
  if (cliPath !== undefined && cliPath.trim().length === 0) {
    throw new Error('--research-env-file requires a non-empty absolute path.');
  }
  let configuredPath = cliPath;
  if (configuredPath === undefined) {
    const inheritedPointer = process.env[SHARED_ENV_FILE_VARIABLE];
    configuredPath = inheritedPointer !== undefined && inheritedPointer.trim().length > 0
      ? inheritedPointer
      : shellEnvironment.get(SHARED_ENV_FILE_VARIABLE);
  }
  if (configuredPath === undefined || configuredPath.trim().length === 0) return null;
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(`${SHARED_ENV_FILE_VARIABLE} and --research-env-file must use an absolute path.`);
  }
  return path.normalize(configuredPath);
}

function rejectNodeEnvironmentPreload() {
  if (process.execArgv.some((argument) => (
    argument === '--env-file'
    || argument.startsWith('--env-file=')
    || argument === '--env-file-if-exists'
    || argument.startsWith('--env-file-if-exists=')
  ))) {
    throw new Error("Refusing Node's env-file preload because it bypasses the research allowlist; use --research-env-file instead.");
  }
}

async function loadAllowlistedEnvironmentFile(absolutePath) {
  if (absolutePath === null) return emptyRuntimeEnvironment();
  if (process.platform === 'win32') {
    throw new Error('Secure --research-env-file loading is unavailable on Windows; inject approved process environment variables instead.');
  }
  if (typeof fsConstants.O_NOFOLLOW !== 'number') {
    throw new Error('This platform cannot safely reject symlinked research environment files.');
  }

  let fileHandle;
  try {
    fileHandle = await open(
      absolutePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ELOOP') {
      throw new Error(`Research environment file must not be a symbolic link: ${absolutePath}.`);
    }
    throw error;
  }

  let contents;
  try {
    const fileStats = await fileHandle.stat();
    if (!fileStats.isFile()) {
      throw new Error(`Research environment path is not a regular file: ${absolutePath}.`);
    }
    if ((fileStats.mode & 0o077) !== 0) {
      throw new Error(`Research environment file must have owner-only permissions (0600 or stricter): ${absolutePath}.`);
    }
    contents = await fileHandle.readFile({ encoding: 'utf8' });
  } finally {
    await fileHandle.close();
  }

  const parsed = parseAllowlistedEnvFile(contents, absolutePath, IMPORTABLE_ENV_NAME_SET);

  const loadedNames = [];
  const overriddenNames = [];
  const maskedNames = [];
  for (const [name, value] of parsed) {
    if (value.trim().length === 0) {
      if (hasEnv(name)) overriddenNames.push(name);
      delete process.env[name];
      maskedNames.push(name);
      continue;
    }
    if (process.env[name] !== undefined && process.env[name] !== value) {
      overriddenNames.push(name);
    }
    process.env[name] = value;
    loadedNames.push(name);
  }
  return {
    source: 'env-file',
    loadedNames,
    overriddenNames: [...new Set(overriddenNames)],
    maskedNames,
    defaultedNames: [],
    envFiles: [absolutePath],
  };
}

function applyInteractiveShellEnvironment(shellEnvironment, enabled, maskedNames) {
  if (!enabled) return emptyRuntimeEnvironment();
  const masked = new Set(maskedNames);
  const loadedNames = [];
  for (const name of IMPORTABLE_ENV_NAMES) {
    const value = shellEnvironment.get(name);
    if (value === undefined || masked.has(name) || hasEnv(name) || value.trim().length === 0) continue;
    process.env[name] = value;
    loadedNames.push(name);
  }

  const defaultedNames = [];
  if (!masked.has('SEARXNG_URLS') && !hasEnv('SEARXNG_URLS')) {
    process.env.SEARXNG_URLS = BRAINTIED_SEARXNG_URLS;
    defaultedNames.push('SEARXNG_URLS');
  }
  return {
    source: 'interactive-shell',
    loadedNames,
    overriddenNames: [],
    maskedNames: [],
    defaultedNames,
    envFiles: [],
  };
}

function combineRuntimeEnvironments(...environments) {
  const active = environments.filter((environment) => environment.source !== null);
  return {
    source: active.length > 0 ? active.map((environment) => environment.source).join('+') : null,
    loadedNames: [...new Set(active.flatMap((environment) => environment.loadedNames))].sort(),
    overriddenNames: [...new Set(active.flatMap((environment) => environment.overriddenNames))].sort(),
    maskedNames: [...new Set(active.flatMap((environment) => environment.maskedNames))].sort(),
    defaultedNames: [...new Set(active.flatMap((environment) => environment.defaultedNames))].sort(),
    envFiles: [...new Set(active.flatMap((environment) => environment.envFiles))],
    resolvedGeminiKeyName: null,
  };
}

function resolveGeminiEnvironment(cliKeyName, runtimeEnvironment) {
  const configuredKeyName = cliKeyName ?? process.env[GEMINI_KEY_NAME_VARIABLE];
  if (configuredKeyName !== undefined && configuredKeyName.trim().length === 0) {
    throw new Error('--gemini-key-name must name a supported Gemini environment variable.');
  }
  const selectedByName = configuredKeyName?.trim();
  if (selectedByName !== undefined && !GEMINI_KEY_NAMES.includes(selectedByName)) {
    throw new Error(`Unsupported Gemini key name ${selectedByName}; expected one of: ${GEMINI_KEY_NAMES.join(', ')}.`);
  }

  const candidates = GEMINI_KEY_NAMES
    .filter(hasEnv)
    .map((name) => ({ name, value: process.env[name] }));
  let selected = null;
  if (selectedByName !== undefined) {
    selected = candidates.find((candidate) => candidate.name === selectedByName) ?? null;
    if (selected === null) {
      throw new Error(`Selected Gemini key ${selectedByName} is not configured.`);
    }
  } else {
    const distinctValues = new Set(candidates.map((candidate) => candidate.value));
    if (distinctValues.size > 1) {
      const names = candidates.map((candidate) => candidate.name).join(', ');
      throw new Error(`Conflicting Gemini aliases are configured (${names}); choose one with --gemini-key-name.`);
    }
    selected = candidates[0] ?? null;
  }

  if (selected === null) return;
  for (const canonicalName of ['GEMINI_RESEARCH_KEY', 'GEMINI_API_KEY']) {
    if (hasEnv(canonicalName) && process.env[canonicalName] !== selected.value) {
      runtimeEnvironment.overriddenNames.push(canonicalName);
    }
    process.env[canonicalName] = selected.value;
  }
  runtimeEnvironment.overriddenNames = [...new Set(runtimeEnvironment.overriddenNames)].sort();
  runtimeEnvironment.resolvedGeminiKeyName = selected.name;
  process.env[GEMINI_KEY_NAME_VARIABLE] = selected.name;
}

async function loadPackage() {
  try {
    await access(DIST_ENTRY);
  } catch {
    throw new Error(`Built package not found at ${DIST_ENTRY}. Run npm run build first.`);
  }

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
    if (!hasEnv('GEMINI_RESEARCH_KEY') && !hasEnv('GEMINI_API_KEY')
      && !hasEnv('GOOGLE_GENERATIVE_AI_API_KEY') && !hasEnv('GOOGLE_GEMINI_API_KEY')) {
      addMissing(missing, 'a supported Gemini API key');
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
  const geminiPresent = hasEnv('GEMINI_RESEARCH_KEY') || hasEnv('GEMINI_API_KEY')
    || hasEnv('GOOGLE_GENERATIVE_AI_API_KEY') || hasEnv('GOOGLE_GEMINI_API_KEY');
  const generalSearchPresent = enabledProviders.some((provider) => GENERAL_SEARCH_PROVIDERS.has(provider));
  const socialProviders = new Set(['reddit', 'youtube', 'x', 'tiktok', 'instagram', 'facebook_groups', 'podcasts']);
  const socialSearchPresent = enabledProviders.some((provider) => socialProviders.has(provider));

  if (kind === 'managed') {
    if (!hasEnv('PERPLEXITY_API_KEY')) addMissing(missing, 'PERPLEXITY_API_KEY');
  } else if (kind === 'answer') {
    if (!generalSearchPresent) addMissing(missing, 'at least one enabled general search provider');
    requireSynthesisCredential(synthesisModel, missing);
  } else {
    if (!geminiPresent) addMissing(missing, 'a supported Gemini API key');
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

async function preflight(
  research,
  kind,
  maxCostUsd,
  synthesisModel,
  runtimeEnvironment,
  { sources, requiredProviders, asOf, profileRef },
) {
  const builtKinds = Array.isArray(research.RESEARCH_KINDS) ? research.RESEARCH_KINDS : [];
  if (!builtKinds.includes(kind)) {
    throw new Error(`Kind ${kind} is absent from built dist (available: ${builtKinds.join(', ') || 'none'}). Run npm run build.`);
  }

  const enabled = typeof research.getEnabledProviders === 'function'
    ? Object.keys(research.getEnabledProviders()).sort()
    : [];
  const enabledSearch = typeof research.getEnabledSearchProviders === 'function'
    ? Object.keys(research.getEnabledSearchProviders()).sort()
    : enabled.filter((provider) => provider !== 'crawl4ai');
  const config = requiredConfiguration(kind, enabled, synthesisModel);
  let sourcePlan = null;
  let effectiveRequiredProviders = [...requiredProviders];
  if ((sources.length > 0 || profileRef !== undefined) && asOf === undefined) {
    config.missing.push('--as-of is required with --sources or --profile');
  }
  if (typeof research.resolveSourceExecutionPlan === 'function' && asOf !== undefined && (sources.length > 0 || profileRef !== undefined)) {
    let effectiveSources = sources;
    if (profileRef !== undefined) {
      if (typeof research.compileProfileExecution !== 'function') {
        config.missing.push('built package does not export compileProfileExecution');
      } else {
        try {
          const profileExecution = research.compileProfileExecution(
            profileRef,
            { question: 'Preflight research question for source capability validation.', asOf: asOf.slice(0, 10) },
            enabledSearch,
          );
          if (effectiveSources.length === 0) effectiveSources = profileExecution.sourceModes;
          effectiveRequiredProviders = Array.from(new Set([
            ...profileExecution.requiredProviders,
            ...effectiveRequiredProviders,
          ]));
        } catch (error) {
          config.missing.push(`profile preflight failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (effectiveSources.length > 0) {
      sourcePlan = research.resolveSourceExecutionPlan({
        question: 'Preflight research question for source capability validation.',
        modes: effectiveSources,
        availableProviders: enabledSearch,
        availableTrustedAdapters: [],
        requiredProviders: effectiveRequiredProviders,
        asOf,
      });
      for (const mode of sourcePlan.missingModes) addMissing(config.missing, `source mode unavailable: ${mode}`);
      for (const provider of sourcePlan.missingRequiredProviders) addMissing(config.missing, `required provider unavailable: ${provider}`);
    }
  }
  const githubRequested = effectiveRequiredProviders.includes('github')
    || sourcePlan?.publicModes?.includes('github') === true;
  let githubHealth = null;
  if (typeof research.resolveGitHubPublicAuthState === 'function') {
    githubHealth = research.resolveGitHubPublicAuthState(process.env);
  }
  if (githubRequested) {
    if (githubHealth === null) {
      addMissing(config.missing, 'built package does not export GitHub public-auth policy');
    } else if (githubHealth.ready !== true) {
      addMissing(
        config.missing,
        `GitHub public-research authentication policy is not satisfied (${githubHealth.code})`,
      );
    }
  }
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
    enabled_search_providers: enabledSearch,
    required_providers: effectiveRequiredProviders,
    provider_health: { github: githubHealth },
    source_plan: sourcePlan,
    configured_key_names: RESEARCH_ENV_NAMES.filter(hasEnv),
    runtime_environment: {
      source: runtimeEnvironment.source,
      loaded_names: runtimeEnvironment.loadedNames,
      overridden_names: runtimeEnvironment.overriddenNames,
      masked_names: runtimeEnvironment.maskedNames,
      defaulted_names: runtimeEnvironment.defaultedNames,
      env_files: runtimeEnvironment.envFiles,
      resolved_gemini_key_name: runtimeEnvironment.resolvedGeminiKeyName,
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
  rejectNodeEnvironmentPreload();
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
  const sources = parseCsv(values.sources, '--sources');
  const requiredProviders = parseCsv(values['require-providers'], '--require-providers');
  const asOf = values['as-of'];
  const profileRef = values.profile;
  const invalidSources = sources.filter((source) => !VALID_SOURCE_MODES.has(source));
  if (invalidSources.length > 0) {
    throw new Error(`Unknown --sources value(s): ${invalidSources.join(', ')}.`);
  }
  if (asOf !== undefined) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(asOf);
    const timestamp = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(asOf)
      && !Number.isNaN(new Date(asOf).getTime());
    if (!dateOnly && !timestamp) {
      throw new Error('--as-of must be YYYY-MM-DD or an RFC3339 timestamp with an explicit offset.');
    }
  }
  const synthesisModel = effectiveSynthesisModel(kind, values['synthesis-model']);
  if (PIPELINE_KINDS.has(kind) && maxCostUsd === undefined) {
    throw new Error(`--max-cost-usd is required for ${kind} research.`);
  }
  if (!PIPELINE_KINDS.has(kind) && maxCostUsd !== undefined) {
    throw new Error(`--max-cost-usd is not enforced by ${kind} research; omit it and choose this kind deliberately.`);
  }
  const loadShellEnvironment = values['load-shell-env'] === true;
  const capturedShellEnvironment = await captureInteractiveShellEnvironment(loadShellEnvironment);
  const environmentFilePath = resolveEnvironmentFilePath(values['research-env-file'], capturedShellEnvironment);
  const fileEnvironment = await loadAllowlistedEnvironmentFile(environmentFilePath);
  const shellEnvironment = applyInteractiveShellEnvironment(
    capturedShellEnvironment,
    loadShellEnvironment,
    fileEnvironment.maskedNames,
  );
  const runtimeEnvironment = combineRuntimeEnvironments(fileEnvironment, shellEnvironment);
  resolveGeminiEnvironment(values['gemini-key-name'], runtimeEnvironment);
  const research = await loadPackage();
  const knownProviders = new Set(Array.isArray(research.PROVIDER_NAMES) ? research.PROVIDER_NAMES : []);
  const invalidProviders = requiredProviders.filter((provider) => !knownProviders.has(provider));
  if (invalidProviders.length > 0) {
    throw new Error(`Unknown --require-providers value(s): ${invalidProviders.join(', ')}.`);
  }
  const check = await preflight(research, kind, maxCostUsd, synthesisModel, runtimeEnvironment, {
    sources, requiredProviders, asOf, profileRef,
  });
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
  let programResult = null;
  let result;
  if (sources.length > 0 || profileRef !== undefined) {
    if (typeof research.runResearchProgram !== 'function') {
      throw new Error('Built package does not export runResearchProgram. Run npm run build.');
    }
    programResult = await research.runResearchProgram({
      brief,
      asOf,
      ...(sources.length > 0 ? { sourceModes: sources } : {}),
      ...(profileRef !== undefined ? { profileRef } : {}),
      kind,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(recencyDays !== undefined ? { recencyDays } : {}),
      ...(requiredProviders.length > 0 ? { requiredProviders } : {}),
      ...(synthesisModel !== null ? { synthesisModelOverride: synthesisModel } : {}),
    });
    result = programResult.publicResearch;
    if (result === null) throw new Error('Source program completed without a public report.');
  } else {
    result = await research.runResearch({
      brief,
      kind,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(recencyDays !== undefined ? { recencyDays } : {}),
      ...(synthesisModel !== null ? { synthesisModelOverride: synthesisModel } : {}),
    });
  }
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
    discovery_count: Array.isArray(result.discoveries) ? result.discoveries.length : 0,
    source_program_status: programResult?.status ?? null,
    source_plan: programResult?.sourcePlan ?? null,
    source_coverage: programResult?.sourceCoverage ?? null,
    profile_coverage: programResult?.profileCoverage ?? null,
    trusted_recall_failures: programResult?.trustedRecallFailures ?? [],
    warnings: check.warnings,
  };

  const reportPath = await atomicWrite(values.output, `${result.report.full_markdown.trim()}\n`);
  const metadataPath = await atomicWrite(values.metadata, `${JSON.stringify(metadata, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({
    ok: programResult === null || programResult.status === 'complete',
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
    source_program_status: metadata.source_program_status,
    source_coverage_passed: metadata.source_coverage?.passed ?? null,
    profile_coverage_passed: metadata.profile_coverage?.passed ?? null,
  }, null, 2)}\n`);
  if (programResult !== null && programResult.status !== 'complete') process.exitCode = 2;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`run-braintied-research: ${message}\n`);
  process.exitCode = 1;
});
