/**
 * Baseline sweep — run the golden corpus through the engine and record
 * deterministic metrics + per-stage cost + latency to JSON and a markdown
 * table. This is the Phase-2 measurement layer: no improvement in Phase 3+
 * ships without moving a number here.
 *
 * Usage:
 *   npx tsx evals/run-baseline.ts [options]
 *
 * Options:
 *   --kind <quick|standard|deep|social>  Force one kind for every brief
 *                                         (default: each brief's suggestedKind)
 *   --subset                              Only the CHEAP_SUBSET_IDS (~5 briefs)
 *   --domain <name>                       Only briefs in one domain
 *   --limit <n>                           Cap the number of briefs
 *   --ids <a,b,c>                         Explicit brief ids
 *   --no-cache                            Disable the on-disk source cache
 *   --label <name>                        Output filename label (default: date-less "adhoc")
 *
 * Env: same as smoke — SEARXNG_URLS/SERPER_API_KEY/TAVILY_API_KEY,
 * CRAWL4AI_URL, GEMINI_RESEARCH_KEY or GEMINI_API_KEY, VOYAGE_API_KEY,
 * ANTHROPIC_API_KEY.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { runResearch, getEnabledProviders, RESEARCH_KINDS } from '../src/index.js';
import type { PipelineUsageEvent, ResearchKind } from '../src/index.js';
import { GOLDEN_BRIEFS, CHEAP_SUBSET_IDS } from './golden-briefs.js';
import type { GoldenBrief } from './golden-briefs.js';
import { computeReportMetrics, meanOf } from './metrics.js';
import type { ReportMetrics } from './metrics.js';
import { FileCache } from './file-cache.js';

const OUT_DIR = new URL('./results/', import.meta.url).pathname;
const CACHE_PATH = new URL('./.source-cache.json', import.meta.url).pathname;

interface Args {
  kind: ResearchKind | null;
  subset: boolean;
  domain: string | null;
  limit: number | null;
  ids: string[] | null;
  useCache: boolean;
  label: string;
}

function narrowKind(raw: string): ResearchKind {
  for (const k of RESEARCH_KINDS) {
    if (raw === k) {
      return k;
    }
  }
  throw new Error(`--kind must be one of ${RESEARCH_KINDS.join('|')}, got "${raw}"`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { kind: null, subset: false, domain: null, limit: null, ids: null, useCache: true, label: 'adhoc' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') { i++; args.kind = narrowKind(argv[i]); }
    else if (a === '--subset') { args.subset = true; }
    else if (a === '--domain') { i++; args.domain = argv[i]; }
    else if (a === '--limit') { i++; args.limit = Number.parseInt(argv[i], 10); }
    else if (a === '--ids') { i++; args.ids = argv[i].split(',').map((s) => s.trim()).filter((s) => s.length > 0); }
    else if (a === '--no-cache') { args.useCache = false; }
    else if (a === '--label') { i++; args.label = argv[i]; }
  }
  return args;
}

function selectBriefs(args: Args): GoldenBrief[] {
  let briefs = GOLDEN_BRIEFS;
  if (args.ids !== null) {
    const wanted = new Set(args.ids);
    briefs = briefs.filter((b) => wanted.has(b.id));
  } else if (args.subset) {
    const wanted = new Set(CHEAP_SUBSET_IDS);
    briefs = briefs.filter((b) => wanted.has(b.id));
  }
  if (args.domain !== null) {
    briefs = briefs.filter((b) => b.domain === args.domain);
  }
  if (args.limit !== null && args.limit > 0) {
    briefs = briefs.slice(0, args.limit);
  }
  return briefs;
}

interface StageCost {
  events: number;
  costUsd: number;
}

interface BriefResult {
  id: string;
  domain: string;
  kind: ResearchKind;
  engine: string;
  ok: boolean;
  error: string | null;
  latencyMs: number;
  costUsd: number;
  stageCosts: Record<string, StageCost>;
  metrics: ReportMetrics | null;
}

function round(value: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

async function runOne(brief: GoldenBrief, kind: ResearchKind, cache: FileCache | undefined, startMs: number): Promise<BriefResult> {
  const stageCosts: Record<string, StageCost> = {};
  const onUsage = (e: PipelineUsageEvent): void => {
    const bucket = stageCosts[e.category] !== undefined
      ? stageCosts[e.category]
      : (stageCosts[e.category] = { events: 0, costUsd: 0 });
    bucket.events++;
    bucket.costUsd = round(bucket.costUsd + e.costUsd, 6);
  };

  try {
    const research = await runResearch({ brief: brief.brief, kind, onUsage, cache });
    const latencyMs = Date.now() - startMs;
    const metrics = computeReportMetrics(research.report, research.grounding);
    return {
      id: brief.id,
      domain: brief.domain,
      kind,
      engine: research.engine,
      ok: true,
      error: null,
      latencyMs,
      costUsd: round(research.costUsd, 4),
      stageCosts,
      metrics,
    };
  } catch (err: unknown) {
    return {
      id: brief.id,
      domain: brief.domain,
      kind,
      engine: 'pipeline',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - startMs,
      costUsd: 0,
      stageCosts,
      metrics: null,
    };
  }
}

function renderMarkdown(results: BriefResult[], nowIso: string): string {
  const ok = results.filter((r) => r.ok && r.metrics !== null);
  const okMetrics = ok.map((r) => r.metrics).filter((m): m is ReportMetrics => m !== null);

  const lines: string[] = [];
  lines.push('# Deep-research baseline sweep');
  lines.push('');
  lines.push(`Generated: ${nowIso}`);
  lines.push(`Briefs: ${results.length} (${ok.length} ok, ${results.length - ok.length} failed)`);
  lines.push('');
  lines.push('## Per-brief');
  lines.push('');
  lines.push('| id | kind | eng | words | bib | anchors | dens/1k | domains | disp | uncited | ground | $ | s |');
  lines.push('|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const r of results) {
    if (r.ok && r.metrics !== null) {
      const m = r.metrics;
      const ground = m.groundingRatio !== null ? m.groundingRatio.toFixed(2) : '—';
      lines.push(`| ${r.id} | ${r.kind} | ${r.engine.slice(0, 4)} | ${m.wordCount} | ${m.bibliographyCount} | ${m.inlineAnchorCount} | ${m.citationDensityPer1k} | ${m.distinctSourceDomains} | ${m.sectionSourceDispersion} | ${m.uncitedSectionCount} | ${ground} | ${r.costUsd.toFixed(3)} | ${Math.round(r.latencyMs / 1000)} |`);
    } else {
      lines.push(`| ${r.id} | ${r.kind} | FAIL | — | — | — | — | — | — | — | — | — | ${Math.round(r.latencyMs / 1000)} | `);
    }
  }
  lines.push('');
  lines.push('## Aggregates (ok runs)');
  lines.push('');
  lines.push('| metric | mean |');
  lines.push('|---|--:|');
  lines.push(`| word_count | ${meanOf(okMetrics, (m) => m.wordCount)} |`);
  lines.push(`| bibliography_count | ${meanOf(okMetrics, (m) => m.bibliographyCount)} |`);
  lines.push(`| inline_anchors | ${meanOf(okMetrics, (m) => m.inlineAnchorCount)} |`);
  lines.push(`| citation_density_per_1k | ${meanOf(okMetrics, (m) => m.citationDensityPer1k)} |`);
  lines.push(`| distinct_source_domains | ${meanOf(okMetrics, (m) => m.distinctSourceDomains)} |`);
  lines.push(`| section_source_dispersion | ${meanOf(okMetrics, (m) => m.sectionSourceDispersion)} |`);
  lines.push(`| uncited_sections | ${meanOf(okMetrics, (m) => m.uncitedSectionCount)} |`);
  lines.push(`| grounding_ratio | ${meanOf(okMetrics, (m) => m.groundingRatio)} |`);
  const meanCost = ok.length > 0 ? round(ok.reduce((acc, r) => acc + r.costUsd, 0) / ok.length, 4) : null;
  const meanSecs = ok.length > 0 ? round(ok.reduce((acc, r) => acc + r.latencyMs, 0) / ok.length / 1000, 1) : null;
  lines.push(`| cost_usd | ${meanCost} |`);
  lines.push(`| latency_s | ${meanSecs} |`);
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const enabled = Object.keys(getEnabledProviders());
  console.log('[baseline] Enabled providers:', enabled.join(', '));

  const briefs = selectBriefs(args);
  if (briefs.length === 0) {
    console.error('[baseline] No briefs matched the selection — nothing to run.');
    process.exit(1);
  }
  console.log(`[baseline] Running ${briefs.length} brief(s)${args.kind !== null ? ` forced kind=${args.kind}` : ''}, cache=${args.useCache}`);

  const startAllMs = Date.now();
  // Single nowMs for the whole sweep keeps cache TTL math stable and avoids
  // per-call Date.now() churn (which the workflow layer forbids anyway).
  const cache = args.useCache ? new FileCache(CACHE_PATH, startAllMs) : undefined;

  const results: BriefResult[] = [];
  for (const brief of briefs) {
    const kind = args.kind !== null ? args.kind : brief.suggestedKind;
    console.log(`[baseline] → ${brief.id} (${brief.domain}, kind=${kind})`);
    const result = await runOne(brief, kind, cache, Date.now());
    if (result.ok && result.metrics !== null) {
      console.log(`[baseline]   ok: ${result.metrics.wordCount}w, ${result.metrics.bibliographyCount}src, ${result.metrics.inlineAnchorCount} anchors, ground ${result.metrics.groundingRatio}, $${result.costUsd.toFixed(3)}, ${Math.round(result.latencyMs / 1000)}s`);
    } else {
      console.log(`[baseline]   FAILED: ${result.error}`);
    }
    results.push(result);
  }

  if (cache !== undefined) {
    cache.flush();
    console.log(`[baseline] Source cache: ${cache.size} entries persisted`);
  }

  const nowIso = new Date(startAllMs).toISOString();
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }
  const stamp = nowIso.slice(0, 10);
  const base = `baseline-${stamp}-${args.label}`;
  writeFileSync(`${OUT_DIR}${base}.json`, JSON.stringify({ generatedAt: nowIso, args, results }, null, 2), 'utf8');
  const md = renderMarkdown(results, nowIso);
  writeFileSync(`${OUT_DIR}${base}.md`, md, 'utf8');

  console.log(`\n[baseline] Wrote ${OUT_DIR}${base}.{json,md}`);
  console.log(`[baseline] Total wall time: ${Math.round((Date.now() - startAllMs) / 1000)}s`);
  console.log('\n' + md);
}

main().catch((err) => {
  console.error('[baseline] FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
