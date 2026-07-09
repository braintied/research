/**
 * Research kinds — semantic presets over the deep-research engine.
 *
 * Callers say *what kind* of research they need instead of tuning depth
 * knobs, provider lists, and cost caps individually:
 *
 *   - 'quick'    — single-pass cheap research (~$0.05-0.50, no critique loop)
 *   - 'standard' — the default grounded pipeline
 *   - 'deep'     — wide mode: more subqueries, more critique passes, higher cap
 *   - 'managed'  — hosted end-to-end via Perplexity sonar-deep-research
 *   - 'social'   — community/audience-voice research (reddit, youtube, x, ...)
 *
 * Every kind returns the same `KindResearchResult` so downstream consumers
 * (document layer, index sinks) are engine-agnostic.
 */

import { runDeepResearch } from './index.js';
import type {
  RunDeepResearchInput,
  IndexSink,
  OnPipelineUsage,
  ResearchCacheAdapter,
} from './index.js';
import { runManagedResearch } from './managed-research.js';
import { runAnswer } from './answer.js';
import type { ResearchDepth } from './depth-config.js';
import type { Logger } from './logger.js';
import type { FinalReport, ProviderName, VerbatimQuote } from './types.js';
import type { GroundingResult } from './grounding.js';

// =============================================================================
// Kind definitions
// =============================================================================

export const RESEARCH_KINDS = ['answer', 'quick', 'standard', 'deep', 'managed', 'social'] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

export interface ResearchKindPreset {
  kind: ResearchKind;
  description: string;
  /** Engine: the agentic pipeline, hosted Perplexity, or the single-pass answer engine. */
  engine: 'pipeline' | 'perplexity' | 'answer';
  /** Depth mapping for pipeline runs. */
  depth?: ResearchDepth;
  /** Provider allowlist for pipeline runs (intersected with env-enabled). */
  providers?: ProviderName[];
  /** Preamble appended to the brief to steer the planner. */
  briefPreamble?: string;
  /**
   * Default synthesis model for this kind (callers can still override via
   * RunResearchInput.synthesisModelOverride). Unset -> claude-sonnet-4-6.
   */
  synthesisModelDefault?: string;
}

export const RESEARCH_KIND_PRESETS: Record<ResearchKind, ResearchKindPreset> = {
  answer: {
    kind: 'answer',
    description: 'Perplexity-style cited quick answer — one search, one cheap synthesis (~5-15s, ~$0.002-0.01)',
    engine: 'answer',
    synthesisModelDefault: 'gemini-3-flash-preview',
  },
  quick: {
    kind: 'quick',
    description: 'Single-pass cheap research for fast context (~30-90s, ~$0.02-0.10)',
    engine: 'pipeline',
    depth: 'quick',
    // ~90% of a quick-run's cost was hardcoded Sonnet synthesis (2026-07-09
    // cost audit) — quick now defaults to the MICRO-tier Gemini flash.
    synthesisModelDefault: 'gemini-3-flash-preview',
  },
  standard: {
    kind: 'standard',
    description: 'Grounded multi-provider research with critique loop (~2-5 min, ~$0.50-3)',
    engine: 'pipeline',
    depth: 'standard',
  },
  deep: {
    kind: 'deep',
    description: 'High-stakes wide research — more subqueries, more critique passes (~8-15 min, ~$3-7)',
    engine: 'pipeline',
    depth: 'wide',
  },
  managed: {
    kind: 'managed',
    description: 'Hosted end-to-end deep research via Perplexity sonar-deep-research (~$0.40-1.30/query)',
    engine: 'perplexity',
  },
  social: {
    kind: 'social',
    description: 'Community and audience-voice research across social platforms',
    engine: 'pipeline',
    depth: 'standard',
    providers: [
      'reddit',
      'youtube',
      'hn',
      'x',
      'tiktok',
      'instagram',
      'facebook_groups',
      'podcasts',
      'searxng',
    ],
    briefPreamble:
      'Prioritize community discussion, verbatim audience voice, and social sentiment over editorial/press coverage.',
  },
};

