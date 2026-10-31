import { canonicalizeUrl } from './types.js';

/**
 * Fair-share extract-budget allocation.
 *
 * The extract budget (depth-tunable, e.g. 20 pages at standard) used to be
 * consumed as a FIFO prefix of the candidate list, which preserves subquery
 * order — so the first few subqueries ate the entire run budget and every
 * later section extracted zero pages. Measured 2026-08-15: standard runs on
 * multi-question briefs emitted evidence gaps for every section after the
 * first ~5 subqueries, purely from this starvation.
 *
 * This allocator round-robins the budget across section groups instead:
 * every section with candidates is guaranteed floor(budget / sectionCount)
 * pages before any section receives extras. Total selected never exceeds the
 * budget; relative candidate order is preserved both within a section and in
 * the returned list. Pure and deterministic.
 */
export function allocateExtractBudgetFairShare<T>(
  candidates: readonly T[],
  sectionKeyOf: (candidate: T) => string,
  budget: number,
): T[] {
  if (budget <= 0 || candidates.length === 0) {
    return [];
  }
  if (candidates.length <= budget) {
    return [...candidates];
  }

  // Group candidate indices by section, groups in first-appearance order.
  const groups = new Map<string, number[]>();
  for (let i = 0; i < candidates.length; i += 1) {
    const key = sectionKeyOf(candidates[i]);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [i]);
    } else {
      existing.push(i);
    }
  }

  // Round-robin: one candidate per group per round until the budget is spent.
  const selected: number[] = [];
  const queues = [...groups.values()];
  let took = true;
  while (selected.length < budget && took) {
    took = false;
    for (const queue of queues) {
      if (selected.length >= budget) {
        break;
      }
      const next = queue.shift();
      if (next !== undefined) {
        selected.push(next);
        took = true;
      }
    }
  }

  selected.sort((a, b) => a - b);
  return selected.map((i) => candidates[i]);
}

/** Validated evidence one section holds so far. */
export interface SectionEvidence {
  /** Validated quotes plus validated claims. */
  units: number;
  /** Distinct source documents those units came from. */
  sources: number;
}

/** What "enough" means for one section at a depth. */
export interface SectionEvidenceTarget {
  units: number;
  sources: number;
}

/**
 * Count a section's evidence. Sources are distinct DOCUMENTS: quotes keep
 * same-page anchors (`#comment-<id>`, `#t=93`) while claims carry the bare
 * page, so counting raw URLs let one Reddit thread or one video satisfy a
 * two-source target by itself.
 */
export function sectionEvidenceFrom(entries: readonly { source_url: string }[]): SectionEvidence {
  const documents = new Set<string>();
  for (const entry of entries) documents.add(canonicalizeUrl(entry.source_url));
  return { units: entries.length, sources: documents.size };
}

export function sectionNeedsEvidence(
  evidence: SectionEvidence | undefined,
  target: SectionEvidenceTarget,
): boolean {
  if (evidence === undefined) return true;
  return evidence.units < target.units || evidence.sources < target.sources;
}

/**
 * Pick the next extraction wave from per-section candidate queues.
 *
 * A fixed page count per section is a guess: one section is answered by a
 * single primary page, another needs six forum threads before anything
 * survives validation. So extraction runs in waves, and only sections still
 * below target get more pages, thinnest first, so when the budget runs out
 * it was spent where the report was emptiest.
 *
 * One page can serve several sections, so it sits in several queues. `taken`
 * holds the keys already picked this run; a taken page met again in another
 * queue is dropped, never extracted twice. Mutates `queues` and `taken`.
 * Deterministic: ties on evidence break by first-appearance order.
 */
export function takeAdaptiveExtractWave<T>(
  queues: Map<string, T[]>,
  evidence: ReadonlyMap<string, SectionEvidence>,
  target: SectionEvidenceTarget,
  perSection: number,
  budget: number,
  keyOf: (item: T) => string,
  taken: Set<string>,
): T[] {
  if (budget <= 0 || perSection <= 0) return [];
  const nextUntaken = (queue: T[]): T | undefined => {
    while (queue.length > 0 && taken.has(keyOf(queue[0]))) queue.shift();
    return queue.shift();
  };
  const hasUntaken = (queue: T[]): boolean => queue.some((item) => !taken.has(keyOf(item)));
  const order = [...queues.keys()].map((section, index) => ({ section, index }));
  const needy = order
    .filter(({ section }) => {
      const queue = queues.get(section);
      return queue !== undefined && hasUntaken(queue) && sectionNeedsEvidence(evidence.get(section), target);
    })
    .sort((a, b) => {
      const ea = evidence.get(a.section);
      const eb = evidence.get(b.section);
      const ua = ea === undefined ? 0 : ea.units;
      const ub = eb === undefined ? 0 : eb.units;
      return ua !== ub ? ua - ub : a.index - b.index;
    })
    .map(({ section }) => section);

  const picked: T[] = [];
  for (let round = 0; round < perSection && picked.length < budget; round += 1) {
    let took = false;
    for (const section of needy) {
      if (picked.length >= budget) break;
      const queue = queues.get(section);
      const next = queue === undefined ? undefined : nextUntaken(queue);
      if (next !== undefined) {
        taken.add(keyOf(next));
        picked.push(next);
        took = true;
      }
    }
    if (!took) break;
  }
  return picked;
}

