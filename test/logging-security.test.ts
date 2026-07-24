import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizePipelineUsageMetadata } from '../src/index.js';
import {
  createSanitizedLogger,
  type Logger,
} from '../src/logger.js';

test('sanitized logger never forwards raw briefs, queries, URLs, bodies, or errors', () => {
  const calls: unknown[][] = [];
  const sink: Logger = {
    info: (obj, msg) => calls.push([obj, msg]),
    warn: (obj, msg) => calls.push([obj, msg]),
    error: (obj, msg) => calls.push([obj, msg]),
    debug: (obj, msg) => calls.push([obj, msg]),
  };
  const logger = createSanitizedLogger(sink);
  logger.warn(
    {
      brief: 'private Burning Man shopping preferences',
      query: 'private user query',
      url: 'https://example.com/path?token=top-secret',
      body: 'private provider response',
      error: 'request failed at https://api.test/?key=top-secret',
      providerName: 'tavily',
      count: 4,
    },
    '[test] Provider failed',
  );
  logger.error('raw private payload that must not be emitted');

  const serialized = JSON.stringify(calls);
  for (const secret of [
    'private Burning Man',
    'private user query',
    'top-secret',
    'private provider response',
    'raw private payload',
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(serialized.includes('tavily'), true);
  assert.equal(serialized.includes('[test] Provider failed'), false);
  assert.equal(serialized.includes('[research] event'), true);
});

test('sanitized logger does not trust a known message prefix or safe-looking value field', () => {
  const calls: unknown[][] = [];
  const sink: Logger = {
    info: (obj, msg) => calls.push([obj, msg]),
    warn: (obj, msg) => calls.push([obj, msg]),
    error: (obj, msg) => calls.push([obj, msg]),
    debug: (obj, msg) => calls.push([obj, msg]),
  };
  const logger = createSanitizedLogger(sink);
  logger.info(
    {
      category: 'secret-acquisition-target',
      operation: 'private user taste profile',
      provider: 'api_key_SECRET',
      query: 'secret',
      secret_number: 8675309,
      status: 'customer-medical-status',
      'private user query': true,
      error: { 'secret-key-material': 7 },
    },
    '[Tavily] private user taste profile',
  );

  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes('private user taste profile'), false);
  assert.equal(serialized.includes('api_key_SECRET'), false);
  assert.equal(serialized.includes('customer-medical-status'), false);
  assert.equal(serialized.includes('secret-acquisition-target'), false);
  assert.equal(serialized.includes('8675309'), false);
  assert.equal(serialized.includes('private user query'), false);
  assert.equal(serialized.includes('secret-key-material'), false);
  assert.equal(serialized.includes('[Tavily] event'), true);
});

test('usage metadata is an allowlisted telemetry contract', () => {
  const metadata = sanitizePipelineUsageMetadata({
    model: 'gemini-3.5-flash-lite',
    operation: 'extract-input',
    results: 8,
    source_mode: 'web',
    query: 'private brief-derived query',
    url: 'https://example.com/?signature=private',
    body: 'provider response',
    nested: { prompt: 'private' },
    secret_number: 8675309,
  });
  assert.deepEqual(metadata, {
    model: 'gemini-3.5-flash-lite',
    operation: 'extract-input',
    results: 8,
    source_mode: 'web',
  });

  assert.deepEqual(sanitizePipelineUsageMetadata({
    model: 'gemini-private_customer_name',
    operation: 'private-user-segment',
    source_mode: 'private-customer-name',
    sort: 'private-query',
  }), {});
});
