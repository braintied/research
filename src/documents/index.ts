/**
 * Document layer — generateDocument({ docType, ... }).
 *
 * Turns a research result (or runs one via the kinds layer) into a typed,
 * Zod-validated structured document plus a deterministic markdown rendering.
 *
 * Consumers that track AI spend (e.g. Sentigen's admin_ai_usage_log) pass
 * `onUsage` — it fires once per LLM call with real token counts. Model choice
 * is a plain string routed by prefix (claude-, gemini-, deepseek-, qwen),
 * same dispatcher the synthesis stage uses.
 */

import { z } from 'zod';
import { synthesisGenerate } from '../synthesis.js';
import { runResearch } from '../kinds.js';
import type { KindResearchResult, ResearchKind } from '../kinds.js';
import { logger as defaultLogger } from '../logger.js';
import type { Logger } from '../logger.js';
import { deepResearchSynthesisCostUsd } from '../depth-config.js';
import type { FinalReport } from '../types.js';
import { DOC_TYPES, type DocType, type DocTypeDefinition } from './types.js';
import { prdDefinition, PrdSchema } from './prd.js';
import { marketReportDefinition, MarketReportSchema } from './market-report.js';
import { techSpecDefinition, TechSpecSchema } from './tech-spec.js';
import { clientBriefDefinition, ClientBriefSchema } from './client-brief.js';
import { contentBriefDefinition, ContentBriefSchema } from './content-brief.js';
import { estimateResearchDefinition, EstimateResearchSchema } from './estimate-research.js';

// =============================================================================
// Registry
// =============================================================================

export const DOC_TYPE_REGISTRY: Record<DocType, DocTypeDefinition> = {
  'prd': prdDefinition,
  'market-report': marketReportDefinition,
  'tech-spec': techSpecDefinition,
  'client-brief': clientBriefDefinition,
  'content-brief': contentBriefDefinition,
  'estimate-research': estimateResearchDefinition,
};

/** Narrow an arbitrary string to a valid DocType. Returns null when unknown. */
export function coerceDocType(input: string | null | undefined): DocType | null {
  for (const docType of DOC_TYPES) {
    if (input === docType) return docType;
  }
  return null;
}

// =============================================================================
// Usage callback — attribution hook for consumers with cost tracking
// =============================================================================

