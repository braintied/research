/**
 * categorizeItems — ONE batched Gemini call that tags every ingested item with
 * a contractor-relevant `category`, `tags`, and a one-line `whyItMatters`.
 *
 * Reuses the package's Gemini client conventions (GEMINI_RESEARCH_KEY +
 * EXTRACTION_MODEL via pipeline-core). Output is Zod-validated; when the Gemini
 * CALL fails or returns something unparseable, the items are returned unchanged
 * with their default category, so the sweep never breaks on a categorizer
 * hiccup.
 *
 * Two failures deliberately do NOT behave that way, because swallowing them
 * hands back a knowledge base where every item is the fallback category with
 * nothing anywhere saying why: a missing Gemini credential, and a taxonomy that
 * cannot produce a coherent prompt. Both throw.
 *
 * The taxonomy is a PARAMETER — see CategorizeTaxonomy below for why.
 */

import { z } from 'zod';
import { fetchWithRetry, extractionModelId } from '../pipeline-core.js';
import { requireGeminiApiKey, type ResearchCredentials } from '../credentials.js';
import { logger } from '../logger.js';
import { KNOWLEDGE_CATEGORIES } from './types.js';
import type { IngestedItem, KnowledgeCategory } from './types.js';

// =============================================================================
// Gemini response envelope + per-item result schemas
// =============================================================================

const GeminiEnvelopeSchema = z.object({
  candidates: z.array(
    z.object({
      content: z.object({
        parts: z.array(z.object({ text: z.string() })),
      }),
    }),
  ),
});

const CategorizedEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  category: z.string().default('other'),
  tags: z.array(z.string()).default([]),
  why_it_matters: z.string().default(''),
  // 0–2 VERBATIM quotable sentences copied from the item's content. Defaulted to
  // [] so a model that omits the field never breaks the batch.
  quotes: z.array(z.string()).default([]),
});

const CategorizedBatchSchema = z.object({
  items: z.array(CategorizedEntrySchema).default([]),
});

// =============================================================================
// Constants
// =============================================================================

const MAX_BATCH = 40; // items per Gemini call
const MAX_CONTENT_CHARS_PER_ITEM = 800;
const MAX_TAGS = 6;
const MAX_QUOTES = 2;
// A quotable sentence shorter than this is not worth surfacing as a pull-quote.
const MIN_QUOTE_CHARS = 20;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Everything the categorizer prompt needs to classify for ONE product's
 * audience.
 *
 * Why this is a parameter and not a string literal: this prompt used to
 * hardcode "curating a knowledge base FOR CONTRACTORS" with a
 * tip|tool|news|win|pain_point|trend|competitor|other taxonomy — the most
 * domain-coupled code in the least domain-coupled package. Any other domain run
 * through it was classified against the wrong universe, so a silversmithing
 * studio came back `competitor`. A taxonomy is a product's policy, and it
 * belongs in a value the product passes.
 *
 * The category union `C` defaults to `string` so a consumer can write
 * `CategorizeTaxonomy` bare and supply its own categories.
 *
 * Plain strings throughout, deliberately, matching `@braintied/knowledge`'s
 * `Taxonomy`: a schema object built by this package's zod carries a brand
 * another zod instance rejects, which is a documented failure in this fleet.
 * The two are siblings by design — this one is prompt-side (it carries
 * `quoteVoice`, which shapes what the model is asked for), and knowledge's is
 * guard-side (it carries `quotePolicy`, which decides what survives).
 */
export interface CategorizeTaxonomy<C extends string = string> {
  /** The closed category set. Order is preserved into the prompt. */
  readonly categories: readonly C[];
  /** The category assigned when a model returns something unrecognized. */
  readonly fallback: C;
  /** One or two sentences naming who this knowledge base is for. */
  readonly audienceBrief: string;
  /** Category -> what belongs in it. Every category needs an entry. */
  readonly categoryDescriptions: Readonly<Record<string, string>>;
  /** Instruction for the free-text "why this matters to that audience" field. */
  readonly relevanceFieldPrompt: string;
  /** Describes the voice a quotable sentence should be in. */
  readonly quoteVoice: string;
}

/**
 * The taxonomy this categorizer used before one could be injected. It stays the
 * default so every existing caller keeps its exact behaviour and output.
 */
