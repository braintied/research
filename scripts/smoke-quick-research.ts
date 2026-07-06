/**
 * Live smoke test — quick research + document generation.
 *
 * Runs the cheapest end-to-end path: runResearch(kind: 'quick') then
 * generateDocument(docType: 'prd') reusing the research. Expected total
 * cost well under $1. Requires env: TAVILY_API_KEY (or SEARXNG_URLS),
 * CRAWL4AI_URL, GEMINI_RESEARCH_KEY or GEMINI_API_KEY, VOYAGE_API_KEY,
 * ANTHROPIC_API_KEY.
 *
 * Usage: npx tsx scripts/smoke-quick-research.ts
 */

import { runResearch, generateDocument, getEnabledProviders } from '../src/index.js';

async function main(): Promise<void> {
  const enabled = Object.keys(getEnabledProviders());
  console.log('[smoke] Enabled providers:', enabled.join(', '));

  const started = Date.now();
  const usageByCategory: Record<string, { events: number; costUsd: number }> = {};
  const research = await runResearch({
    brief: 'What are the leading open-source web crawling tools for LLM/RAG pipelines in 2026, and how do Crawl4AI and Firecrawl compare on cost and capability?',
    kind: 'quick',
    onUsage: (e) => {
      const bucket = usageByCategory[e.category] !== undefined
        ? usageByCategory[e.category]
        : (usageByCategory[e.category] = { events: 0, costUsd: 0 });
      bucket.events++;
      bucket.costUsd += e.costUsd;
    },
  });
  console.log('[smoke] Pipeline usage by category:',
    Object.fromEntries(Object.entries(usageByCategory).map(([k, v]) => [k, `${v.events}ev $${v.costUsd.toFixed(4)}`])));

  console.log('[smoke] Grounding verdict returned to caller (F2a):', research.grounding === null ? 'NULL' : {
    status: research.grounding.status,
    ratio: Number(research.grounding.ratio.toFixed(2)),
    valid: research.grounding.valid_citations,
    total: research.grounding.total_citations,
  });
  // F1 dispersion check: sections should NOT share identical source sets.
  const sectionSources = research.report.sections.map((s) => ({
    path: s.section_path,
    sources: [...new Set(s.inline_citations.map((ic) => ic.source_url))].sort(),
  }));
  const uniqueSets = new Set(sectionSources.map((x) => JSON.stringify(x.sources)));
  console.log('[smoke] F1 evidence dispersion:', {
    sections: sectionSources.length,
    distinctSourceSets: uniqueSets.size,
    perSection: sectionSources.map((x) => `${x.path}:${x.sources.length}src`).join(' '),
  });

  console.log('[smoke] Research complete', {
    engine: research.engine,
    words: research.report.word_count,
    sources: research.report.bibliography.length,
    quotes: research.quotes.length,
    costUsd: research.costUsd.toFixed(4),
    seconds: Math.round((Date.now() - started) / 1000),
  });

  if (research.report.full_markdown.length < 200) {
    throw new Error('Research produced <200 chars of markdown — smoke FAILED');
  }

  const doc = await generateDocument({
    docType: 'prd',
    brief: 'Add a self-hosted web-crawling fallback tier to our research pipeline so scraping keeps working when the primary crawler is down',
    research: { report: research.report, costUsd: research.costUsd },
    onUsage: (u) => {
      console.log('[smoke] onUsage fired', {
        model: u.model,
        operation: u.operation,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        costUsd: u.costUsd.toFixed(4),
      });
    },
  });

  console.log('[smoke] Document complete', {
    docType: doc.docType,
    title: (doc.data as { title: string }).title,
    tasks: (doc.data as { tasks: unknown[] }).tasks.length,
    acceptanceCriteria: (doc.data as { acceptance_criteria: unknown[] }).acceptance_criteria.length,
    markdownChars: doc.markdown.length,
    docCostUsd: doc.docCostUsd.toFixed(4),
    totalCostUsd: doc.totalCostUsd.toFixed(4),
  });

  console.log('\n===== DOCUMENT MARKDOWN (first 2000 chars) =====\n');
  console.log(doc.markdown.slice(0, 2000));
  console.log('\n[smoke] PASS');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
