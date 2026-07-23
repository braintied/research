/**
 * Gemini Extractor — shared verbatim-quote extraction helper for all providers.
 *
 * Calls Gemini 3.1 Flash Lite with mode-specific prompts and returns
 * Zod-validated ExtractedQuotes. Used by reddit, youtube, hn, crawl4ai, serpapi.
 */

import { z } from 'zod';
import { getGeminiKey, fetchWithRetry, EXTRACTION_MODEL } from '../pipeline-core.js';
import {
  ExtractedQuotesSchema,
  resolveSameSourceCitationUrl,
  type ExtractedQuotes,
  type ProviderName,
} from '../types.js';
import { logger } from '../logger.js';

// =============================================================================
// Input type
// =============================================================================

export interface GeminiExtractInput {
  provider: ProviderName;
  url: string;
  content: string;
  mode: 'reddit' | 'youtube' | 'serp' | 'longform' | 'hn';
}

// =============================================================================
// Gemini response envelope schema (minimal — just what we need)
// =============================================================================

const GeminiResponseEnvelopeSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(z.object({
        text: z.string(),
      })),
    }),
  })),
  usageMetadata: z.object({
    promptTokenCount: z.number().int().nonnegative().default(0),
    candidatesTokenCount: z.number().int().nonnegative().default(0),
  }).optional(),
});

// =============================================================================
// Raw quote schema (what Gemini returns per quote in its JSON array)
// =============================================================================

const SENTIMENT_VALUES = ['positive', 'negative', 'neutral', 'mixed'] as const;
type QuoteSentiment = (typeof SENTIMENT_VALUES)[number];
const SENTIMENT_VALUE_SET = new Set<string>(SENTIMENT_VALUES);

const RawQuoteSchema = z.object({
  quote: z.string().min(1),
  context: z.string().default(''),
  source_url: z.string().default(''),
  author: z.string().optional(),
  published_at: z.string().datetime({ offset: true }).optional(),
  engagement: z.object({
    upvotes: z.number().optional(),
    likes: z.number().optional(),
    replies: z.number().optional(),
    views: z.number().optional(),
  }).default({}),
  sentiment: z.enum(SENTIMENT_VALUES).optional(),
  category: z.string().optional(),
});

// =============================================================================
// Raw ExtractedQuotes schema (what Gemini returns as the top-level JSON object)
// =============================================================================

const RawExtractedSchema = z.object({
  // Treat model-generated collections as untrusted here, then salvage valid
  // entries individually. One malformed optional field must not erase every
  // valid quote and key claim extracted from the same page.
  key_claims: z.unknown().optional(),
  verbatim_quotes: z.unknown().optional(),
  dates_mentioned: z.unknown().optional(),
  entities_mentioned: z.unknown().optional(),
  themes: z.unknown().optional(),
}).passthrough();

function stringEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function normalizeSentiment(value: unknown): QuoteSentiment | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return SENTIMENT_VALUE_SET.has(normalized) ? normalized as QuoteSentiment : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalPublishedAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return z.string().datetime({ offset: true }).safeParse(value).success ? value : undefined;
}

function sanitizedEngagement(value: unknown): {
  upvotes?: number;
  likes?: number;
  replies?: number;
  views?: number;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const engagement: { upvotes?: number; likes?: number; replies?: number; views?: number } = {};
  for (const key of ['upvotes', 'likes', 'replies', 'views'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) engagement[key] = candidate;
  }
  return engagement;
}

const ANCHORED_SOURCE_MODES = new Set<GeminiExtractInput['mode']>(['reddit', 'youtube', 'hn']);

/**
 * Bind model-returned quote URLs to the page that was actually fetched.
 * Long-form/SERP evidence always cites that parent page. Thread/video modes
 * may preserve a fragment (comment/timestamp), but only when resolving the
 * candidate produces the same origin and canonical source as the parent.
 */
function validatedQuoteSourceUrl(input: GeminiExtractInput, candidate: unknown): string {
  if (!ANCHORED_SOURCE_MODES.has(input.mode) || typeof candidate !== 'string' || candidate.length === 0) {
    return input.url;
  }
  return resolveSameSourceCitationUrl(input.url, candidate);
}

