/**
 * Contract tests for the OpenAI-SDK call path in synthesisGenerate().
 *
 * Why this file exists: research declares `openai` in dependencies and calls
 * it in exactly one place (synthesis.ts, the qwen-* / OpenRouter branch), but
 * NO test constructed a client or exercised a request. The package's whole
 * OpenAI surface was covered only by "it compiles" — so an SDK major bump had
 * no runtime evidence behind it at all. That is the same trap as a package
 * with no test script: a green suite that is silent about the thing you
 * changed.
 *
 * These stub globalThis.fetch rather than mocking the openai module, so the
 * REAL SDK builds the request and parses the response. That is what makes them
 * meaningful across a major: they assert the SDK still honours baseURL, still
 * sends the body we expect, and still exposes choices[]/usage in the shape
 * this package reads.
 *
 * Deliberately no API key is required and no network call is made: the key is
 * a config field the test supplies directly.
 */

import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';

import { synthesisGenerate } from '../src/synthesis.js';
import type { ResearchCredentials } from '../src/credentials.js';

const QWEN_MODEL = 'qwen-3-max';

type CapturedRequest = { url: string; init: RequestInit | undefined };

const realFetch = globalThis.fetch;
const credentials: ResearchCredentials = { openrouterApiKey: 'test-key-not-a-real-credential' };  // git-secret-allow: fake fixture value, never a live credential
let captured: CapturedRequest[] = [];

function stubFetch(payload: unknown, status = 200): void {
  captured = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function completion(content: string, usage?: Record<string, number>) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: QWEN_MODEL,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('synthesisGenerate — OpenAI SDK path', () => {
  test('returns the assistant content and maps usage to the internal shape', async () => {
    stubFetch(
      completion('synthesised text', { prompt_tokens: 120, completion_tokens: 45 }),
    );

    const result = await synthesisGenerate({
      credentials,
      system: 'you are a synthesiser',
      user: 'synthesise this',
      model: QWEN_MODEL,
      maxTokens: 256,
    });

    assert.equal(result.text, 'synthesised text');
    assert.equal(result.inputTokens, 120);
    assert.equal(result.outputTokens, 45);
    // OpenRouter surfaces no cache-hit field; the code hardcodes 0.
    assert.equal(result.cachedReadTokens, 0);
  });

  test('sends the request to the OpenRouter base URL, not api.openai.com', async () => {
    stubFetch(completion('x'));

    await synthesisGenerate({
      credentials,
      system: 's',
      user: 'u',
      model: QWEN_MODEL,
      maxTokens: 16,
    });

    assert.equal(captured.length, 1);
    assert.ok(String(captured[0]?.url).includes('openrouter.ai/api/v1'));
    assert.ok(String(captured[0]?.url).includes('/chat/completions'));
    assert.ok(!String(captured[0]?.url).includes('api.openai.com'));
  });

  test('sends model, max_tokens and both message roles in the body', async () => {
    stubFetch(completion('x'));

    await synthesisGenerate({
      credentials,
      system: 'SYSTEM-MARKER',
      user: 'USER-MARKER',
      model: QWEN_MODEL,
      maxTokens: 1234,
    });

    const body = JSON.parse(String(captured[0]?.init?.body));
    assert.equal(body.model, QWEN_MODEL);
    assert.equal(body.max_tokens, 1234);
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'SYSTEM-MARKER' },
      { role: 'user', content: 'USER-MARKER' },
    ]);
  });

  test('sends the API key as a bearer token', async () => {
    stubFetch(completion('x'));

    await synthesisGenerate({
      credentials,
      system: 's',
      user: 'u',
      model: QWEN_MODEL,
      maxTokens: 16,
    });

    const headers = new Headers(captured[0]?.init?.headers);
    assert.equal(
      headers.get('authorization'),
      'Bearer test-key-not-a-real-credential',
    );
  });

  test('tolerates a response with no usage block', async () => {
    stubFetch(completion('no usage here'));

    const result = await synthesisGenerate({
      credentials,
      system: 's',
      user: 'u',
      model: QWEN_MODEL,
      maxTokens: 16,
    });

    assert.equal(result.text, 'no usage here');
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
  });

  test('returns empty text when the model returns a null content', async () => {
    stubFetch({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: QWEN_MODEL,
      choices: [
        { index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' },
      ],
    });

    const result = await synthesisGenerate({
      credentials,
      system: 's',
      user: 'u',
      model: QWEN_MODEL,
      maxTokens: 16,
    });

    assert.equal(result.text, '');
  });

  test('fails loudly when the OpenRouter key is absent from the config', async () => {
    stubFetch(completion('never reached'));

    await assert.rejects(synthesisGenerate({
        credentials: {},
        system: 's',
        user: 'u',
        model: QWEN_MODEL,
        maxTokens: 16,
      }), /openrouterApiKey/);

    // No silent fallback to an unauthenticated call.
    assert.equal(captured.length, 0);
  });
});
