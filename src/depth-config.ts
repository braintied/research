/**
 * Depth-mode tunables for the deep-research pipeline.
 *
 * The pipeline supports four modes:
 *
 *   - 'quick'    — single-pass cheap mode. ~30-90s per run, ~$0.02-0.15 cost.
 *                  No critique loop. Default product path after 2026-08 cost cut.
 *   - 'blog'     — lightweight single-article mode. ~1-3 min per run, ~$0.3-1.25.
 *                  Tuned for a single premium blog post: a handful of subqueries,
 *                  shallow per-subquery fetch, and a single critique pass.
 *   - 'standard' — grounded default when quality > speed. ~2-5 min, ~$0.50-2.
 *                  Use for general research, brain enrichment, vibe-card backing.
 *   - 'wide'     — high-stakes opt-in. ~5-12 min per run, ~$2-6 cost.
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
  /**
   * Hard cap on Gemini extract calls for the ENTIRE run (main pass + every
   * critique pass combined). One page = one generateContent. Without this,
   * a standard/wide run × critique loop could mint hundreds of extract calls
   * (Aug 2026: a single brief produced ~7k extract ledger rows in a day).
   */
  maxExtractPages: number;
  /** Max concurrent Gemini extract calls inside one extractQuotes wave. */
  extractConcurrency: number;
}

