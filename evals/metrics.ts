/**
 * Deterministic report metrics — the $0, reproducible baseline layer.
 *
 * Everything here is computed from a FinalReport (+ the optional grounding
 * verdict F2a now returns) with NO extra LLM calls, so a baseline sweep can
 * be re-run for free and diffed across package versions. LLM-judged quality
 * (RACE-style comprehensiveness/insight) is a separate, opt-in, paid layer.
 */

import type { FinalReport } from '../src/index.js';
import type { GroundingResult } from '../src/index.js';

/** One report's deterministic metrics. All fields derivable without a model. */
export interface ReportMetrics {
  wordCount: number;
  /** Distinct sources in the bibliography (== citation_count in the runner). */
  bibliographyCount: number;
  /** `[^N]` anchors actually present in the assembled markdown. */
  inlineAnchorCount: number;
  /** Anchors per 1,000 words — citation DENSITY, comparable across lengths. */
  citationDensityPer1k: number;
  /** Distinct registrable-ish hostnames across bibliography URLs. */
  distinctSourceDomains: number;
  /** Distinct search providers represented in the bibliography. */
  distinctProviders: number;
  sectionCount: number;
  /**
   * Fraction of sections whose cited-source SET is unique across the report
   * (1.0 = every section drew a distinct evidence set). Directly measures the
   * F1 fix: pre-fix same-provider sections shared identical sources → low.
   */
  sectionSourceDispersion: number;
  /** Sections that ended up with zero inline citations (evidence-starved). */
  uncitedSectionCount: number;
  /** Grounding ratio [0,1] if the run returned a verdict, else null. */
  groundingRatio: number | null;
  groundingStatus: GroundingResult['status'] | null;
}

const ANCHOR_RE = /\[\^\d+\]/g;

function hostnameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function round(value: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

export function computeReportMetrics(
  report: FinalReport,
  grounding: GroundingResult | null,
): ReportMetrics {
  const anchorMatches = report.full_markdown.match(ANCHOR_RE);
  const inlineAnchorCount = anchorMatches !== null ? anchorMatches.length : 0;

  const wordCount = report.word_count > 0
    ? report.word_count
    : report.full_markdown.split(/\s+/).filter((w) => w.length > 0).length;

  const domains = new Set<string>();
  const providers = new Set<string>();
  for (const entry of report.bibliography) {
    const host = hostnameOf(entry.source_url);
    if (host !== null) {
      domains.add(host);
    }
    providers.add(entry.provider);
  }

  let uncitedSectionCount = 0;
  const sourceSetKeys = new Set<string>();
  for (const section of report.sections) {
    const urls = new Set<string>();
    for (const citation of section.inline_citations) {
      urls.add(citation.source_url);
    }
    if (urls.size === 0) {
      uncitedSectionCount++;
    } else {
      sourceSetKeys.add(JSON.stringify(Array.from(urls).sort()));
    }
  }
  const citedSectionCount = report.sections.length - uncitedSectionCount;
  const sectionSourceDispersion = citedSectionCount > 0
    ? round(sourceSetKeys.size / citedSectionCount, 3)
    : 0;

  const citationDensityPer1k = wordCount > 0
    ? round((inlineAnchorCount / wordCount) * 1000, 2)
    : 0;

  return {
    wordCount,
    bibliographyCount: report.bibliography.length,
    inlineAnchorCount,
    citationDensityPer1k,
    distinctSourceDomains: domains.size,
    distinctProviders: providers.size,
    sectionCount: report.sections.length,
    sectionSourceDispersion,
    uncitedSectionCount,
    groundingRatio: grounding !== null ? round(grounding.ratio, 3) : null,
    groundingStatus: grounding !== null ? grounding.status : null,
  };
}

/** Mean of a numeric field across many metric rows (nulls excluded). */
export function meanOf(
  rows: ReportMetrics[],
  pick: (m: ReportMetrics) => number | null,
): number | null {
  const values: number[] = [];
  for (const row of rows) {
    const v = pick(row);
    if (v !== null) {
      values.push(v);
    }
  }
  if (values.length === 0) {
    return null;
  }
  const sum = values.reduce((acc, v) => acc + v, 0);
  return round(sum / values.length, 3);
}
