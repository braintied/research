/**
 * Deep-Research Engine — Core Types & Schemas
 *
 * Shared contract that every search provider, planner output, synthesis stage,
 * and Inngest event payload conforms to. All boundaries (LLM JSON, external
 * APIs, Inngest events) are validated through Zod — no `as` casts.
 *
 * Provider modules implement `SearchProvider`. The planner emits Subqueries.
 * The runner persists Discoveries. The synthesizer emits Sections + Reports.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';

// =============================================================================
// Provider names — closed set, must match DB CHECK constraints
// =============================================================================

export const PROVIDER_NAMES = [
  'tavily',
  'exa',
  'serpapi',
  'serper',
  'searxng',
  'perplexity',
  'reddit',
  'youtube',
  'hn',
  'rss',
  'crawl4ai',
  'facebook_groups',
  'tiktok',
  'instagram',
  'x',
  'podcasts',
] as const;

export const ProviderNameSchema = z.enum(PROVIDER_NAMES);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

// =============================================================================
// Source types — used by planner to route subqueries to providers
// =============================================================================

export const ExpectedSourceTypeSchema = z.enum([
  'forum',          // Reddit, HN, Discord, Facebook Groups
  'social',         // X, TikTok, Instagram, Reddit
  'video',          // YouTube reviews / tutorials
  'video_comments', // YouTube comment threads
  'social_video',   // TikTok, Instagram Reels (short-form video + comments)
  'longform',       // Blogs, essays
  'academic',       // Papers, arxiv
  'news',           // Press, recent reactions
  'serp',           // Google ranked results / ads / PAA
  'course_page',    // Competitor course landing pages
  'audience_voice', // Verbatim user pain
  'newsletter',     // Substack, RSS
  'documentation',  // Vendor docs, changelogs
  'podcast',        // Podcast episodes + transcripts (Listen Notes)
  'course_review',  // Course reviews across Reddit, YouTube, forums
]);

export type ExpectedSourceType = z.infer<typeof ExpectedSourceTypeSchema>;

// =============================================================================
// Subquery — emitted by planner, consumed by search-fanout
// =============================================================================

export const SubquerySchema = z.object({
  section_path: z.string().min(1),                 // e.g. "A.1", "B.intro"
  query: z.string().min(3),
  providers: z.array(ProviderNameSchema).min(1),
  expected_source_types: z.array(ExpectedSourceTypeSchema).default([]),
  rationale: z.string().default(''),
});

export type Subquery = z.infer<typeof SubquerySchema>;

// =============================================================================
// SearchResult — uniform shape returned by every provider's `search()`
// =============================================================================

export const SearchResultSchema = z.object({
  provider: ProviderNameSchema,
  url: z.string(),                                  // canonical URL or permalink
  canonical_id: z.string().optional(),              // Reddit post id, YT video id
  title: z.string().default(''),
  snippet: z.string().default(''),                  // search-provider summary
  author: z.string().optional(),                    // u/foo, channel, byline
  published_at: z.string().datetime({ offset: true }).optional(),
  engagement: z.object({
    upvotes: z.number().optional(),
    comment_count: z.number().optional(),
    view_count: z.number().optional(),
    like_count: z.number().optional(),
    score: z.number().optional(),                   // provider-native rank
  }).default({}),
  raw_metadata: z.record(z.string(), z.unknown()).default({}),  // provider-specific blob
});

export type SearchResult = z.infer<typeof SearchResultSchema>;

// =============================================================================
// FetchResult — returned by `fetch()` for providers that own fetch
// =============================================================================

export const FetchResultSchema = z.object({
  provider: ProviderNameSchema,
  url: z.string(),
  canonical_id: z.string().optional(),
  title: z.string().default(''),
  author: z.string().optional(),
  published_at: z.string().datetime({ offset: true }).optional(),
  raw_content: z.string().default(''),              // raw HTML / JSON / transcript
  markdown: z.string().default(''),                 // cleaned, ready for extraction
  engagement: z.record(z.string(), z.unknown()).default({}),
  fetch_status: z.enum(['ok', 'partial', 'failed']).default('ok'),
  fetch_error: z.string().optional(),
});

export type FetchResult = z.infer<typeof FetchResultSchema>;

// =============================================================================
// ExtractedQuotes — Gemini-extracted primary evidence per source
// =============================================================================

export const VerbatimQuoteSchema = z.object({
  quote: z.string().min(1),                         // exact wording, never paraphrased
  context: z.string().default(''),                  // 1-2 lines of surrounding context
  source_url: z.string(),                           // permalink or anchored URL
  author: z.string().optional(),                    // u/foo, channel name, byline
  published_at: z.string().datetime({ offset: true }).optional(),
  engagement: z.object({
    upvotes: z.number().optional(),
    likes: z.number().optional(),
    replies: z.number().optional(),
    views: z.number().optional(),
  }).default({}),
  sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']).optional(),
  category: z.string().optional(),                  // 'helpful' | 'critical' | 'scammy' | etc
});

export type VerbatimQuote = z.infer<typeof VerbatimQuoteSchema>;

export const ExtractedQuotesSchema = z.object({
  source_url: z.string(),
  source_provider: ProviderNameSchema,
  key_claims: z.array(z.string()).default([]),
  verbatim_quotes: z.array(VerbatimQuoteSchema).default([]),
  dates_mentioned: z.array(z.string()).default([]),
  entities_mentioned: z.array(z.string()).default([]),
  themes: z.array(z.string()).default([]),
});

export type ExtractedQuotes = z.infer<typeof ExtractedQuotesSchema>;

// =============================================================================
// SearchOpts — passed to provider.search()
// =============================================================================

export interface SearchOpts {
  limit?: number;                                   // top-N results
  recency_days?: number;                            // restrict to last N days
  include_domains?: string[];
  exclude_domains?: string[];
  signal?: AbortSignal;
}

// =============================================================================
// SearchProvider — the contract every provider module implements
// =============================================================================

export interface SearchProvider {
  readonly name: ProviderName;
  readonly enabled: boolean;
  search(query: string, opts: SearchOpts): Promise<SearchResult[]>;
  fetch?(url: string, signal?: AbortSignal): Promise<FetchResult>;
  extract?(raw: FetchResult): Promise<ExtractedQuotes>;
}

// =============================================================================
// Section synthesis — emitted by section-synthesis stage
// =============================================================================

export const SectionDraftSchema = z.object({
  section_path: z.string().min(1),
  heading: z.string().min(1),
  level: z.number().int().min(1).max(6).default(2),
  body_md: z.string().min(1),
  source_urls: z.array(z.string()).default([]),
  inline_citations: z.array(z.object({
    anchor: z.string(),          // [^1], [^2]
    source_url: z.string(),
    quote_excerpt: z.string().default(''),
  })).default([]),
  word_count: z.number().int().nonnegative(),
});

export type SectionDraft = z.infer<typeof SectionDraftSchema>;

// =============================================================================
// Critique — emitted by critique step
// =============================================================================

export const CritiqueSchema = z.object({
  gaps: z.array(z.object({
    section_path: z.string(),
    description: z.string(),
    suggested_subqueries: z.array(z.string()).default([]),
  })).default([]),
  unsupported_claims: z.array(z.object({
    claim: z.string(),
    section_path: z.string(),
  })).default([]),
  thin_sections: z.array(z.string()).default([]),
  missing_provider_coverage: z.array(z.object({
    section_path: z.string(),
    missing_providers: z.array(ProviderNameSchema),
  })).default([]),
  overall_word_count: z.number().int().nonnegative(),
  meets_target: z.boolean(),
});

export type Critique = z.infer<typeof CritiqueSchema>;

// =============================================================================
// FinalReport — emitted by assembly stage
// =============================================================================

export const FinalReportSchema = z.object({
  title: z.string().min(1),
  executive_summary: z.string().min(1),
  full_markdown: z.string().min(1),
  sections: z.array(SectionDraftSchema),
  bibliography: z.array(z.object({
    citation_anchor: z.string(),
    source_url: z.string(),
    title: z.string().default(''),
    author: z.string().default(''),
    provider: ProviderNameSchema,
    published_at: z.string().optional(),
  })),
  gaps: z.array(z.string()).default([]),
  word_count: z.number().int().nonnegative(),
});

export type FinalReport = z.infer<typeof FinalReportSchema>;

// =============================================================================
// Report chunks — produced by the indexer for embedding + retrieval
// =============================================================================

export const ChunkKindSchema = z.enum(['exec_summary', 'section', 'quote', 'source_summary']);
export type ChunkKind = z.infer<typeof ChunkKindSchema>;

export interface ReportChunkInput {
  chunk_kind: ChunkKind;
  section_path: string;
  heading: string | null;
  content: string;
  source_url: string | null;
  source_provider: ProviderName | 'perplexity' | 'manual' | null;
  source_author: string | null;
  source_published_at: string | null;
  source_engagement: Record<string, unknown>;
  citation_anchor: string | null;
  metadata: Record<string, unknown>;
}

// =============================================================================
// Inngest event payloads
// =============================================================================

/** Depth mode for the deep-research run. See lib/deep-research/depth-config.ts. */
export const ResearchDepthSchema = z.enum(['standard', 'wide']);
export type ResearchDepthLiteral = z.infer<typeof ResearchDepthSchema>;

