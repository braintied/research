import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEPTH_CONFIG,
  EXTRACT_SPEND_SHARE,
  getDepthConfig,
  refinementExtractReserve,
  refinementRounds,
} from '../src/depth-config.js';
import {
  runAdaptiveExtraction,
  sectionEvidenceFrom,
  sectionNeedsEvidence,
  takeAdaptiveExtractWave,
} from '../src/extract-budget.js';
import type { SectionEvidence } from '../src/extract-budget.js';
import {
  EXTRACTION_MODEL,
  extractionModelId,
  resolveGeminiRequestModel,
} from '../src/pipeline-core.js';

test('every depth defines extract page + concurrency caps', () => {
  for (const depth of ['quick', 'blog', 'standard', 'wide'] as const) {
    const cfg = getDepthConfig(depth);
    assert.ok(cfg.maxExtractPages > 0, `${depth} maxExtractPages`);
    assert.ok(cfg.extractConcurrency > 0, `${depth} extractConcurrency`);
    assert.ok(cfg.extractConcurrency <= 8, `${depth} concurrency stays bounded`);
  }
});

test('extract page ceilings stay far below the Aug 2026 unbounded class', () => {
  // Pre-fix CUMULATIVE_URL_CEILING was 400 and extract ran every URL with
  // concurrency 8 and no run budget; critique multiplied that. One brief
  // minted ~7k extract ledger rows (Aug 2026 GCP incident class).
  // Since 2026-10-27 maxExtractPages is a ceiling: evidence targets and
  // EXTRACT_SPEND_SHARE decide how many pages a run actually reads.
  assert.ok(DEPTH_CONFIG.quick.maxExtractPages <= 16);
  assert.ok(DEPTH_CONFIG.standard.maxExtractPages <= 100);
  // Wide stays above the web-design-intelligence@2 public coverage floors (~41).
  assert.ok(DEPTH_CONFIG.wide.maxExtractPages >= 48);
  assert.ok(DEPTH_CONFIG.wide.maxExtractPages <= 200);
  assert.ok(DEPTH_CONFIG.standard.hardCapUsd <= 3.5);
  assert.ok(EXTRACT_SPEND_SHARE > 0 && EXTRACT_SPEND_SHARE < 1, 'synthesis keeps part of the cap');
  // Cost program bound: at most ONE refinement round at standard. The raw
  // knob counts critique calls, so one round is critiqueMaxPasses === 2.
  assert.equal(refinementRounds(DEPTH_CONFIG.standard), 1);
});

test('critiqueMaxPasses counts critique calls; the last pass never refines', () => {
  assert.equal(refinementRounds({ critiqueMaxPasses: 0 }), 0);
  // The 2026-08-01 trap: 1 pass reads like "one round" and is zero.
  assert.equal(refinementRounds({ critiqueMaxPasses: 1 }), 0);
  assert.equal(refinementRounds({ critiqueMaxPasses: 2 }), 1);
  assert.equal(refinementRounds({ critiqueMaxPasses: 3 }), 2);
});

test('every depth with a critique loop can actually refine', () => {
  // A depth that pays for a critique but can never act on it is the
  // 2026-09-24 regression: gaps found, labelled "after refinement", never refilled.
  for (const depth of ['blog', 'standard', 'wide'] as const) {
    assert.ok(refinementRounds(DEPTH_CONFIG[depth]) >= 1, `${depth} refines at least once`);
  }
  assert.equal(refinementRounds(DEPTH_CONFIG.quick), 0);
});

test('refinement extract reserve holds pages back only when a round can use them', () => {
  assert.equal(refinementExtractReserve(DEPTH_CONFIG.quick), 0);
  assert.equal(refinementExtractReserve({ critiqueMaxPasses: 1, maxExtractPages: 20 }), 0);

  const standard = refinementExtractReserve(DEPTH_CONFIG.standard);
  assert.ok(standard > 0, 'standard reserves pages for refinement');
  // The main pass keeps at least half the budget.
  assert.ok(DEPTH_CONFIG.standard.maxExtractPages - standard >= DEPTH_CONFIG.standard.maxExtractPages / 2);
  assert.equal(standard, 29);

  // Tiny budgets never hand the whole budget to refinement.
  assert.equal(refinementExtractReserve({ critiqueMaxPasses: 2, maxExtractPages: 1 }), 0);
  assert.equal(refinementExtractReserve({ critiqueMaxPasses: 2, maxExtractPages: 3 }), 1);
});

