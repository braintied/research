/**
 * Deep-Research Synthesis
 *
 * Three-stage synthesis pipeline:
 *   1. synthesizeSection  — per-section Claude Sonnet call with quotes + claims
 *   2. synthesizeAllSections — parallel runner (chunked by 5)
 *   3. assembleFinalReport — exec summary + bibliography + full markdown
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { z } from 'zod';
import { logger } from './logger.js';
import { recordGeminiUsage } from './cache-hit-measurement.js';
import {
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

const SYNTH_MODEL_DEFAULT = 'claude-sonnet-4-6';
const ASSEMBLY_MODEL_DEFAULT = 'claude-sonnet-4-6';

// =============================================================================
// Multi-provider synthesis dispatcher
// =============================================================================

const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Phase 1.b — unified synthesis call that dispatches to the right provider
 * SDK based on model prefix and returns just the assembled text.
 *
 *   claude-*   → Anthropic SDK (ANTHROPIC_API_KEY)
 *   deepseek-* → Anthropic SDK with baseURL override (DEEPSEEK_API_KEY) —
 *                DeepSeek's Anthropic-compatible endpoint
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
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'GEMINI_API_KEY environment variable is not configured — required for gemini-* models. '
          + 'Set it on the cortex-worker Fly.io app.',
      );
    }
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: user,
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
      },
    });
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
    const openai = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
    const response = await openai.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
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
  } else {
    apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey === '') {
      throw new Error('ANTHROPIC_API_KEY environment variable is not configured');
    }
  }
  const client = baseURL !== undefined ? new Anthropic({ apiKey, baseURL }) : new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
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
  if (override.startsWith('gemini-')) return override;
  if (override.startsWith('qwen')) return override;
  throw new Error(
    `synthesis_model_override='${override}' not recognized. Supported prefixes: `
      + `claude-*, deepseek-*, gemini-*, qwen* (or qwen/<openrouter-id>).`,
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
  /** Phase 1 Experiment 1 — see resolveSynthesisModel(). undefined → claude-sonnet-4-6. */
  synthesisModelOverride?: string;
  /** Phase 1 Experiment 3 — Gemini cache-hit measurement attribution. */
  telemetry?: { organizationId?: string; promptRunId?: string };
}

export interface SynthesizeSectionResult {
  draft: SectionDraft;
  inputTokens: number;
  cachedReadTokens: number;
  outputTokens: number;
}

