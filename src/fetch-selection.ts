import type { SearchResult, Subquery } from './types.js';

/**
 * The results a subquery is answerable from: the first `limit` results that
 * were retrieved for its section, with the legacy provider heuristic for
 * callers composing untagged results. `extractQuotes` buckets evidence by
 * exactly this set, so the fetch phase must fetch exactly this set.
 */
export function resultsForSubquery(
  subquery: Subquery,
  results: SearchResult[],
  limit: number,
): SearchResult[] {
  const picked: SearchResult[] = [];
  for (const result of results) {
    if (result.retrieved_for.includes(subquery.section_path)) {
      picked.push(result);
      if (picked.length >= limit) return picked;
    }
  }
  if (picked.length === 0) {
    for (const result of results) {
      if (result.retrieved_for.length === 0 && subquery.providers.includes(result.provider)) {
        picked.push(result);
        if (picked.length >= limit) return picked;
      }
    }
  }
  return picked;
}

/**
 * Pages to fetch for a run: each subquery's own top results, in subquery
 * order, deduplicated and capped.
 *
 * This used to be `allResults.slice(0, subqueries * urlsPerSubquery)` over
 * the merged list, which is ordered by the first subqueries' results. A
 * section's eight hits filled the window, so later sections' pages were never
 * fetched and those sections were reported as "no source-validated evidence"
 * (measured 2026-09-30: sections B.1 to C.2 had three URLs each, every one
 * with zero fetched content, while their best pages were never requested).
 */
export function selectUrlsToFetch(
  subqueries: Subquery[],
  results: SearchResult[],
  urlsPerSubquery: number,
  ceiling: number,
): SearchResult[] {
  const selected: SearchResult[] = [];
  const seen = new Set<string>();
  for (const subquery of subqueries) {
    for (const result of resultsForSubquery(subquery, results, urlsPerSubquery)) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      selected.push(result);
      if (selected.length >= ceiling) return selected;
    }
  }
  return selected;
}
