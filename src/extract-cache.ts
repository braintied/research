/**
 * Extract-result cache key helpers.
 *
 * Isolated from the main runner so hosts and tests can key a durable store
 * without importing the full pipeline graph.
 */

import { createHash } from 'node:crypto';

export const EXTRACT_CACHE_TTL_SECONDS = 14 * 86_400;
export const EXTRACT_CACHE_KEY_PREFIX = 'extract:v1';

/**
 * Stable extract cache key: model + URL + content fingerprint.
 * Content hash means an updated page re-extracts; identical re-reads are free.
 */
export function extractCacheKey(url: string, content: string, model: string): string {
  const urlPart = createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 24);
  const contentPart = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 24);
  const modelPart = model.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return `${EXTRACT_CACHE_KEY_PREFIX}:${modelPart}:${urlPart}:${contentPart}`;
}
