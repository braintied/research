import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageScripts = path.join(packageRoot, 'skills/run-braintied-research/scripts');
const FIXTURE_VERSION = '0.0.0-package-root-fixture';

async function writePackageJson(directory: string, name: string, version: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version }));
}

/**
 * Lay out a fake HOME the way a skill install looks on a laptop: the runner is a
 * plain copy under ~/.claude/skills/run-braintied-research/scripts, and
 * ~/.claude has a package.json of its own that is not this package.
 */
async function installedCopy(t: test.TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), 'braintied-research-home-'));
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  const scripts = path.join(home, '.claude/skills/run-braintied-research/scripts');
  await cp(packageScripts, scripts, { recursive: true });
  await writePackageJson(path.join(home, '.claude'), 'claude-home', '9.9.9');
  return { home, runner: path.join(scripts, 'run-internal-research.mjs') };
}

function check(runner: string, env: NodeJS.ProcessEnv) {
  const base = { ...process.env };
  delete base.BRAINTIED_RESEARCH_PACKAGE_ROOT;
  return spawnSync(process.execPath, [runner, '--check', '--kind', 'quick', '--max-cost-usd', '1'], {
    cwd: path.dirname(runner),
    env: { ...base, BRAINTIED_AGENT_TOKEN: 'sat_package_root_test', ...env }, // git-secret-allow: fake fixture token; --check never sends it
    encoding: 'utf8',
  });
}

function reportedVersion(stdout: string) {
  return (JSON.parse(stdout) as { package_version: string }).package_version;
}

test('a copy outside the monorepo resolves the stack checkout, not ~/.claude', async (t) => {
  const { home, runner } = await installedCopy(t);
  await writePackageJson(
    path.join(home, 'Development/stack/packages/research'),
    '@braintied/research',
    FIXTURE_VERSION,
  );

  const result = check(runner, { HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(reportedVersion(result.stdout), FIXTURE_VERSION);
});

test('BRAINTIED_RESEARCH_PACKAGE_ROOT wins over every other candidate', async (t) => {
  const { home, runner } = await installedCopy(t);
  await writePackageJson(
    path.join(home, 'Development/stack/packages/research'),
    '@braintied/research',
    FIXTURE_VERSION,
  );
  const expected = (JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
    version: string;
  }).version;

  const result = check(runner, { HOME: home, BRAINTIED_RESEARCH_PACKAGE_ROOT: packageRoot });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(reportedVersion(result.stdout), expected);
});

test('a manifest with the wrong name is skipped, and no match fails naming every path', async (t) => {
  const { home, runner } = await installedCopy(t);
  await writePackageJson(
    path.join(home, 'Development/stack/packages/research'),
    '@braintied/not-research',
    FIXTURE_VERSION,
  );

  const result = check(runner, { HOME: home });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not find the @braintied\/research package root/);
  assert.ok(result.stderr.includes(path.join(home, '.claude')), result.stderr);
  assert.ok(
    result.stderr.includes(path.join(home, 'Development/stack/packages/research')),
    result.stderr,
  );
  assert.doesNotMatch(result.stdout, /9\.9\.9/);
});

test('inside the package the runner reports its own package version', async () => {
  const expected = (JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
    version: string;
  }).version;
  const home = await mkdtemp(path.join(tmpdir(), 'braintied-research-empty-home-'));
  try {
    const result = check(path.join(packageScripts, 'run-internal-research.mjs'), { HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(reportedVersion(result.stdout), expected);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
