/**
 * The one model transport every research stage calls.
 *
 * Extraction, planning, categorisation, synthesis, critique and assembly all
 * send one system + user prompt and read back text and token usage. Which
 * model runs is `@braintied/models`' decision (a `ModelResolution`); this
 * module only decides HOW to reach the provider that resolution names, and
 * reports back the provider and wire id that actually ran so every cost row
 * is attributed to them.
 *
 * Routing is by provider, never by model-name prefix. Until 2026-09 the
 * dispatcher read `model.startsWith('gemini-')` and friends, so an id the
 * catalog serves from a different vendor (the US-hosted Fireworks copy of
 * DeepSeek, `accounts/fireworks/models/...`) fell through to api.anthropic.com.
 * That is also why the research use-cases were bound to `providers: ['google']`:
 * the extract / plan / categorise stages built Gemini `generateContent` bodies
 * by hand, so no other resolution could be sent.
 *
 *   google      → @google/genai SDK (native generateContent)
 *   openrouter  → OpenAI SDK, OpenRouter base URL (`qwen*` override ids only)
 *   any other   → Anthropic SDK against the provider's `anthropic-messages`
 *                 base URL from `@braintied/models` `providerWires` (anthropic,
 *                 deepseek, fireworks, zai)
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  findCatalogModel,
  providerWires,
  reasoningParams,
  WireFormatUnsupportedError,
  type ModelResolution,
  type ReasoningEffort,
} from '@braintied/models';
import type { ThinkingConfig, ThinkingLevel } from '@google/genai';
import {
  requireAnthropicApiKey,
  requireGeminiApiKey,
  MissingCredentialError,
  type ResearchCredentials,
} from './credentials.js';
import { recordGeminiUsage } from './cache-hit-measurement.js';

/**
 * OpenRouter is not a catalog provider: it only serves the `qwen*` bake-off
 * override ids, which are OpenRouter model ids rather than catalog ids.
 */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Hard ceiling on a single provider synthesis call. Root-cause fix for the
 * 2026-07-20 synthesis-hang incident: 12/12 prompt runs froze in
 * status='synthesizing' for 90+ minutes because none of the provider SDK
 * clients had a request timeout — a wedged socket stalls the promise
 * forever and the run never advances, never fails, and never writes a
 * heartbeat. 15 minutes is far above the p99 for a Sonnet section call
 * (1-5 min at 4-16k max tokens); it is a death sentence for a wedged
 * request, not a performance target.
 */
export const SYNTHESIS_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/** Thrown when a google resolution runs but the host did not install the optional peer. */
export class GeminiSdkMissingError extends Error {
  constructor() {
    super(
      '@google/genai is required when a research stage resolves to google. Add it to the host package (it is an optional peer of @braintied/research so Watchtower and other non-Gemini hosts do not pull it into their image).',
    );
    this.name = 'GeminiSdkMissingError';
  }
}

async function loadGoogleGenAI(): Promise<typeof import('@google/genai')> {
  try {
    return await import('@google/genai');
  } catch (cause) {
    const error = new GeminiSdkMissingError();
    error.cause = cause;
    throw error;
  }
}

/**
 * `reasoningParams()`'s Gemini fragment carries the fleet's lowercase
 * `ReasoningEffort` vocabulary (`none`, `minimal`, `low`, ...); the
 * `@google/genai` SDK's `ThinkingConfig.thinkingLevel` is its own uppercase
 * enum, and that enum has no "off" member. Gemini's catalog descriptors never
 * set `canDisable: true` today (there is no verified "off" wire value), so
 * `none` disables via `thinkingBudget: 0` instead — the SDK's own documented
 * meaning for that field ("0 is DISABLED"). `xhigh`/`max` collapse to `HIGH`,
 * the ceiling the enum actually offers; no catalog entry resolves to them
 * today (Gemini's `gemini-thinking-level` descriptors only ever list
 * low/medium/high), so this is a safety net, not a live path.
 */
function geminiThinkingConfig(
  effort: ReasoningEffort,
  levels: typeof ThinkingLevel,
): ThinkingConfig {
  switch (effort) {
    case 'none':
      return { thinkingBudget: 0 };
    case 'minimal':
      return { thinkingLevel: levels.MINIMAL };
    case 'low':
      return { thinkingLevel: levels.LOW };
    case 'medium':
      return { thinkingLevel: levels.MEDIUM };
    case 'high':
    case 'xhigh':
    case 'max':
      return { thinkingLevel: levels.HIGH };
    default: {
      const exhaustive: never = effort;
      throw new Error(`Unhandled reasoning effort ${String(exhaustive)}`);
    }
  }
}

