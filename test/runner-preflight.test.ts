import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAllowlistedEnvFile } from '../skills/run-braintied-research/scripts/research-env-file.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(packageRoot, 'skills/run-braintied-research/scripts/run-research.mjs');
const geminiKeyNames = [
  'GEMINI_RESEARCH_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
];

function cleanRunnerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    ...geminiKeyNames,
    'BRAINTIED_GEMINI_KEY_NAME',
    'BRAINTIED_RESEARCH_ENV_FILE',
    'TAVILY_API_KEY',
    'SERPER_API_KEY',
    'ANTHROPIC_API_KEY',
    'VOYAGE_API_KEY',
    'BRAINTIED_GITHUB_PUBLIC_TOKEN',
    'BRAINTIED_GITHUB_REQUIRE_AUTH',
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ]) {
    delete env[name];
  }
  return env;
}

test('web-design v2 preflight fails closed when dedicated GitHub auth is absent', () => {
  const env = cleanRunnerEnvironment();
  env.GEMINI_API_KEY = 'test-only-key';
  env.TAVILY_API_KEY = 'test-only-tavily-key';
  env.BRAINTIED_GITHUB_REQUIRE_AUTH = 'true';
  const broadToken = 'ghp_broad_private_credential_must_be_ignored';
  const broadCliToken = 'gho_broad_cli_credential_must_be_ignored';
  env.GITHUB_TOKEN = broadToken;
  env.GH_TOKEN = broadCliToken;

  const result = spawnSync(process.execPath, [
    runner,
    '--check',
    '--kind', 'standard',
    '--max-cost-usd', '1',
    '--synthesis-model', 'gemini-3-flash-preview',
    '--profile', 'web-design-intelligence@2',
    '--as-of', '2026-07-22',
  ], { cwd: packageRoot, env, encoding: 'utf8' });

  assert.equal(result.status, 2, result.stderr);
  const preflight = JSON.parse(result.stdout) as {
    ready: boolean;
    missing: string[];
    required_providers: string[];
    provider_health: { github: { ready: boolean; authenticated: boolean; code: string } };
  };
  assert.equal(preflight.ready, false);
  assert.deepEqual(preflight.required_providers, ['github']);
  assert.deepEqual(preflight.provider_health.github, {
    ready: false,
    authenticated: false,
    required: true,
    ambientCredentialsIgnored: true,
    code: 'github_auth_required',
  });
  assert.ok(
    preflight.missing.includes('required provider unavailable: github'),
  );
  assert.ok(preflight.missing.includes(
    'GitHub public-research authentication policy is not satisfied (github_auth_required)',
  ));
  assert.equal(result.stdout.includes(broadToken), false);
  assert.equal(result.stdout.includes(broadCliToken), false);
});

