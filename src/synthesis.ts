/**
 * Deep-Research Synthesis
 *
 * Three-stage synthesis pipeline:
 *   1. synthesizeSection  — per-section Claude Sonnet call with quotes + claims
 *   2. synthesizeAllSections — parallel runner (chunked by 2)
 *   3. assembleFinalReport — exec summary + bibliography + full markdown
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { logger } from './logger.js';
import { getGeminiKey } from './pipeline-core.js';
import { recordGeminiUsage } from './cache-hit-measurement.js';
import {
  canonicalizeUrl,
  SectionDraftSchema,
  FinalReportSchema,
  ProviderNameSchema,
} from './types.js';
import type {
  SectionDraft,
  FinalReport,
  VerbatimQuote,
  ProviderName,
} from './types.js';

// =============================================================================
// Constants
// =============================================================================

// gemini-3.6-flash is the working default today; glm-5.2 (z.ai quota resets
// 2026-07-25) and claude-sonnet-5 (Anthropic key) are premium overrides once
// live, selected via synthesis_model_override.
const SYNTH_MODEL_DEFAULT = 'gemini-3.6-flash';
const ASSEMBLY_MODEL_DEFAULT = 'gemini-3.6-flash';

/**
 * Keep synthesized claims mechanically auditable against their evidence.
 * The validator is intentionally lexical and exact about numbers; fluent but
 * lossy rewrites (for example, replacing an HTTP status code with a generic
 * success description) turn supported claims into unverifiable ones.
 */
export const SECTION_SYNTHESIS_SYSTEM_PROMPT =
  'You are a research editor. Write a well-structured markdown section using only the supplied evidence units for factual claims. ' +
  'Insert an evidence unit with its exact token, such as {{EVIDENCE:E1}}. The renderer replaces that token with the exact source sentence and its citation; never copy, paraphrase, combine, or add [^N] citation syntax yourself. ' +
  'Put each evidence token on its own line between paragraphs. Use each token at most once and never invent an evidence ID. ' +
  'You may add concise connective analysis, but it must not introduce new names, numbers, dates, product capabilities, prices, legal terms, benchmarks, or other externally verifiable facts. The renderer visibly labels every word of that connective prose as editorial inference rather than source-validated evidence. ' +
  'This evidence-token contract makes every cited sentence source-near and mechanically traceable while preserving every number, percentage, date, named entity, standard identifier, protocol or status code, and technical term exactly as stated. ' +
  'Write in concise, non-repetitive paragraphs. Do not output a heading; the renderer assigns the section heading deterministically. ' +
  'Match the requested word count as closely as possible.';

const EVIDENCE_TOKEN_PATTERN = /\{\{EVIDENCE:([A-Z][A-Z0-9_-]{0,31})\}\}/gu;
const MODEL_CITATION_PATTERN = /\[\^\d+\]/gu;

export interface SynthesisEvidenceUnit {
  id: string;
  text: string;
  sourceUrl: string;
  citationAnchor: string;
}

export class SynthesisEvidenceBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynthesisEvidenceBindingError';
  }
}

function normalizeEvidenceText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Build stable, source-bound evidence handles for one section. The model sees
 * handles, but only this renderer is allowed to emit a citation marker.
 */
