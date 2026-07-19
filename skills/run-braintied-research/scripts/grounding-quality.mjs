export const GROUNDING_PASS_THRESHOLD = 0.6;
export const GROUNDING_STRONG_THRESHOLD = 0.8;

export function assessGrounding(grounding) {
  if (grounding === null || typeof grounding !== 'object') {
    return { quality: 'unavailable', passed: null, ratio: null };
  }

  const rawRatio = Number(grounding.ratio);
  const ratio = Number.isFinite(rawRatio)
    ? Math.max(0, Math.min(1, rawRatio))
    : 0;
  const totalCitations = Number.isFinite(Number(grounding.total_citations))
    ? Math.max(0, Number(grounding.total_citations))
    : 0;

  if (grounding.status === 'ungrounded' || totalCitations === 0) {
    return { quality: 'ungrounded', passed: false, ratio };
  }
  if (ratio >= GROUNDING_STRONG_THRESHOLD) {
    return { quality: 'strong', passed: true, ratio };
  }
  if (ratio >= GROUNDING_PASS_THRESHOLD) {
    return { quality: 'acceptable', passed: true, ratio };
  }
  return { quality: 'weak', passed: false, ratio };
}
