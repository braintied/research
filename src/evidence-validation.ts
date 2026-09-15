/**
 * Offline validation for model-extracted evidence.
 *
 * Extraction output is untrusted. A model-authored claim must never become
 * grounding evidence merely because it shares vocabulary with fetched text.
 * This module therefore uses a deliberately fail-closed contract:
 *
 * - quotes must equal one complete fetched sentence/line;
 * - key claims must equal a complete fetched sentence/line and contain at
 *   least four tokens.
 *
 * Semantic paraphrases remain unverified until a real entailment boundary is
 * introduced. Lower recall is preferable to circularly certifying a model's
 * own wording.
 */

const MIN_KEY_CLAIM_TOKENS = 4;

/** Normalize presentation-only differences without changing words. */
function normalizeUnicodePresentation(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/gu, '"')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, '-')
    .replace(/[\p{Zs}\t\f\v]+/gu, ' ');
}

function evidenceTokens(text: string): string[] {
  return normalizeUnicodePresentation(text)
    .toLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+(?:[./:-][\p{L}\p{M}\p{N}]+)*(?:%)?/gu) ?? [];
}

function normalizeExactText(text: string): string {
  return normalizeUnicodePresentation(text)
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .trim()
    .replace(/\.$/u, '');
}

function sourceEvidenceUnits(sourceContent: string): string[] {
  return normalizeUnicodePresentation(sourceContent)
    .split(/(?:\r?\n)+|(?<=[.!?\u3002\uFF01\uFF1F])\s+/u)
    .map(normalizeExactText)
    .filter((unit) => unit.length > 0);
}

/**
 * True only when the quote equals one complete fetched sentence or line.
 *
 * Public through the `./evidence` subpath since 1.9.0. A second consumer
 * (`@braintied/intros`, checking a model's cited evidence against an approved
 * profile field) needs exactly this contract, and the alternative to exporting
 * it was a copy - which is how a complete-sentence check silently becomes a
 * substring check.
 */
export function isVerbatimQuoteSupportedBySource(
  quote: string,
  sourceContent: string,
): boolean {
  const normalizedQuote = normalizeExactText(quote);
  if (normalizedQuote.length === 0) return false;
  return sourceEvidenceUnits(sourceContent).includes(normalizedQuote);
}

/**
 * True only for a material claim equal to one complete fetched sentence or
 * line after conservative presentation normalization, carrying at least four
 * tokens.
 *
 * Public through the `./evidence` subpath since 1.9.0. See the note on
 * `isVerbatimQuoteSupportedBySource`.
 */
export function isKeyClaimSupportedBySource(
  claim: string,
  sourceContent: string,
): boolean {
  const normalizedClaim = normalizeExactText(claim);
  if (evidenceTokens(claim).length < MIN_KEY_CLAIM_TOKENS) return false;
  return sourceEvidenceUnits(sourceContent).includes(normalizedClaim);
}
