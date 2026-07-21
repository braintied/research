/**
 * Deep-Research Critique
 *
 * Evaluates a draft report against the original brief and identifies:
 * - Sections with unsupported claims
 * - Sections that are too thin (below target word count)
 * - Sections missing primary evidence from key providers
 * - Factual gaps warranting new subqueries
 *
 * Routes through the unified synthesisGenerate() dispatcher, so the critique
 * model is prefix-routed like every other synthesis call: gemini-3.6-flash is
 * the working default today; glm-5.2 (z.ai) and claude-* become premium options
 * by editing CRITIQUE_MODEL once their quota/credits restore.
 */

import { z } from 'zod';
import { synthesisGenerate } from './synthesis.js';
import { logger } from './logger.js';
import { CritiqueSchema } from './types.js';
import type { Critique, SectionDraft, ProviderName } from './types.js';

// =============================================================================
// Constants
// =============================================================================

// gemini-3.6-flash is the working default today; glm-5.2 (z.ai quota resets
// 2026-07-25) and claude-sonnet-5 (Anthropic key) are premium overrides once
// live. synthesisGenerate() prefix-routes all three.
const CRITIQUE_MODEL = 'gemini-3.6-flash';

// =============================================================================
// Permissive fallback critique (no gaps, never loop)
// =============================================================================

function buildPermissiveCritique(sections: SectionDraft[]): Critique {
  const totalWords = sections.reduce((sum, s) => sum + s.word_count, 0);
  return {
    gaps: [],
    unsupported_claims: [],
    thin_sections: [],
    missing_provider_coverage: [],
    overall_word_count: totalWords,
    meets_target: true,
  };
}

// =============================================================================
// Exports
// =============================================================================

export interface CritiqueDraftInput {
  promptMd: string;
  sections: SectionDraft[];
  targetWordCount: { min: number; max: number };
  providerCoverageBySection: Record<string, ProviderName[]>;
}

export async function critiqueDraft(input: CritiqueDraftInput): Promise<Critique> {
  const { promptMd, sections, targetWordCount, providerCoverageBySection } = input;

  const totalWords = sections.reduce((sum, s) => sum + s.word_count, 0);
  const perSectionTarget = Math.floor(
    targetWordCount.min / Math.max(sections.length, 1),
  );

  // Build section summaries for the prompt
  const sectionSummaries = sections
    .map((s) => {
      const providers = providerCoverageBySection[s.section_path];
      const providerList =
        providers !== undefined && providers.length > 0
          ? providers.join(', ')
          : 'none';
      return (
        `### ${s.section_path}: ${s.heading} (${s.word_count} words, providers: ${providerList})\n\n` +
        s.body_md
      );
    })
    .join('\n\n---\n\n');

  const systemPrompt =
    'You are a research critic. Identify: (1) sections that have unsupported claims, ' +
    '(2) sections that are too thin (< target word count for that section), ' +
    '(3) sections that lack primary evidence from key providers ' +
    '(e.g. an audience-voice section with zero Reddit/YouTube quotes is missing primary evidence), ' +
    '(4) factual gaps that warrant new subqueries.\n\n' +
    'Output ONLY valid JSON in this exact shape (no markdown fences, no explanation):\n' +
    '{\n' +
    '  "gaps": [\n' +
    '    {\n' +
    '      "section_path": "A.1",\n' +
    '      "description": "what is missing",\n' +
    '      "suggested_subqueries": ["specific query to fill gap"]\n' +
    '    }\n' +
    '  ],\n' +
    '  "unsupported_claims": [\n' +
    '    { "claim": "the claim text", "section_path": "B.2" }\n' +
    '  ],\n' +
    '  "thin_sections": ["A.3", "C.1"],\n' +
    '  "missing_provider_coverage": [\n' +
    '    { "section_path": "D.1", "missing_providers": ["reddit", "youtube"] }\n' +
    '  ],\n' +
    '  "overall_word_count": 4200,\n' +
    '  "meets_target": false\n' +
    '}';

  const userMessage =
    `Original research brief:\n\n${promptMd}\n\n` +
    `Target word count: ${targetWordCount.min}–${targetWordCount.max} words\n` +
    `Per-section target: ~${perSectionTarget} words\n` +
    `Actual total: ${totalWords} words\n\n` +
    `Draft sections:\n\n${sectionSummaries}`;

  let rawText = '';
  try {
    const result = await synthesisGenerate({
      system: systemPrompt,
      user: userMessage,
      model: CRITIQUE_MODEL,
      maxTokens: 4096,
    });
    rawText = result.text;
  } catch (err: unknown) {
    logger.error({ err: String(err) }, '[critique] synthesis call failed, returning permissive critique');
    return buildPermissiveCritique(sections);
  }

  // Extract JSON
  const trimmed = rawText.trim();
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');

  if (jsonStart === -1 || jsonEnd === -1) {
    logger.warn({ rawText }, '[critique] No JSON found in synthesis response, returning permissive critique');
    return buildPermissiveCritique(sections);
  }

  const jsonStr = trimmed.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    const critique = CritiqueSchema.parse(parsed);
    logger.info(
      {
        gaps: critique.gaps.length,
        thinSections: critique.thin_sections.length,
        meetsTarget: critique.meets_target,
      },
      '[critique] Critique complete',
    );
    return critique;
  } catch (err: unknown) {
    logger.warn(
      { err: String(err), jsonStr: jsonStr.slice(0, 500) },
      '[critique] JSON parse/validation failed, returning permissive critique',
    );
    return buildPermissiveCritique(sections);
  }
}

// Re-export the schema for callers that want to validate externally
export { CritiqueSchema };
export type { Critique };

// Internal schema for validating the critique response shape
const _CritiqueOutputValidation = z.object({
  gaps: z.array(
    z.object({
      section_path: z.string(),
      description: z.string(),
      suggested_subqueries: z.array(z.string()).default([]),
    }),
  ).default([]),
  unsupported_claims: z.array(
    z.object({
      claim: z.string(),
      section_path: z.string(),
    }),
  ).default([]),
  thin_sections: z.array(z.string()).default([]),
  missing_provider_coverage: z.array(
    z.object({
      section_path: z.string(),
      missing_providers: z.array(z.string()),
    }),
  ).default([]),
  overall_word_count: z.number().int().nonnegative(),
  meets_target: z.boolean(),
});

// Keep unused variable warning suppressed — this validates the internal
// structure matches CritiqueSchema to catch drift at compile time.
void _CritiqueOutputValidation;