/**
 * `reasoningParams()`'s Anthropic fragment types `output_config.effort` as
 * the full fleet `ReasoningEffort` (it is one field shared across every
 * control); the Anthropic SDK's own `effort` field only accepts
 * `'low'|'medium'|'high'|'xhigh'|'max'` — `none` and `minimal` are never
 * legal there; `none` instead routes to the `thinking: {type: 'disabled'}`
 * branch. Anthropic's catalog descriptors never set `canDisable: true` or
 * list `minimal`, so this call should never see either value; it throws
 * rather than send a request the wire would 400 on.
 */
function anthropicEffort(effort: ReasoningEffort): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (effort === 'none' || effort === 'minimal') {
    throw new Error(
      `reasoningParams() returned an Anthropic output_config.effort of "${effort}", which the `
        + 'Messages API does not accept there; this indicates a catalog or thinking-policy defect, not a real request.',
    );
  }
  return effort;
}

/**
 * `reasoningParams()`'s return type is not narrowed by the `wire` argument it
 * was called with, so its `thinking` field's type covers every control's
 * shape: Anthropic's own `{type: 'disabled'}` and DeepSeek's
 * `{type: 'enabled'}` (paired with a `reasoning_effort` field this function
 * never sees). Requested on the `anthropic-messages` wire specifically, only
 * `'disabled'` is ever actually returned — DeepSeek's `deepseek-thinking`
 * control pairs `type: 'enabled'` with `output_config`, not a bare `thinking`
 * field, on this wire. `'enabled'` reaching here would be a `reasoningParams()`
 * defect: this throws rather than send Anthropic a fragment missing the
 * `budget_tokens` its own `type: 'enabled'` shape requires.
 */
function anthropicThinkingDisabled(thinking: { type: 'disabled' } | { type: 'enabled' }): { type: 'disabled' } {
  if (thinking.type !== 'disabled') {
    throw new Error(
      `reasoningParams() returned an Anthropic "thinking" fragment of type "${thinking.type}" on the `
        + 'anthropic-messages wire, where only "disabled" is expected.',
    );
  }
  return thinking;
}

/** Thrown when a provider call exceeds its deadline. */
export class SynthesisTimeoutError extends Error {
  constructor(
    public readonly model: string,
    public readonly timeoutMs: number,
  ) {
    super(`Synthesis call to ${model} timed out after ${timeoutMs}ms`);
    this.name = 'SynthesisTimeoutError';
  }
}

/**
 * Thrown when a model id names no provider this package can reach: it is not
 * in the `@braintied/models` catalog and is not an OpenRouter `qwen*` id.
 * Guessing a vendor from the id is how Fireworks ids reached api.anthropic.com.
 */
export class UnroutableModelError extends Error {
  constructor(public readonly model: string) {
    super(
      `Model "${model}" is not in the @braintied/models catalog, so its provider is unknown. `
        + 'Pass a ModelResolution, or a catalog id.',
    );
    this.name = 'UnroutableModelError';
  }
}

/**
 * Race a provider call against a hard deadline with explicit timer cleanup.
 * Belt-and-suspenders alongside SDK-level `timeout` options: the observed
 * hang was an SDK-level wait that never fired, so the watchdog does not
 * trust any single SDK to bound its own sockets.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, model: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new SynthesisTimeoutError(model, timeoutMs));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * What to run: a resolution from `@braintied/models` (every default stage), or
 * a bare model id (a caller's `synthesisModelOverride`). A bare id carries no
 * effort, so the provider's default reasoning applies.
 */
export type ModelCallTarget = string | ModelResolution;

interface Route {
  provider: string;
  apiModelId: string;
  resolution: ModelResolution | null;
}

/** The provider serving a bare model id, from the catalog. */
export function providerForModelId(modelId: string): string {
  // Override contract since the bake-off: `qwen*` ids are OpenRouter ids,
  // including `qwen/<openrouter-id>`, even where the catalog lists the same
  // weights under another host.
  if (modelId.startsWith('qwen')) return 'openrouter';
  const row = findCatalogModel(modelId);
  if (row === null) {
    throw new UnroutableModelError(modelId);
  }
  return row.provider;
}

function routeFor(target: ModelCallTarget): Route {
  if (typeof target === 'string') {
    return { provider: providerForModelId(target), apiModelId: target, resolution: null };
  }
  return { provider: target.provider, apiModelId: target.apiModelId, resolution: target };
}