export interface DocUsageEvent {
  model: string;
  operation: string;                 // e.g. 'doc-prd'
  inputTokens: number;
  cachedReadTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type OnUsage = (event: DocUsageEvent) => void | Promise<void>;

// =============================================================================
// generateDocument
// =============================================================================

const DEFAULT_DOC_MODEL = 'claude-sonnet-4-6';
const DOC_MAX_TOKENS = 8192;
const MAX_PARSE_RETRIES = 1;

export interface GenerateDocumentInput {
  docType: DocType;
  /** What the document is about. Required even when `research` is supplied. */
  brief: string;
  /**
   * Pre-run research (from runResearch/runDeepResearch/runManagedResearch).
   * When omitted, generateDocument runs research itself at the doc type's
   * default kind (override via `researchKind`).
   */
  research?: { report: FinalReport; costUsd?: number };
  /** Research kind override when generateDocument runs research itself. */
  researchKind?: ResearchKind;
  /** Caller context woven into the prompt (client name, codebase, region…). */
  context?: string;
  /** Doc-synthesis model — prefix-routed. Default claude-sonnet-4-6. */
  model?: string;
  /** Fires once per LLM call with real token counts, for spend attribution. */
  onUsage?: OnUsage;
  logger?: Logger;
}

export interface GenerateDocumentResult<T = unknown> {
  docType: DocType;
  /** Zod-validated structured document. */
  data: T;
  /** Deterministic markdown rendering of `data`. */
  markdown: string;
  /** The research result the document was grounded in (when run here). */
  research: KindResearchResult | null;
  /** Doc-synthesis LLM cost (excludes research cost). */
  docCostUsd: number;
  /** Research + doc synthesis. */
  totalCostUsd: number;
}

/** Doc type → validated data shape, for the typed public signature. */
export interface DocTypeDataMap {
  'prd': z.infer<typeof PrdSchema>;
  'market-report': z.infer<typeof MarketReportSchema>;
  'tech-spec': z.infer<typeof TechSpecSchema>;
  'client-brief': z.infer<typeof ClientBriefSchema>;
  'content-brief': z.infer<typeof ContentBriefSchema>;
  'estimate-research': z.infer<typeof EstimateResearchSchema>;
}

export async function generateDocument<T extends DocType>(
  input: GenerateDocumentInput & { docType: T },
): Promise<GenerateDocumentResult<DocTypeDataMap[T]>>;
export async function generateDocument(
  input: GenerateDocumentInput,
): Promise<GenerateDocumentResult> {
  const log: Logger = input.logger !== undefined ? input.logger : defaultLogger;
  const definition = DOC_TYPE_REGISTRY[input.docType];
  const model = input.model !== undefined ? input.model : DEFAULT_DOC_MODEL;

  // ---------------------------------------------------------------------------
  // 1. Research — reuse supplied evidence or run at the doc type's default kind
  // ---------------------------------------------------------------------------
  let report: FinalReport;
  let researchResult: KindResearchResult | null = null;
  let researchCostUsd = 0;

  if (input.research !== undefined) {
    report = input.research.report;
    researchCostUsd = input.research.costUsd !== undefined ? input.research.costUsd : 0;
  } else {
    const kind: ResearchKind = input.researchKind !== undefined
      ? input.researchKind
      : definition.researchKindDefault;
    log.info({ docType: input.docType, kind }, '[generateDocument] Running research');
    researchResult = await runResearch({
      brief: input.brief,
      kind,
      logger: log,
    });
    report = researchResult.report;
    researchCostUsd = researchResult.costUsd;
  }

  // ---------------------------------------------------------------------------
  // 2. Doc synthesis — prompt from the registry, validated by its schema
  // ---------------------------------------------------------------------------
  const bibliography = report.bibliography
    .map((b) => `${b.citation_anchor} ${b.title.length > 0 ? b.title : b.source_url} — ${b.source_url}`)
    .join('\n');

  const userPrompt = definition.buildUserPrompt({
    brief: input.brief,
    researchMarkdown: report.full_markdown,
    bibliography,
    context: input.context,
  });

  let docCostUsd = 0;
  let data: unknown = null;
  let lastError = '';

  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
    const retrySuffix = attempt > 0
      ? `\n\nYour previous output failed validation: ${lastError.slice(0, 500)}. Return corrected JSON only.`
      : '';

    const result = await synthesisGenerate({
      system: definition.systemPrompt,
      user: userPrompt + retrySuffix,
      model,
      maxTokens: DOC_MAX_TOKENS,
    });

    const callCostUsd = deepResearchSynthesisCostUsd(
      model,
      result.inputTokens,
      result.outputTokens,
      result.cachedReadTokens,
    );
    docCostUsd += callCostUsd;

    if (input.onUsage !== undefined) {
      await input.onUsage({
        model,
        operation: `doc-${input.docType}`,
        inputTokens: result.inputTokens,
        cachedReadTokens: result.cachedReadTokens,
        outputTokens: result.outputTokens,
        costUsd: callCostUsd,
      });
    }

    try {
      const raw: unknown = JSON.parse(extractJson(result.text));
      data = definition.schema.parse(raw);
      break;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(
        { docType: input.docType, attempt, error: lastError.slice(0, 200) },
        '[generateDocument] Output failed validation',
      );
      if (attempt >= MAX_PARSE_RETRIES) {
        throw new Error(
          `Document synthesis failed validation after ${MAX_PARSE_RETRIES + 1} attempts: ${lastError.slice(0, 300)}`,
        );
      }
    }
  }

  const markdown = renderDocumentMarkdown(input.docType, data);

  log.info(
    { docType: input.docType, docCostUsd, researchCostUsd },
    '[generateDocument] Complete',
  );

  return {
    docType: input.docType,
    data,
    markdown,
    research: researchResult,
    docCostUsd,
    totalCostUsd: docCostUsd + researchCostUsd,
  };
}

// =============================================================================
// JSON extraction (mirrors planner.ts)
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
// Deterministic markdown rendering
// =============================================================================

