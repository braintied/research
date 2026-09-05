/**
 * buildIngestedItem — the one constructor for IngestedItem, shared by the
 * sweep lanes (ingest-source.ts) and the catalog lanes (catalog.ts) so both
 * produce byte-identical shapes: canonical url, url_hash dedupe key, excerpt,
 * and the defaults categorize/embed fill in later.
 */

import { hashUrl, canonicalizeUrl } from '../types.js';
import type { IngestedItem, IngestEngagement, KnowledgeSourceType } from './types.js';

export interface BuildItemInput {
  sourceId: string | null;
  sourceType: KnowledgeSourceType;
  url: string;
  title: string;
  contentMd: string;
  author: string | null;
  publishedAt: string | null;
  engagement: IngestEngagement;
}

export function toExcerpt(content: string, snippet: string): string {
  const base = content.trim().length > 0 ? content.trim() : snippet.trim();
  if (base.length <= 320) return base;
  return `${base.slice(0, 320).trim()}…`;
}

export function buildIngestedItem(input: BuildItemInput): IngestedItem {
  const canonical = canonicalizeUrl(input.url);
  return {
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    url: canonical,
    urlHash: hashUrl(canonical),
    title: input.title,
    contentMd: input.contentMd,
    excerpt: toExcerpt(input.contentMd, input.title),
    author: input.author,
    publishedAt: input.publishedAt,
    engagement: input.engagement,
    qualityScore: null,
    // categorize/embed fill these in later; defaults keep the type total.
    category: 'other',
    tags: [],
    whyItMatters: null,
    quotes: [],
    embedding: null,
  };
}
