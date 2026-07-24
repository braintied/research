/**
 * Deep-Research Citation Grounding Validator
 *
 * For every [^N] citation marker in a final report's full_markdown, verifies
 * that the cited claim text can be substantiated by the corresponding source chunk.
 *
 * Algorithm:
 *   1. Extract all [^N] markers + the sentence containing each marker
 *   2. Look up bibliography[N-1] to resolve source_url
 *   3. Find chunks where chunk.source_url === source_url
 *   4. Accept only a material citation sentence that matches one complete
 *      punctuation-preserving evidence sentence/line
 *   5. Return ratio + per-citation diagnostics
 *
 * Pure TS, no external deps.
 */

import { resolveSameSourceCitationUrl } from './types.js';
import { isKeyClaimSupportedBySource } from './evidence-validation.js';
import type {
  FinalReport,
  ProviderName,
  ReportChunkInput,
  VerbatimQuote,
} from './types.js';

// =============================================================================
// Public types
// =============================================================================

export interface HallucinatedCitation {
  citation_anchor: string;         // e.g. "[^3]"
  expected_substring: string;      // the surrounding claim sentence in synthesis
  matched_chunk_id: string | null; // null if anchor not in bibliography
  /** Best conservative lexical score observed across the source's chunks (0–1). */
  best_ratio?: number;
}
export type GroundingQuality = 'strong' | 'acceptable' | 'weak' | 'ungrounded';

export const GROUNDING_PASS_THRESHOLD = 0.6;
export const GROUNDING_STRONG_THRESHOLD = 0.8;


export interface GroundingResult {
  ratio: number;                   // valid_citations / total_citations (0–1)
  total_citations: number;
  valid_citations: number;
  hallucinated: HallucinatedCitation[];
  /**
   * 'ungrounded' — the report contains ZERO citation markers (worst case, not
   * best: ratio is forced to 0, not 1). 'validated' — markers were checked.
   */
  status: 'validated' | 'ungrounded';
  /** Human-facing evidence quality. Unlike status, this is a pass/fail signal. */
  quality: GroundingQuality;
  /** True only when the citation match ratio reaches the published threshold. */
  passed: boolean;
}

export interface ValidateGroundingInput {
  fullMarkdown: string;
  bibliography: FinalReport['bibliography'];
  chunks: ReportChunkInput[];
}

export interface GroundingClaimEvidence {
  claim: string;
  source_url: string;
  provider: ProviderName;
}

export interface BuildGroundingEvidenceInput {
  sourceQuotesByUrl: Record<string, VerbatimQuote[]>;
  claimsBySection: Record<string, GroundingClaimEvidence[]>;
}

/**
 * Build the complete evidence pool offered to section synthesis.
 *
 * Section synthesis is explicitly allowed to cite both verbatim quotes and
 * extracted key claims. Grounding must validate against the same source-bound
 * evidence contract; checking quotes alone makes every claim-only citation
 * structurally impossible to validate. Key claims remain tied to the URL from
 * which they were extracted and are never allowed to support another source.
 */
