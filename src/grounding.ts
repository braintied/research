/**
 * Deep-Research Citation Grounding Validator
 *
 * For every [^N] citation marker in a final report's full_markdown, verifies
 * that the cited claim text can be substantiated by the corresponding source chunk.
 *
 * Algorithm:
 *   1. Extract all [^N] markers + surrounding ±200-char context windows ("claims")
 *   2. Look up bibliography[N-1] to resolve source_url
 *   3. Find chunks where chunk.source_url === source_url
 *   4. 3-gram match: split claim into 3-word phrases, check ≥60% appear in chunk content
 *   5. Return ratio + per-citation diagnostics
 *
 * Pure TS, no external deps.
 */

import type { FinalReport, ReportChunkInput } from './types.js';

// =============================================================================
// Public types
// =============================================================================

export interface HallucinatedCitation {
  citation_anchor: string;         // e.g. "[^3]"
  expected_substring: string;      // the surrounding claim sentence in synthesis
  matched_chunk_id: string | null; // null if anchor not in bibliography
  /** Best trigram overlap observed across the source's chunks (0–1) — tuning data. */
  best_ratio?: number;
}

export interface GroundingResult {
  ratio: number;                   // valid_citations / total_citations (0–1)
  total_citations: number;
  valid_citations: number;
  hallucinated: HallucinatedCitation[];
}

export interface ValidateGroundingInput {
  fullMarkdown: string;
  bibliography: FinalReport['bibliography'];
  chunks: ReportChunkInput[];
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Extract all [^N] citation markers from markdown text together with
 * ±200 characters of surrounding context as the "claim window".
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
    const windowStart = Math.max(0, matchStart - 200);
    const windowEnd = Math.min(markdown.length, matchStart + anchor.length + 200);
    const window = markdown.slice(windowStart, windowEnd);
    results.push({ anchor, citationNumber, window });
  }

  return results;
}

/**
 * Build 3-word phrases (trigrams) from a text string.
 * Returns an array of lower-cased trigrams.
 */
function buildTrigrams(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length < 3) {
    // Fall back to bigrams or unigrams if text is very short
    return words;
  }

  const trigrams: string[] = [];
  for (let i = 0; i <= words.length - 3; i++) {
    const w0 = words[i];
    const w1 = words[i + 1];
    const w2 = words[i + 2];
    if (w0 !== undefined && w1 !== undefined && w2 !== undefined) {
      trigrams.push(`${w0} ${w1} ${w2}`);
    }
  }
  return trigrams;
}

/**
 * Check if ≥60% of the claim trigrams appear in the chunk content.
 */
function directionalTrigramRatio(needleText: string, haystackText: string): number {
  const needleTrigrams = buildTrigrams(needleText);
  if (needleTrigrams.length === 0) {
    return 0;
  }

  const haystackLower = haystackText.toLowerCase();
  let matched = 0;
  for (const trigram of needleTrigrams) {
    if (haystackLower.includes(trigram)) {
      matched++;
    }
  }
  return matched / needleTrigrams.length;
}

/**
 * Bidirectional trigram overlap between a citation's ±200-char claim window
 * and a chunk (verbatim quote).
 *
 * Forward (window→chunk) alone was structurally near-zero: the window is
 * dominated by the model's own prose, so even a correctly-cited verbatim
 * quote drowned in paraphrase. The reverse direction (chunk→window) measures
 * the right thing for short quotes embedded in longer prose: what fraction of
 * the QUOTE's content appears near the citation. Take the max.
 */
function trigramMatchRatio(claimText: string, chunkContent: string): number {
  const forward = directionalTrigramRatio(claimText, chunkContent);
  const reverse = directionalTrigramRatio(chunkContent, claimText);
  return Math.max(forward, reverse);
}

const TRIGRAM_MATCH_THRESHOLD = 0.6;

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
    return {
      ratio: 1,
      total_citations: 0,
      valid_citations: 0,
      hallucinated: [],
    };
  }

  // Deduplicate by anchor so each [^N] is counted once
  const seenAnchors = new Set<string>();
  const uniqueWindows = citationWindows.filter((cw) => {
    if (seenAnchors.has(cw.anchor)) {
      return false;
    }
    seenAnchors.add(cw.anchor);
    return true;
  });

  const hallucinated: HallucinatedCitation[] = [];
  let validCount = 0;

  for (const cw of uniqueWindows) {
    // bibliography is 0-indexed; [^N] → bibliography[N-1]
    const bibIndex = cw.citationNumber - 1;
    const bibEntry = bibliography[bibIndex];

    if (bibEntry === undefined) {
      // Anchor not in bibliography — definite hallucination
      hallucinated.push({
        citation_anchor: cw.anchor,
        expected_substring: cw.window.slice(0, 300),
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
        citation_anchor: cw.anchor,
        expected_substring: cw.window.slice(0, 300),
        matched_chunk_id: null,
      });
      continue;
    }

    // Check if any chunk passes the trigram match threshold
    let foundMatch = false;
    let bestRatio = 0;
    for (const chunk of matchingChunks) {
      const matchRatio = trigramMatchRatio(cw.window, chunk.content);
      if (matchRatio > bestRatio) {
        bestRatio = matchRatio;
      }
      if (matchRatio >= TRIGRAM_MATCH_THRESHOLD) {
        foundMatch = true;
        break;
      }
    }

    if (foundMatch) {
      validCount++;
    } else {
      // Use the first matching chunk's source_url as the matched_chunk_id
      // (we don't have a chunk DB id here — use source_url as identifier)
      const firstChunk = matchingChunks[0];
      hallucinated.push({
        citation_anchor: cw.anchor,
        expected_substring: cw.window.slice(0, 300),
        matched_chunk_id: firstChunk !== undefined ? (firstChunk.source_url !== null ? firstChunk.source_url : null) : null,
        best_ratio: Math.round(bestRatio * 100) / 100,
      });
    }
  }

  const totalCitations = uniqueWindows.length;
  const ratio = totalCitations > 0 ? validCount / totalCitations : 1;

  return {
    ratio,
    total_citations: totalCitations,
    valid_citations: validCount,
    hallucinated,
  };
}
