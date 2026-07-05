/**
 * Gemini cache-hit measurement — decoupled no-op shim.
 *
 * In cortex-worker this appended rows to `ora_core.gemini_cache_measurements`
 * via cortexInsert for a synthesis-cost experiment. @swishh/research is not
 * wired to Cortex Postgres, so `recordGeminiUsage` is a no-op here: synthesis
 * still passes telemetry, it simply isn't persisted. The call signature is
 * preserved so synthesis.ts needs no changes.
 */

export interface GeminiUsageRecord {
  model: string;
  functionName: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  organizationId?: string;
  promptRunId?: string;
}

export async function recordGeminiUsage(_record: GeminiUsageRecord): Promise<void> {
  // Intentionally a no-op — measurement sink lives in Cortex, not in this package.
  void _record;
}