export const CONTRACTOR_TAXONOMY: CategorizeTaxonomy<KnowledgeCategory> = {
  categories: KNOWLEDGE_CATEGORIES,
  fallback: 'other',
  audienceBrief:
    'You are a research assistant curating a knowledge base FOR CONTRACTORS ' +
    '(builders, remodelers, plumbers, electricians, HVAC, roofers, etc.).',
  categoryDescriptions: {
    tip: 'actionable how-to / advice a contractor can apply',
    tool: 'software, equipment, or product relevant to running a trade business',
    news: 'industry news / regulation / market event',
    win: 'a success story or positive outcome',
    pain_point: 'a problem, complaint, or frustration contractors voice',
    trend: 'an emerging pattern or shift in the trades',
    competitor: 'content from a competing SaaS / platform (ServiceTitan, Jobber, etc.)',
    other: 'none of the above',
  },
  relevanceFieldPrompt: 'one short sentence on why a contractor should care',
  quoteVoice:
    'in REAL contractor voice (the kind of authentic, opinionated, specific line a ' +
    'human wrote that AI could never fake)',
};

/**
 * Throw unless every category has a description.
 *
 * A missing description would otherwise reach the model as an empty line, so
 * the model would silently classify against a category it was never told the
 * meaning of. Failing here names the category instead.
 */
