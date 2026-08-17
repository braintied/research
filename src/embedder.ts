/**
 * Deep-Research Embedder
 *
 * Voyage 4 Large (1024-dim) batch embedding.
 *
 * Decoupled from Cortex: the original `embedAndIndexChunks` wrote chunks to
 * `ora_core.research_report_chunks` via postgres.js. Indexing is now optional
 * and injected — `runDeepResearch({ indexSink })` receives the chunked report
 * and persists it however the consumer wants. Only the pure `embedTexts()`
 * Voyage call remains here.
 */

import { z } from 'zod';
import { logger } from './logger.js';
import { VOYAGE_MODEL, VOYAGE_API_URL } from './pipeline-core.js';
import { requireVoyageApiKey, type ResearchCredentials } from './credentials.js';

// =============================================================================
// Constants
// =============================================================================

const EMBED_BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// =============================================================================
// Zod schemas for Voyage API response
// =============================================================================

const VoyageResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
    }),
  ),
});

// =============================================================================
// Helpers
// =============================================================================

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// =============================================================================
// embedTexts
// =============================================================================

export async function embedTexts(
  credentials: ResearchCredentials,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const voyageKey = requireVoyageApiKey(credentials);
  const allEmbeddings: number[][] = [];

  for (let batchStart = 0; batchStart < texts.length; batchStart += EMBED_BATCH_SIZE) {
    const batch = texts.slice(batchStart, batchStart + EMBED_BATCH_SIZE);

    let lastError: unknown = null;
    let succeeded = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(VOYAGE_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${voyageKey}`,
          },
          body: JSON.stringify({
            model: VOYAGE_MODEL,
            input: batch,
            input_type: 'document',
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Voyage API error ${response.status}: ${errorText}`);
        }

        const raw: unknown = await response.json();
        const parsed = VoyageResponseSchema.parse(raw);

        if (parsed.data.length !== batch.length) {
          throw new Error(
            `Voyage returned ${parsed.data.length} embeddings for ${batch.length} inputs`,
          );
        }

        for (const item of parsed.data) {
          allEmbeddings.push(item.embedding);
        }

        succeeded = true;
        break;
      } catch (err: unknown) {
        lastError = err;
        logger.warn(
          { err: String(err), attempt, batchStart },
          '[embedder] Voyage API attempt failed',
        );
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }

    if (!succeeded) {
      throw new Error(
        `Voyage embedding failed after ${MAX_RETRIES} retries: ${String(lastError)}`,
      );
    }
  }

  return allEmbeddings;
}
