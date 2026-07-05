/**
 * embedItems — embed each ingested item via the package's Voyage embedder.
 *
 * Builds an embedding input from (title + excerpt + a head of content_md) so
 * retrieval matches on the most signal-dense text without paying to embed full
 * articles. Mutates + returns the same array. On failure, items keep
 * `embedding: null` (the store layer simply won't make them retrievable).
 */

import { embedTexts } from '../embedder.js';
import { logger } from '../logger.js';
import type { IngestedItem } from './types.js';

const MAX_CONTENT_HEAD_CHARS = 1500;

function buildEmbedInput(item: IngestedItem): string {
  const parts: string[] = [];
  if (item.title.trim().length > 0) parts.push(item.title.trim());
  if (item.excerpt.trim().length > 0) parts.push(item.excerpt.trim());
  const head = item.contentMd.trim().slice(0, MAX_CONTENT_HEAD_CHARS);
  if (head.length > 0) parts.push(head);
  const joined = parts.join('\n\n').trim();
  // Voyage rejects empty input — fall back to the URL so every item embeds.
  return joined.length > 0 ? joined : item.url;
}

export async function embedItems(items: IngestedItem[]): Promise<IngestedItem[]> {
  if (items.length === 0) return items;

  const inputs = items.map(buildEmbedInput);

  try {
    const embeddings = await embedTexts(inputs);
    if (embeddings.length !== items.length) {
      logger.warn(
        { expected: items.length, got: embeddings.length },
        '[embedItems] embedding count mismatch — leaving items unembedded',
      );
      return items;
    }
    for (let i = 0; i < items.length; i++) {
      const vec = embeddings[i];
      if (vec !== undefined) {
        items[i].embedding = vec;
      }
    }
    logger.info({ count: items.length }, '[embedItems] embedding complete');
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), count: items.length },
      '[embedItems] embedding failed — items keep embedding=null',
    );
  }

  return items;
}
