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

/** Provider → the content need it serves, used to build the routing table. */
const PROVIDER_ROUTING_ROWS: Array<{ need: string; providers: string[] }> = [
  { need: 'Forum / community voice', providers: ['reddit', 'searxng', 'tavily'] },
  { need: 'Video reviews / demos', providers: ['youtube'] },
  { need: 'YouTube comment threads', providers: ['youtube'] },
  { need: 'News / recent reactions', providers: ['searxng', 'serper', 'tavily', 'serpapi'] },
  { need: 'Google SERP / ads / PAA', providers: ['serper', 'serpapi'] },
  { need: 'Long-form blogs / essays', providers: ['exa', 'searxng', 'tavily'] },
  { need: 'Academic papers / arxiv', providers: ['exa', 'tavily', 'searxng'] },
  { need: 'Hacker News discussions', providers: ['hn', 'tavily'] },
  { need: 'RSS newsletters / Substack', providers: ['rss', 'searxng'] },
  { need: 'Competitor landing pages', providers: ['tavily', 'serper', 'serpapi'] },
  { need: 'Audience verbatim pain', providers: ['reddit', 'youtube'] },
  { need: 'Vendor docs / changelogs', providers: ['tavily', 'searxng', 'exa'] },
  { need: 'GitHub repositories / releases', providers: ['github', 'tavily', 'searxng'] },
  { need: 'GitHub issues / pull requests', providers: ['github', 'tavily', 'searxng'] },
];

/** Legacy default — used when the caller doesn't pass availableProviders. */
const DEFAULT_PLANNER_PROVIDERS = [
  'tavily', 'exa', 'serpapi', 'serper', 'searxng', 'reddit', 'youtube', 'hn', 'rss', 'github',
];

/**
 * Build the routing table restricted to the providers actually available for
 * this run, so the planner never routes a subquery to a disabled provider.
 */
function buildRoutingTable(available: string[]): string {
  const availableSet = new Set(available);
  const lines: string[] = [
    '| Content need              | Use these providers                            |',
    '|---------------------------|------------------------------------------------|',
  ];
  for (const row of PROVIDER_ROUTING_ROWS) {
    const usable = row.providers.filter((p) => availableSet.has(p));
    if (usable.length === 0) continue;
    lines.push(`| ${row.need.padEnd(25)} | ${usable.join(', ').padEnd(46)} |`);
  }
  return lines.join('\n');
}

const buildSystemPrompt = (
  subqueriesMin: number,
  subqueriesMax: number,
  availableProviders: string[],
) => {
  const providerList = availableProviders.join(', ');
  return `You are a research planner. Decompose the following deep-research brief into ${subqueriesMin}–${subqueriesMax} specific, web-searchable subqueries grouped by section (A.1, A.2, B.1...). For each subquery, choose 1–3 providers from this list: ${providerList}. Choose providers based on what the subquery needs to find.

Provider routing reference:
${buildRoutingTable(availableProviders)}

Output ONLY valid JSON in this exact shape (no markdown fences, no explanation):
{
  "subqueries": [
    {
      "section_path": "A.1",
      "query": "specific web-searchable query string",
      "providers": ["${availableProviders[0]}"],
      "expected_source_types": ["news"],
      "rationale": "1-sentence explanation"
    }
  ]
}

Valid provider values: ${providerList}
Valid expected_source_types: forum, social, video, video_comments, social_video, longform, academic, news, serp, course_page, audience_voice, newsletter, documentation, podcast, course_review, repository, issue, code`;
};

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
  usageMetadata: z.object({
    promptTokenCount: z.number().int().nonnegative().default(0),
    candidatesTokenCount: z.number().int().nonnegative().default(0),
  }).optional(),
});

/** Token usage reported for one planner LLM call (audit F8). */
export interface PlannerUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// =============================================================================
// Gemini call helper
// =============================================================================

async function callGemini(userMessage: string, systemPrompt: string): Promise<{ text: string; usage: PlannerUsage }> {
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

  const usageMeta = parsed.usageMetadata;
  return {
    text: firstPart.text,
    usage: {
      model: EXTRACTION_MODEL,
      inputTokens: usageMeta !== undefined ? usageMeta.promptTokenCount : 0,
      outputTokens: usageMeta !== undefined ? usageMeta.candidatesTokenCount : 0,
    },
  };
}

// =============================================================================
// Claude fallback call helper
// =============================================================================

async function callClaude(userMessage: string, systemPrompt: string): Promise<{ text: string; usage: PlannerUsage }> {
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

  return {
    text,
    usage: {
      model: 'claude-sonnet-4-6',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
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
  /**
   * Provider names the planner may route subqueries to. Pass the enabled
   * search-provider names so plans never target disabled providers. Defaults
   * to the full legacy list when omitted.
   */
  availableProviders?: string[];
  /**
   * Reports token usage for every planner LLM call — including failed
   * attempts, which still bill (audit F8: the 'plan' cost category was dead
   * code; planner spend never hit the cap). Errors are the caller's problem;
   * the sink itself must not throw.
   */
  usageSink?: (usage: PlannerUsage) => void;
}

export async function planSubqueries(input: PlanSubqueriesInput): Promise<Subquery[]> {
  const { promptMd, targetWordCount, refinementHint, usageSink } = input;
  const subqueriesMin = input.subqueriesMin ?? 15;
  const subqueriesMax = input.subqueriesMax ?? 35;
  const availableProviders =
    input.availableProviders !== undefined && input.availableProviders.length > 0
      ? input.availableProviders
      : DEFAULT_PLANNER_PROVIDERS;
  const systemPrompt = buildSystemPrompt(subqueriesMin, subqueriesMax, availableProviders);

  let userMessage = `Research brief:\n\n${promptMd}\n\nTarget report length: ${targetWordCount.min}–${targetWordCount.max} words.`;

  if (refinementHint !== undefined && refinementHint !== '') {
    userMessage += `\n\nFocus the new subqueries on these gaps: ${refinementHint}`;
  }

  const reportUsage = (usage: PlannerUsage): void => {
    if (usageSink !== undefined) {
      try {
        usageSink(usage);
      } catch {
        // Usage reporting must never break planning.
      }
    }
  };

  // Try Gemini up to PLANNER_MAX_RETRIES times
  let geminiText: string | null = null;
  for (let attempt = 0; attempt < PLANNER_MAX_RETRIES; attempt++) {
    try {
      const geminiResult = await callGemini(userMessage, systemPrompt);
      reportUsage(geminiResult.usage);
      geminiText = geminiResult.text;
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
    const claudeResult = await callClaude(userMessage, systemPrompt);
    reportUsage(claudeResult.usage);
    const jsonStr = extractJson(claudeResult.text);
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