test('every depth defines an evidence target the first wave cannot trivially meet', () => {
  for (const depth of ['quick', 'blog', 'standard', 'wide'] as const) {
    const cfg = DEPTH_CONFIG[depth];
    assert.ok(cfg.firstWavePagesPerSection >= 1, `${depth} first wave reads something`);
    assert.ok(cfg.evidenceTargetUnits >= 1, `${depth} units target`);
    assert.ok(cfg.evidenceTargetSources >= 1, `${depth} sources target`);
  }
  assert.ok(DEPTH_CONFIG.standard.evidenceTargetUnits > DEPTH_CONFIG.quick.evidenceTargetUnits);
  assert.ok(DEPTH_CONFIG.wide.evidenceTargetSources >= DEPTH_CONFIG.standard.evidenceTargetSources);
});

test('a section stops taking pages once it has enough units from enough sources', () => {
  const target = { units: 6, sources: 2 };
  assert.equal(sectionNeedsEvidence(undefined, target), true);
  assert.equal(sectionNeedsEvidence({ units: 12, sources: 1 }, target), true, 'one source is not enough');
  assert.equal(sectionNeedsEvidence({ units: 5, sources: 3 }, target), true);
  assert.equal(sectionNeedsEvidence({ units: 6, sources: 2 }, target), false);
});

test('adaptive waves feed the thinnest sections and skip full ones', () => {
  const queues = new Map<string, string[]>([
    ['full', ['f1', 'f2', 'f3']],
    ['thin', ['t1', 't2', 't3']],
    ['empty', ['e1', 'e2', 'e3']],
  ]);
  const evidence = new Map([
    ['full', { units: 9, sources: 3 }],
    ['thin', { units: 2, sources: 1 }],
  ]);
  const target = { units: 6, sources: 2 };
  const taken = new Set<string>();
  const key = (item: string): string => item;
  // Thinnest first: empty (0 units) before thin (2); full gets nothing.
  assert.deepEqual(takeAdaptiveExtractWave(queues, evidence, target, 1, 10, key, taken), ['e1', 't1']);
  assert.deepEqual(queues.get('full'), ['f1', 'f2', 'f3']);
  // Two pages each, budget caps the wave.
  assert.deepEqual(takeAdaptiveExtractWave(queues, evidence, target, 2, 3, key, taken), ['e2', 't2', 'e3']);
  const done = new Map([['thin', { units: 6, sources: 2 }], ['empty', { units: 7, sources: 2 }], ['full', { units: 9, sources: 3 }]]);
  assert.deepEqual(takeAdaptiveExtractWave(queues, done, target, 1, 10, key, taken), []);
  assert.deepEqual(takeAdaptiveExtractWave(queues, evidence, target, 1, 0, key, taken), []);
});

test('a page in two queues is taken once', () => {
  const queues = new Map<string, string[]>([['A', ['shared', 'a2']], ['B', ['shared', 'b2']]]);
  const taken = new Set<string>();
  const wave = takeAdaptiveExtractWave(queues, new Map(), { units: 6, sources: 2 }, 1, 10, (x) => x, taken);
  assert.deepEqual(wave, ['shared', 'b2']);
});

test('sources are counted by document, not by anchor', () => {
  const thread = 'https://www.reddit.com/r/india/comments/abc/hampi_tips/';
  const evidence = sectionEvidenceFrom([
    { source_url: `${thread}#comment-1` },
    { source_url: `${thread}#comment-2` },
    { source_url: thread },
    { source_url: 'https://www.youtube.com/watch?v=x#t=93' },
    { source_url: 'https://www.youtube.com/watch?v=x' },
  ]);
  assert.deepEqual(evidence, { units: 5, sources: 2 });
});