export interface AdaptiveExtractionInput<T> {
  candidates: readonly T[];
  /** Identity of a page; a page is extracted at most once. */
  keyOf: (item: T) => string;
  /** Every section whose evidence this page feeds. Empty means none. */
  sectionsOf: (item: T) => readonly string[];
  /** Evidence per section right now, including earlier passes. */
  evidence: () => ReadonlyMap<string, SectionEvidence>;
  target: SectionEvidenceTarget;
  firstWavePagesPerSection: number;
  concurrency: number;
  /** Pages this pass may read. */
  pageBudget: number;
  /** Extraction spend so far (extraction only, not synthesis or critique). */
  extractSpentUsd: () => number;
  /** Extraction may not exceed this, counting calls already in flight. */
  extractCeilingUsd: number;
  /** Close estimate of one page's extraction cost, reserved before dispatch. */
  estimateUsd: (item: T) => number;
  /**
   * Would the run's whole dollar cap be passed if `reservedUsd` more were spent?
   * The driver passes the estimates of calls still in flight (plus the next
   * call's), so parallel calls near the cap cannot all slip under it.
   */
  hardCapReached: (reservedUsd: number) => boolean;
  extract: (item: T) => Promise<void>;
}

export interface AdaptiveExtractionResult {
  extracted: number;
  waves: number;
  /** Unread pages a short section could still have used, left for the page budget. */
  skippedForBudget: number;
  /** Unread pages a short section could still have used, left for the dollar ceiling. */
  skippedForCost: number;
  /** Unread pages whose every section already met its target. */
  notNeeded: number;
}

/**
 * Extract in waves until every section has enough evidence, its candidates
 * run out, the page budget is spent, or extraction reaches its dollar
 * ceiling.
 *
 * The first wave gives each section `firstWavePagesPerSection` pages. Later
 * waves give each short section enough pages to keep `concurrency` busy, so a
 * single short section does not crawl one page at a time.
 *
 * Dollars are reserved before dispatch: a page starts only if extraction
 * spend, plus the estimates of pages still in flight, plus its own estimate,
 * stays under the ceiling. Parallel calls therefore cannot jointly overshoot
 * it on costs that are only recorded when they finish.
 */
export async function runAdaptiveExtraction<T>(input: AdaptiveExtractionInput<T>): Promise<AdaptiveExtractionResult> {
  const queues = new Map<string, T[]>();
  for (const item of input.candidates) {
    for (const section of input.sectionsOf(item)) {
      const queue = queues.get(section);
      if (queue === undefined) queues.set(section, [item]);
      else if (!queue.includes(item)) queue.push(item);
    }
  }

  const taken = new Set<string>();
  let remaining = input.pageBudget;
  let inFlightUsd = 0;
  let extracted = 0;
  let waves = 0;
  let stoppedForCost = false;

  for (;;) {
    if (input.hardCapReached(inFlightUsd)) {
      stoppedForCost = true;
      break;
    }
    const evidence = input.evidence();
    let needy = 0;
    for (const [section, queue] of queues.entries()) {
      if (sectionNeedsEvidence(evidence.get(section), input.target)
        && queue.some((item) => !taken.has(input.keyOf(item)))) {
        needy += 1;
      }
    }
    if (needy === 0) break;
    const perSection = waves === 0
      ? input.firstWavePagesPerSection
      : Math.max(1, Math.ceil(input.concurrency / needy));
    const wave = takeAdaptiveExtractWave(
      queues, evidence, input.target, perSection, Math.max(0, remaining), input.keyOf, taken,
    );
    if (wave.length === 0) break;
    waves += 1;
    remaining -= wave.length;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < wave.length) {
        const item = wave[cursor];
        cursor += 1;
        const estimate = input.estimateUsd(item);
        if (input.extractSpentUsd() + inFlightUsd + estimate > input.extractCeilingUsd || input.hardCapReached(inFlightUsd + estimate)) {
          // Not read: give the page back to the budget and to the leftover count.
          stoppedForCost = true;
          taken.delete(input.keyOf(item));
          remaining += 1;
          continue;
        }
        inFlightUsd += estimate;
        try {
          await input.extract(item);
          extracted += 1;
        } finally {
          inFlightUsd -= estimate;
        }
      }
    };
    const workers = Math.max(1, Math.min(input.concurrency, wave.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (stoppedForCost) break;
  }

  const finalEvidence = input.evidence();
  let skippedForBudget = 0;
  let skippedForCost = 0;
  let notNeeded = 0;
  const counted = new Set<string>();
  for (const item of input.candidates) {
    const key = input.keyOf(item);
    if (taken.has(key) || counted.has(key)) continue;
    counted.add(key);
    const sections = input.sectionsOf(item);
    const needed = sections.some((section) => sectionNeedsEvidence(finalEvidence.get(section), input.target));
    if (!needed) notNeeded += 1;
    else if (stoppedForCost) skippedForCost += 1;
    else skippedForBudget += 1;
  }
  return { extracted, waves, skippedForBudget, skippedForCost, notNeeded };
}