function assertDescribed<C extends string>(taxonomy: CategorizeTaxonomy<C>): void {
  if (taxonomy.categories.length === 0) {
    throw new CategorizeTaxonomyError('a taxonomy needs at least one category');
  }
  const missing = taxonomy.categories.filter((category) => {
    const description = taxonomy.categoryDescriptions[category];
    return description === undefined || description.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new CategorizeTaxonomyError(
      `categoryDescriptions is missing an entry for: ${missing.join(', ')}`,
    );
  }
  if (!taxonomy.categories.includes(taxonomy.fallback)) {
    throw new CategorizeTaxonomyError(
      `fallback "${taxonomy.fallback}" is not one of the categories`,
    );
  }
}

/** A taxonomy that cannot produce a coherent prompt. */
export class CategorizeTaxonomyError extends Error {
  constructor(message: string) {
    super(`[categorizeItems] invalid taxonomy: ${message}`);
    this.name = 'CategorizeTaxonomyError';
  }
}

function coerceCategory<C extends string>(raw: string, taxonomy: CategorizeTaxonomy<C>): C {
  const needle = raw.trim().toLowerCase();
  for (const category of taxonomy.categories) {
    if (category.toLowerCase() === needle) return category;
  }
  return taxonomy.fallback;
}

// Collapse whitespace + lowercase so the verbatim check tolerates harmless
// reflow differences (newline vs. space) without accepting paraphrases. The
// quote must still be a literal substring of the source after this normalize.
function normalizeForVerbatim(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Keep only quotes that genuinely appear VERBATIM in the item's source content
// (defends against an invented/paraphrased "quote"). Dedupes, trims, drops
// too-short fragments, and caps at MAX_QUOTES.
function selectVerbatimQuotes(rawQuotes: string[], sourceText: string): string[] {
  const haystack = normalizeForVerbatim(sourceText);
  if (haystack.length === 0) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawQuotes) {
    const quote = raw.trim();
    if (quote.length < MIN_QUOTE_CHARS) continue;
    const needle = normalizeForVerbatim(quote);
    if (needle.length === 0 || seen.has(needle)) continue;
    if (!haystack.includes(needle)) continue;
    seen.add(needle);
    out.push(quote);
    if (out.length >= MAX_QUOTES) break;
  }
  return out;
}

function parseJsonObject(rawText: string): unknown {
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildPrompt<C extends string>(
  batch: IngestedItem<C>[],
  taxonomy: CategorizeTaxonomy<C>,
): string {
  const catalog = taxonomy.categories.join(' | ');
  const exampleCategory = taxonomy.categories[0];
  const lines: string[] = [
    taxonomy.audienceBrief,
    'For each content item below, classify it for that audience.',
    '',
    `Allowed categories (pick exactly one): ${catalog}`,
    ...taxonomy.categories.map(
      (category) => `  - ${category}: ${taxonomy.categoryDescriptions[category]}`,
    ),
    '',
    `Also extract 0–${MAX_QUOTES} genuinely quotable sentences ${taxonomy.quoteVoice} from`,
    "each item's content. The quotes MUST be copied VERBATIM — character",
    "for character — from that item's content. NEVER invent, paraphrase, summarize,",
    'clean up, or combine sentences. If nothing is worth quoting, return an empty array.',
    '',
    'Return ONLY valid JSON — no prose, no markdown fences:',
    `{ "items": [ { "index": 0, "category": "${exampleCategory}", "tags": ["one","two"], "why_it_matters": "${taxonomy.relevanceFieldPrompt}", "quotes": ["a verbatim sentence from the content"] } ] }`,
    '',
    `Use up to ${MAX_TAGS} lowercase tags per item. For why_it_matters: ${taxonomy.relevanceFieldPrompt}.`,
    `Include at most ${MAX_QUOTES} verbatim quotes per item; prefer fewer high-quality ones.`,
    '',
    'ITEMS:',
  ];

  batch.forEach((item, i) => {
    const body = item.contentMd.length > 0 ? item.contentMd : item.excerpt;
    lines.push(
      `--- index ${i} ---`,
      `source_type: ${item.sourceType}`,
      `title: ${item.title.slice(0, 200)}`,
      `content: ${body.slice(0, MAX_CONTENT_CHARS_PER_ITEM)}`,
    );
  });

  return lines.join('\n');
}

async function categorizeBatch<C extends string>(
  credentials: ResearchCredentials,
  batch: IngestedItem<C>[],
  taxonomy: CategorizeTaxonomy<C>,
): Promise<void> {
  const geminiKey = requireGeminiApiKey(credentials);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${extractionModelId()}:generateContent`;
  const prompt = buildPrompt(batch, taxonomy);

  let rawJson: unknown;
  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        }),
        signal: AbortSignal.timeout(60_000),
      },
      3,
      2000,
    );
    if (!response.ok) {
      throw new Error(`Gemini categorize error: ${response.status}`);
    }
    rawJson = await response.json();
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), batchSize: batch.length },
      '[categorizeItems] Gemini call failed — items keep default category',
    );
    return;
  }

  const envelope = GeminiEnvelopeSchema.safeParse(rawJson);
  if (!envelope.success) {
    logger.warn({ errors: envelope.error.message }, '[categorizeItems] invalid envelope');
    return;
  }
  const firstCandidate = envelope.data.candidates[0];
  if (firstCandidate === undefined) return;
  const firstPart = firstCandidate.content.parts[0];
  if (firstPart === undefined) return;

  const parsed = parseJsonObject(firstPart.text);
  if (parsed === null) {
    logger.warn('[categorizeItems] could not parse JSON');
    return;
  }
  const result = CategorizedBatchSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({ errors: result.error.message }, '[categorizeItems] invalid batch schema');
    return;
  }

  for (const entry of result.data.items) {
    const target = batch[entry.index];
    if (target === undefined) continue;
    target.category = coerceCategory(entry.category, taxonomy);
    target.tags = entry.tags.slice(0, MAX_TAGS).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
    target.whyItMatters = entry.why_it_matters.trim().length > 0 ? entry.why_it_matters.trim() : null;
    // VERBATIM guard: only keep quotes that literally appear in the item's
    // source content, so an invented/paraphrased "quote" is dropped.
    const sourceText = target.contentMd.length > 0 ? target.contentMd : target.excerpt;
    target.quotes = selectVerbatimQuotes(entry.quotes, sourceText);
  }
}

// =============================================================================
// categorizeItems — public entry. Mutates + returns the same array.
// =============================================================================

export function categorizeItems(
  credentials: ResearchCredentials,
  items: IngestedItem[],
): Promise<IngestedItem[]>;
export function categorizeItems<C extends string>(
  credentials: ResearchCredentials,
  items: IngestedItem<C>[],
  taxonomy: CategorizeTaxonomy<C>,
): Promise<IngestedItem<C>[]>;
// The implementation widens to `string` so the contractor default is assignable
// without a type assertion; the overloads above are what a caller sees, and they
// keep the category union exact in both directions.
export async function categorizeItems(
  credentials: ResearchCredentials,
  items: IngestedItem<string>[],
  taxonomy: CategorizeTaxonomy<string> = CONTRACTOR_TAXONOMY,
): Promise<IngestedItem<string>[]> {
  // Validated even on the empty-items fast path: a caller who passes a broken
  // taxonomy should hear about it on the first call, not on the first call that
  // happens to carry data.
  assertDescribed(taxonomy);
  if (items.length === 0) return items;

  for (let start = 0; start < items.length; start += MAX_BATCH) {
    const batch = items.slice(start, start + MAX_BATCH);
    await categorizeBatch(credentials, batch, taxonomy);
  }

  logger.info({ count: items.length }, '[categorizeItems] categorization complete');
  return items;
}