interface Page { url: string; sections: string[]; units: number; costUsd: number }

/** A stub extraction run: each page adds its units to its sections and records its cost on completion. */
function stubRun(pages: Page[], opts: {
  prior?: Map<string, SectionEvidence>;
  ceilingUsd?: number;
  pageBudget?: number;
  firstWave?: number;
  concurrency?: number;
  hardCap?: (reservedUsd: number, spentUsd: number) => boolean;
}) {
  const evidence = new Map<string, { units: number; docs: Set<string> }>();
  let spent = 0;
  const read: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const run = runAdaptiveExtraction<Page>({
    candidates: pages,
    keyOf: (page) => page.url,
    sectionsOf: (page) => page.sections,
    evidence: () => {
      const out = new Map<string, SectionEvidence>();
      for (const [section, prior] of opts.prior ?? new Map<string, SectionEvidence>()) out.set(section, prior);
      for (const [section, e] of evidence) {
        const before = out.get(section);
        out.set(section, {
          units: e.units + (before === undefined ? 0 : before.units),
          sources: e.docs.size + (before === undefined ? 0 : before.sources),
        });
      }
      return out;
    },
    target: { units: 4, sources: 2 },
    firstWavePagesPerSection: opts.firstWave ?? 1,
    concurrency: opts.concurrency ?? 3,
    pageBudget: opts.pageBudget ?? 100,
    extractSpentUsd: () => spent,
    extractCeilingUsd: opts.ceilingUsd ?? 100,
    estimateUsd: (page) => page.costUsd,
    hardCapReached: (reserved) => (opts.hardCap ? opts.hardCap(reserved, spent) : false),
    extract: async (page) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      read.push(page.url);
      for (const section of page.sections) {
        const e = evidence.get(section) ?? { units: 0, docs: new Set<string>() };
        e.units += page.units;
        if (page.units > 0) e.docs.add(page.url);
        evidence.set(section, e);
      }
      spent += page.costUsd;
      inFlight -= 1;
    },
  });
  return { run, read, maxInFlight: () => maxInFlight };
}

const page = (url: string, sections: string[], units = 2, costUsd = 0.001): Page => ({ url, sections, units, costUsd });

test('extraction keeps reading only for sections still short, and stops when all are covered', async () => {
  const pages = [
    page('a1', ['A']), page('a2', ['A']), page('a3', ['A']), page('a4', ['A']),
    page('b1', ['B'], 0), page('b2', ['B'], 0), page('b3', ['B']), page('b4', ['B']),
  ];
  const { run, read } = stubRun(pages, {});
  const outcome = await run;
  // A is covered by a1+a2 (4 units, 2 docs); B's first two pages yield nothing, so it reads on.
  assert.ok(read.includes('b3') && read.includes('b4'), 'the short section keeps drawing');
  assert.ok(!read.includes('a4'), 'a covered section stops');
  assert.equal(outcome.notNeeded, pages.length - read.length);
  assert.equal(outcome.skippedForBudget + outcome.skippedForCost, 0);
});

test('a page another section has finished with is still read for the section that needs it', async () => {
  // url3 is B's only page and also A's third; A is full after url1+url2.
  const pages = [page('url1', ['A']), page('url2', ['A']), page('url3', ['A', 'B'])];
  const { run, read } = stubRun(pages, { firstWave: 1 });
  await run;
  assert.ok(read.includes('url3'));
  assert.equal(read.filter((url) => url === 'url3').length, 1, 'read once');
});

test('a section already full from an earlier pass takes no pages in refinement', async () => {
  const pages = [page('r1', ['A']), page('r2', ['A']), page('r3', ['B'])];
  const prior = new Map<string, SectionEvidence>([['A', { units: 8, sources: 3 }]]);
  const { run, read } = stubRun(pages, { prior });
  const outcome = await run;
  assert.deepEqual(read, ['r3']);
  assert.equal(outcome.notNeeded, 2);
});