/**
 * The `ResearchCredentials` field holding the key for a provider, or null when
 * the record has no field for it (research cannot reach that provider).
 */
export function credentialFieldForProvider(provider: string): keyof ResearchCredentials | null {
  switch (provider) {
    case 'google':
      return 'geminiApiKey';
    case 'anthropic':
      return 'anthropicApiKey';
    case 'deepseek':
      return 'deepseekApiKey';
    case 'fireworks':
      return 'fireworksApiKey';
    case 'zai':
      return 'zaiApiKey';
    case 'openrouter':
      return 'openrouterApiKey';
    default:
      return null;
  }
}

/** The key for a provider on the Anthropic Messages wire, or a named error. */
function messagesApiKey(credentials: ResearchCredentials, provider: string): string {
  if (provider === 'anthropic') return requireAnthropicApiKey(credentials);
  const field = credentialFieldForProvider(provider);
  if (field === null) {
    throw new MissingCredentialError(
      `${provider}ApiKey`,
      `ResearchCredentials has no field for provider "${provider}"; add one before routing research to it`,
    );
  }
  const value = credentials[field];
  if (typeof value !== 'string') {
    throw new MissingCredentialError(field, `required when a research model call resolves to ${provider}`);
  }
  return value;
}

function messagesBaseUrl(provider: string): string {
  const wires = providerWires(provider);
  const messages = wires.find((wire) => wire.format === 'anthropic-messages');
  if (messages === undefined) {
    throw new WireFormatUnsupportedError(
      provider,
      'anthropic-messages',
      wires.map((wire) => wire.format),
    );
  }
  return messages.baseUrl;
}

export interface ModelCallResult {
  text: string;
  /** Uncached input tokens — billed at the full input rate. */
  inputTokens: number;
  /**
   * Cache-read input tokens — billed at the model's `cacheHitInputUsdPerM`
   * if defined, otherwise the full input rate. The Anthropic wire (Anthropic,
   * DeepSeek, Fireworks, Z.ai) populates `usage.cache_read_input_tokens`.
   * Gemini populates `usageMetadata.cachedContentTokenCount` (a SLICE of
   * `promptTokenCount`, not in addition to it).
   */
  cachedReadTokens: number;
  /** Billable output, thinking included. */
  outputTokens: number;
  /** Catalog provider that served the call. Attribute cost to this. */
  provider: string;
  /** Wire model id that ran. Attribute cost to this. */
  model: string;
}

export interface ModelCallInput {
  /** Host-resolved credentials; which key is required follows from the provider. */
  credentials: ResearchCredentials;
  system: string;
  user: string;
  model: ModelCallTarget;
  maxTokens: number;
  /** Sent to google and openrouter only. See the Anthropic-wire note in callModel. */
  temperature?: number;
  /** Ask google for `application/json`. Other wires rely on the prompt. */
  jsonResponse?: boolean;
  /** Defaults to SYNTHESIS_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Phase 1 Experiment 3 — when set, Gemini calls log cache-hit measurements. */
  telemetry?: { functionName: string; organizationId?: string; promptRunId?: string };
}

