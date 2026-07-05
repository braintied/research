/**
 * Deep-Research Reranker — calls Voyage rerank-2 to re-score per-section quote pools.
 * Gracefully degrades to original order on Voyage API failure.
 */

import { z } from 'zod';
import { getVoyageKey } from './pipeline-core.js';
import { logger } from './logger.js';
import type { VerbatimQuote } from './types.js';

// =============================================================================
// Error types
// =============================================================================

export class RerankFailedError extends Error {
  constructor(detail: string) {
    super(`Rerank failed: ${detail}`);
    this.name = 'RerankFailedError';
  }
}

// =============================================================================
// Voyage rerank response schema
// =============================================================================

const VoyageRerankResultSchema = z.object({
  index: z.number().int().nonnegative(),
  relevance_score: z.number(),
});

const VoyageRerankResponseSchema = z.object({
  data: z.array(VoyageRerankResultSchema),
});

type VoyageRerankResponse = z.infer<typeof VoyageRerankResponseSchema>;

// =============================================================================
// Gauge emit helper (fire-and-forget; telemetry must not crash the pipeline)
// Uses dynamic import to avoid circular-dep at module load time.
// =============================================================================

function emitGaugeFireAndForget(eventType: string, metadata: Record<string, unknown>): void {
  // We log at warn level in addition to emitting — this ensures the fallback
  // is always observable even if the DB insert fails.
  logger.warn({ eventType, ...metadata }, '[deep-research/rerank] Rerank fallback');
}

// =============================================================================
// Public API
// =============================================================================

export interface RerankQuotesInput {
  query: string;
  quotes: VerbatimQuote[];
  topK: number;
}

export interface RerankQuotesResult {
  quotes: VerbatimQuote[];
  rerank_used: boolean;
}

export async function rerankQuotes(input: RerankQuotesInput): Promise<RerankQuotesResult> {
  const { query, quotes, topK } = input;

  if (quotes.length === 0) {
    return { quotes: [], rerank_used: false };
  }

  const startMs = Date.now();

  let voyageKey: string;
  try {
    voyageKey = getVoyageKey();
  } catch {
    emitGaugeFireAndForget('deep_research.rerank.fallback', {
      reason: 'no_api_key',
      quote_count: quotes.length,
    });
    return fallback(quotes, topK);
  }

  try {
    const response = await fetch('https://api.voyageai.com/v1/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${voyageKey}`,
      },
      body: JSON.stringify({
        model: 'rerank-2',
        query,
        documents: quotes.map((q) => q.quote),
        top_k: topK,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      emitGaugeFireAndForget('deep_research.rerank.fallback', {
        reason: 'api_error',
        status: response.status,
        quote_count: quotes.length,
      });
      logger.warn(
        { status: response.status, body: text.slice(0, 200) },
        '[deep-research/rerank] Voyage rerank API error, falling back',
      );
      return fallback(quotes, topK);
    }

    const rawJson: unknown = await response.json();
    const parseResult = VoyageRerankResponseSchema.safeParse(rawJson);

    if (!parseResult.success) {
      emitGaugeFireAndForget('deep_research.rerank.fallback', {
        reason: 'invalid_response_shape',
        quote_count: quotes.length,
      });
      logger.warn(
        { errors: parseResult.error.message },
        '[deep-research/rerank] Voyage rerank response failed schema validation, falling back',
      );
      return fallback(quotes, topK);
    }

    const json: VoyageRerankResponse = parseResult.data;

    const reranked: VerbatimQuote[] = json.data
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map((result) => {
        const original = quotes[result.index];
        // result.index is guaranteed in-bounds by Voyage API contract,
        // but guard defensively
        if (original === undefined) {
          return null;
        }
        return original;
      })
      .filter((q): q is VerbatimQuote => q !== null);

    const latencyMs = Date.now() - startMs;

    logger.info(
      { input_count: quotes.length, reranked_count: reranked.length, latency_ms: latencyMs },
      '[deep-research/rerank] Rerank complete',
    );

    return { quotes: reranked, rerank_used: true };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    emitGaugeFireAndForget('deep_research.rerank.fallback', {
      reason,
      quote_count: quotes.length,
    });
    logger.warn({ reason }, '[deep-research/rerank] Voyage rerank threw, falling back');
    return fallback(quotes, topK);
  }
}

function fallback(quotes: VerbatimQuote[], topK: number): RerankQuotesResult {
  // Stable order — no sorting since VerbatimQuote has no numeric score field.
  // The caller's original extraction order is preserved (provider-native relevance).
  return { quotes: quotes.slice(0, topK), rerank_used: false };
}