test('parallel calls cannot jointly overshoot the extraction dollar ceiling', async () => {
  // Costs land only when a call finishes. Without reserving in-flight
  // estimates, all three in the first wave would start below the ceiling.
  const pages = Array.from({ length: 9 }, (_, i) => page(`p${i}`, [`S${i}`], 0, 0.01));
  const { run, read } = stubRun(pages, { ceilingUsd: 0.025, concurrency: 3 });
  const outcome = await run;
  assert.equal(read.length, 2, 'two reservations fit under 0.025, a third does not');
  assert.equal(outcome.skippedForCost, 7);
  assert.equal(outcome.skippedForBudget, 0);
});

test('the run hard cap stops extraction even under the extraction ceiling', async () => {
  const pages = [page('h1', ['A'], 0), page('h2', ['A'], 0), page('h3', ['A'], 0)];
  let calls = 0;
  const { run, read } = stubRun(pages, { hardCap: () => { calls += 1; return calls > 2; } });
  const outcome = await run;
  assert.ok(read.length < 3);
  assert.ok(outcome.skippedForCost >= 1);
});

test('parallel calls near the run cap cannot all slip under it', async () => {
  // Earlier stages left $0.025 of a $1 cap. Each page costs $0.01 and costs land
  // only when a call finishes, so without counting in-flight reservations all
  // three first-wave calls would pass a plain "is the cap spent" check.
  const pages = Array.from({ length: 6 }, (_, i) => page(`n${i}`, [`S${i}`], 0, 0.01));
  const earlier = 0.975;
  const { run, read } = stubRun(pages, { concurrency: 3, hardCap: (reserved, spent) => earlier + spent + reserved > 1 });
  const outcome = await run;
  assert.equal(read.length, 2, 'two $0.01 reservations fit in $0.025, a third does not');
  assert.equal(outcome.skippedForCost, 4);
});

test('the page budget bounds a section that never fills', async () => {
  const pages = Array.from({ length: 10 }, (_, i) => page(`z${i}`, ['A'], 0));
  const { run, read } = stubRun(pages, { pageBudget: 4 });
  const outcome = await run;
  assert.equal(read.length, 4);
  assert.equal(outcome.skippedForBudget, 6);
});

test('one short section keeps concurrency busy instead of crawling one page per wave', async () => {
  const pages = Array.from({ length: 9 }, (_, i) => page(`c${i}`, ['A'], 0));
  const { run, maxInFlight } = stubRun(pages, { concurrency: 3, firstWave: 1 });
  const outcome = await run;
  assert.ok(maxInFlight() >= 3, 'later waves fill the worker pool');
  assert.ok(outcome.waves <= 4, `waves ${outcome.waves}`);
});

test('quick is cheaper than standard on extract pages and hard cap', () => {
  assert.ok(DEPTH_CONFIG.quick.maxExtractPages < DEPTH_CONFIG.standard.maxExtractPages);
  assert.ok(DEPTH_CONFIG.quick.hardCapUsd < DEPTH_CONFIG.standard.hardCapUsd);
  assert.equal(DEPTH_CONFIG.quick.critiqueMaxPasses, 0);
});

test('EXTRACTION_MODEL is not a banned preview id', () => {
  assert.equal(EXTRACTION_MODEL.includes('preview'), false);
  assert.equal(extractionModelId().includes('preview'), false);
  // Research stages are provider-neutral (`research-extract` carries no
  // `providers` filter), so the live pick is whatever the fleet profile
  // resolves — DeepSeek Flash under the default, not always a Gemini id.
  // Running it back through the Gemini preview-rewrite gate must be a no-op:
  // it is not itself a banned preview id needing rewrite.
  assert.equal(resolveGeminiRequestModel(extractionModelId()), extractionModelId());
});

test('resolveGeminiRequestModel rewrites the July tax id', () => {
  assert.equal(
    resolveGeminiRequestModel('gemini-3.1-flash-lite-preview'),
    'gemini-3.5-flash-lite',
  );
});

test('resolveGeminiRequestModel leaves image previews alone', () => {
  assert.equal(
    resolveGeminiRequestModel('gemini-3-pro-image-preview'),
    'gemini-3-pro-image-preview',
  );
});
