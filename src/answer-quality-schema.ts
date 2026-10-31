/**
 * Answer-quality schemas, kept free of runtime imports beyond zod so
 * `types.ts` (FinalReport) can carry the verdict without importing the
 * model-calling half in `answer-quality.ts`.
 */

import { z } from 'zod';

export const FACET_KINDS = [
  'version', 'date', 'price', 'number', 'person', 'organization', 'name', 'command', 'list', 'text',
] as const;

export const AnswerFacetSchema = z.object({
  /** Stable id inside its question, e.g. "version". */
  key: z.string().min(1).max(40),
  /** Reader-facing label, e.g. "Release date". */
  label: z.string().min(1).max(80),
  kind: z.enum(FACET_KINDS),
});
export type AnswerFacet = z.infer<typeof AnswerFacetSchema>;

export const BriefQuestionSchema = z.object({
  question: z.string().min(3).max(600),
  facets: z.array(AnswerFacetSchema).min(1).max(8),
});
export type BriefQuestion = z.infer<typeof BriefQuestionSchema>;

export const PrimarySourceSchema = z.object({
  name: z.string().min(1).max(160),
  /** Registrable host without scheme, e.g. "core.telegram.org". */
  domain: z.string().min(3).max(253),
  /** Canonical https URLs on `domain` only; anything else is discarded. */
  urls: z.array(z.string()).max(4).default([]),
});
export type PrimarySource = z.infer<typeof PrimarySourceSchema>;

export const BriefRequirementsSchema = z.object({
  questions: z.array(BriefQuestionSchema).max(12),
  primary_sources: z.array(PrimarySourceSchema).max(4).default([]),
});
export type BriefRequirements = z.infer<typeof BriefRequirementsSchema>;

export const AnswerQualitySchema = z.object({
  /**
   * answered — every asked fact has evidence; partial — at least half;
   * unanswered — fewer; not_assessed — the brief could not be analyzed.
   */
  status: z.enum(['answered', 'partial', 'unanswered', 'not_assessed']),
  /** Answered facets / asked facets (0 when not assessed). */
  answered_ratio: z.number().min(0).max(1),
  facets_total: z.number().int().nonnegative(),
  facets_answered: z.number().int().nonnegative(),
  questions: z.array(z.object({
    question: z.string(),
    facets: z.array(z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(FACET_KINDS),
      answered: z.boolean(),
      /** Bibliography anchors of the evidence that answers it. */
      citation_anchors: z.array(z.string()),
      evidence: z.array(z.string()),
    })),
  })),
  /** Official sources the brief named or implied. */
  primary_sources: z.array(z.object({
    name: z.string(),
    domain: z.string(),
    cited: z.boolean(),
  })),
  /** null when the brief named or implied no primary source. */
  primary_source_cited: z.boolean().nullable(),
  relevance_gate: z.object({
    status: z.enum(['applied', 'unavailable', 'not_run']),
    units_judged: z.number().int().nonnegative(),
    units_kept: z.number().int().nonnegative(),
    units_dropped: z.number().int().nonnegative(),
    units_unjudged: z.number().int().nonnegative(),
  }),
  fetch_quality: z.object({
    pages_rejected: z.number().int().nonnegative(),
    evidence_rejected: z.number().int().nonnegative(),
  }),
  /** One line a reader or log can scan: "answered: version ✓, date ✗". */
  summary_line: z.string(),
  /**
   * True when every asked fact is answered and, when a primary source was
   * named or implied, it is cited. A canary can gate on this.
   */
  passed: z.boolean(),
  /** Why the brief could not be assessed, when status is not_assessed. */
  error: z.string().optional(),
});
export type AnswerQuality = z.infer<typeof AnswerQualitySchema>;