/** Narrow an arbitrary string to a valid ResearchKind. Falls back to 'standard'. */
export function coerceResearchKind(input: string | null | undefined): ResearchKind {
  for (const kind of RESEARCH_KINDS) {
    if (input === kind) return kind;
  }
  return 'standard';
}

// =============================================================================
// runResearch — kind-aware dispatcher
// =============================================================================

export interface RunResearchInput {
  /** The research brief / question. */
  brief: string;
  /** Research kind — defaults to 'standard'. */
  kind?: ResearchKind;
  /** Hard cost cap in USD (pipeline kinds only; overrides the depth default). */
  maxCostUsd?: number;
  /** Optional sink for report chunks (pipeline kinds only). */
  indexSink?: IndexSink;
  /** Per-stage usage events for attribution (pipeline kinds only). */
  onUsage?: OnPipelineUsage;
  /** Optional source cache (pipeline kinds only). */
  cache?: ResearchCacheAdapter;
  /** Free-first tier threshold override (pipeline kinds only). */
  minFreeResults?: number;
  /**
   * Synthesis/assembly model override — forwarded to the pipeline (and the
   * answer engine). Unset -> the kind's synthesisModelDefault, then Sonnet.
   */
  synthesisModelOverride?: string;
  /** Recency window in days (answer kind: mapped to SearXNG time_range). */
  recencyDays?: number;
  logger?: Logger;
}

export interface KindResearchResult {
  kind: ResearchKind;
  engine: 'pipeline' | 'perplexity' | 'answer';
  report: FinalReport;
  /** Verbatim evidence pool — empty for managed runs (no quote extraction). */
  quotes: VerbatimQuote[];
  costUsd: number;
  /**
   * Faithfulness verdict (audit F2) — null for managed runs, whose provider
   * does its own citation pipeline and exposes no quote-level evidence.
   */
  grounding: GroundingResult | null;
}

/**
 * Run research at a given kind. All kinds return the same result shape so
 * the document layer and consumers don't care which engine ran.
 */
export async function runResearch(input: RunResearchInput): Promise<KindResearchResult> {
  const kind: ResearchKind = input.kind !== undefined ? input.kind : 'standard';
  const preset = RESEARCH_KIND_PRESETS[kind];
  const synthesisModelOverride = input.synthesisModelOverride !== undefined
    ? input.synthesisModelOverride
    : preset.synthesisModelDefault;

  if (preset.engine === 'answer') {
    const answer = await runAnswer({
      query: input.brief,
      recencyDays: input.recencyDays,
      synthesisModelOverride,
      logger: input.logger,
    });
    return {
      kind,
      engine: 'answer',
      report: answer.report,
      quotes: [],
      costUsd: answer.costUsd,
      grounding: null,
    };
  }

  if (preset.engine === 'perplexity') {
    const managed = await runManagedResearch({
      brief: input.brief,
      logger: input.logger,
    });
    return {
      kind,
      engine: 'perplexity',
      report: managed.report,
      quotes: [],
      costUsd: managed.costUsd,
      grounding: null,
    };
  }

  const brief = preset.briefPreamble !== undefined
    ? `${input.brief}\n\n${preset.briefPreamble}`
    : input.brief;

  const pipelineInput: RunDeepResearchInput = {
    brief,
    depth: preset.depth,
    maxCostUsd: input.maxCostUsd,
    logger: input.logger,
    indexSink: input.indexSink,
    providers: preset.providers,
    onUsage: input.onUsage,
    cache: input.cache,
    minFreeResults: input.minFreeResults,
    synthesisModelOverride,
  };

  const result = await runDeepResearch(pipelineInput);
  return {
    kind,
    engine: 'pipeline',
    report: result.report,
    quotes: result.quotes,
    costUsd: result.costUsd,
    grounding: result.grounding,
  };
}