function parseRawQuote(value: unknown, input: GeminiExtractInput): z.infer<typeof RawQuoteSchema> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.quote !== 'string' || record.quote.trim().length === 0) return null;

  const candidate = {
    quote: record.quote,
    context: typeof record.context === 'string' ? record.context : '',
    source_url: validatedQuoteSourceUrl(input, record.source_url),
    author: optionalString(record.author),
    published_at: optionalPublishedAt(record.published_at),
    engagement: sanitizedEngagement(record.engagement),
    sentiment: normalizeSentiment(record.sentiment),
    category: optionalString(record.category),
  };
  const parsed = RawQuoteSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export interface GeminiExtractionUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
}

/** @internal Pure normalization boundary, exported for offline contract tests. */
export function normalizeGeminiExtractionPayload(
  payload: unknown,
  input: GeminiExtractInput,
  usageMeta?: GeminiExtractionUsage,
): ExtractedQuotes {
  const rawResult = RawExtractedSchema.safeParse(payload);
  if (!rawResult.success) {
    logger.warn({ url: input.url, errors: rawResult.error.message }, '[GeminiExtractor] Invalid extracted schema');
    return buildEmptyResult(input);
  }

  const rawQuotes = Array.isArray(rawResult.data.verbatim_quotes)
    ? rawResult.data.verbatim_quotes
    : [];
  const validQuotes = rawQuotes.flatMap((quote) => {
    const parsedQuote = parseRawQuote(quote, input);
    return parsedQuote === null ? [] : [parsedQuote];
  });
  const droppedQuotes = rawQuotes.length - validQuotes.length;
  if (droppedQuotes > 0) {
    logger.warn(
      { url: input.url, dropped_quotes: droppedQuotes },
      '[GeminiExtractor] Dropped malformed quote entries',
    );
  }

  const assembled = {
    source_url: input.url,
    source_provider: input.provider,
    usage: usageMeta !== undefined
      ? {
          prompt_tokens: usageMeta.promptTokenCount,
          candidate_tokens: usageMeta.candidatesTokenCount,
        }
      : undefined,
    key_claims: stringEntries(rawResult.data.key_claims),
    verbatim_quotes: validQuotes,
    dates_mentioned: stringEntries(rawResult.data.dates_mentioned),
    entities_mentioned: stringEntries(rawResult.data.entities_mentioned),
    themes: stringEntries(rawResult.data.themes),
  };

  const final = ExtractedQuotesSchema.safeParse(assembled);
  if (!final.success) {
    logger.warn({ url: input.url, errors: final.error.message }, '[GeminiExtractor] Final schema validation failed');
    return buildEmptyResult(input);
  }

  logger.info(
    {
      url: input.url.slice(0, 60),
      mode: input.mode,
      quotes: final.data.verbatim_quotes.length,
      claims: final.data.key_claims.length,
    },
    '[GeminiExtractor] Extraction complete',
  );

  return final.data;
}

// =============================================================================
// Mode-specific prompt builders
// =============================================================================