export async function synthesizeSection(
  input: SynthesizeSectionInput,
): Promise<SynthesizeSectionResult> {
  const { sectionPath, sectionGoal, quotes, keyClaims, targetWords, synthesisModelOverride, telemetry } = input;
  const synthModel = resolveSynthesisModel(synthesisModelOverride, SYNTH_MODEL_DEFAULT);

  const citationMap = buildCitationMap(quotes, keyClaims);

  // Build quote block
  const quotesBlock =
    quotes.length > 0
      ? quotes
          .map((q) => {
            const num = citationMap.get(q.source_url);
            const anchor = num !== undefined ? `[^${num}]` : '';
            const authorLine =
              q.author !== undefined && q.author !== '' ? ` — ${q.author}` : '';
            const pubLine =
              q.published_at !== undefined && q.published_at !== ''
                ? ` (${q.published_at.slice(0, 10)})`
                : '';
            return `> "${q.quote}"${authorLine}${pubLine} ${anchor}\n> Source: ${q.source_url}`;
          })
          .join('\n\n')
      : '(no direct quotes available)';

  // Build claims block
  const claimsBlock =
    keyClaims.length > 0
      ? keyClaims
          .map((c) => {
            const num = citationMap.get(c.source_url);
            const anchor = num !== undefined ? `[^${num}]` : '';
            return `- ${c.claim} ${anchor} [via ${c.provider}]`;
          })
          .join('\n')
      : '(no key claims available)';

  // Build footnote reference list for the model
  const footnotes = Array.from(citationMap.entries())
    .map(([url, num]) => `[^${num}]: ${url}`)
    .join('\n');

  const systemPrompt =
    'You are a research writer. Write a well-structured markdown section using the provided quotes and claims as primary evidence. ' +
    'Embed inline citations using [^N] notation exactly where the evidence appears in the text. ' +
    'Do not invent citations or facts not present in the evidence below. ' +
    'Write in flowing paragraphs with a clear section heading. ' +
    'Match the requested word count as closely as possible.';

  const userMessage =
    `Section: ${sectionPath}\n` +
    `Goal: ${sectionGoal}\n` +
    `Target length: ~${targetWords} words\n\n` +
    `## Verbatim Quotes\n\n${quotesBlock}\n\n` +
    `## Key Claims\n\n${claimsBlock}\n\n` +
    `## Citation Map (use these [^N] references inline)\n\n${footnotes}\n\n` +
    `Write the section now. Start with a markdown heading (## or ###). Use [^N] inline citations.`;

  const callResult = await synthesisGenerate({
    system: systemPrompt,
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
  const bodyMd = callResult.text;

  // Extract heading from first line
  const lines = bodyMd.trim().split('\n');
  const headingLine = lines[0];
  let heading = sectionPath;
  let bodyContent = bodyMd;

  if (headingLine !== undefined && headingLine.startsWith('#')) {
    heading = headingLine.replace(/^#+\s*/, '').trim();
    bodyContent = lines.slice(1).join('\n').trim();
  }

  // Determine heading level from markdown
  let level = 2;
  if (headingLine !== undefined) {
    const match = headingLine.match(/^(#+)/);
    if (match !== null) {
      level = Math.min(match[1].length, 6);
    }
  }

  // Build inline_citations from citation map
  const inlineCitations = Array.from(citationMap.entries()).map(([url, num]) => {
    const quote = quotes.find((q) => q.source_url === url);
    return {
      anchor: `[^${num}]`,
      source_url: url,
      quote_excerpt:
        quote !== undefined ? quote.quote.slice(0, 120) : '',
    };
  });

  // Collect source URLs
  const sourceUrls = Array.from(citationMap.keys());

  const draft = SectionDraftSchema.parse({
    section_path: sectionPath,
    heading,
    level,
    body_md: bodyContent,
    source_urls: sourceUrls,
    inline_citations: inlineCitations,
    word_count: countWords(bodyMd),
  });

  logger.info(
    { sectionPath, words: draft.word_count, citations: inlineCitations.length },
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

export interface SynthesizeAllInput {
  sectionsToWrite: SectionSpec[];
  quotesByPath: Record<string, VerbatimQuote[]>;
  claimsByPath: Record<string, { claim: string; source_url: string; provider: ProviderName }[]>;
  /** Phase 1 Experiment 1 — see resolveSynthesisModel(). */
  synthesisModelOverride?: string;
  /** Phase 1 Experiment 3 — Gemini cache-hit measurement attribution. */
  telemetry?: { organizationId?: string; promptRunId?: string };
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
  const { sectionsToWrite, quotesByPath, claimsByPath, synthesisModelOverride, telemetry } = input;
  const synthModel = resolveSynthesisModel(synthesisModelOverride, SYNTH_MODEL_DEFAULT);

  const results: SectionDraft[] = [];
  let totalInputTokens = 0;
  let totalCachedReadTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < sectionsToWrite.length; i += PARALLEL_CHUNK_SIZE) {
    const chunk = sectionsToWrite.slice(i, i + PARALLEL_CHUNK_SIZE);

    const chunkResults = await Promise.all(
      chunk.map((spec) => {
        const quotes = quotesByPath[spec.section_path];
        const claims = claimsByPath[spec.section_path];

        return synthesizeSection({
          sectionPath: spec.section_path,
          sectionGoal: spec.goal,
          quotes: quotes !== undefined ? quotes : [],
          keyClaims: claims !== undefined ? claims : [],
          targetWords: spec.targetWords,
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

export async function assembleFinalReport(
  input: AssembleFinalReportInput,
): Promise<AssembleFinalReportResult> {
  const { promptMd, sections, gaps, synthesisModelOverride, telemetry, sourceMeta } = input;
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

  const renumberedSections: SectionDraft[] = citedSections.map((s) => {
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
    return { ...s, body_md: body, inline_citations: inlineCitations };
  });

  // Build full markdown from renumbered sections
  const sectionsMarkdown = renumberedSections
    .map((s) => {
      const prefix = '#'.repeat(s.level);
      return `${prefix} ${s.heading}\n\n${s.body_md}`;
    })
    .join('\n\n');

  // Bibliography in global numeric order — bibliography[N-1] ⇔ [^N].
  // Provenance (audit m3): fill provider/title/author from the search phase's
  // sourceMeta instead of hardcoding placeholders. Unknown providers fall back
  // to 'crawl4ai' (the fetch backbone) so the ProviderName enum still holds.
  const bibliography = Array.from(urlToGlobal.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([sourceUrl, num]) => {
      const meta = sourceMeta !== undefined ? sourceMeta[sourceUrl] : undefined;
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

  // Generate title + executive summary via Claude
  const totalWords = sections.reduce((sum, s) => sum + s.word_count, 0);

  const summarySystemPrompt =
    'You are an executive editor. Given a multi-section research report, write: ' +
    '(1) a concise, informative title (max 12 words), and ' +
    '(2) an executive summary of 200–400 words that distills the most important findings across all sections. ' +
    'Output ONLY valid JSON (no markdown fences): {"title": "...", "executive_summary": "..."}';

  const summaryUserMessage =
    `Original research brief:\n\n${promptMd}\n\n` +
    `Report sections (${totalWords} total words):\n\n${sectionsMarkdown.slice(0, 20000)}`;

  const summaryCallResult = await synthesisGenerate({
    system: summarySystemPrompt,
    user: summaryUserMessage,
    model: assemblyModel,
    maxTokens: 2048,
    telemetry: telemetry !== undefined
      ? {
          functionName: 'assembleFinalReport',
          organizationId: telemetry.organizationId,
          promptRunId: telemetry.promptRunId,
        }
      : undefined,
  });
  const summaryRaw = summaryCallResult.text;

  // Parse title + exec summary
  const SummarySchema = z.object({
    title: z.string().min(1),
    executive_summary: z.string().min(1),
  });

  let title = 'Deep Research Report';
  let executiveSummary = '';

  const jsonStart = summaryRaw.indexOf('{');
  const jsonEnd = summaryRaw.lastIndexOf('}');

  if (jsonStart !== -1 && jsonEnd !== -1) {
    try {
      const parsed: unknown = JSON.parse(summaryRaw.slice(jsonStart, jsonEnd + 1));
      const validated = SummarySchema.parse(parsed);
      title = validated.title;
      executiveSummary = validated.executive_summary;
    } catch {
      logger.warn('[synthesis] Failed to parse title/summary JSON, using fallback');
      executiveSummary = summaryRaw.slice(0, 1000);
    }
  } else {
    executiveSummary = summaryRaw.slice(0, 1000);
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
    gaps,
    word_count: countWords(fullMarkdown),
  });

  logger.info(
    { title, sections: sections.length, words: report.word_count, citations: bibliography.length },
    '[synthesis] Final report assembled',
  );

  return {
    report,
    inputTokens: summaryCallResult.inputTokens,
    cachedReadTokens: summaryCallResult.cachedReadTokens,
    outputTokens: summaryCallResult.outputTokens,
    model: assemblyModel,
  };
}
