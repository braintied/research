import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCacheKey } from '../src/extract-cache.js';

test('extractCacheKey is stable for same url+content+model', () => {
  const a = extractCacheKey('https://example.com/a', 'hello world', 'gemini-3.1-flash-lite');
  const b = extractCacheKey('https://example.com/a', 'hello world', 'gemini-3.1-flash-lite');
  assert.equal(a, b);
  assert.match(a, /^extract:v1:gemini-3\.1-flash-lite:/);
});

test('extractCacheKey changes when content changes', () => {
  const a = extractCacheKey('https://example.com/a', 'hello world', 'gemini-3.1-flash-lite');
  const b = extractCacheKey('https://example.com/a', 'hello world!', 'gemini-3.1-flash-lite');
  assert.notEqual(a, b);
});

test('extractCacheKey changes when model changes', () => {
  const a = extractCacheKey('https://example.com/a', 'hello world', 'gemini-3.1-flash-lite');
  const b = extractCacheKey('https://example.com/a', 'hello world', 'gemini-3.5-flash-lite');
  assert.notEqual(a, b);
});