export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
  const { credentials, system, user, maxTokens, telemetry } = input;
  const route = routeFor(input.model);
  const model = route.apiModelId;
  const timeoutMs = input.timeoutMs === undefined ? SYNTHESIS_REQUEST_TIMEOUT_MS : input.timeoutMs;

  if (route.provider === 'google') {
    const apiKey = requireGeminiApiKey(credentials);
    const { GoogleGenAI, ThinkingLevel } = await loadGoogleGenAI();
    // Google's preferred wire in PROVIDER_WIRES is generateContent, which is
    // the reasoningParams default, so an effort maps through `generationConfig`
    // — but the SDK's own `ThinkingConfig` type does not accept the fleet's
    // lowercase `ReasoningEffort` strings, so `geminiThinkingConfig` converts
    // (see its docstring) rather than forwarding `reasoningParams()`'s fragment
    // verbatim.
    const resolvedEffort = route.resolution === null ? null : route.resolution.effort;
    const thinkingConfig = resolvedEffort === null || resolvedEffort === undefined
      ? {}
      : { thinkingConfig: geminiThinkingConfig(resolvedEffort, ThinkingLevel) };
    const ai = new GoogleGenAI({ apiKey });
    const response = await withTimeout(
      ai.models.generateContent({
        model,
        contents: user,
        config: {
          systemInstruction: system,
          maxOutputTokens: maxTokens,
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
          ...(input.jsonResponse === true ? { responseMimeType: 'application/json' } : {}),
          ...thinkingConfig,
        },
      }),
      timeoutMs,
      model,
    );
    const text = response.text;
    const usage = response.usageMetadata;
    // Gemini reports `cachedContentTokenCount` as a SLICE of `promptTokenCount`,
    // so the uncached portion is the difference (not the total). Mirror this
    // in the result so cost calc treats input + cached as orthogonal.
    const totalPromptTokens = usage?.promptTokenCount !== undefined ? usage.promptTokenCount : 0;
    const cachedTokens = usage?.cachedContentTokenCount !== undefined ? usage.cachedContentTokenCount : 0;
    const uncachedInputTokens = Math.max(0, totalPromptTokens - cachedTokens);
    // Thinking tokens are DISJOINT from candidates and Google bills them as
    // output, so billable output is candidates + thoughts. Counting candidates
    // alone under-books every thinking-enabled call. Same semantics as
    // `@braintied/cost` extractGeminiUsage.
    const candidateTokens = usage?.candidatesTokenCount !== undefined ? usage.candidatesTokenCount : 0;
    const thoughtsTokens = usage?.thoughtsTokenCount !== undefined ? usage.thoughtsTokenCount : 0;
    const outputTokens = candidateTokens + thoughtsTokens;

    if (telemetry !== undefined) {
      await recordGeminiUsage({
        model,
        functionName: telemetry.functionName,
        inputTokens: totalPromptTokens,
        cachedTokens,
        outputTokens,
        organizationId: telemetry.organizationId,
        promptRunId: telemetry.promptRunId,
      });
    }

    return {
      text: text !== undefined ? text : '',
      inputTokens: uncachedInputTokens,
      cachedReadTokens: cachedTokens,
      outputTokens,
      provider: route.provider,
      model,
    };
  }

  if (route.provider === 'openrouter') {
    if (credentials.openrouterApiKey === undefined) {
      throw new MissingCredentialError('openrouterApiKey', 'required for qwen-* synthesis models');
    }
    const apiKey = credentials.openrouterApiKey;
    const openai = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL, timeout: timeoutMs });
    const response = await withTimeout(
      openai.chat.completions.create({
        model,
        max_tokens: maxTokens,
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      timeoutMs,
      model,
    );
    const content = response.choices[0]?.message.content;
    return {
      text: typeof content === 'string' ? content : '',
      inputTokens: response.usage?.prompt_tokens !== undefined ? response.usage.prompt_tokens : 0,
      cachedReadTokens: 0, // OpenRouter does not surface a cache-hit field
      outputTokens: response.usage?.completion_tokens !== undefined ? response.usage.completion_tokens : 0,
      provider: route.provider,
      model,
    };
  }

  // Anthropic Messages wire: Anthropic itself, and every provider the models
  // package lists with an `anthropic-messages` endpoint (DeepSeek, Fireworks,
  // Z.ai). A provider without one throws WireFormatUnsupportedError rather
  // than having its id sent to the wrong vendor.
  //
  // Temperature is not sent on this wire: Anthropic rejects it alongside
  // extended thinking and DeepSeek ignores it in thinking mode, which is the
  // default for every stage that does not set an effort.
  const apiKey = messagesApiKey(credentials, route.provider);
  const baseURL = messagesBaseUrl(route.provider);
  const reasoning = route.resolution === null
    ? {}
    : reasoningParams(route.resolution, undefined, 'anthropic-messages');
  const client = new Anthropic({ apiKey, baseURL, timeout: timeoutMs });
  const response = await withTimeout(
    client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      ...('thinking' in reasoning ? { thinking: anthropicThinkingDisabled(reasoning.thinking) } : {}),
      ...('output_config' in reasoning
        ? { output_config: { effort: anthropicEffort(reasoning.output_config.effort) } }
        : {}),
    }),
    timeoutMs,
    model,
  );
  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
    }
  }
  // `input_tokens` already excludes both cache slices on this wire; mirror
  // that so cost calc treats them as orthogonal.
  const cacheRead = response.usage.cache_read_input_tokens;
  return {
    text,
    inputTokens: response.usage.input_tokens,
    cachedReadTokens: typeof cacheRead === 'number' ? cacheRead : 0,
    outputTokens: response.usage.output_tokens,
    provider: route.provider,
    model,
  };
}
