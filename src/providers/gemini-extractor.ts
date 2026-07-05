/**
 * Gemini Extractor — shared verbatim-quote extraction helper for all providers.
 *
 * Calls Gemini 3.1 Flash Lite with mode-specific prompts and returns
 * Zod-validated ExtractedQuotes. Used by reddit, youtube, hn, crawl4ai, serpapi.
 */

import { z } from 'zod';
import { getGeminiKey, fetchWithRetry, EXTRACTION_MODEL } from '../pipeline-core.js';
import { ExtractedQuotesSchema, type ExtractedQuotes, type ProviderName } from '../types.js';
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
});

// =============================================================================
// Raw quote schema (what Gemini returns per quote in its JSON array)
// =============================================================================

const RawQuoteSchema = z.object({
  quote: z.string().default(''),
  context: z.string().default(''),
  source_url: z.string().default(''),
  author: z.string().optional(),
  published_at: z.string().optional(),
  engagement: z.object({
    upvotes: z.number().optional(),
    likes: z.number().optional(),
    replies: z.number().optional(),
    views: z.number().optional(),
  }).default({}),
  sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']).optional(),
  category: z.string().optional(),
});

// =============================================================================
// Raw ExtractedQuotes schema (what Gemini returns as the top-level JSON object)
// =============================================================================

const RawExtractedSchema = z.object({
  source_url: z.string().default(''),
  source_provider: z.string().default('tavily'),
  key_claims: z.array(z.string()).default([]),
  verbatim_quotes: z.array(RawQuoteSchema).default([]),
  dates_mentioned: z.array(z.string()).default([]),
  entities_mentioned: z.array(z.string()).default([]),
  themes: z.array(z.string()).default([]),
});

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
      "sentiment": "positive|negative|neutral|mixed",
      "category": "helpful|critical|scammy|promotional|informational"
    }
  ],
  "dates_mentioned": [],
  "entities_mentioned": [],
  "themes": []
}

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

  const rawResult = RawExtractedSchema.safeParse(parsed);
  if (!rawResult.success) {
    logger.warn({ url: input.url, errors: rawResult.error.message }, '[GeminiExtractor] Invalid extracted schema');
    return buildEmptyResult(input);
  }

  // Build and Zod-validate the final ExtractedQuotes
  const assembled = {
    source_url: input.url,
    source_provider: input.provider,
    key_claims: rawResult.data.key_claims,
    verbatim_quotes: rawResult.data.verbatim_quotes.map(q => ({
      quote: q.quote,
      context: q.context,
      source_url: q.source_url.length > 0 ? q.source_url : input.url,
      author: q.author,
      published_at: q.published_at,
      engagement: q.engagement,
      sentiment: q.sentiment,
      category: q.category,
    })),
    dates_mentioned: rawResult.data.dates_mentioned,
    entities_mentioned: rawResult.data.entities_mentioned,
    themes: rawResult.data.themes,
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
