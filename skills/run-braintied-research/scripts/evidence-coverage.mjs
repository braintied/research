/**
 * How much of a report carries source-validated evidence.
 *
 * Grounding answers "are the citations that exist real?". It says nothing
 * about how many sections have any citation at all. An evidence-bound report
 * renders an empty section as an explicit gap notice, so a run can be
 * "strong, ratio 1" while most of its sections are empty. Measured
 * 2026-09-24: two standard runs graded strong had 13 of 20 sections as
 * evidence gaps; across August, 842 of 1,487 evidence-bound sections (57%).
 *
 * This reads the report the engine returned and counts. It never calls a
 * provider and never changes the report.
 */

/** Marker the engine writes into a section that had no validated evidence. */
export const EVIDENCE_GAP_MARKER = '**Evidence gap:**';

/** At or above this share of evidenced sections the report is complete. */
export const COVERAGE_COMPLETE_THRESHOLD = 0.8;
/** Below this share of evidenced sections the report is thin. */
export const COVERAGE_PASS_THRESHOLD = 0.5;

const NON_FINDING_HEADINGS = new Set(['executive summary', 'bibliography', 'sources', 'references']);

function sectionsFromMarkdown(markdown) {
  const sections = [];
  const parts = markdown.split(/^## /mu).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    if (NON_FINDING_HEADINGS.has(heading.toLowerCase())) continue;
    sections.push({ heading, body: newline === -1 ? '' : part.slice(newline + 1) });
  }
  return sections;
}

function sectionsFromReport(report) {
  if (report !== null && typeof report === 'object' && Array.isArray(report.sections)
      && report.sections.length > 0) {
    return report.sections.map((section) => ({
      heading: typeof section?.heading === 'string' ? section.heading : '',
      body: typeof section?.body_md === 'string' ? section.body_md : '',
    }));
  }
  if (report !== null && typeof report === 'object' && typeof report.full_markdown === 'string') {
    return sectionsFromMarkdown(report.full_markdown);
  }
  if (typeof report === 'string') return sectionsFromMarkdown(report);
  return [];
}

/**
 * @param {unknown} report  engine report object ({ sections, full_markdown })
 *                          or the rendered Markdown string
 * @returns {{ status: 'complete'|'partial'|'thin'|'empty', passed: boolean,
 *   sections_total: number, sections_with_evidence: number,
 *   evidence_gap_sections: number, ratio: number|null, gap_headings: string[] }}
 */
export function assessEvidenceCoverage(report) {
  const sections = sectionsFromReport(report);
  const gapHeadings = sections
    .filter((section) => section.body.includes(EVIDENCE_GAP_MARKER))
    .map((section) => section.heading);
  const total = sections.length;
  const withEvidence = total - gapHeadings.length;
  if (total === 0) {
    return {
      status: 'empty',
      passed: false,
      sections_total: 0,
      sections_with_evidence: 0,
      evidence_gap_sections: 0,
      ratio: null,
      gap_headings: [],
    };
  }
  const ratio = withEvidence / total;
  const status = ratio >= COVERAGE_COMPLETE_THRESHOLD
    ? 'complete'
    : ratio >= COVERAGE_PASS_THRESHOLD ? 'partial' : 'thin';
  return {
    status,
    passed: ratio >= COVERAGE_PASS_THRESHOLD,
    sections_total: total,
    sections_with_evidence: withEvidence,
    evidence_gap_sections: gapHeadings.length,
    ratio: Math.round(ratio * 1000) / 1000,
    gap_headings: gapHeadings,
  };
}
