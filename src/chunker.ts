/**
 * Deep-Research Chunker
 *
 * Produces ReportChunkInput[] at four granularities from a FinalReport:
 *   - exec_summary  : 1 chunk per report (the executive summary)
 *   - section       : 1+ chunks per section (split at ≤1200 chars)
 *   - quote         : 1 chunk per VerbatimQuote across all sections
 *   - source_summary: 1 chunk per unique source_url that contributed quotes
 *
 * The resulting array is consumed by embedder.ts → research_report_chunks.
 */

import { chunkText } from './pipeline-core.js';
import type { FinalReport, ReportChunkInput, VerbatimQuote } from './types.js';

// =============================================================================
// Constants
// =============================================================================

// ~1200 chars ≈ 300 tokens — fits comfortably in Voyage 4 Large 16k-token window
// while keeping chunks granular enough for retrieval.
const SECTION_CHUNK_TARGET_TOKENS = 300;

// =============================================================================
// Helpers
// =============================================================================

function emptyEngagement(): Record<string, unknown> {
  return {};
}

// =============================================================================
// Export
// =============================================================================

export interface BuildReportChunksInput {
  report: FinalReport;
  sourceQuotesByUrl: Map<string, VerbatimQuote[]>;
}

export function buildReportChunks(input: BuildReportChunksInput): ReportChunkInput[] {
  const { report, sourceQuotesByUrl } = input;
  const chunks: ReportChunkInput[] = [];

  // -------------------------------------------------------------------------
  // 1. exec_summary — one chunk for the entire executive summary
  // -------------------------------------------------------------------------
  chunks.push({
    chunk_kind: 'exec_summary',
    section_path: 'exec_summary',
    heading: 'Executive Summary',
    content: report.executive_summary,
    source_url: null,
    source_provider: null,
    source_author: null,
    source_published_at: null,
    source_engagement: emptyEngagement(),
    citation_anchor: null,
    metadata: { report_title: report.title, word_count: report.word_count },
  });

  // -------------------------------------------------------------------------
  // 2. section — one or more chunks per section body
  // -------------------------------------------------------------------------
  for (const section of report.sections) {
    const subChunks = chunkText(section.body_md, SECTION_CHUNK_TARGET_TOKENS);

    subChunks.forEach((content, idx) => {
      const isMulti = subChunks.length > 1;
      chunks.push({
        chunk_kind: 'section',
        section_path: section.section_path,
        heading: section.heading,
        content,
        source_url: null,
        source_provider: null,
        source_author: null,
        source_published_at: null,
        source_engagement: emptyEngagement(),
        citation_anchor: null,
        metadata: {
          level: section.level,
          chunk_index: idx,
          chunk_total: subChunks.length,
          is_split: isMulti,
          source_urls: section.source_urls,
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // 3. quote — one chunk per VerbatimQuote
  //    Collect from sourceQuotesByUrl (all quotes across all sections)
  // -------------------------------------------------------------------------
  const seenQuotes = new Set<string>();

  for (const [sourceUrl, quotes] of sourceQuotesByUrl.entries()) {
    for (const quote of quotes) {
      // Deduplicate by quote text + source_url
      const dedupeKey = `${sourceUrl}::${quote.quote}`;
      if (seenQuotes.has(dedupeKey)) {
        continue;
      }
      seenQuotes.add(dedupeKey);

      // Find which citation anchor was assigned to this URL in any section
      let citationAnchor: string | null = null;
      for (const section of report.sections) {
        const ic = section.inline_citations.find((c) => c.source_url === sourceUrl);
        if (ic !== undefined) {
          citationAnchor = ic.anchor;
          break;
        }
      }

      // Resolve provider from bibliography
      const bibEntry = report.bibliography.find((b) => b.source_url === sourceUrl);
      const sourceProvider =
        bibEntry !== undefined ? bibEntry.provider : null;

      const engagementRecord: Record<string, unknown> = {};
      if (quote.engagement.upvotes !== undefined) {
        engagementRecord['upvotes'] = quote.engagement.upvotes;
      }
      if (quote.engagement.likes !== undefined) {
        engagementRecord['likes'] = quote.engagement.likes;
      }
      if (quote.engagement.replies !== undefined) {
        engagementRecord['replies'] = quote.engagement.replies;
      }
      if (quote.engagement.views !== undefined) {
        engagementRecord['views'] = quote.engagement.views;
      }

      chunks.push({
        chunk_kind: 'quote',
        section_path: 'quotes',
        heading: null,
        content: quote.quote,
        source_url: sourceUrl,
        source_provider: sourceProvider,
        source_author: quote.author !== undefined ? quote.author : null,
        source_published_at: quote.published_at !== undefined ? quote.published_at : null,
        source_engagement: engagementRecord,
        citation_anchor: citationAnchor,
        metadata: {
          context: quote.context,
          sentiment: quote.sentiment !== undefined ? quote.sentiment : null,
          category: quote.category !== undefined ? quote.category : null,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4. source_summary — one chunk per unique source_url
  // -------------------------------------------------------------------------
  const processedUrls = new Set<string>();

  for (const [sourceUrl, quotes] of sourceQuotesByUrl.entries()) {
    if (processedUrls.has(sourceUrl)) {
      continue;
    }
    processedUrls.add(sourceUrl);

    if (quotes.length === 0) {
      continue;
    }

    const bibEntry = report.bibliography.find((b) => b.source_url === sourceUrl);
    const title = bibEntry !== undefined && bibEntry.title !== '' ? bibEntry.title : sourceUrl;
    const author =
      bibEntry !== undefined && bibEntry.author !== ''
        ? bibEntry.author
        : (quotes[0].author !== undefined ? quotes[0].author : '');
    const provider = bibEntry !== undefined ? bibEntry.provider : null;

    // Collect key claims from the quotes for this source
    const keyClaims: string[] = [];
    for (const q of quotes) {
      // Use context as a claim summary if available, otherwise truncate quote
      const claim =
        q.context !== '' ? q.context : q.quote.slice(0, 120);
      keyClaims.push(claim);
      if (keyClaims.length >= 5) {
        break;
      }
    }

    const providerLabel = provider !== null ? String(provider) : 'unknown';
    const authorLine = author !== '' ? `Author: ${author}\n` : '';
    const content =
      `Source: ${title}\n` +
      authorLine +
      `Provider: ${providerLabel}\n` +
      `Key claims:\n` +
      keyClaims.map((c) => `- ${c}`).join('\n');

    const firstQuote = quotes[0];
    const engagementRecord: Record<string, unknown> = {};
    if (firstQuote !== undefined) {
      if (firstQuote.engagement.upvotes !== undefined) {
        engagementRecord['upvotes'] = firstQuote.engagement.upvotes;
      }
      if (firstQuote.engagement.views !== undefined) {
        engagementRecord['views'] = firstQuote.engagement.views;
      }
    }

    chunks.push({
      chunk_kind: 'source_summary',
      section_path: 'sources',
      heading: title,
      content,
      source_url: sourceUrl,
      source_provider: provider,
      source_author: author !== '' ? author : null,
      source_published_at:
        bibEntry !== undefined && bibEntry.published_at !== undefined
          ? bibEntry.published_at
          : null,
      source_engagement: engagementRecord,
      citation_anchor: null,
      metadata: {
        quote_count: quotes.length,
        provider: providerLabel,
      },
    });
  }

  return chunks;
}
