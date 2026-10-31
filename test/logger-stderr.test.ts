import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const loggerPath = fileURLToPath(new URL('../src/logger.ts', import.meta.url));

/** Runs the default logger in a fresh process so stdout and stderr are the real streams. */
function runLogger(body: string): { stdout: string; stderr: string } {
  const script = `import { logger } from ${JSON.stringify(loggerPath)};\n${body}`;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, stderr: result.stderr };
}

test('default logger writes nothing to stdout at any level', () => {
  const { stdout, stderr } = runLogger(`
    logger.info({ providerName: 'reddit', count: 3 }, '[Reddit] search');
    logger.info('[Reddit] fetch');
    logger.debug({ providerName: 'reddit' }, '[Reddit] debug');
    logger.debug('[Reddit] debug');
    logger.warn({ providerName: 'reddit' }, '[Reddit] warn');
    logger.error({ providerName: 'reddit' }, '[Reddit] error');
  `);
  assert.equal(stdout, '');
  assert.equal(stderr.match(/\[Reddit\] event/g)?.length, 6);
});

test('default logger keeps sanitizing what it writes to stderr', () => {
  const { stdout, stderr } = runLogger(`
    logger.info({ query: 'private user query', count: 2 }, '[Reddit] private body');
  `);
  assert.equal(stdout, '');
  assert.equal(stderr.includes('private user query'), false);
  assert.equal(stderr.includes('private body'), false);
  assert.equal(stderr.includes('[Reddit] event'), true);
});
