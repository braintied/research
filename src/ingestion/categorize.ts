/**
 * categorizeItems — ONE batched Gemini call that tags every ingested item with
 * a contractor-relevant `category`, `tags`, and a one-line `whyItMatters`.
 *
 * Reuses the package's Gemini client conventions (GEMINI_RESEARCH_KEY +
 * EXTRACTION_MODEL via pipeline-core). Output is Zod-validated; on ANY failure
 * the items are returned unchanged with their default category ('other'), so
 * the sweep never breaks on a categorizer hiccup.
 */

import { z } from 'zod';
import { getGeminiKey, fetchWithRetry, EXTRACTION_MODEL } from '../pipeline-core.js';
import { logger } from '../logger.js';
import { KNOWLEDGE_CATEGORIES, KnowledgeCategorySchema } from './types.js';
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

function coerceCategory(raw: string): KnowledgeCategory {
  const parsed = KnowledgeCategorySchema.safeParse(raw.trim().toLowerCase());
  if (parsed.success) return parsed.data;
  return 'other';
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

function buildPrompt(batch: IngestedItem[]): string {
  const catalog = KNOWLEDGE_CATEGORIES.join(' | ');
  const lines: string[] = [
    'You are a research assistant curating a knowledge base FOR CONTRACTORS',
    '(builders, remodelers, plumbers, electricians, HVAC, roofers, etc.).',
    'For each content item below, classify it for a contractor audience.',
    '',
    `Allowed categories (pick exactly one): ${catalog}`,
    '  - tip: actionable how-to / advice a contractor can apply',
    '  - tool: software, equipment, or product relevant to running a trade business',
    '  - news: industry news / regulation / market event',
    '  - win: a success story or positive outcome',
    '  - pain_point: a problem, complaint, or frustration contractors voice',
    '  - trend: an emerging pattern or shift in the trades',
    '  - competitor: content from a competing SaaS / platform (ServiceTitan, Jobber, etc.)',
    '  - other: none of the above',
    '',
    'Also extract 0–2 genuinely quotable sentences in REAL contractor voice from',
    "each item's content (the kind of authentic, opinionated, specific line a human",
    'wrote that AI could never fake). The quotes MUST be copied VERBATIM — character',
    "for character — from that item's content. NEVER invent, paraphrase, summarize,",
    'clean up, or combine sentences. If nothing is worth quoting, return an empty array.',
    '',
    'Return ONLY valid JSON — no prose, no markdown fences:',
    '{ "items": [ { "index": 0, "category": "tip", "tags": ["pricing","estimating"], "why_it_matters": "one short sentence on why a contractor should care", "quotes": ["a verbatim sentence from the content"] } ] }',
    '',
    `Use up to ${MAX_TAGS} lowercase tags per item. Keep why_it_matters to one sentence.`,
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

async function categorizeBatch(batch: IngestedItem[]): Promise<void> {
  const geminiKey = getGeminiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACTION_MODEL}:generateContent?key=${geminiKey}`;
  const prompt = buildPrompt(batch);

  let rawJson: unknown;
  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const body = await response.text();
      throw new Error(`Gemini categorize error: ${response.status} ${body.slice(0, 200)}`);
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
    target.category = coerceCategory(entry.category);
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

export async function categorizeItems(items: IngestedItem[]): Promise<IngestedItem[]> {
  if (items.length === 0) return items;

  for (let start = 0; start < items.length; start += MAX_BATCH) {
    const batch = items.slice(start, start + MAX_BATCH);
    await categorizeBatch(batch);
  }

  logger.info({ count: items.length }, '[categorizeItems] categorization complete');
  return items;
}
