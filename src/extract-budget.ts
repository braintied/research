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
