/**
 * Offline validation for model-extracted evidence.
 *
 * Extraction output is untrusted. A model-authored claim must never become
 * grounding evidence merely because it shares vocabulary with fetched text.
 * This module therefore uses a deliberately fail-closed contract:
 *
 * - quotes must equal one complete fetched sentence, or a run of up to four
 *   adjacent complete sentences inside one line;
 * - key claims must meet the same test and contain at least four tokens.
 *
 * Markdown presentation syntax (links, emphasis, bullets, headings) is
 * removed from both sides first; words are never changed.
 *
 * Semantic paraphrases remain unverified until a real entailment boundary is
 * introduced. Lower recall is preferable to circularly certifying a model's
 * own wording.
 */

/**
 * The evidence contract itself, re-exported here so `./evidence` is the ONE
 * light subpath carrying both halves: the type an item must conform to, and
 * the two checks that say whether its text is really in its source.
 *
 * Type-only, so nothing is added to this subpath's runtime bundle — the point
 * of the subpath is that `@braintied/intros` and `@braintied/onboarding-core`
 * can hold the contract without importing the engine. A consumer needing the
 * runtime Zod schema imports `EvidenceItemSchema` from the package root.
 */
export type { EvidenceItem, EvidenceSourceClass, EvidenceVisibility } from './evidence.js';

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

/**
 * Remove Markdown presentation syntax without touching a single word.
 *
 * Fetched pages arrive as crawler Markdown (`**bold**`, `[anchor](url)`,
 * `* ` bullets, `# ` headings), while an extractor quotes the text a reader
 * sees. Comparing the two raw rejected 54 of 68 genuine prose lines across
 * five real pages (2026-09-26), which left most web runs with zero evidence.
 * Both sides pass through this, so the contract is unchanged: the quote must
 * still equal one complete source sentence or line, word for word.
 */
function stripMarkdownPresentation(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line
      .replace(/!\[[^\]\n]*\]\([^)\n]*\)/gu, '')
      .replace(/\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/gu, '$1')
      .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/gu, '$2')
      .replace(/(^|[^\p{L}\p{N}*_])([*_])(?=\S)([^\n*_]*?\S)\2(?![\p{L}\p{N}])/gu, '$1$3')
      .replace(/~~(?=\S)([^\n]*?\S)~~/gu, '$1')
      .replace(/`([^`\n]+)`/gu, '$1')
      .replace(/^\s*(?:>\s*)+/u, '')
      .replace(/^\s*#{1,6}\s+/u, '')
      .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/u, ''))
    .join('\n');
}

function evidenceTokens(text: string): string[] {
  return normalizeUnicodePresentation(text)
    .toLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+(?:[./:-][\p{L}\p{M}\p{N}]+)*(?:%)?/gu) ?? [];
}

function normalizeExactText(text: string): string {
  return normalizeUnicodePresentation(stripMarkdownPresentation(text))
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .trim()
    .replace(/\.$/u, '');
}

/** Longest run of adjacent complete sentences one quote may span. */
const MAX_SENTENCES_PER_QUOTE = 4;

/**
 * Every complete sentence, plus every run of up to four adjacent complete
 * sentences inside one line. A multi-sentence line used to be unmatchable
 * even whole, although the contract has always said "sentence or line", and
 * extractors routinely quote two or three sentences together. A span never
 * crosses a line break and never starts or ends mid-sentence.
 */
function sourceEvidenceUnits(sourceContent: string): string[] {
  const units: string[] = [];
  const lines = normalizeUnicodePresentation(stripMarkdownPresentation(sourceContent))
    .split(/(?:\r?\n)+/u);
  for (const line of lines) {
    const sentences = line
      .split(/(?<=[.!?\u3002\uFF01\uFF1F])\s+/u)
      .filter((sentence) => sentence.trim().length > 0);
    for (let start = 0; start < sentences.length; start++) {
      const end = Math.min(sentences.length, start + MAX_SENTENCES_PER_QUOTE);
      for (let stop = start + 1; stop <= end; stop++) {
        const unit = normalizeExactText(sentences.slice(start, stop).join(' '));
        if (unit.length > 0) units.push(unit);
      }
    }
  }
  return units;
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