export function buildGroundingEvidenceChunks(
  input: BuildGroundingEvidenceInput,
): ReportChunkInput[] {
  const chunks: ReportChunkInput[] = [];
  const seen = new Set<string>();

  for (const [sourceUrl, quotes] of Object.entries(input.sourceQuotesByUrl)) {
    for (const quote of quotes) {
      // Revalidate at the grounding boundary because native provider
      // extractors can also supply quote URLs. Preserve only a same-source
      // anchor so the bibliography and evidence pool share one safe identity.
      const quoteSourceUrl = resolveSameSourceCitationUrl(sourceUrl, quote.source_url);
      const key = `quote\u0000${quoteSourceUrl}\u0000${normalizeForMatch(quote.quote)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push({
        chunk_kind: 'quote',
        section_path: '',
        heading: null,
        content: quote.quote,
        source_url: quoteSourceUrl,
        source_provider: null,
        source_author: quote.author !== undefined ? quote.author : null,
        source_published_at: quote.published_at !== undefined ? quote.published_at : null,
        source_engagement: { ...quote.engagement },
        citation_anchor: null,
        metadata: { grounding_basis: 'verbatim_quote' },
      });
    }
  }

  for (const [sectionPath, claims] of Object.entries(input.claimsBySection)) {
    for (const claim of claims) {
      const normalizedClaim = normalizeForMatch(claim.claim);
      if (normalizedClaim.length === 0) continue;
      const key = `claim\u0000${claim.source_url}\u0000${normalizedClaim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push({
        chunk_kind: 'source_summary',
        section_path: sectionPath,
        heading: null,
        content: claim.claim,
        source_url: claim.source_url,
        source_provider: claim.provider,
        source_author: null,
        source_published_at: null,
        source_engagement: {},
        citation_anchor: null,
        metadata: { grounding_basis: 'extracted_key_claim' },
      });
    }
  }

  return chunks;
}

export function assessGroundingQuality(
  ratio: number,
  totalCitations: number,
): { quality: GroundingQuality; passed: boolean } {
  if (totalCitations <= 0) return { quality: 'ungrounded', passed: false };
  if (ratio >= GROUNDING_STRONG_THRESHOLD) return { quality: 'strong', passed: true };
  if (ratio >= GROUNDING_PASS_THRESHOLD) return { quality: 'acceptable', passed: true };
  return { quality: 'weak', passed: false };
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Extract all [^N] citation markers from markdown text together with the
 * sentence that contains the marker. Sentence-level isolation prevents an
 * adjacent, unrelated sentence from either diluting or falsely supporting the
 * cited claim. A bounded context window is retained only for malformed prose
 * that has no discoverable sentence boundary.
 */
function extractCitationWindows(
  markdown: string,
): Array<{ anchor: string; citationNumber: number; window: string }> {
  const results: Array<{ anchor: string; citationNumber: number; window: string }> = [];
  // Match [^N] where N is one or more digits
  const citationRegex = /\[\^(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = citationRegex.exec(markdown)) !== null) {
    const anchor = match[0];
    const citationNumber = parseInt(match[1], 10);
    const matchStart = match.index;
    const matchEnd = matchStart + anchor.length;

    // Footnote definitions are bibliography metadata, not claim citations.
    // They were harmless while only the first anchor occurrence was checked,
    // but become false failures once every use of a source is validated.
    const lineStart = markdown.lastIndexOf('\n', matchStart - 1) + 1;
    if (markdown.slice(lineStart, matchStart).trim() === '' && markdown[matchEnd] === ':') {
      continue;
    }

    const before = markdown.slice(0, matchStart);
    const boundaryRegex = /(?:[.!?]["')\]]*\s+|\n{2,})/g;
    let boundary: RegExpExecArray | null;
    let sentenceStart = Math.max(0, matchStart - 300);
    while ((boundary = boundaryRegex.exec(before)) !== null) {
      sentenceStart = boundary.index + boundary[0].length;
    }

    const after = markdown.slice(matchEnd);
    const nextBoundary = /(?:[.!?]["')\]]*(?:\s+|$)|\n{2,})/.exec(after);
    const sentenceEnd = nextBoundary !== null
      ? matchEnd + nextBoundary.index + nextBoundary[0].trimEnd().length
      : Math.min(markdown.length, matchEnd + 300);

    const window = markdown.slice(sentenceStart, sentenceEnd).trim();
    results.push({ anchor, citationNumber, window });
  }

  return results;
}

/**
 * Normalize text for stable evidence identities.
 */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[\^\d+\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceMatchRatio(claimText: string, evidenceText: string): number {
  const claimWithoutCitations = claimText.replace(/\[\^\d+\]/gu, ' ');
  const claimTokens = normalizeForMatch(claimWithoutCitations).split(' ').filter(Boolean);
  const evidenceTokens = normalizeForMatch(evidenceText).split(' ').filter(Boolean);
  if (claimTokens.length < 4 || evidenceTokens.length < 4) return 0;
  return isKeyClaimSupportedBySource(claimWithoutCitations, evidenceText) ? 1 : 0;
}

/**
 * Validate citation grounding for a fully assembled report.
 *
 * bibliography is 0-indexed in the array but [^N] markers are 1-indexed,
 * so bibliography[N-1] corresponds to [^N].
 */
export function validateGrounding(input: ValidateGroundingInput): GroundingResult {
  const { fullMarkdown, bibliography, chunks } = input;

  const citationWindows = extractCitationWindows(fullMarkdown);

  if (citationWindows.length === 0) {
    // Zero citations is the WORST outcome for a research report, not a pass —
    // an entirely uncited report must never score better than a partially
    // grounded one. (Previously returned ratio 1.)
    return {
      ratio: 0,
      total_citations: 0,
      valid_citations: 0,
      hallucinated: [],
      status: 'ungrounded',
      quality: 'ungrounded',
      passed: false,
    };
  }

  // Score unique cited sources, but require every distinct claim using that
  // source to validate. Taking only the first [^N] occurrence made the result
  // order-dependent: a supported first use could hide a later hallucination,
  // while an abstractive first use could hide a later exact citation.
  const windowsByAnchor = new Map<string, typeof citationWindows>();
  for (const citationWindow of citationWindows) {
    const existing = windowsByAnchor.get(citationWindow.anchor);
    if (existing === undefined) {
      windowsByAnchor.set(citationWindow.anchor, [citationWindow]);
      continue;
    }
    if (!existing.some((candidate) => candidate.window === citationWindow.window)) {
      existing.push(citationWindow);
    }
  }

  const hallucinated: HallucinatedCitation[] = [];
  let validCount = 0;

  for (const citationUses of windowsByAnchor.values()) {
    const firstUse = citationUses[0];
    if (firstUse === undefined) continue;

    // bibliography is 0-indexed; [^N] → bibliography[N-1]
    const bibIndex = firstUse.citationNumber - 1;
    const bibEntry = bibliography[bibIndex];

    if (bibEntry === undefined) {
      // Anchor not in bibliography — definite hallucination
      hallucinated.push({
        citation_anchor: firstUse.anchor,
        expected_substring: firstUse.window.slice(0, 300),
        matched_chunk_id: null,
      });
      continue;
    }

    const sourceUrl = bibEntry.source_url;

    // Find chunks that correspond to this source_url
    const matchingChunks = chunks.filter((chunk) => chunk.source_url === sourceUrl);

    if (matchingChunks.length === 0) {
      // Source URL exists in bibliography but no chunk was indexed for it
      hallucinated.push({
        citation_anchor: firstUse.anchor,
        expected_substring: firstUse.window.slice(0, 300),
        matched_chunk_id: null,
      });
      continue;
    }

    let everyUseMatched = true;
    for (const citationUse of citationUses) {
      let foundMatch = false;
      let bestRatio = 0;
      for (const chunk of matchingChunks) {
        const matchRatio = evidenceMatchRatio(citationUse.window, chunk.content);
        if (matchRatio > bestRatio) {
          bestRatio = matchRatio;
        }
        if (matchRatio === 1) {
          foundMatch = true;
          break;
        }
      }

      if (foundMatch) continue;

      everyUseMatched = false;
      // Use the first matching chunk's source_url as the matched_chunk_id
      // (we don't have a chunk DB id here — use source_url as identifier)
      const firstChunk = matchingChunks[0];
      hallucinated.push({
        citation_anchor: citationUse.anchor,
        expected_substring: citationUse.window.slice(0, 300),
        matched_chunk_id: firstChunk !== undefined ? (firstChunk.source_url !== null ? firstChunk.source_url : null) : null,
        best_ratio: Math.round(bestRatio * 100) / 100,
      });
    }

    if (everyUseMatched) {
      validCount++;
    }
  }

  const totalCitations = windowsByAnchor.size;
  const ratio = totalCitations > 0 ? validCount / totalCitations : 0;
  const assessment = assessGroundingQuality(ratio, totalCitations);

  return {
    ratio,
    total_citations: totalCitations,
    valid_citations: validCount,
    hallucinated,
    status: 'validated',
    ...assessment,
  };
}