export const CorpusRunEventSchema = z.object({
  organization_id: z.string().uuid(),
  prompt_corpus_ids: z.array(z.string().uuid()).optional(),
  filter_category: z.enum(['top-level', 'per-workshop', 'per-course', 'total-beginners', 'ad_hoc']).optional(),
  tools: z.array(z.enum(['ora_agentic', 'perplexity'])).default(['ora_agentic']),
  date_anchor: z.string(),       // YYYY-MM-DD
  triggered_by: z.string().default('cli'),
  depth: ResearchDepthSchema.default('standard'),
  /**
   * Phase 1 Experiment 1 — synthesis-model bake-off override.
   * Set by Sentigen from admin.feature_flags['cortex_synthesis_model'] per workspace.
   * `undefined` → Cortex uses its built-in default (currently claude-sonnet-4-6).
   */
  synthesis_model_override: z.string().min(1).optional(),
});

export type CorpusRunEvent = z.infer<typeof CorpusRunEventSchema>;

export const PromptRunEventSchema = z.object({
  organization_id: z.string().uuid(),
  parent_run_id: z.string().uuid(),
  prompt_corpus_id: z.string().uuid(),
  prompt_run_id: z.string().uuid(),
  tool_name: z.enum(['ora_agentic', 'perplexity']),
  depth: ResearchDepthSchema.default('standard'),
  synthesis_model_override: z.string().min(1).optional(),
});

