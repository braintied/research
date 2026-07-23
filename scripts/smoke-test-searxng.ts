#!/usr/bin/env tsx
/**
 * Phase 1 Experiment 4 — SearXNG smoke test
 *
 * Runs N queries against the configured SEARXNG_URLS instances and reports:
 *   - Per-query success/failure
 *   - Aggregate success rate (target ≥ 70%)
 *   - Per-engine reliability (which upstream engines returned results)
 *   - P50 / P95 latency
 *
 * Usage:
 *   SEARXNG_URLS="https://searxng-a.fly.dev,https://searxng-b.fly.dev,https://searxng-c.fly.dev" \
 *   tsx --env-file=.env.local scripts/smoke-test-searxng.ts [<query-count>]
 *
 * Default query count: 100. Plan target for go/no-go: 1,000 queries / 24h.
 *
 * The query corpus mixes realistic Sentigen-style probes (M&A diligence,
 * market sizing, deep-dive topics) with random benign queries to model
 * the real production workload.
 *
 * Plan: ~/.claude/plans/we-were-building-in-imperative-eich.md
 * (Phase 1 Experiment 4)
 */

import { searxngSearch } from '../src/providers/searxng.js';

const QUERY_CORPUS = [
  // M&A / diligence-style
  'Stripe M&A history acquisitions',
  'OpenAI Series H valuation 2026',
  'Anthropic latest funding round',
  'CoreWeave revenue 2025',
  'Databricks IPO timeline',
  'Anduril latest valuation',
  'Anthropic competitive positioning vs OpenAI',
  'Snowflake quarterly earnings 2025 Q4',

  // Market sizing
  'global vector database market size 2026',
  'B2B AI agent platform TAM',
  'enterprise observability market growth',
  'AI inference cost trends 2025-2026',

  // Deep-dive topical
  'DeepSeek V4 architecture details',
  'Anthropic prompt caching cost economics',
  'Gemini 2.5 Flash benchmark scores',
  'open source deep research frameworks',
  'STORM perspective driven research method',
  'multi-agent research system Anthropic',
  'TR-DRA paper findings depth optimal',
  'citation faithfulness LLM benchmarks',

  // Competitive
  'Perplexity Sonar pricing tiers',
  'Tavily search API rate limits',
  'Exa neural search comparison',
  'Brave Search API independent index',

  // General benign
  'how does prompt caching work',
  'react server components 2026',
  'next.js 16 turbopack production',
  'postgres jsonb indexing strategies',
  'kubernetes vs nomad small team',
  'ledger nano s vs trezor',
];

interface QueryOutcome {
  query: string;
  success: boolean;
  triedUrls: string[];
  resultCount: number;
  latencyMs: number;
  enginesReturned: string[];
  error: string | undefined;
}

async function runOne(query: string): Promise<QueryOutcome> {
  const started = Date.now();
  try {
    const outcome = await searxngSearch(query, { limit: 10 });
    const latencyMs = Date.now() - started;
    const engines = new Set<string>();
    for (const r of outcome.results) {
      if (r.engine !== undefined && r.engine !== '') engines.add(r.engine);
    }
    return {
      query,
      success: outcome.success,
      triedUrls: outcome.triedUrls,
      resultCount: outcome.results.length,
      latencyMs,
      enginesReturned: Array.from(engines),
      error: outcome.error,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    return {
      query,
      success: false,
      triedUrls: [],
      resultCount: 0,
      latencyMs,
      enginesReturned: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function pct(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[idx];
}

async function main(): Promise<void> {
  const queryCountArg = process.argv[2];
  const targetCount = queryCountArg !== undefined ? Number.parseInt(queryCountArg, 10) : 100;
  if (Number.isFinite(targetCount) === false || targetCount <= 0) {
    console.error('Usage: smoke-test-searxng.ts [<query-count>]');
    process.exit(1);
  }

  if (process.env.SEARXNG_URLS === undefined || process.env.SEARXNG_URLS === '') {
    console.error('SEARXNG_URLS not set. Example:');
    console.error('  export SEARXNG_URLS="https://searxng-a.fly.dev,https://searxng-b.fly.dev"');
    process.exit(1);
  }

  console.log(`SearXNG smoke test — ${targetCount} queries`);
  console.log(`  Instances: ${process.env.SEARXNG_URLS}`);

  const outcomes: QueryOutcome[] = [];
  for (let i = 0; i < targetCount; i++) {
    const query = QUERY_CORPUS[i % QUERY_CORPUS.length];
    const outcome = await runOne(query);
    outcomes.push(outcome);
    if ((i + 1) % 25 === 0 || i + 1 === targetCount) {
      const ok = outcomes.filter((o) => o.success).length;
      console.log(`  [${i + 1}/${targetCount}] success=${ok} fail=${i + 1 - ok}`);
    }
  }

  // Aggregate
  const total = outcomes.length;
  const success = outcomes.filter((o) => o.success).length;
  const fail = total - success;
  const empty = outcomes.filter((o) => o.success === true && o.resultCount === 0).length;

  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  const engineCounts = new Map<string, number>();
  for (const o of outcomes) {
    for (const e of o.enginesReturned) {
      const prior = engineCounts.get(e);
      engineCounts.set(e, prior !== undefined ? prior + 1 : 1);
    }
  }
  const sortedEngines = Array.from(engineCounts.entries()).sort((a, b) => b[1] - a[1]);

  const errorCounts = new Map<string, number>();
  for (const o of outcomes) {
    if (o.success === false && o.error !== undefined) {
      const key = o.error.length > 60 ? `${o.error.slice(0, 60)}…` : o.error;
      const prior = errorCounts.get(key);
      errorCounts.set(key, prior !== undefined ? prior + 1 : 1);
    }
  }
  const sortedErrors = Array.from(errorCounts.entries()).sort((a, b) => b[1] - a[1]);

  console.log('\n──────────── Aggregate ────────────');
  console.log(`  Total queries:        ${total}`);
  console.log(`  Successful:           ${success} (${pct(success, total)})`);
  console.log(`  Failed:               ${fail} (${pct(fail, total)})`);
  console.log(`  Success but 0 results: ${empty} (${pct(empty, total)})`);
  console.log(`  Latency P50:          ${p50}ms`);
  console.log(`  Latency P95:          ${p95}ms`);

  const passThreshold = 0.7;
  const passed = success / total >= passThreshold;
  console.log(`  Phase 1 gate (≥70%):  ${passed === true ? 'PASS' : 'FAIL'}`);

  if (sortedEngines.length > 0) {
    console.log('\n──────────── Engines that returned results ────────────');
    for (const [engine, count] of sortedEngines.slice(0, 15)) {
      console.log(`  ${engine.padEnd(30)} ${count}`);
    }
  }

  if (sortedErrors.length > 0) {
    console.log('\n──────────── Top errors ────────────');
    for (const [err, count] of sortedErrors.slice(0, 8)) {
      console.log(`  ${count.toString().padStart(4)} × ${err}`);
    }
  }

  process.exit(passed === true ? 0 : 1);
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(2);
});
