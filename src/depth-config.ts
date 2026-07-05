/**
 * Depth-mode tunables for the deep-research pipeline.
 *
 * The pipeline supports four modes:
 *
 *   - 'quick'    — single-pass cheap mode. ~30-90s per run, ~$0.05-0.50 cost.
 *                  No critique loop. Fast context grabs and pre-research.
 *   - 'blog'     — lightweight single-article mode. ~1-3 min per run, ~$0.5-2 cost.
 *                  Tuned for a single premium blog post: a handful of subqueries,
 *                  shallow per-subquery fetch, and a single critique pass. Keeps
 *                  the grounded/critique-refined quality of the heavier modes while
 *                  fitting inside a per-post budget (~$1.50).
 *   - 'standard' — legacy default. ~2-5 min per run, ~$0.50-3 cost.
 *                  Use for general research, brain enrichment, vibe-card backing.
 *   - 'wide'     — high-stakes mode. ~8-15 min per run, ~$3-7 cost.
 *                  Use for M&A due diligence, market sizing, deep dives where
 *                  Claude.ai's hosted deep-research is the comparison point.
 *
 * Wide mode does NOT change the pipeline shape — it raises the budget knobs:
 * more subqueries up front, more URLs fetched per subquery, more critique
 * passes (the existing critique loop already does gap-driven retries — wide
 * mode just buys it more turns), and a higher cost cap so the extra work
 * isn't truncated mid-flight.
 */

export type ResearchDepth = 'quick' | 'blog' | 'standard' | 'wide';

export interface DepthTunables {
  /** Target subquery range — passed to the planner as instructions. */
  subqueriesMin: number;
  subqueriesMax: number;
  /** Max URLs fetched per subquery during step 6 (fetch-content). */
  urlsPerSubquery: number;
  /**
   * Max passes through the critique-and-refine loop (step 9). The loop
   * already does gap-driven retries: it analyzes the draft, identifies
   * missing sections / thin sections / providers that should have been
   * called, generates 10-15 new subqueries via `planSubqueries(refinementHint)`,
   * and re-runs search → fetch → extract → synthesize for those gaps.
   * Wide mode just gives the loop more turns before final assembly.
   */
  critiqueMaxPasses: number;
  /** Hard cost cap for the entire prompt run. */
  hardCapUsd: number;
  /**
   * Word-count band for the planner prompt + final synthesis target.
   * The corpus row is also widened by the RPC at dispatch time, but the
   * planner needs a matching number to issue subqueries that produce
   * enough material.
   */
  targetWordCountMin: number;
  targetWordCountMax: number;
}

export const DEPTH_CONFIG: Record<ResearchDepth, DepthTunables> = {
  quick: {
    // Single-pass cheap research (~30-90s, ~$0.05-0.50). No critique loop —
    // mirrors Sentigen's composite Tavily→Crawl4AI→NANO pattern. For fast
    // context grabs, card backing, and pre-research before a deeper run.
    subqueriesMin: 3,
    subqueriesMax: 8,
    urlsPerSubquery: 3,
    critiqueMaxPasses: 0,
    hardCapUsd: 0.75,
    targetWordCountMin: 400,
    targetWordCountMax: 1500,
  },
  blog: {
    subqueriesMin: 6,
    subqueriesMax: 10,
    urlsPerSubquery: 4,
    critiqueMaxPasses: 1,
    hardCapUsd: 2.0,
    targetWordCountMin: 1200,
    targetWordCountMax: 2500,
  },
  standard: {
    subqueriesMin: 15,
    subqueriesMax: 35,
    urlsPerSubquery: 7,
    critiqueMaxPasses: 3,
    hardCapUsd: 10,
    targetWordCountMin: 800,
    targetWordCountMax: 8000,
  },
  wide: {
    subqueriesMin: 50,
    subqueriesMax: 80,
    urlsPerSubquery: 12,
    critiqueMaxPasses: 8,
    hardCapUsd: 15,
    targetWordCountMin: 5000,
    targetWordCountMax: 12000,
  },
};

/** Narrow an arbitrary string to a valid ResearchDepth. Falls back to 'standard'. */
export function coerceDepth(input: string | null | undefined): ResearchDepth {
  if (input === 'quick') return 'quick';
  if (input === 'blog') return 'blog';
  if (input === 'wide') return 'wide';
  return 'standard';
}

/** Look up tunables for a depth mode. Always returns a valid config. */
export function getDepthConfig(depth: ResearchDepth): DepthTunables {
  return DEPTH_CONFIG[depth];
}

