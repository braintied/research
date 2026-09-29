/**
 * Deep-Research Planner
 *
 * Decomposes a research brief into 15–35 web-searchable subqueries,
 * grouped by section, with provider routing for each subquery.
 *
 * Primary model: `research-extract` from @braintied/models.
 * Fallback model: STRONG style from @braintied/models (if the primary fails after 2 retries).
 */

import { z } from 'zod';
import { resolveForStyle, type ModelResolution } from '@braintied/models';
import { logger } from './logger.js';
import type { ResearchCredentials } from './credentials.js';
import { callModel } from './model-call.js';
import { researchStageResolution } from './model-policy.js';
import { SubquerySchema } from './types.js';
import type { Subquery } from './types.js';

/** Planner fallback — the live STRONG pin from the catalog, not a hardcoded id. */
function plannerFallbackResolution(): ModelResolution {
  return resolveForStyle('STRONG', { moduleId: 'research' });
}

// =============================================================================
// Constants
// =============================================================================

const PLANNER_MAX_RETRIES = 2;

/** Provider → the content need it serves, used to build the routing table. */
const PROVIDER_ROUTING_ROWS: Array<{ need: string; providers: string[] }> = [
  { need: 'Forum / community voice', providers: ['reddit', 'tavily', 'searxng'] },
  { need: 'Video reviews / demos', providers: ['youtube'] },
  { need: 'YouTube comment threads', providers: ['youtube'] },
  { need: 'News / recent reactions', providers: ['tavily', 'searxng', 'serper', 'serpapi'] },
  { need: 'Google SERP / ads / PAA', providers: ['serper', 'serpapi'] },
  { need: 'Long-form blogs / essays', providers: ['exa', 'tavily', 'searxng'] },
  { need: 'Academic papers / arxiv', providers: ['exa', 'tavily', 'searxng'] },
  { need: 'Hacker News discussions', providers: ['hn', 'tavily'] },
  { need: 'RSS newsletters / Substack', providers: ['rss', 'tavily', 'searxng'] },
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

/** Token usage reported for one planner LLM call (audit F8). */
export interface PlannerUsage {
  /** Catalog provider that served the call. */
  provider: string;
  /** Wire model id that ran. */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// =============================================================================
// Model call helper
// =============================================================================

/**
 * One planner call. Primary is `research-extract` (the cheap volume stage);
 * the fallback is the STRONG style. Both come from `@braintied/models` and go
 * through `callModel`, so each reaches whichever provider it resolved to.
 */
async function callPlannerModel(
  credentials: ResearchCredentials,
  resolution: ModelResolution,
  userMessage: string,
  systemPrompt: string,
): Promise<{ text: string; usage: PlannerUsage }> {
  const result = await callModel({
    credentials,
    system: systemPrompt,
    user: userMessage,
    model: resolution,
    maxTokens: 8192,
    temperature: 0.2,
    jsonResponse: true,
  });
  return {
    text: result.text,
    usage: {
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens + result.cachedReadTokens,
      outputTokens: result.outputTokens,
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
  /** Host-resolved credentials; planning needs the key for whichever provider each stage resolves to. */
  credentials: ResearchCredentials;
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
  const { credentials, promptMd, targetWordCount, refinementHint, usageSink } = input;
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

  // Try the primary model up to PLANNER_MAX_RETRIES times
  const primary = researchStageResolution('extract');
  let primaryText: string | null = null;
  for (let attempt = 0; attempt < PLANNER_MAX_RETRIES; attempt++) {
    try {
      const primaryResult = await callPlannerModel(credentials, primary, userMessage, systemPrompt);
      reportUsage(primaryResult.usage);
      primaryText = primaryResult.text;
      const jsonStr = extractJson(primaryText);
      const parsed = PlannerOutputSchema.parse(JSON.parse(jsonStr));
      logger.info(
        { count: parsed.subqueries.length, attempt, subqueriesMin, subqueriesMax, model: primary.apiModelId },
        '[planner] Subqueries produced',
      );
      return parsed.subqueries;
    } catch (err: unknown) {
      logger.warn(
        { err: String(err), attempt, model: primary.apiModelId },
        '[planner] Primary attempt failed, retrying',
      );
    }
  }

  // Fallback: the STRONG style
  const fallback = plannerFallbackResolution();
  logger.info({ model: fallback.apiModelId }, '[planner] Falling back to the STRONG model for subquery planning');
  try {
    const fallbackResult = await callPlannerModel(credentials, fallback, userMessage, systemPrompt);
    reportUsage(fallbackResult.usage);
    const jsonStr = extractJson(fallbackResult.text);
    const parsed = PlannerOutputSchema.parse(JSON.parse(jsonStr));
    logger.info(
      { count: parsed.subqueries.length, subqueriesMin, subqueriesMax, model: fallback.apiModelId },
      '[planner] Fallback subqueries produced',
    );
    return parsed.subqueries;
  } catch (err: unknown) {
    logger.error(
      { err: String(err), primaryText },
      '[planner] Primary and fallback models both failed to produce valid subqueries',
    );
    return [];
  }
}

export async function summarizePromptBrief(
  credentials: ResearchCredentials,
  promptMd: string,
): Promise<string> {
  const systemInstruction =
    'You are a research coordinator. Distill the following research brief into a single paragraph of 2–4 sentences that captures the core question, audience, and desired output. Be precise and concrete. Return only the paragraph text — no labels, no markdown.';

  const result = await callModel({
    credentials,
    system: systemInstruction,
    user: promptMd,
    model: researchStageResolution('extract'),
    maxTokens: 512,
    temperature: 0.1,
  });
  return result.text.trim();
}
