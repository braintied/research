import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const commonJsBundle = readFileSync(
  new URL('../dist/index.js', import.meta.url),
  'utf8',
);

test('CommonJS entry point contains no empty import.meta compatibility shim', () => {
  assert.doesNotMatch(commonJsBundle, /var import_meta = \{\}/);
  assert.doesNotMatch(commonJsBundle, /createRequire\)\(import_meta\.url\)/);
});