function buildPrompt(input: GeminiExtractInput): string {
  const { mode, url, content } = input;
  const truncated = content.slice(0, 12000);

  const baseInstruction = `You are a research assistant. Extract key information from the content below.
Return ONLY valid JSON matching this exact schema — no prose, no markdown fences, just raw JSON:
{
  "source_url": "<the source URL>",
  "source_provider": "${input.provider}",
  "key_claims": ["claim1", "claim2"],
  "verbatim_quotes": [
    {
      "quote": "<exact verbatim text from the source>",
      "context": "<1-2 lines of surrounding context>",
      "source_url": "<permalink or anchored URL>",
      "author": "<author if known>",
      "engagement": { "upvotes": 0, "likes": 0 },
      "sentiment": "neutral",
      "category": "helpful|critical|scammy|promotional|informational"
    }
  ],
  "dates_mentioned": [],
  "entities_mentioned": [],
  "themes": []
}

For sentiment, emit exactly one of "positive", "negative", "neutral", or "mixed". Omit sentiment when it cannot be classified confidently.

Source URL: ${url}`;

  if (mode === 'reddit') {
    return `${baseInstruction}

MODE: Reddit post + comments analysis
- Extract verbatim quotes from the original post body AND from comments with ≥10 upvotes
- For each comment quote, set source_url to the permalink + "#comment-<id>" if available
- Author format: "u/<username>"
- Include sentiment classification (positive/negative/neutral/mixed) for each quote
- Include category: helpful/critical/scammy/promotional
- Maximum 50 verbatim quotes
- Focus on authentic user opinions and pain points

CONTENT:
${truncated}`;
  }

  if (mode === 'youtube') {
    return `${baseInstruction}

MODE: YouTube transcript + comments analysis
- Extract verbatim quotes from the transcript. When transcript lines begin with [t=<sec>] prefixes, PRESERVE the timestamp by emitting source_url as "<url>#t=<sec>" (e.g. "https://youtube.com/watch?v=abc#t=142"). For transcript lines without [t=<sec>] prefixes, estimate the timestamp offset from context clues.
- Extract verbatim comment quotes from all top-level comments with ≥5 likes (engagement is lower-bar for finding adult-learner verbatim language — was ≥10, now ≥5).
- For top comments that have reply threads (marked as "Replies:" in the content), include up to 3 high-signal replies as separate verbatim_quotes. Set the reply's category to "reply" and include the parent comment's author in the context field as "reply to <parent_author>".
- Maximum 20 transcript quotes, 30 comment quotes (50 total max).
- Include author (channel/username) and likes in engagement for every quote.
- Sentiment classification and category for each quote.

CONTENT:
${truncated}`;
  }

  if (mode === 'serp') {
    return `${baseInstruction}

MODE: Search engine results page analysis
- Extract key claims from organic results, ads, People Also Ask (PAA), and answer boxes
- For each result, note the serp_kind in category field: organic/ads/paa/answer_box
- Pull exact text from snippets and answer boxes as verbatim quotes
- Maximum 30 verbatim quotes
- Focus on competitive intelligence and SEO patterns

CONTENT:
${truncated}`;
  }

  if (mode === 'hn') {
    return `${baseInstruction}

MODE: Hacker News discussion analysis
- Extract verbatim quotes from comments with ≥10 points
- Author format: "<hn_username>"
- Include upvotes in engagement.upvotes
- Maximum 30 verbatim quotes
- Focus on technical insights, contrarian views, and expert opinions
- Sentiment and category for each quote

CONTENT:
${truncated}`;
  }

  // mode === 'longform'
  return `${baseInstruction}

MODE: Long-form article/blog/essay analysis
- Extract verbatim pull-quotes (meaningful paragraphs or sentences) from the main content
- Focus on key arguments, data points, and memorable assertions
- Maximum 30 verbatim quotes
- Author from byline/metadata
- Include dates_mentioned and entities_mentioned (people, companies, products)

CONTENT:
${truncated}`;
}

// =============================================================================
// Strip markdown fences and parse the outer JSON object
// =============================================================================

function parseGeminiJsonObject(rawText: string): unknown {
  let cleaned = rawText.trim();

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  // Try direct parse
  try {
    return JSON.parse(cleaned);
  } catch {
    // Find outer { ... }
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {
      // Give up
    }
  }

  return null;
}

// =============================================================================
// Main exported function
// =============================================================================

export async function extractQuotesWithGemini(input: GeminiExtractInput): Promise<ExtractedQuotes> {
  const geminiKey = getGeminiKey();
  const prompt = buildPrompt(input);

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACTION_MODEL}:generateContent?key=${geminiKey}`;

  let rawJson: unknown;

  try {
    const response = await fetchWithRetry(
      geminiUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 8192,
          },
        }),
        signal: AbortSignal.timeout(60000),
      },
      3,
      2000,
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${body.slice(0, 200)}`);
    }

    rawJson = await response.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ url: input.url, mode: input.mode, error: msg }, '[GeminiExtractor] API call failed');
    return buildEmptyResult(input);
  }

  const envelopeResult = GeminiResponseEnvelopeSchema.safeParse(rawJson);
  if (!envelopeResult.success) {
    logger.warn({ url: input.url, errors: envelopeResult.error.message }, '[GeminiExtractor] Invalid response envelope');
    return buildEmptyResult(input);
  }

  const firstCandidate = envelopeResult.data.candidates[0];
  if (firstCandidate === undefined) {
    return buildEmptyResult(input);
  }

  const firstPart = firstCandidate.content.parts[0];
  if (firstPart === undefined) {
    return buildEmptyResult(input);
  }

  const parsed = parseGeminiJsonObject(firstPart.text);
  if (parsed === null) {
    logger.warn({ url: input.url }, '[GeminiExtractor] Could not parse JSON from response');
    return buildEmptyResult(input);
  }

  return normalizeGeminiExtractionPayload(parsed, input, envelopeResult.data.usageMetadata);
}

function buildEmptyResult(input: GeminiExtractInput): ExtractedQuotes {
  return {
    source_url: input.url,
    source_provider: input.provider,
    key_claims: [],
    verbatim_quotes: [],
    dates_mentioned: [],
    entities_mentioned: [],
    themes: [],
  };
}