test('web-design v2 preflight exposes sanitized authenticated health only', () => {
  const env = cleanRunnerEnvironment();
  env.GEMINI_API_KEY = 'test-only-key';
  env.TAVILY_API_KEY = 'test-only-tavily-key';
  env.BRAINTIED_GITHUB_REQUIRE_AUTH = 'true';
  const dedicated = 'github_pat_dedicated_public_research_credential';
  const broad = 'ghp_broad_private_credential_must_be_ignored';
  env.BRAINTIED_GITHUB_PUBLIC_TOKEN = dedicated;
  env.GITHUB_TOKEN = broad;

  const result = spawnSync(process.execPath, [
    runner,
    '--check',
    '--kind', 'standard',
    '--max-cost-usd', '1',
    '--synthesis-model', 'gemini-3-flash-preview',
    '--sources', 'web,github',
    '--profile', 'web-design-intelligence@2',
    '--as-of', '2026-07-22',
  ], { cwd: packageRoot, env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const preflight = JSON.parse(result.stdout) as {
    ready: boolean;
    required_providers: string[];
    provider_health: { github: Record<string, unknown> };
  };
  assert.equal(preflight.ready, true);
  assert.deepEqual(preflight.required_providers, ['github']);
  assert.deepEqual(preflight.provider_health.github, {
    ready: true,
    authenticated: true,
    required: true,
    ambientCredentialsIgnored: true,
    code: 'ready_authenticated_ambient_ignored',
  });
  assert.equal('token' in preflight.provider_health.github, false);
  assert.equal(result.stdout.includes(dedicated), false);
  assert.equal(result.stdout.includes(broad), false);
});

test('dotenv parser returns only allowlisted names using the documented single-line grammar', () => {
  const parsed = parseAllowlistedEnvFile([
    'export TAVILY_API_KEY=plain-value # comment',
    'SERPER_API_KEY=`value#inside-backticks`',
    'GEMINI_API_KEY="line-one\\nline-two"',
    'UNRELATED_PRIVATE_KEY=must-not-load',
    '',
  ].join('\n'), '/test/research.env', new Set([
    'TAVILY_API_KEY',
    'SERPER_API_KEY',
    'GEMINI_API_KEY',
  ]));

  assert.deepEqual([...parsed.entries()], [
    ['TAVILY_API_KEY', 'plain-value'],
    ['SERPER_API_KEY', 'value#inside-backticks'],
    ['GEMINI_API_KEY', 'line-one\nline-two'],
  ]);
  assert.equal(parsed.has('UNRELATED_PRIVATE_KEY'), false);
});

test('Gemini-backed standard research does not require Anthropic or Voyage', () => {
  const env = cleanRunnerEnvironment();
  env.GEMINI_API_KEY = 'test-only-key';
  env.SEARXNG_URLS = 'https://search.example';

  const result = spawnSync(process.execPath, [
    runner,
    '--check',
    '--kind', 'standard',
    '--max-cost-usd', '1',
    '--synthesis-model', 'gemini-3-flash-preview',
  ], { cwd: packageRoot, env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const preflight = JSON.parse(result.stdout) as { ready: boolean; missing: string[]; warnings: string[] };
  assert.equal(preflight.ready, true);
  assert.deepEqual(preflight.missing, []);
  assert.ok(preflight.warnings.some((warning) => warning.includes('critique')));
  assert.ok(preflight.warnings.some((warning) => warning.includes('reranking')));
});

test('secure env file overrides stale inherited research settings and ignores unrelated names', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'braintied-research-env-'));
  const envFile = path.join(temporaryDirectory, 'research.env');
  try {
    writeFileSync(envFile, [
      'GEMINI_RESEARCH_KEY="file-gemini-key"',
      'TAVILY_API_KEY=file-tavily-key',
      'UNRELATED_PRIVATE_KEY=must-not-load',
      '',
    ].join('\n'), { mode: 0o600 });
    chmodSync(envFile, 0o600);

    const env = cleanRunnerEnvironment();
    env.GEMINI_RESEARCH_KEY = 'stale-inherited-key';
    env.TAVILY_API_KEY = '';
    delete env.ANTHROPIC_API_KEY;
    delete env.VOYAGE_API_KEY;

    const result = spawnSync(process.execPath, [
      runner,
      '--check',
      '--kind', 'standard',
      '--max-cost-usd', '1',
      '--synthesis-model', 'gemini-3-flash-preview',
      '--sources', 'web',
      '--require-providers', 'tavily',
      '--as-of', '2026-07-23',
      '--research-env-file', envFile,
    ], { cwd: packageRoot, env, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const preflight = JSON.parse(result.stdout) as {
      ready: boolean;
      configured_key_names: string[];
      runtime_environment: {
        source: string;
        loaded_names: string[];
        overridden_names: string[];
        env_files: string[];
        resolved_gemini_key_name: string;
      };
    };
    assert.equal(preflight.ready, true);
    assert.equal(preflight.runtime_environment.source, 'env-file');
    assert.deepEqual(preflight.runtime_environment.env_files, [envFile]);
    assert.ok(preflight.runtime_environment.loaded_names.includes('GEMINI_RESEARCH_KEY'));
    assert.ok(preflight.runtime_environment.loaded_names.includes('TAVILY_API_KEY'));
    assert.ok(preflight.runtime_environment.overridden_names.includes('GEMINI_RESEARCH_KEY'));
    assert.ok(preflight.runtime_environment.overridden_names.includes('TAVILY_API_KEY'));
    assert.equal(preflight.runtime_environment.resolved_gemini_key_name, 'GEMINI_RESEARCH_KEY');
    assert.ok(!preflight.configured_key_names.includes('UNRELATED_PRIVATE_KEY'));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('BRAINTIED_RESEARCH_ENV_FILE makes the secure allowlisted source portable across workspaces', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'braintied-research-shared-env-'));
  const envFile = path.join(temporaryDirectory, 'research.env');
  try {
    writeFileSync(envFile, [
      'GOOGLE_GENERATIVE_AI_API_KEY=portable-gemini-key',
      'BRAINTIED_GEMINI_KEY_NAME=GOOGLE_GENERATIVE_AI_API_KEY',
      'SERPER_API_KEY=portable-serper-key',
      '',
    ].join('\n'), { mode: 0o600 });
    chmodSync(envFile, 0o600);

    const env = cleanRunnerEnvironment();
    env.BRAINTIED_RESEARCH_ENV_FILE = envFile;
    env.GEMINI_RESEARCH_KEY = 'stale-inherited-key';

    const result = spawnSync(process.execPath, [
      runner,
      '--check',
      '--kind', 'quick',
      '--max-cost-usd', '1',
      '--synthesis-model', 'gemini-3-flash-preview',
    ], { cwd: packageRoot, env, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const preflight = JSON.parse(result.stdout) as {
      ready: boolean;
      enabled_search_providers: string[];
      runtime_environment: {
        source: string;
        env_files: string[];
        resolved_gemini_key_name: string;
      };
    };
    assert.equal(preflight.ready, true);
    assert.ok(preflight.enabled_search_providers.includes('serper'));
    assert.equal(preflight.runtime_environment.source, 'env-file');
    assert.deepEqual(preflight.runtime_environment.env_files, [envFile]);
    assert.equal(
      preflight.runtime_environment.resolved_gemini_key_name,
      'GOOGLE_GENERATIVE_AI_API_KEY',
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('every env file must be owner-only, even when recognized entries are not secrets', () => {
  if (process.platform === 'win32') return;
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'braintied-research-insecure-env-'));
  const envFile = path.join(temporaryDirectory, 'research.env');
  try {
    writeFileSync(envFile, [
      'SEARXNG_URLS=https://search.example',
      'DATABASE_URL=must-never-load',
      '',
    ].join('\n'), { mode: 0o644 });
    chmodSync(envFile, 0o644);

    const result = spawnSync(process.execPath, [
      runner,
      '--check',
      '--kind', 'quick',
      '--max-cost-usd', '1',
      '--research-env-file', envFile,
    ], { cwd: packageRoot, env: cleanRunnerEnvironment(), encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must have owner-only permissions/);
    assert.ok(!result.stderr.includes('must-never-load'));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('blank env-file assignment masks inherited provider credentials', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'braintied-research-mask-env-'));
  const envFile = path.join(temporaryDirectory, 'research.env');
  const fakeShell = path.join(temporaryDirectory, 'zsh');
  try {
    writeFileSync(envFile, 'TAVILY_API_KEY=\n', { mode: 0o600 });
    chmodSync(envFile, 0o600);
    writeFileSync(fakeShell, [
      '#!/bin/sh',
      "printf 'TAVILY_API_KEY=shell-tavily-key\\0'",
      '',
    ].join('\n'), { mode: 0o700 });
    chmodSync(fakeShell, 0o700);

    const env = cleanRunnerEnvironment();
    env.TAVILY_API_KEY = 'stale-tavily-key';
    env.GEMINI_API_KEY = 'test-gemini-key';
    env.SEARXNG_URLS = 'https://search.example';
    env.SHELL = fakeShell;
    const result = spawnSync(process.execPath, [
      runner,
      '--check',
      '--kind', 'quick',
      '--max-cost-usd', '1',
      '--sources', 'web',
      '--require-providers', 'tavily',
      '--as-of', '2026-07-23',
      '--research-env-file', envFile,
      '--load-shell-env',
    ], { cwd: packageRoot, env, encoding: 'utf8' });

    assert.equal(result.status, 2, result.stderr);
    const preflight = JSON.parse(result.stdout) as {
      configured_key_names: string[];
      runtime_environment: { masked_names: string[] };
      missing: string[];
    };
    assert.ok(!preflight.configured_key_names.includes('TAVILY_API_KEY'));
    assert.ok(preflight.runtime_environment.masked_names.includes('TAVILY_API_KEY'));
    assert.ok(preflight.missing.some((entry) => entry.includes('required provider unavailable: tavily')));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('conflicting Gemini aliases fail unless one alias is selected explicitly', () => {
  const env = cleanRunnerEnvironment();
  env.GOOGLE_GENERATIVE_AI_API_KEY = 'wrong-test-key';
  env.GOOGLE_GEMINI_API_KEY = 'working-test-key';
  env.SEARXNG_URLS = 'https://search.example';

  const baseArguments = [
    runner,
    '--check',
    '--kind', 'quick',
    '--max-cost-usd', '1',
  ];
  const conflicted = spawnSync(process.execPath, baseArguments, {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(conflicted.status, 1);
  assert.match(conflicted.stderr, /Conflicting Gemini aliases/);
  assert.ok(!conflicted.stderr.includes('wrong-test-key'));
  assert.ok(!conflicted.stderr.includes('working-test-key'));

  const selected = spawnSync(process.execPath, [
    ...baseArguments,
    '--gemini-key-name', 'GOOGLE_GEMINI_API_KEY',
  ], { cwd: packageRoot, env, encoding: 'utf8' });
  assert.equal(selected.status, 0, selected.stderr);
  const preflight = JSON.parse(selected.stdout) as {
    ready: boolean;
    runtime_environment: { resolved_gemini_key_name: string };
  };
  assert.equal(preflight.ready, true);
  assert.equal(preflight.runtime_environment.resolved_gemini_key_name, 'GOOGLE_GEMINI_API_KEY');
});

test('relative env-file paths are rejected', () => {
  const result = spawnSync(process.execPath, [
    runner,
    '--check',
    '--kind', 'quick',
    '--max-cost-usd', '1',
    '--research-env-file', 'relative/research.env',
  ], { cwd: packageRoot, env: cleanRunnerEnvironment(), encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must use an absolute path/);
});

test("Node's built-in env-file preloads are detected and refused", () => {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 6)) return;
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'braintied-node-env-file-'));
  const envFile = path.join(temporaryDirectory, 'unsafe.env');
  try {
    writeFileSync(envFile, 'UNRELATED_PRIVATE_KEY=must-not-appear\n', { mode: 0o600 });
    const flags = [`--env-file=${envFile}`];
    if (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 9)) {
      flags.push(`--env-file-if-exists=${envFile}`);
    }
    for (const flag of flags) {
      const result = spawnSync(process.execPath, [
        flag,
        runner,
        '--check',
        '--kind', 'quick',
        '--max-cost-usd', '1',
      ], { cwd: packageRoot, env: cleanRunnerEnvironment(), encoding: 'utf8' });

      assert.equal(result.status, 1, `${flag}: ${result.stderr}`);
      assert.match(result.stderr, /bypasses the research allowlist/);
      assert.ok(!result.stderr.includes('must-not-appear'));
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('load-shell-env can discover the shared absolute env-file pointer', () => {
  if (process.platform === 'win32') return;
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'braintied-research-shell-pointer-'));
  const envFile = path.join(temporaryDirectory, 'research.env');
  const fakeShell = path.join(temporaryDirectory, 'zsh');
  try {
    writeFileSync(envFile, [
      'GEMINI_API_KEY=shell-pointer-gemini-key',
      'SERPER_API_KEY=shell-pointer-serper-key',
      '',
    ].join('\n'), { mode: 0o600 });
    chmodSync(envFile, 0o600);
    writeFileSync(fakeShell, [
      '#!/bin/sh',
      "printf 'BRAINTIED_RESEARCH_ENV_FILE=%s\\0' \"$TEST_RESEARCH_ENV_FILE\"",
      '',
    ].join('\n'), { mode: 0o700 });
    chmodSync(fakeShell, 0o700);

    const env = cleanRunnerEnvironment();
    env.SHELL = fakeShell;
    env.TEST_RESEARCH_ENV_FILE = envFile;
    const result = spawnSync(process.execPath, [
      runner,
      '--check',
      '--kind', 'quick',
      '--max-cost-usd', '1',
      '--load-shell-env',
    ], { cwd: packageRoot, env, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const preflight = JSON.parse(result.stdout) as {
      ready: boolean;
      enabled_search_providers: string[];
      runtime_environment: { env_files: string[]; source: string };
    };
    assert.equal(preflight.ready, true);
    assert.ok(preflight.enabled_search_providers.includes('serper'));
    assert.deepEqual(preflight.runtime_environment.env_files, [envFile]);
    assert.equal(preflight.runtime_environment.source, 'env-file+interactive-shell');
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('symlinked env files are rejected before their contents are read', () => {
  if (process.platform === 'win32') return;
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'braintied-research-symlink-env-'));
  const targetFile = path.join(temporaryDirectory, 'target.env');
  const linkedFile = path.join(temporaryDirectory, 'linked.env');
  try {
    writeFileSync(targetFile, 'GEMINI_API_KEY=must-not-appear\n', { mode: 0o600 });
    chmodSync(targetFile, 0o600);
    symlinkSync(targetFile, linkedFile);
    const result = spawnSync(process.execPath, [
      runner,
      '--check',
      '--kind', 'quick',
      '--max-cost-usd', '1',
      '--research-env-file', linkedFile,
    ], { cwd: packageRoot, env: cleanRunnerEnvironment(), encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not be a symbolic link/);
    assert.ok(!result.stderr.includes('must-not-appear'));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