export const DEPTH_CONFIG: Record<ResearchDepth, DepthTunables> = {
  quick: {
    // Single-pass cheap research (~30-90s, ~$0.02-0.15). No critique loop —
    // mirrors Sentigen's composite Tavily→Crawl4AI→NANO pattern. For fast
    // context grabs, card backing, and pre-research before a deeper run.
    // 2026-08-01 cost program: default product path after research project
    // billed ~$393/30d (mostly per-page extract on gemini-3.1-flash-lite).
    subqueriesMin: 3,
    subqueriesMax: 6,
    urlsPerSubquery: 3,
    critiqueMaxPasses: 0,
    hardCapUsd: 0.50,
    targetWordCountMin: 400,
    targetWordCountMax: 1200,
    maxExtractPages: 10,
    extractConcurrency: 3,
  },
  blog: {
    subqueriesMin: 5,
    subqueriesMax: 8,
    urlsPerSubquery: 3,
    critiqueMaxPasses: 1,
    hardCapUsd: 1.25,
    targetWordCountMin: 1000,
    targetWordCountMax: 2200,
    maxExtractPages: 16,
    extractConcurrency: 3,
  },
  // Standard is no longer "spend freely." 2026-08 GCP: research-agents
  // project ~$200/7d; extract volume dominated the bill. Caps cut theoretical
  // fan-out (subqueriesMax × urlsPerSubquery) and hard extract pages ~2×
  // without removing the critique loop.
  standard: {
    subqueriesMin: 8,
    subqueriesMax: 16,
    urlsPerSubquery: 4,
    critiqueMaxPasses: 1,
    hardCapUsd: 3.0,
    targetWordCountMin: 800,
    targetWordCountMax: 5000,
    maxExtractPages: 20,
    extractConcurrency: 3,
  },
  // Wide remains high-stakes but not "80 pages × 8 critique passes".
  // Explicit opt-in only — never the tool default.
  //
  // 2026-08-02: maxExtractPages was 36 after the cost program. That is below
  // the sum of web-design-intelligence@2 coverage floors (~41 minimum evidence
  // items across public packs). Profile canaries then failed deterministically
  // with profile_coverage_incomplete on award / implementation / guidance /
  // practitioner packs while trusted cortex+telegram priors still passed.
  // 64 keeps the cut vs the pre-program 80, and is enough for the release
  // profile under maxCostUsd=$5.
  wide: {
    subqueriesMin: 16,
    subqueriesMax: 32,
    urlsPerSubquery: 6,
    critiqueMaxPasses: 3,
    hardCapUsd: 8.0,
    targetWordCountMin: 3000,
    targetWordCountMax: 10000,
    maxExtractPages: 64,
    extractConcurrency: 3,
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
  // Google Gemini — Cortex ora_models.model_catalog (verified 2026-07-29/30).
  // Never invent rates: an unknown model must not ship as vendor_reported.
  'gemini-2.5-flash-lite':                { inputUsdPerM: 0.10, outputUsdPerM: 0.40, cacheHitInputUsdPerM: 0.01, provider: 'google' },
  'gemini-2.5-flash':                     { inputUsdPerM: 0.30, outputUsdPerM: 2.50, cacheHitInputUsdPerM: 0.03, provider: 'google' },
  'gemini-3.1-flash-lite':                { inputUsdPerM: 0.25, outputUsdPerM: 1.50, cacheHitInputUsdPerM: 0.025, provider: 'google' },
  'gemini-3.5-flash-lite':                { inputUsdPerM: 0.25, outputUsdPerM: 1.50, cacheHitInputUsdPerM: 0.025, provider: 'google' },
  // Retired preview id (still appears in residual traffic / BQ SKUs).
  'gemini-3.1-flash-lite-preview':        { inputUsdPerM: 0.25, outputUsdPerM: 1.50, cacheHitInputUsdPerM: 0.025, provider: 'google' },
  'gemini-3.5-flash':                     { inputUsdPerM: 1.50, outputUsdPerM: 9.00, cacheHitInputUsdPerM: 0.15, provider: 'google' },
  'gemini-3.6-flash':                     { inputUsdPerM: 1.50, outputUsdPerM: 7.50, cacheHitInputUsdPerM: 0.15, provider: 'google' },
  'gemini-3-flash-preview':               { inputUsdPerM: 0.50, outputUsdPerM: 3.00, provider: 'google' },
  'claude-sonnet-5':                      { inputUsdPerM: 2,    outputUsdPerM: 10,   provider: 'anthropic' },
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

/**
 * Look up a model's REAL published rates. Returns null when the model is not
 * in the table — no guessing, no substitute rate.
 *
 * Use this wherever the resulting number leaves this package as a factual
 * claim about spend: a ledger row, an invoice reconciliation, an alert. A
 * guessed rate that escapes into a system of record is worse than no number,
 * because downstream it is indistinguishable from a measured one.
 *
 * For local budget enforcement use `getModelPricing()`, which never returns
 * null because a spend cap must still bound an unrecognized model.
 */
const MODEL_ID_ALIASES: Readonly<Record<string, string>> = {
  'gemini-3.1-flash-lite-preview': 'gemini-3.5-flash-lite',
  'gemini-3-flash-preview': 'gemini-3.6-flash',
  'gemini-3-flash': 'gemini-3.6-flash',
};

export function tryGetModelPricing(model: string, asOf?: Date): ModelPricing | null {
  if (model === 'deepseek-v4-pro') {
    const now = asOf !== undefined ? asOf : new Date();
    if (now.getTime() >= DEEPSEEK_V4_PRO_PROMO_EXPIRY_AT.getTime()) {
      return DEEPSEEK_V4_PRO_FULL_PRICING;
    }
  }
  const aliased = MODEL_ID_ALIASES[model];
  const ids = aliased !== undefined ? [model, aliased] : [model];
  for (const id of ids) {
    const found = MODEL_PRICING[id];
    if (found !== undefined) return found;

    // Dated model IDs ('claude-haiku-4-5-20251001') match their undated alias.
    const undated = id.replace(/-\d{8}$/, '');
    if (undated !== id) {
      const datedMatch = MODEL_PRICING[undated];
      if (datedMatch !== undefined) return datedMatch;
    }
  }

  return null;
}

/**
 * Pricing for local budget enforcement. Unknown models get deliberately
 * conservative rates so `CostTracker`'s hard cap still bounds them rather
 * than letting an unrecognized model spend without limit.
 *
 * The returned rates for an unknown model are an UPPER BOUND, not a
 * measurement — never forward them anywhere they would be read as actual
 * spend. Use `tryGetModelPricing()` for that and handle the null.
 */
export function getModelPricing(model: string, asOf?: Date): ModelPricing {
  const known = tryGetModelPricing(model, asOf);
  if (known !== null) return known;
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