// =============================================================================
// Phase 1.d — per-model pricing for the synthesis bake-off
// =============================================================================
//
// Without per-model pricing, costTracker.record() defaults to Sonnet rates and
// the bake-off can't compare cost across candidates — the whole point of the
// experiment. These rates feed deepResearchSynthesisCostUsd() which is called
// after every synthesizeAllSections + assembleFinalReport with real token
// counts from synthesisGenerate().

export interface ModelPricing {
  /** USD per 1,000,000 input tokens (uncached). */
  inputUsdPerM: number;
  /** USD per 1,000,000 output tokens. */
  outputUsdPerM: number;
  /** Optional: USD per 1,000,000 input tokens on a cache hit. */
  cacheHitInputUsdPerM?: number;
  /** Provider tag — used as `CostEntry.provider`. */
  provider: 'anthropic' | 'google' | 'deepseek' | 'openrouter';
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-sonnet-4-6':                    { inputUsdPerM: 3,    outputUsdPerM: 15,   provider: 'anthropic' },
  'claude-haiku-4-5':                     { inputUsdPerM: 1,    outputUsdPerM: 5,    provider: 'anthropic' },
  // DeepSeek (direct API, China-hosted). V3.2 dropped from bake-off — the
  // Anthropic-compat endpoint only accepts v4-flash / v4-pro; V3.2 needs the
  // OpenAI-compat endpoint which is a separate provider integration.
  'deepseek-v4-flash':                    { inputUsdPerM: 0.14, outputUsdPerM: 0.28, cacheHitInputUsdPerM: 0.0028,  provider: 'deepseek' },
  // V4-Pro promo runs through 2026-05-31 15:59 UTC. Promo price below.
  // Post-cutoff pricing is held in DEEPSEEK_V4_PRO_FULL_PRICING and applied by
  // getModelPricing() at lookup time so cost projections after the cutoff
  // don't silently keep using the promo rate.
  'deepseek-v4-pro':                      { inputUsdPerM: 0.435, outputUsdPerM: 0.87, cacheHitInputUsdPerM: 0.003625, provider: 'deepseek' },
  // Google Gemini
  'gemini-2.5-flash':                     { inputUsdPerM: 0.30, outputUsdPerM: 2.50, provider: 'google' },
  // OpenRouter (US-resold open weights)
  'qwen/qwen3-235b-a22b-instruct-2507':   { inputUsdPerM: 0.071, outputUsdPerM: 0.10, provider: 'openrouter' },
};

/**
 * DeepSeek V4-Pro promo expiry (75% off through 2026-05-31 15:59 UTC).
 * After this instant, getModelPricing('deepseek-v4-pro') returns the
 * full-price rates below instead of the promo rates above. Exported so
 * `deepseek-v4-pro-promo-expiry-cron` can warn ops 7 days before.
 */
export const DEEPSEEK_V4_PRO_PROMO_EXPIRY_AT = new Date('2026-05-31T15:59:00Z');

const DEEPSEEK_V4_PRO_FULL_PRICING: ModelPricing = {
  inputUsdPerM: 1.74,
  outputUsdPerM: 3.48,
  cacheHitInputUsdPerM: 0.0145,
  provider: 'deepseek',
};

/** Look up pricing for a synthesis model. Falls back to Sonnet rates for unknown models. */
export function getModelPricing(model: string, asOf?: Date): ModelPricing {
  if (model === 'deepseek-v4-pro') {
    const now = asOf !== undefined ? asOf : new Date();
    if (now.getTime() >= DEEPSEEK_V4_PRO_PROMO_EXPIRY_AT.getTime()) {
      return DEEPSEEK_V4_PRO_FULL_PRICING;
    }
  }
  const found = MODEL_PRICING[model];
  if (found !== undefined) return found;
  // Conservative fallback — preserves prior behavior so unknown models don't underbill.
  return { inputUsdPerM: 3, outputUsdPerM: 15, provider: 'anthropic' };
}

/**
 * Compute the USD cost of a synthesis call given model + token counts.
 * `inputTokens` should be UNCACHED input only — `cachedReadTokens` are
 * billed separately at `cacheHitInputUsdPerM` when the model defines one,
 * otherwise at the full input rate.
 */
export function deepResearchSynthesisCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedReadTokens: number = 0,
): number {
  const pricing = getModelPricing(model);
  const cachedRate = pricing.cacheHitInputUsdPerM !== undefined
    ? pricing.cacheHitInputUsdPerM
    : pricing.inputUsdPerM;
  return (inputTokens / 1_000_000) * pricing.inputUsdPerM
    + (cachedReadTokens / 1_000_000) * cachedRate
    + (outputTokens / 1_000_000) * pricing.outputUsdPerM;
}