export type PromptRunEvent = z.infer<typeof PromptRunEventSchema>;

// =============================================================================
// Caller-completion callback (POSTed to Sentigen / other product ingest endpoints
// when a caller_product='<product>' run finishes).
// =============================================================================

export const SentigenResearchCompletedPayloadSchema = z.object({
  run_id: z.string().uuid(),
  report_ids: z.array(z.string().uuid()),
  caller_workspace_id: z.string().uuid(),
  caller_user_id: z.string().uuid(),
  caller_context: z.record(z.string(), z.unknown()),
  cost_usd: z.number().nonnegative(),
  token_usage: z.object({
    input: z.number().int().nonnegative().optional(),
    output: z.number().int().nonnegative().optional(),
    cache_creation: z.number().int().nonnegative().optional(),
    cache_read: z.number().int().nonnegative().optional(),
  }).optional(),
});

export type SentigenResearchCompletedPayload = z.infer<typeof SentigenResearchCompletedPayloadSchema>;

// =============================================================================
// Cost tracking
// =============================================================================

export interface CostEntry {
  provider: string;
  category: 'search' | 'fetch' | 'extract' | 'embed' | 'synth' | 'critique' | 'plan' | 'transcribe';
  units: number;
  unit_cost_usd: number;
  metadata: Record<string, unknown>;
}

export function computeTotalCost(entries: CostEntry[]): number {
  let total = 0;
  for (const e of entries) {
    total += e.units * e.unit_cost_usd;
  }
  return total;
}

// =============================================================================
// Helpers
// =============================================================================

export function hashUrl(url: string): string {
  // SHA-256 of the canonical URL — used as the cache key.
  return createHash('sha256').update(url).digest('hex');
}

export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    // Strip common tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ref'];
    for (const p of trackingParams) {
      u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return url;
  }
}