function humanize(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderValue(value: unknown, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];

  if (value === null || value === undefined) {
    return lines;
  }
  if (typeof value === 'string') {
    if (value.length > 0) lines.push(`${indent}${value}`);
    return lines;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    lines.push(`${indent}${String(value)}`);
    return lines;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === null || item === undefined) continue;
      if (isRecord(item)) {
        const entries = Object.entries(item).filter(([, v]) => v !== null && v !== undefined && v !== '');
        if (entries.length === 0) continue;
        const firstEntry = entries[0];
        const rest = entries.slice(1);
        lines.push(`${indent}- **${String(firstEntry[1])}**`);
        for (const [k, v] of rest) {
          if (Array.isArray(v)) {
            if (v.length > 0) {
              lines.push(`${indent}  - ${humanize(k)}: ${v.map((x) => String(x)).join('; ')}`);
            }
          } else {
            lines.push(`${indent}  - ${humanize(k)}: ${String(v)}`);
          }
        }
      } else {
        lines.push(`${indent}- ${String(item)}`);
      }
    }
    return lines;
  }
  // Plain object
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === '') continue;
      lines.push(`${indent}- ${humanize(k)}: ${String(v)}`);
    }
  }
  return lines;
}

/**
 * Render a validated document object as markdown: `title` becomes the H1,
 * every other populated field becomes an H2 section rendered by shape.
 * Deterministic — same data always renders the same markdown.
 */
export function renderDocumentMarkdown(docType: DocType, data: unknown): string {
  if (!isRecord(data)) {
    throw new Error(`renderDocumentMarkdown expects a validated document object for ${docType}`);
  }
  const record = data;
  const lines: string[] = [];

  const title = record['title'];
  lines.push(`# ${typeof title === 'string' && title.length > 0 ? title : humanize(docType)}`);
  lines.push('');

  for (const [key, value] of Object.entries(record)) {
    if (key === 'title') continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;

    lines.push(`## ${humanize(key)}`);
    lines.push('');
    lines.push(...renderValue(value, 0));
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// =============================================================================
// Re-exports — schemas + inferred types per doc type
// =============================================================================

export { DOC_TYPES } from './types.js';
export type { DocType, DocTypeDefinition, DocPromptInput } from './types.js';
export { PrdSchema, prdDefinition } from './prd.js';
export type { Prd } from './prd.js';
export { MarketReportSchema, marketReportDefinition } from './market-report.js';
export type { MarketReport } from './market-report.js';
export { TechSpecSchema, techSpecDefinition } from './tech-spec.js';
export type { TechSpec } from './tech-spec.js';
export { ClientBriefSchema, clientBriefDefinition } from './client-brief.js';
export type { ClientBrief } from './client-brief.js';
export { ContentBriefSchema, contentBriefDefinition } from './content-brief.js';
export type { ContentBrief } from './content-brief.js';
export { EstimateResearchSchema, estimateResearchDefinition } from './estimate-research.js';
export type { EstimateResearch } from './estimate-research.js';

// Typed convenience wrappers — the generic overload narrows `data`.
export async function generatePrd(
  input: Omit<GenerateDocumentInput, 'docType'>,
): Promise<GenerateDocumentResult<DocTypeDataMap['prd']>> {
  return generateDocument({ ...input, docType: 'prd' });
}

export async function generateMarketReport(
  input: Omit<GenerateDocumentInput, 'docType'>,
): Promise<GenerateDocumentResult<DocTypeDataMap['market-report']>> {
  return generateDocument({ ...input, docType: 'market-report' });
}

export async function generateTechSpec(
  input: Omit<GenerateDocumentInput, 'docType'>,
): Promise<GenerateDocumentResult<DocTypeDataMap['tech-spec']>> {
  return generateDocument({ ...input, docType: 'tech-spec' });
}

export async function generateClientBrief(
  input: Omit<GenerateDocumentInput, 'docType'>,
): Promise<GenerateDocumentResult<DocTypeDataMap['client-brief']>> {
  return generateDocument({ ...input, docType: 'client-brief' });
}

export async function generateContentBrief(
  input: Omit<GenerateDocumentInput, 'docType'>,
): Promise<GenerateDocumentResult<DocTypeDataMap['content-brief']>> {
  return generateDocument({ ...input, docType: 'content-brief' });
}

export async function generateEstimateResearch(
  input: Omit<GenerateDocumentInput, 'docType'>,
): Promise<GenerateDocumentResult<DocTypeDataMap['estimate-research']>> {
  return generateDocument({ ...input, docType: 'estimate-research' });
}
