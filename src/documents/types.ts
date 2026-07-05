/**
 * Document layer — shared types.
 *
 * A DocTypeDefinition turns a research result into a typed, structured
 * document: each doc type declares its Zod output schema, a prompt builder,
 * and the research kind it defaults to when the caller hasn't already run
 * research.
 */

import type { z } from 'zod';
import type { ResearchKind } from '../kinds.js';

export const DOC_TYPES = [
  'prd',
  'market-report',
  'tech-spec',
  'client-brief',
  'content-brief',
  'estimate-research',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

export interface DocPromptInput {
  /** What the document is about — the original brief/topic. */
  brief: string;
  /** The research report markdown (evidence base). */
  researchMarkdown: string;
  /** Bibliography lines ("[^1] Title — url") for reference selection. */
  bibliography: string;
  /** Optional caller-supplied context (client name, codebase, constraints…). */
  context?: string;
}

export interface DocTypeDefinition<TSchema extends z.ZodType = z.ZodType> {
  docType: DocType;
  description: string;
  /** Research kind used when generateDocument has to run research itself. */
  researchKindDefault: ResearchKind;
  /** Zod schema the LLM output must validate against. */
  schema: TSchema;
  /** System prompt for the doc-synthesis call. */
  systemPrompt: string;
  /** Builds the user message from research evidence. */
  buildUserPrompt: (input: DocPromptInput) => string;
}

/** Shared instruction suffix for every doc type — JSON discipline. */
export const JSON_OUTPUT_INSTRUCTION =
  'Return ONLY a valid JSON object matching the requested shape. No markdown fences, no commentary before or after the JSON. Ground every claim in the research evidence; when citing a source, use its exact URL from the bibliography.';