export function buildSynthesisEvidenceUnits(
  quotes: VerbatimQuote[],
  claims: { claim: string; source_url: string; provider: ProviderName }[],
  citationMap: Map<string, number>,
): SynthesisEvidenceUnit[] {
  const units: SynthesisEvidenceUnit[] = [];
  const seen = new Set<string>();
  const add = (text: string, sourceUrl: string): void => {
    const normalizedText = normalizeEvidenceText(text);
    const citationNumber = citationMap.get(sourceUrl);
    if (normalizedText.length === 0 || citationNumber === undefined) return;
    const identity = `${sourceUrl}\u0000${normalizedText}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    units.push({
      id: `E${units.length + 1}`,
      text: normalizedText,
      sourceUrl,
      citationAnchor: `[^${citationNumber}]`,
    });
  };

  for (const quote of quotes) add(quote.quote, quote.source_url);
  for (const claim of claims) add(claim.claim, claim.source_url);
  return units;
}

function citeExactEvidence(text: string, anchor: string): string {
  const terminal = /([.!?]+)(["')\]]*)$/u.exec(text);
  if (terminal === null || terminal.index === undefined) {
    return `${text} ${anchor}.`;
  }
  const prefix = text.slice(0, terminal.index).trimEnd();
  return `${prefix} ${anchor}${terminal[1]}${terminal[2]}`;
}

function codeOwnedSectionHeading(sectionOrdinal: number): string {
  const ordinal = Number.isSafeInteger(sectionOrdinal) && sectionOrdinal > 0
    ? sectionOrdinal
    : 1;
  return `Research Findings ${ordinal}`;
}

export interface RenderEvidenceBoundMarkdownResult {
  bodyMd: string;
  usedUnits: SynthesisEvidenceUnit[];
}

const EDITORIAL_SYNTHESIS_LABEL =
  '**Editorial synthesis — inference, not source-validated:**';

/**
 * Model-authored connective prose is useful for orientation, but it is not
 * evidence. Render it inside an unmistakable blockquote so no consumer can
 * confuse fluent model prose with the exact, mechanically validated source
 * sentences emitted beside it.
 */
function renderEditorialSynthesis(markdown: string): string {
  const normalized = markdown
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (normalized.length === 0) return '';

  const quoted = normalized
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
  return `> ${EDITORIAL_SYNTHESIS_LABEL}\n>\n${quoted}`;
}

/**
 * Replace model-selected evidence handles with exact evidence sentences.
 * Direct model-authored citations are removed, repeated handles are emitted
 * once, and an unknown/missing handle fails closed. Blank paragraphs isolate
 * each cited sentence so sentence-level grounding cannot accidentally absorb
 * adjacent editorial prose.
 */
export function renderEvidenceBoundMarkdown(
  modelMarkdown: string,
  units: SynthesisEvidenceUnit[],
): RenderEvidenceBoundMarkdownResult {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const usedIds = new Set<string>();
  const unknownIds = new Set<string>();
  const usedUnits: SynthesisEvidenceUnit[] = [];

  const withoutModelCitations = modelMarkdown.replace(MODEL_CITATION_PATTERN, '');
  const renderedParts: string[] = [];
  let cursor = 0;
  EVIDENCE_TOKEN_PATTERN.lastIndex = 0;
  let tokenMatch: RegExpExecArray | null;

  while ((tokenMatch = EVIDENCE_TOKEN_PATTERN.exec(withoutModelCitations)) !== null) {
    const editorial = renderEditorialSynthesis(
      withoutModelCitations.slice(cursor, tokenMatch.index),
    );
    if (editorial.length > 0) renderedParts.push(editorial);

    const rawId = tokenMatch[1];
    const unit = rawId !== undefined ? byId.get(rawId) : undefined;
    if (unit === undefined) {
      if (rawId !== undefined) unknownIds.add(rawId);
    } else if (!usedIds.has(rawId)) {
      usedIds.add(rawId);
      usedUnits.push(unit);
      renderedParts.push(citeExactEvidence(unit.text, unit.citationAnchor));
    }

    cursor = tokenMatch.index + tokenMatch[0].length;
  }

  const trailingEditorial = renderEditorialSynthesis(
    withoutModelCitations.slice(cursor),
  );
  if (trailingEditorial.length > 0) renderedParts.push(trailingEditorial);

  if (unknownIds.size > 0) {
    throw new SynthesisEvidenceBindingError(
      `Synthesis referenced unknown evidence IDs: ${Array.from(unknownIds).sort().join(', ')}`,
    );
  }
  if (units.length > 0 && usedUnits.length === 0) {
    throw new SynthesisEvidenceBindingError(
      'Synthesis returned no valid evidence tokens for an evidence-backed section.',
    );
  }

  return {
    bodyMd: renderedParts.join('\n\n').trim(),
    usedUnits,
  };
}

// =============================================================================
// Multi-provider synthesis dispatcher
// =============================================================================

const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
const GLM_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
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

/** Thrown when a provider synthesis call exceeds SYNTHESIS_REQUEST_TIMEOUT_MS. */
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
 * Phase 1.b — unified synthesis call that dispatches to the right provider
 * SDK based on model prefix and returns just the assembled text.
 *
 *   claude-*   → Anthropic SDK (ANTHROPIC_API_KEY)
 *   deepseek-* → Anthropic SDK with baseURL override (DEEPSEEK_API_KEY) —
 *                DeepSeek's Anthropic-compatible endpoint
 *   glm-*      → Anthropic SDK with baseURL override (ZAI_API_KEY) —
 *                z.ai's Anthropic-compatible endpoint
 *   gemini-*   → @google/genai SDK (GEMINI_API_KEY)
 *   qwen*      → OpenAI SDK with OpenRouter baseURL (OPENROUTER_API_KEY) —
 *                supports both `qwen-` short names and `qwen/qwen3-...`
 *                full OpenRouter model IDs
 */
export interface SynthesisCallResult {
  text: string;
  /** Uncached input tokens — billed at the full input rate. */
  inputTokens: number;
  /**
   * Cache-read input tokens — billed at the model's `cacheHitInputUsdPerM`
   * if defined, otherwise the full input rate. Anthropic + DeepSeek-via-
   * Anthropic-compat populate `usage.cache_read_input_tokens`. Gemini
   * populates `usageMetadata.cachedContentTokenCount` (which represents the
   * cached SLICE of `promptTokenCount`, not in addition to it).
   */
  cachedReadTokens: number;
  outputTokens: number;
}

export async function synthesisGenerate(args: {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
  /** Phase 1 Experiment 3 — when set, Gemini calls log cache-hit measurements. */
  telemetry?: { functionName: string; organizationId?: string; promptRunId?: string };
}): Promise<SynthesisCallResult> {
  const { system, user, model, maxTokens, telemetry } = args;

  if (model.startsWith('gemini-')) {
    const apiKey = getGeminiKey();
    const ai = new GoogleGenAI({ apiKey });
    const response = await withTimeout(
      ai.models.generateContent({
        model,
        contents: user,
        config: {
          systemInstruction: system,
          maxOutputTokens: maxTokens,
        },
      }),
      SYNTHESIS_REQUEST_TIMEOUT_MS,
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
    const outputTokens = usage?.candidatesTokenCount !== undefined ? usage.candidatesTokenCount : 0;

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
    };
  }

  if (model.startsWith('qwen')) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'OPENROUTER_API_KEY environment variable is not configured — required for qwen-* models. '
          + 'Set it on the cortex-worker Fly.io app.',
      );
    }
    const openai = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL, timeout: SYNTHESIS_REQUEST_TIMEOUT_MS });
    const response = await withTimeout(
      openai.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      SYNTHESIS_REQUEST_TIMEOUT_MS,
      model,
    );
    const content = response.choices[0]?.message.content;
    return {
      text: typeof content === 'string' ? content : '',
      inputTokens: response.usage?.prompt_tokens !== undefined ? response.usage.prompt_tokens : 0,
      cachedReadTokens: 0, // OpenRouter does not surface a cache-hit field
      outputTokens: response.usage?.completion_tokens !== undefined ? response.usage.completion_tokens : 0,
    };
  }

  // Anthropic OR DeepSeek-via-Anthropic (compatible endpoint)
  let apiKey: string | undefined;
  let baseURL: string | undefined;
  if (model.startsWith('deepseek-')) {
    apiKey = process.env.DEEPSEEK_API_KEY;
    baseURL = DEEPSEEK_ANTHROPIC_BASE_URL;
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'DEEPSEEK_API_KEY environment variable is not configured — required for deepseek-* models. '
          + 'Set it on the cortex-worker Fly.io app (compliance: direct API is China-hosted; '
          + 'use only for synthetic eval / non-customer-tagged data).',
      );
    }
  } else if (model.startsWith('glm-')) {
    apiKey = process.env.ZAI_API_KEY;
    baseURL = GLM_ANTHROPIC_BASE_URL;
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'ZAI_API_KEY environment variable is not configured — required for glm-* models. '
          + 'Set it on the cortex-worker Fly.io app.',
      );
    }
  } else {
    apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey === '') {
      throw new Error('ANTHROPIC_API_KEY environment variable is not configured');
    }
  }
  const client = baseURL !== undefined
    ? new Anthropic({ apiKey, baseURL, timeout: SYNTHESIS_REQUEST_TIMEOUT_MS })
    : new Anthropic({ apiKey, timeout: SYNTHESIS_REQUEST_TIMEOUT_MS });
  const response = await withTimeout(
    client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    SYNTHESIS_REQUEST_TIMEOUT_MS,
    model,
  );
  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
    }
  }
  // Anthropic API and DeepSeek-via-Anthropic-compat both surface
  // `cache_read_input_tokens` (and `cache_creation_input_tokens`) on the
  // usage object. `input_tokens` already excludes both cache slices —
  // mirror that here so cost calc treats them as orthogonal.
  const usage = response.usage as unknown as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  const cachedReadTokens = typeof usage.cache_read_input_tokens === 'number'
    ? usage.cache_read_input_tokens
    : 0;
  return {
    text,
    inputTokens: usage.input_tokens,
    cachedReadTokens,
    outputTokens: usage.output_tokens,
  };
}

// =============================================================================
// Phase 1 Experiment 1 — synthesis-model bake-off resolution
// =============================================================================

/**
 * Resolve a per-run override to a concrete model identifier. Phase 1.c wires
 * all four providers needed by the 7-model bake-off:
 *   - Anthropic (claude-*)              via Anthropic SDK
 *   - DeepSeek (deepseek-*)             via Anthropic-compatible endpoint
 *   - GLM / z.ai (glm-*)                via Anthropic-compatible endpoint
 *   - Gemini (gemini-*)                 via @google/genai
 *   - Qwen3 + any OpenRouter model      via OpenAI SDK + OpenRouter baseURL
 *
 * The flag in admin.feature_flags['cortex_synthesis_model'] is intentionally
 * disabled by default so this codepath only fires by intentional bake-off
 * configuration.
 */
function resolveSynthesisModel(override: string | undefined, fallback: string): string {
  if (override === undefined || override.length === 0) return fallback;
  if (override.startsWith('claude-')) return override;
  if (override.startsWith('deepseek-')) return override;
  if (override.startsWith('glm-')) return override;
  if (override.startsWith('gemini-')) return override;
  if (override.startsWith('qwen')) return override;
  throw new Error(
    `synthesis_model_override='${override}' not recognized. Supported prefixes: `
      + `claude-*, deepseek-*, glm-*, gemini-*, qwen* (or qwen/<openrouter-id>).`,
  );
}

// =============================================================================
// Word count helper
// =============================================================================

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

// =============================================================================
// Citation anchor builder
// =============================================================================

function buildCitationMap(
  quotes: VerbatimQuote[],
  claims: { claim: string; source_url: string; provider: ProviderName }[],
): Map<string, number> {
  const map = new Map<string, number>();
  let counter = 1;

  for (const q of quotes) {
    if (!map.has(q.source_url)) {
      map.set(q.source_url, counter);
      counter++;
    }
  }
  for (const c of claims) {
    if (!map.has(c.source_url)) {
      map.set(c.source_url, counter);
      counter++;
    }
  }

  return map;
}

// =============================================================================
// synthesizeSection
// =============================================================================

export interface SynthesizeSectionInput {
  sectionPath: string;
  sectionGoal: string;
  quotes: VerbatimQuote[];
  keyClaims: { claim: string; source_url: string; provider: ProviderName }[];
  targetWords: number;
  /** Code-owned display order; never derived from planner/model prose. */
  sectionOrdinal?: number;
  /** Phase 1 Experiment 1 — see resolveSynthesisModel(). undefined → glm-5.2. */
  synthesisModelOverride?: string;
  /** Phase 1 Experiment 3 — Gemini cache-hit measurement attribution. */
  telemetry?: { organizationId?: string; promptRunId?: string };
  /** Deterministic test/consumer injection; production uses synthesisGenerate. */
  generate?: typeof synthesisGenerate;
}

export interface SynthesizeSectionResult {
  draft: SectionDraft;
  inputTokens: number;
  cachedReadTokens: number;
  outputTokens: number;
}

export const EVIDENCE_GAP_NOTICE =
  '> **Evidence gap:** No source-validated evidence sentence was available for this section, so no factual synthesis was produced.';

export async function synthesizeSection(
  input: SynthesizeSectionInput,
): Promise<SynthesizeSectionResult> {
  const {
    sectionPath,
    sectionGoal,
    quotes,
    keyClaims,
    targetWords,
    sectionOrdinal = 1,
    synthesisModelOverride,
    telemetry,
    generate = synthesisGenerate,
  } = input;
  const synthModel = resolveSynthesisModel(synthesisModelOverride, SYNTH_MODEL_DEFAULT);

  const citationMap = buildCitationMap(quotes, keyClaims);
  const evidenceUnits = buildSynthesisEvidenceUnits(quotes, keyClaims, citationMap);

  // An evidence-empty section is an explicit research gap, not an invitation
  // for a model to manufacture polished filler. The critique loop can search
  // again; if the final pass is still empty, assembly preserves this notice.
  if (evidenceUnits.length === 0) {
    const draft = SectionDraftSchema.parse({
      section_path: sectionPath,
      heading: codeOwnedSectionHeading(sectionOrdinal),
      level: 2,
      body_md: EVIDENCE_GAP_NOTICE,
      source_urls: [],
      inline_citations: [],
      word_count: countWords(EVIDENCE_GAP_NOTICE),
    });
    logger.warn({ sectionPath }, '[synthesis] Section has no validated evidence');
    return {
      draft,
      inputTokens: 0,
      cachedReadTokens: 0,
      outputTokens: 0,
    };
  }

  const evidenceBlock = evidenceUnits
    .map((unit) =>
      `### ${unit.id}\nSource: ${unit.sourceUrl}\nExact evidence: ${unit.text}`)
    .join('\n\n');

  const userMessage =
    `Section: ${sectionPath}\n` +
    `Goal: ${sectionGoal}\n` +
    `Target length: ~${targetWords} words\n\n` +
    `## Source-validated evidence units\n\n${evidenceBlock}\n\n` +
    'Write the section body now without a heading. ' +
    'Insert factual support only with exact {{EVIDENCE:EN}} tokens on their own lines. ' +
    'Do not output footnotes or [^N] markers.';

  const callResult = await generate({
    system: SECTION_SYNTHESIS_SYSTEM_PROMPT,
    user: userMessage,
    model: synthModel,
    maxTokens: Math.max(4096, targetWords * 2),
    telemetry: telemetry !== undefined
      ? {
          functionName: 'synthesizeSection',
          organizationId: telemetry.organizationId,
          promptRunId: telemetry.promptRunId,
        }
      : undefined,
  });
  const heading = codeOwnedSectionHeading(sectionOrdinal);
  const level = 2;
  let bodyContent = callResult.text;

  const rendered = renderEvidenceBoundMarkdown(bodyContent, evidenceUnits);
  bodyContent = rendered.bodyMd;

  // Only selected evidence becomes a section source/citation. This removes
  // phantom bibliography entries at the earliest possible boundary.
  const usedByUrl = new Map<string, SynthesisEvidenceUnit>();
  for (const unit of rendered.usedUnits) {
    if (!usedByUrl.has(unit.sourceUrl)) usedByUrl.set(unit.sourceUrl, unit);
  }
  const inlineCitations = Array.from(usedByUrl.values()).map((unit) => {
    return {
      anchor: unit.citationAnchor,
      source_url: unit.sourceUrl,
      // Preserve the complete evidence sentence. Assembly reuses this exact
      // text for its deterministic executive summary; truncation would turn a
      // valid source sentence into a fragment the grounding validator must
      // correctly reject.
      quote_excerpt: unit.text,
    };
  });

  const sourceUrls = Array.from(usedByUrl.keys());

  const draft = SectionDraftSchema.parse({
    section_path: sectionPath,
    heading,
    level,
    body_md: bodyContent,
    source_urls: sourceUrls,
    inline_citations: inlineCitations,
    word_count: countWords(`${heading}\n${bodyContent}`),
  });

  logger.info(
    {
      sectionPath,
      words: draft.word_count,
      citations: inlineCitations.length,
      evidenceUnits: rendered.usedUnits.length,
    },
    '[synthesis] Section synthesized',
  );

  return {
    draft,
    inputTokens: callResult.inputTokens,
    cachedReadTokens: callResult.cachedReadTokens,
    outputTokens: callResult.outputTokens,
  };
}

// =============================================================================
// synthesizeAllSections
// =============================================================================

export interface SectionSpec {
  section_path: string;
  goal: string;
  targetWords: number;
}

/** Progress signal emitted after each section finishes synthesizing. */
export interface SynthesisSectionProgress {
  sectionPath: string;
  sectionsCompleted: number;
  sectionsTotal: number;
}

export interface SynthesizeAllInput {
  sectionsToWrite: SectionSpec[];
  quotesByPath: Record<string, VerbatimQuote[]>;
  claimsByPath: Record<string, { claim: string; source_url: string; provider: ProviderName }[]>;
  /** Phase 1 Experiment 1 — see resolveSynthesisModel(). */
  synthesisModelOverride?: string;
  /** Phase 1 Experiment 3 — Gemini cache-hit measurement attribution. */
  telemetry?: { organizationId?: string; promptRunId?: string };
  /**
   * Optional per-section progress hook (2026-07-20 synthesis-hang fix).
   * Called synchronously after each section completes; the caller uses it
   * to write a liveness heartbeat (research_prompt_runs.updated_at) so the
   * stuck-run sweeper can distinguish "actively synthesizing" from "wedged".
   * Implementations MUST be non-blocking and swallow their own errors —
   * a heartbeat failure must never kill synthesis.
   */
  onSectionComplete?: (progress: SynthesisSectionProgress) => void;
}

const PARALLEL_CHUNK_SIZE = 2;

export interface SynthesizeAllSectionsResult {
  sections: SectionDraft[];
  inputTokens: number;
  cachedReadTokens: number;
  outputTokens: number;
  /** The model that was actually invoked — useful for cost tracking + telemetry. */
  model: string;
}

export async function synthesizeAllSections(
  input: SynthesizeAllInput,
): Promise<SynthesizeAllSectionsResult> {
  const { sectionsToWrite, quotesByPath, claimsByPath, synthesisModelOverride, telemetry, onSectionComplete } = input;
  const synthModel = resolveSynthesisModel(synthesisModelOverride, SYNTH_MODEL_DEFAULT);

  const results: SectionDraft[] = [];
  let totalInputTokens = 0;
  let totalCachedReadTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < sectionsToWrite.length; i += PARALLEL_CHUNK_SIZE) {
    const chunk = sectionsToWrite.slice(i, i + PARALLEL_CHUNK_SIZE);

    const chunkResults = await Promise.all(
      chunk.map((spec, chunkIndex) => {
        const quotes = quotesByPath[spec.section_path];
        const claims = claimsByPath[spec.section_path];

        return synthesizeSection({
          sectionPath: spec.section_path,
          sectionGoal: spec.goal,
          quotes: quotes !== undefined ? quotes : [],
          keyClaims: claims !== undefined ? claims : [],
          targetWords: spec.targetWords,
          sectionOrdinal: i + chunkIndex + 1,
          synthesisModelOverride,
          telemetry,
        });
      }),
    );

    for (const sectionResult of chunkResults) {
      results.push(sectionResult.draft);
      totalInputTokens += sectionResult.inputTokens;
      totalCachedReadTokens += sectionResult.cachedReadTokens;
      totalOutputTokens += sectionResult.outputTokens;

      if (onSectionComplete !== undefined) {
        onSectionComplete({
          sectionPath: sectionResult.draft.section_path,
          sectionsCompleted: results.length,
          sectionsTotal: sectionsToWrite.length,
        });
      }
    }

    logger.info(
      { processed: Math.min(i + PARALLEL_CHUNK_SIZE, sectionsToWrite.length), total: sectionsToWrite.length },
      '[synthesis] Section chunk complete',
    );
  }

  return {
    sections: results,
    inputTokens: totalInputTokens,
    cachedReadTokens: totalCachedReadTokens,
    outputTokens: totalOutputTokens,
    model: synthModel,
  };
}

