/**
 * Deep-Research Planner
 *
 * Decomposes a research brief into 15–35 web-searchable subqueries,
 * grouped by section, with provider routing for each subquery.
 *
 * Primary model: Gemini 3.1 Flash Lite (EXTRACTION_MODEL)
 * Fallback model: Claude Sonnet 4.6 (if Gemini fails after 2 retries)
 */

import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';
import { getGeminiKey, EXTRACTION_MODEL } from './pipeline-core.js';
import { SubquerySchema } from './types.js';
import type { Subquery } from './types.js';

// =============================================================================
// Constants
// =============================================================================

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PLANNER_MAX_RETRIES = 2;

const PROVIDER_ROUTING_TABLE = `
| Content need              | Use these providers                            |
|---------------------------|------------------------------------------------|
| Forum / community voice   | reddit, tavily                                 |
| Video reviews / demos     | youtube                                        |
| YouTube comment threads   | youtube                                        |
| News / recent reactions   | tavily, serpapi                                |
| Google SERP / ads / PAA   | serpapi                                        |
| Long-form blogs / essays  | exa, crawl4ai                                  |
| Academic papers / arxiv   | exa, tavily                                    |
| Hacker News discussions   | hn, tavily                                     |
| RSS newsletters / Substack| rss, crawl4ai                                  |
| Competitor landing pages  | crawl4ai, serpapi                              |
| Audience verbatim pain    | reddit, youtube                                |
| Vendor docs / changelogs  | crawl4ai, exa                                  |
`;

const buildSystemPrompt = (subqueriesMin: number, subqueriesMax: number) =>
  `You are a research planner. Decompose the following deep-research brief into ${subqueriesMin}–${subqueriesMax} specific, web-searchable subqueries grouped by section (A.1, A.2, B.1...). For each subquery, choose 1–3 providers from this list: tavily, exa, serpapi, reddit, youtube, hn, rss, crawl4ai. Choose providers based on what the subquery needs to find.

Provider routing reference:
${PROVIDER_ROUTING_TABLE}

Output ONLY valid JSON in this exact shape (no markdown fences, no explanation):
{
  "subqueries": [
    {
      "section_path": "A.1",
      "query": "specific web-searchable query string",
      "providers": ["tavily"],
      "expected_source_types": ["news"],
      "rationale": "1-sentence explanation"
    }
  ]
}

Valid provider values: tavily, exa, serpapi, reddit, youtube, hn, rss, crawl4ai
Valid expected_source_types: forum, social, video, video_comments, longform, academic, news, serp, course_page, audience_voice, newsletter, documentation`;

// =============================================================================
// Internal Zod schemas
// =============================================================================

const PlannerOutputSchema = z.object({
  subqueries: z.array(SubquerySchema),
});

const GeminiResponseSchema = z.object({
  candidates: z.array(
    z.object({
      content: z.object({
        parts: z.array(
          z.object({
            text: z.string(),
          }),
        ),
      }),
    }),
  ),
});

// =============================================================================
// Gemini call helper
// =============================================================================

async function callGemini(userMessage: string, systemPrompt: string): Promise<string> {
  const key = getGeminiKey();
  const url = `${GEMINI_API_BASE}/${EXTRACTION_MODEL}:generateContent?key=${key}`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);
  }

  const raw: unknown = await response.json();
  const parsed = GeminiResponseSchema.parse(raw);

  const firstCandidate = parsed.candidates[0];
  if (firstCandidate === undefined) {
    throw new Error('Gemini returned no candidates');
  }
  const firstPart = firstCandidate.content.parts[0];
  if (firstPart === undefined) {
    throw new Error('Gemini returned empty content parts');
  }

  return firstPart.text;
}

// =============================================================================
// Claude fallback call helper
// =============================================================================

async function callClaude(userMessage: string, systemPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new Error('ANTHROPIC_API_KEY environment variable is not configured');
  }

  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
    }
  }

  return text;
}

// =============================================================================
// JSON extraction helper
// =============================================================================

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('No JSON object found in LLM response');
  }
  return trimmed.slice(start, end + 1);
}

// =============================================================================
// Exports
// =============================================================================

export interface PlanSubqueriesInput {
  promptMd: string;
  targetWordCount: { min: number; max: number };
  refinementHint?: string;
  /** Subquery breadth — defaults to legacy 15-35 if omitted. */
  subqueriesMin?: number;
  subqueriesMax?: number;
}

export async function planSubqueries(input: PlanSubqueriesInput): Promise<Subquery[]> {
  const { promptMd, targetWordCount, refinementHint } = input;
  const subqueriesMin = input.subqueriesMin ?? 15;
  const subqueriesMax = input.subqueriesMax ?? 35;
  const systemPrompt = buildSystemPrompt(subqueriesMin, subqueriesMax);

  let userMessage = `Research brief:\n\n${promptMd}\n\nTarget report length: ${targetWordCount.min}–${targetWordCount.max} words.`;

  if (refinementHint !== undefined && refinementHint !== '') {
    userMessage += `\n\nFocus the new subqueries on these gaps: ${refinementHint}`;
  }

  // Try Gemini up to PLANNER_MAX_RETRIES times
  let geminiText: string | null = null;
  for (let attempt = 0; attempt < PLANNER_MAX_RETRIES; attempt++) {
    try {
      geminiText = await callGemini(userMessage, systemPrompt);
      const jsonStr = extractJson(geminiText);
      const parsed = PlannerOutputSchema.parse(JSON.parse(jsonStr));
      logger.info(
        { count: parsed.subqueries.length, attempt, subqueriesMin, subqueriesMax },
        '[planner] Gemini subqueries produced',
      );
      return parsed.subqueries;
    } catch (err: unknown) {
      logger.warn(
        { err: String(err), attempt },
        '[planner] Gemini attempt failed, retrying',
      );
    }
  }

  // Fallback: Claude Sonnet 4.6
  logger.info('[planner] Falling back to Claude for subquery planning');
  try {
    const claudeText = await callClaude(userMessage, systemPrompt);
    const jsonStr = extractJson(claudeText);
    const parsed = PlannerOutputSchema.parse(JSON.parse(jsonStr));
    logger.info(
      { count: parsed.subqueries.length, subqueriesMin, subqueriesMax },
      '[planner] Claude fallback subqueries produced',
    );
    return parsed.subqueries;
  } catch (err: unknown) {
    logger.error(
      { err: String(err), geminiText },
      '[planner] Both Gemini and Claude failed to produce valid subqueries',
    );
    return [];
  }
}

export async function summarizePromptBrief(promptMd: string): Promise<string> {
  const key = getGeminiKey();
  const url = `${GEMINI_API_BASE}/${EXTRACTION_MODEL}:generateContent?key=${key}`;

  const systemInstruction =
    'You are a research coordinator. Distill the following research brief into a single paragraph of 2–4 sentences that captures the core question, audience, and desired output. Be precise and concrete. Return only the paragraph text — no labels, no markdown.';

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: promptMd }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 512,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Gemini summarize error ${response.status}: ${await response.text()}`);
  }

  const raw: unknown = await response.json();
  const parsed = GeminiResponseSchema.parse(raw);

  const firstCandidate = parsed.candidates[0];
  if (firstCandidate === undefined) {
    throw new Error('Gemini summarize returned no candidates');
  }
  const firstPart = firstCandidate.content.parts[0];
  if (firstPart === undefined) {
    throw new Error('Gemini summarize returned empty parts');
  }

  return firstPart.text.trim();
}
