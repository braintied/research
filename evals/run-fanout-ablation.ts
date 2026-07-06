/**
 * Fan-out ablation — the ROADMAP Phase 2 question: does the default 15–35
 * subquery band over-spend? Runs the SAME brief at several subquery bands and
 * reports marginal grounding / citations / domains gained per extra dollar.
 *
 * Usage:
 *   npx tsx evals/run-fanout-ablation.ts [--brief <id>] [--bands 4x8,8x16,15x35] [--no-cache]
 *
 * Default brief: tech-01-crawlers (cheap, well-sourced). Default bands span
 * from very-narrow to the current default so the marginal curve is visible.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { runDeepResearch, getEnabledProviders } from '../src/index.js';
import type { PipelineUsageEvent } from '../src/index.js';
import { GOLDEN_BRIEFS } from './golden-briefs.js';
import { computeReportMetrics } from './metrics.js';
import type { ReportMetrics } from './metrics.js';
import { FileCache } from './file-cache.js';

const OUT_DIR = new URL('./results/', import.meta.url).pathname;
const CACHE_PATH = new URL('./.source-cache.json', import.meta.url).pathname;

interface Band { min: number; max: number; label: string; }

function parseBands(raw: string | null): Band[] {
  if (raw === null) {
    return [
      { min: 4, max: 8, label: '4x8' },
      { min: 8, max: 16, label: '8x16' },
      { min: 15, max: 35, label: '15x35' },
    ];
  }
  const bands: Band[] = [];
  for (const token of raw.split(',')) {
    const parts = token.trim().toLowerCase().split('x');
    if (parts.length !== 2) {
      throw new Error(`band "${token}" must be "MINxMAX" e.g. 8x16`);
    }
    const min = Number.parseInt(parts[0], 10);
    const max = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
      throw new Error(`band "${token}" invalid (need 0 < min <= max)`);
    }
    bands.push({ min, max, label: `${min}x${max}` });
  }
  return bands;
}

interface BandResult {
  band: string;
  min: number;
  max: number;
  ok: boolean;
  error: string | null;
  latencyMs: number;
  costUsd: number;
  metrics: ReportMetrics | null;
}

function round(v: number, p: number): number { const f = Math.pow(10, p); return Math.round(v * f) / f; }

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let briefId = 'tech-01-crawlers';
  let bandsRaw: string | null = null;
  let useCache = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--brief') { i++; briefId = argv[i]; }
    else if (argv[i] === '--bands') { i++; bandsRaw = argv[i]; }
    else if (argv[i] === '--no-cache') { useCache = false; }
  }

  const brief = GOLDEN_BRIEFS.find((b) => b.id === briefId);
  if (brief === undefined) {
    console.error(`[ablation] Unknown brief id "${briefId}". Known: ${GOLDEN_BRIEFS.map((b) => b.id).join(', ')}`);
    process.exit(1);
  }
  const bands = parseBands(bandsRaw);

  console.log('[ablation] Enabled providers:', Object.keys(getEnabledProviders()).join(', '));
  console.log(`[ablation] Brief: ${brief.id} — sweeping bands ${bands.map((b) => b.label).join(', ')}`);

  const startAllMs = Date.now();
  const cache = useCache ? new FileCache(CACHE_PATH, startAllMs) : undefined;
  const results: BandResult[] = [];

  for (const band of bands) {
    console.log(`[ablation] → band ${band.label}`);
    const startMs = Date.now();
    const stageCosts: Record<string, number> = {};
    const onUsage = (e: PipelineUsageEvent): void => {
      stageCosts[e.category] = round((stageCosts[e.category] !== undefined ? stageCosts[e.category] : 0) + e.costUsd, 6);
    };
    try {
      const research = await runDeepResearch({
        brief: brief.brief,
        depth: 'standard',
        subqueryBandOverride: { min: band.min, max: band.max },
        onUsage,
        cache,
      });
      const metrics = computeReportMetrics(research.report, research.grounding);
      results.push({
        band: band.label, min: band.min, max: band.max, ok: true, error: null,
        latencyMs: Date.now() - startMs, costUsd: round(research.costUsd, 4), metrics,
      });
      console.log(`[ablation]   ${metrics.wordCount}w, ${metrics.bibliographyCount}src, ${metrics.inlineAnchorCount} anchors, ${metrics.distinctSourceDomains} domains, ground ${metrics.groundingRatio}, $${research.costUsd.toFixed(3)}, ${Math.round((Date.now() - startMs) / 1000)}s`);
    } catch (err: unknown) {
      results.push({
        band: band.label, min: band.min, max: band.max, ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startMs, costUsd: 0, metrics: null,
      });
      console.log(`[ablation]   FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (cache !== undefined) { cache.flush(); }

  // Marginal analysis vs the previous (smaller) band.
  const lines: string[] = [];
  const nowIso = new Date(startAllMs).toISOString();
  lines.push('# Fan-out ablation');
  lines.push('');
  lines.push(`Generated: ${nowIso}`);
  lines.push(`Brief: \`${brief.id}\` — ${brief.brief}`);
  lines.push('');
  lines.push('| band | words | bib | anchors | domains | dispersion | ground | $ | s | Δbib/$ | Δdomains/$ |');
  lines.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  let prev: BandResult | null = null;
  for (const r of results) {
    if (r.ok && r.metrics !== null) {
      const m = r.metrics;
      let dBibPerUsd = '—';
      let dDomPerUsd = '—';
      if (prev !== null && prev.ok && prev.metrics !== null) {
        const dCost = r.costUsd - prev.costUsd;
        if (dCost > 0.0001) {
          dBibPerUsd = round((m.bibliographyCount - prev.metrics.bibliographyCount) / dCost, 1).toString();
          dDomPerUsd = round((m.distinctSourceDomains - prev.metrics.distinctSourceDomains) / dCost, 1).toString();
        }
      }
      const ground = m.groundingRatio !== null ? m.groundingRatio.toFixed(2) : '—';
      lines.push(`| ${r.band} | ${m.wordCount} | ${m.bibliographyCount} | ${m.inlineAnchorCount} | ${m.distinctSourceDomains} | ${m.sectionSourceDispersion} | ${ground} | ${r.costUsd.toFixed(3)} | ${Math.round(r.latencyMs / 1000)} | ${dBibPerUsd} | ${dDomPerUsd} |`);
      prev = r;
    } else {
      lines.push(`| ${r.band} | FAIL | — | — | — | — | — | — | ${Math.round(r.latencyMs / 1000)} | — | — |`);
    }
  }
  lines.push('');
  lines.push('_Δbib/$ and Δdomains/$ = marginal new sources / domains per extra dollar vs the previous (smaller) band. A collapsing marginal = the wider band is over-spend._');
  lines.push('');
  const md = lines.join('\n');

  if (!existsSync(OUT_DIR)) { mkdirSync(OUT_DIR, { recursive: true }); }
  const base = `ablation-${nowIso.slice(0, 10)}-${brief.id}`;
  writeFileSync(`${OUT_DIR}${base}.json`, JSON.stringify({ generatedAt: nowIso, brief: brief.id, results }, null, 2), 'utf8');
  writeFileSync(`${OUT_DIR}${base}.md`, md, 'utf8');

  console.log(`\n[ablation] Wrote ${OUT_DIR}${base}.{json,md}`);
  console.log('\n' + md);
}

main().catch((err) => {
  console.error('[ablation] FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
