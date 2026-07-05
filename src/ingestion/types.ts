/**
 * Knowledge-Ingestion Core — Types & Schemas
 *
 * Reusable, storage-AGNOSTIC types for the continuous knowledge-ingestion
 * pipeline. The core (`ingestSource` → `categorizeItems` → `embedItems`)
 * produces plain data; the consuming app persists it however it wants.
 *
 * Every boundary (the DB row a consumer hands us, the LLM categorizer JSON)
 * is validated through Zod — no `as` casts.
 */

import { z } from 'zod';

// =============================================================================
// Source types — closed set, must match the knowledge_sources CHECK constraint
// =============================================================================

export const KNOWLEDGE_SOURCE_TYPES = [
  'blog',
  'rss',
  'reddit',
  'youtube',
  'podcast',
  'tiktok',
  'instagram',
  'x',
  'linkedin',
  'facebook',
  'web_search',
] as const;

export const KnowledgeSourceTypeSchema = z.enum(KNOWLEDGE_SOURCE_TYPES);
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceTypeSchema>;

// =============================================================================
// Categories — closed set, must match the knowledge_items.category CHECK
// =============================================================================

export const KNOWLEDGE_CATEGORIES = [
  'tip',
  'tool',
  'news',
  'win',
  'pain_point',
  'trend',
  'competitor',
  'other',
] as const;

export const KnowledgeCategorySchema = z.enum(KNOWLEDGE_CATEGORIES);
export type KnowledgeCategory = z.infer<typeof KnowledgeCategorySchema>;

// =============================================================================
// KnowledgeSource — a subscription row (as the consumer hands it to the core)
// =============================================================================

export const KnowledgeSourceSchema = z.object({
  id: z.string(),
  workspaceId: z.string().min(1),
  sourceType: KnowledgeSourceTypeSchema,
  identifier: z.string().min(1),
  label: z.string().nullable().default(null),
  topics: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  pollIntervalHours: z.number().int().positive().default(24),
  lastPolledAt: z.string().nullable().default(null),
  config: z.record(z.string(), z.unknown()).default({}),
});

export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

// =============================================================================
// IngestedItem — one normalized piece of content produced by the core
// =============================================================================

export interface IngestEngagement {
  upvotes?: number;
  views?: number;
  likes?: number;
  comments?: number;
  score?: number;
}

export interface IngestedItem {
  sourceId: string | null;
  sourceType: KnowledgeSourceType;
  url: string;
  urlHash: string;
  title: string;
  contentMd: string;
  excerpt: string;
  author: string | null;
  publishedAt: string | null; // ISO 8601 or null
  engagement: IngestEngagement;
  qualityScore: number | null;
  // Filled by categorizeItems():
  category: KnowledgeCategory;
  tags: string[];
  whyItMatters: string | null;
  // 0–2 VERBATIM quotable sentences copied from this item's source content
  // (real contractor voice; never invented). Empty when none worthwhile.
  quotes: string[];
  // Filled by embedItems():
  embedding: number[] | null;
}

// =============================================================================
// IngestResult — what a single-source ingest run returns to the consumer
// =============================================================================

export interface IngestResult {
  sourceId: string | null;
  sourceType: KnowledgeSourceType;
  items: IngestedItem[];
  costUsd: number;
  error: string | null;
}

// =============================================================================
// Ingest options
// =============================================================================

export interface IngestSourceOptions {
  /** Per-source item ceiling (default 15). */
  maxItems?: number;
  /** Restrict ingestion to content newer than N days (default 30). */
  recencyDays?: number;
  /** Abort signal forwarded to provider HTTP calls. */
  signal?: AbortSignal;
}