// =============================================================================
// assembleFinalReport
// =============================================================================

export interface AssembleFinalReportInput {
  promptMd: string;
  sections: SectionDraft[];
  gaps: string[];
  /** Phase 1 Experiment 1 — see resolveSynthesisModel(). */
  synthesisModelOverride?: string;
  /** Phase 1 Experiment 3 — Gemini cache-hit measurement attribution. */
  telemetry?: { organizationId?: string; promptRunId?: string };
  /**
   * Real provenance per source URL (from the search phase) — used to fill
   * bibliography provider/title/author instead of hardcoded placeholders.
   */
  sourceMeta?: Record<string, {
    provider?: string;
    title?: string;
    author?: string;
    published_at?: string;
  }>;
}

export interface AssembleFinalReportResult {
  report: FinalReport;
  inputTokens: number;
  cachedReadTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Build an executive summary exclusively from evidence sentences that have
 * already survived section synthesis and global citation renumbering. This
 * deliberately favors exactness over abstractive fluency: the summary is the
 * most prominent surface in the report and therefore must obey the same
 * evidence contract as every section.
 */
export function buildEvidenceBoundExecutiveSummary(
  sections: SectionDraft[],
  targetMaxWords = 400,
): string {
  const intro =
    `This report contains source-validated findings across ${sections.length} ` +
    `${sections.length === 1 ? 'section' : 'sections'}. ` +
    'The statements below are reproduced from the accepted evidence set.';
  const findings: string[] = [];
  const seen = new Set<string>();
  let wordCount = countWords(intro);

  for (const section of sections) {
    for (const citation of section.inline_citations) {
      const evidenceText = normalizeEvidenceText(citation.quote_excerpt);
      if (evidenceText.length === 0) continue;
      const identity = `${citation.source_url}\u0000${evidenceText}`;
      if (seen.has(identity)) continue;

      const rendered = citeExactEvidence(evidenceText, citation.anchor);
      const renderedWords = countWords(rendered);
      if (findings.length > 0 && wordCount + renderedWords > targetMaxWords) {
        continue;
      }

      seen.add(identity);
      findings.push(rendered);
      wordCount += renderedWords;
    }
  }

  if (findings.length === 0) {
    return 'No source-validated findings were available for an evidence-bound executive summary.';
  }
  return `${intro}\n\n${findings.join('\n\n')}`;
}

export async function assembleFinalReport(
  input: AssembleFinalReportInput,
): Promise<AssembleFinalReportResult> {
  const {
    sections,
    gaps,
    synthesisModelOverride,
    sourceMeta,
  } = input;
  const assemblyModel = resolveSynthesisModel(synthesisModelOverride, ASSEMBLY_MODEL_DEFAULT);

  // ---------------------------------------------------------------------------
  // Citation pruning (audit m2): a section's inline_citations were built from
  // the full OFFERED citation map, not from what the model actually cited —
  // producing phantom bibliography entries. Keep only citations whose local
  // anchor actually appears in the section body.
  // ---------------------------------------------------------------------------
  const citedSections: SectionDraft[] = sections.map((s) => ({
    ...s,
    inline_citations: s.inline_citations.filter((ic) => s.body_md.includes(ic.anchor)),
  }));

  // ---------------------------------------------------------------------------
  // Global citation renumbering (audit fix, v0.2.1).
  //
  // Each section synthesizes with a LOCAL citation map starting at [^1], so
  // section A's [^1] and section B's [^1] are different URLs. The assembled
  // bibliography is indexed globally (validateGrounding does bibliography[N-1]),
  // which made grounding structurally always 0. Renumber every section's
  // anchors onto one global URL→number map before assembly.
  // ---------------------------------------------------------------------------
  const urlToGlobal = new Map<string, number>();
  let globalCounter = 1;
  for (const section of citedSections) {
    for (const ic of section.inline_citations) {
      if (!urlToGlobal.has(ic.source_url)) {
        urlToGlobal.set(ic.source_url, globalCounter);
        globalCounter++;
      }
    }
  }

  const renumberedSections: SectionDraft[] = citedSections.map((s, sectionIndex) => {
    // Two-pass placeholder replacement — a direct local→global rewrite can
    // collide when local [^2] maps to global [^5] while local [^5] exists.
    const replacements: Array<{ from: string; to: string }> = [];
    for (const ic of s.inline_citations) {
      const globalNum = urlToGlobal.get(ic.source_url);
      if (globalNum === undefined) continue;
      replacements.push({ from: ic.anchor, to: `[^${globalNum}]` });
    }
    let body = s.body_md;
    replacements.forEach((r, i) => {
      body = body.split(r.from).join(`\u{E000}CIT${i}\u{E000}`);
    });
    // Between the two passes every legitimate anchor is a placeholder, so any
    // [^N] still present is model-hallucinated (never in the offered map).
    // Strip them — left in place they'd collide with the new global numbering
    // and point at the wrong bibliography entry.
    body = body.replace(/\[\^\d+\]/g, '');
    replacements.forEach((r, i) => {
      body = body.split(`\u{E000}CIT${i}\u{E000}`).join(r.to);
    });
    const inlineCitations = s.inline_citations.map((ic) => {
      const globalNum = urlToGlobal.get(ic.source_url);
      return globalNum !== undefined ? { ...ic, anchor: `[^${globalNum}]` } : ic;
    });
    return {
      ...s,
      heading: codeOwnedSectionHeading(sectionIndex + 1),
      level: 2,
      body_md: body,
      inline_citations: inlineCitations,
    };
  });

  // Build full markdown from renumbered sections
  const sectionsMarkdown = renumberedSections
    .map((s) => {
      const prefix = '#'.repeat(s.level);
      return `${prefix} ${s.heading}\n\n${s.body_md}`;
    })
    .join('\n\n');

  // Validated comment/timestamp anchors intentionally differ from the fetched
  // parent URL only by a fragment (or stripped tracking parameters). Make the
  // parent search metadata available under that canonical identity so anchored
  // citations do not lose their real provider/title/author provenance.
  const sourceMetaByCanonical = new Map<string, NonNullable<typeof sourceMeta>[string]>();
  if (sourceMeta !== undefined) {
    for (const [sourceUrl, metadata] of Object.entries(sourceMeta)) {
      const canonical = canonicalizeUrl(sourceUrl);
      if (!sourceMetaByCanonical.has(canonical)) sourceMetaByCanonical.set(canonical, metadata);
    }
  }

  // Bibliography in global numeric order — bibliography[N-1] ⇔ [^N].
  // Provenance (audit m3): fill provider/title/author from the search phase's
  // sourceMeta instead of hardcoding placeholders. Unknown providers fall back
  // to 'crawl4ai' (the fetch backbone) so the ProviderName enum still holds.
  const bibliography = Array.from(urlToGlobal.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([sourceUrl, num]) => {
      const meta = sourceMeta !== undefined
        ? sourceMeta[sourceUrl] ?? sourceMetaByCanonical.get(canonicalizeUrl(sourceUrl))
        : undefined;
      const providerParse = ProviderNameSchema.safeParse(
        meta !== undefined && meta.provider !== undefined ? meta.provider : '',
      );
      return {
        citation_anchor: `[^${num}]`,
        source_url: sourceUrl,
        title: meta !== undefined && meta.title !== undefined ? meta.title : '',
        author: meta !== undefined && meta.author !== undefined ? meta.author : '',
        provider: providerParse.success ? providerParse.data : ('crawl4ai' as ProviderName),
        published_at: meta !== undefined ? meta.published_at : undefined,
      };
    });

  // Report-level labels are deterministic. Model-authored headings/titles sit
  // outside sentence grounding and therefore cannot safely become report
  // metadata, even when a prompt asks the model to avoid factual claims.
  const title = 'Evidence-Bound Research Report';
  const executiveSummary = buildEvidenceBoundExecutiveSummary(renumberedSections);

  const assemblyGaps = [...gaps];
  for (const section of renumberedSections) {
    if (section.source_urls.length > 0) continue;
    const gap = `${section.section_path}: no source-validated evidence was available after refinement.`;
    if (!assemblyGaps.includes(gap)) assemblyGaps.push(gap);
  }

  // Assemble full markdown
  const fullMarkdown =
    `# ${title}\n\n` +
    `## Executive Summary\n\n${executiveSummary}\n\n` +
    `---\n\n` +
    sectionsMarkdown +
    (bibliography.length > 0
      ? '\n\n## Bibliography\n\n' +
        bibliography
          .map((b) => `${b.citation_anchor}: ${b.source_url}`)
          .join('\n')
      : '');

  // Audit M4: return the RENUMBERED sections — returning the originals gave
  // indexSink/RAG consumers section-local [^1] anchors that collide across
  // sections and disagree with the global bibliography.
  const report = FinalReportSchema.parse({
    title,
    executive_summary: executiveSummary,
    full_markdown: fullMarkdown,
    sections: renumberedSections,
    bibliography,
    gaps: assemblyGaps,
    word_count: countWords(fullMarkdown),
  });

  logger.info(
    { title, sections: sections.length, words: report.word_count, citations: bibliography.length },
    '[synthesis] Final report assembled',
  );

  return {
    report,
    inputTokens: 0,
    cachedReadTokens: 0,
    outputTokens: 0,
    model: assemblyModel,
  };
}
