/**
 * Managed deep research — Perplexity `sonar-deep-research`.
 *
 * The "buy, don't build" escape hatch: a single API call that runs
 * Perplexity's hosted end-to-end deep-research pipeline (~$0.40–1.30/query)
 * and returns a report normalized into the same FinalReport contract the
 * agentic pipeline produces, so downstream consumers (document layer,
 * indexSinks) don't care which engine ran.
 *
 * Trade-off vs `runDeepResearch`: far less control (no provider routing, no
 * quote-level grounding, no critique loop) but zero orchestration cost and
 * good quality on broad questions.
 */

import { z } from 'zod';
import { safeLogger } from './logger.js';
import type { Logger } from './logger.js';
import { PERPLEXITY_API_URL, getPerplexityApiKey } from './providers/perplexity.js';
import { FinalReportSchema } from './types.js';
import type { FinalReport } from './types.js';

// =============================================================================
// Response schema (subset we consume)
// =============================================================================

const SonarSearchResultSchema = z.object({
  title: z.string().default(''),
  url: z.string(),
  date: z.string().nullable().optional(),
});

const SonarDeepResearchResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().default(''),
      }),
    }),
  ).min(1),
  search_results: z.array(SonarSearchResultSchema).default([]),
  citations: z.array(z.string()).default([]),
  usage: z.object({
    prompt_tokens: z.number().default(0),
    completion_tokens: z.number().default(0),
    // Perplexity bills search + reasoning on deep-research runs.
    citation_tokens: z.number().default(0),
    reasoning_tokens: z.number().default(0),
    num_search_queries: z.number().default(0),
  }).optional(),
});

// =============================================================================
// Cost estimate — sonar-deep-research pricing ($2/M in, $8/M out, $5/1k searches)
// =============================================================================

function estimateCostUsd(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  citation_tokens: number;
  reasoning_tokens: number;
  num_search_queries: number;
} | undefined): number {
  if (usage === undefined) return 0;
  const inputUsd = (usage.prompt_tokens + usage.citation_tokens) * (2 / 1_000_000);
  const outputUsd = (usage.completion_tokens + usage.reasoning_tokens) * (8 / 1_000_000);
  const searchUsd = usage.num_search_queries * (5 / 1000);
  return inputUsd + outputUsd + searchUsd;
}

// =============================================================================
// Public API
// =============================================================================

export interface RunManagedResearchInput {
  /** The research brief / question. */
  brief: string;
  /** Perplexity reasoning effort — maps to cost/depth. Default 'medium'. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Request timeout — deep-research runs take minutes. Default 10 min. */
  timeoutMs?: number;
  logger?: Logger;
}

export interface RunManagedResearchResult {
  report: FinalReport;
  costUsd: number;
}

/**
 * Run a managed deep-research query via Perplexity `sonar-deep-research`
 * and normalize the answer into the shared FinalReport contract.
 */
export async function runManagedResearch(
  input: RunManagedResearchInput,
): Promise<RunManagedResearchResult> {
  const log: Logger = safeLogger(input.logger);
  const apiKey = getPerplexityApiKey();
  const timeoutMs = input.timeoutMs !== undefined ? input.timeoutMs : 600_000;

  log.info(
    { brief: input.brief.slice(0, 80), effort: input.reasoningEffort },
    '[runManagedResearch] Dispatching sonar-deep-research',
  );

  const response = await fetch(PERPLEXITY_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar-deep-research',
      messages: [{ role: 'user', content: input.brief }],
      reasoning_effort: input.reasoningEffort !== undefined ? input.reasoningEffort : 'medium',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Perplexity deep-research error: ${response.status} ${errorBody.slice(0, 300)}`);
  }

  const rawJson: unknown = await response.json();
  const parsed = SonarDeepResearchResponseSchema.parse(rawJson);

  const content = parsed.choices[0].message.content;
  if (content.trim().length === 0) {
    throw new Error('Perplexity deep-research returned empty content');
  }

  // Strip <think> reasoning blocks some deep-research responses lead with.
  const markdown = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Bibliography from structured search_results, else bare citations.
  const bibliography = parsed.search_results.length > 0
    ? parsed.search_results.map((r, i) => ({
        citation_anchor: `[^${i + 1}]`,
        source_url: r.url,
        title: r.title,
        author: '',
        provider: 'perplexity' as const,
        published_at: r.date !== null && r.date !== undefined && r.date !== '' ? r.date : undefined,
      }))
    : parsed.citations.map((url, i) => ({
        citation_anchor: `[^${i + 1}]`,
        source_url: url,
        title: '',
        author: '',
        provider: 'perplexity' as const,
      }));

  // Title: first markdown heading, else first line.
  const headingMatch = markdown.match(/^#+\s+(.+)$/m);
  const firstLine = markdown.split('\n').find((l) => l.trim().length > 0);
  const title = headingMatch !== null && headingMatch[1] !== undefined
    ? headingMatch[1].trim()
    : firstLine !== undefined
      ? firstLine.replace(/^#+\s*/, '').trim().slice(0, 200)
      : 'Research report';

  // Executive summary: first non-heading paragraph.
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith('#'));
  const executiveSummary = paragraphs[0] !== undefined ? paragraphs[0].slice(0, 2000) : title;

  const wordCount = markdown.split(/\s+/).filter((w) => w.length > 0).length;

  const report = FinalReportSchema.parse({
    title,
    executive_summary: executiveSummary,
    full_markdown: markdown,
    sections: [],
    bibliography,
    gaps: [],
    word_count: wordCount,
  });

  const costUsd = estimateCostUsd(parsed.usage);
  log.info(
    { words: wordCount, sources: bibliography.length, costUsd },
    '[runManagedResearch] Complete',
  );

  return { report, costUsd };
}
