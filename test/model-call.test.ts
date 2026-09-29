/**
 * Contract tests for callModel, the one transport every research stage uses.
 *
 * These stub globalThis.fetch rather than mocking the SDKs, so the real
 * Anthropic and Gemini clients build the request and parse the response. What
 * is asserted is where the request goes, which key it carries, which model id
 * is in the body, and which provider and model the result is attributed to:
 * the four things prefix routing got wrong.
 *
 * No network call is made and no real key is used.
 */

import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';

import { resolveForStyle, resolveForUseCase } from '@braintied/models';

import { MissingCredentialError, type ResearchCredentials } from '../src/credentials.js';
import { callModel, providerForModelId, UnroutableModelError } from '../src/model-call.js';
import { researchStageResolution } from '../src/model-policy.js';
import { synthesisGenerate } from '../src/synthesis.js';

type CapturedRequest = { url: string; headers: Headers; body: Record<string, unknown> };

const realFetch = globalThis.fetch;
let captured: CapturedRequest[] = [];

const credentials: ResearchCredentials = {
  deepseekApiKey: 'test-deepseek-key', // git-secret-allow: fake fixture value, never a live credential
  fireworksApiKey: 'test-fireworks-key', // git-secret-allow: fake fixture value, never a live credential
  geminiApiKey: 'test-gemini-key', // git-secret-allow: fake fixture value, never a live credential
};

function readBody(init: RequestInit | undefined): Record<string, unknown> {
  if (init === undefined || typeof init.body !== 'string') return {};
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed));
}

function stubFetch(payload: unknown): void {
  captured = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    captured.push({ url, headers: new Headers(init?.headers), body: readBody(init) });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function messagesReply(model: string) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: '{"ok":true}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 80 },
  };
}

function onlyRequest(): CapturedRequest {
  assert.equal(captured.length, 1, 'exactly one provider request');
  const [request] = captured;
  assert.ok(request !== undefined);
  return request;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('callModel routes by the resolution provider', () => {
  test('the extract stage under the fleet default goes to DeepSeek with thinking off', async () => {
    const resolution = researchStageResolution('extract');
    assert.equal(resolution.provider, 'deepseek');
    assert.equal(resolution.apiModelId, 'deepseek-flash');
    stubFetch(messagesReply(resolution.apiModelId));

    const result = await callModel({
      credentials,
      system: 'sys',
      user: 'usr',
      model: resolution,
      maxTokens: 256,
      temperature: 0.2,
    });

    const request = onlyRequest();
    assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(request.headers.get('x-api-key'), 'test-deepseek-key');
    assert.equal(request.body.model, 'deepseek-flash');
    // research-extract carries effort 'minimum'; DeepSeek's lowest is thinking off.
    assert.deepEqual(request.body.thinking, { type: 'disabled' });
    // Temperature is not sent on the Anthropic wire.
    assert.equal(request.body.temperature, undefined);
    assert.deepEqual(result, {
      text: '{"ok":true}',
      inputTokens: 120,
      cachedReadTokens: 80,
      outputTokens: 30,
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
  });

  test('critique sends no effort, so the provider default thinking applies', async () => {
    const resolution = researchStageResolution('critique');
    stubFetch(messagesReply(resolution.apiModelId));
    await callModel({ credentials, system: 's', user: 'u', model: resolution, maxTokens: 64 });
    const request = onlyRequest();
    assert.equal(request.body.thinking, undefined);
    assert.equal(request.body.output_config, undefined);
  });

  test('a us residency resolution goes to Fireworks with the Fireworks key', async () => {
    const resolution = resolveForUseCase('research-critique', { moduleId: 'research', residency: 'us' });
    assert.equal(resolution.provider, 'fireworks');
    stubFetch(messagesReply(resolution.apiModelId));

    const result = await callModel({ credentials, system: 's', user: 'u', model: resolution, maxTokens: 64 });

    const request = onlyRequest();
    assert.equal(request.url, 'https://api.fireworks.ai/inference/v1/messages');
    assert.equal(request.headers.get('x-api-key'), 'test-fireworks-key');
    assert.equal(request.body.model, resolution.apiModelId);
    assert.equal(result.provider, 'fireworks');
    assert.equal(result.model, resolution.apiModelId);
  });

  test('a bare Fireworks id is routed to Fireworks, not to api.anthropic.com', async () => {
    const id = resolveForUseCase('research-synthesis', { residency: 'us' }).apiModelId;
    assert.equal(providerForModelId(id), 'fireworks');
    stubFetch(messagesReply(id));
    await synthesisGenerate({ credentials, system: 's', user: 'u', model: id, maxTokens: 64 });
    assert.equal(onlyRequest().url, 'https://api.fireworks.ai/inference/v1/messages');
  });

  test('a google resolution still goes to generateContent with the Gemini key', async () => {
    const resolution = resolveForStyle('MICRO', { providers: ['google'] });
    stubFetch({
      candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' } }],
      usageMetadata: {
        promptTokenCount: 50,
        cachedContentTokenCount: 10,
        candidatesTokenCount: 7,
        thoughtsTokenCount: 3,
      },
    });

    const result = await callModel({
      credentials,
      system: 's',
      user: 'u',
      model: resolution,
      maxTokens: 64,
      jsonResponse: true,
    });

    const request = onlyRequest();
    assert.match(request.url, new RegExp(`/models/${resolution.apiModelId}:generateContent`));
    assert.equal(request.headers.get('x-goog-api-key'), 'test-gemini-key');
    assert.deepEqual(result, {
      text: 'hello',
      inputTokens: 40,
      cachedReadTokens: 10,
      outputTokens: 10,
      provider: 'google',
      model: resolution.apiModelId,
    });
  });
});

describe('callModel refuses what it cannot route', () => {
  test('a missing key names the field for the resolved provider', async () => {
    stubFetch(messagesReply('deepseek-flash'));
    await assert.rejects(
      () => callModel({
        credentials: {},
        system: 's',
        user: 'u',
        model: researchStageResolution('extract'),
        maxTokens: 64,
      }),
      (error: unknown) => error instanceof MissingCredentialError && error.field === 'deepseekApiKey',
    );
    assert.equal(captured.length, 0, 'no request without a key');
  });

  test('an id outside the catalog is an error, not a guess', () => {
    assert.throws(() => providerForModelId('not-a-real-model'), UnroutableModelError);
  });

  test('qwen override ids keep their OpenRouter route', () => {
    assert.equal(providerForModelId('qwen/qwen3-235b-a22b-instruct-2507'), 'openrouter');
  });
});
