/**
 * parse-markdown-report.ts
 *
 * Pure helper that parses a Pipeline-B markdown report (with mandatory YAML
 * frontmatter) into a FinalReport + sourceQuotesByUrl map that are directly
 * compatible with chunker.ts buildReportChunks().
 *
 * No new npm dependencies — naïve regex parsing only.
 */

import { z } from 'zod';
import { FinalReportSchema } from './types.js';
import type { FinalReport, VerbatimQuote, ProviderName } from './types.js';

// =============================================================================
// Public types
// =============================================================================

export const ALLOWED_TOOLS = [
  'claude_code',
  'claude_research',
  'gemini_research',
  'chatgpt_research',
  'perplexity',
] as const;

export type ReportTool = (typeof ALLOWED_TOOLS)[number];

const ReportMetadataSchema = z.object({
  prompt_id: z.string().min(1),
  tool: z.enum(ALLOWED_TOOLS),
  date_anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_anchor must be YYYY-MM-DD'),
  research_started: z.string().optional(),
  research_ended: z.string().optional(),
  sources_count: z.coerce.number().int().nonnegative().optional(),
});

export type ReportMetadata = z.infer<typeof ReportMetadataSchema>;

export interface ParsedMarkdownReport {
  report: FinalReport;
  sourceQuotesByUrl: Map<string, VerbatimQuote[]>;
  metadata: ReportMetadata;
}

// =============================================================================
// Provider inference from URL hostname
// =============================================================================

function inferProvider(url: string): ProviderName {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'crawl4ai';
  }

  if (hostname.includes('reddit.com')) {
    return 'reddit';
  }
  if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
    return 'youtube';
  }
  if (hostname.includes('news.ycombinator.com') || hostname.includes('hn.algolia.com')) {
    return 'hn';
  }
  if (hostname.includes('twitter.com') || hostname === 'x.com' || hostname.endsWith('.x.com')) {
    return 'x';
  }
  if (hostname.includes('tiktok.com')) {
    return 'tiktok';
  }
  if (hostname.includes('instagram.com')) {
    return 'instagram';
  }
  // facebook.com/groups/ — check path too
  if (hostname.includes('facebook.com')) {
    return 'facebook_groups';
  }
  // Everything else: generic web fetch
  return 'crawl4ai';
}

// =============================================================================
// Engagement string parser
// e.g. "442 upvotes" → { upvotes: 442 }
//      "1.2M views"  → { views: 1200000 }
// =============================================================================

function parseEngagement(raw: string): Record<string, number> {
  const result: Record<string, number> = {};
  if (raw.trim() === '') {
    return result;
  }

  // Normalise number with optional M/K suffix
  function parseCount(s: string): number {
    const cleaned = s.trim().replace(/,/g, '');
    const m = /^([\d.]+)([MKk]?)$/.exec(cleaned);
    if (m === null) {
      return 0;
    }
    const num = parseFloat(m[1]);
    const suffix = m[2].toLowerCase();
    if (suffix === 'm') {
      return Math.round(num * 1_000_000);
    }
    if (suffix === 'k') {
      return Math.round(num * 1_000);
    }
    return Math.round(num);
  }

  // Try known patterns
  const upvoteMatch = /(\d[\d.,MKk]*)\s+upvotes?/i.exec(raw);
  if (upvoteMatch !== null) {
    result['upvotes'] = parseCount(upvoteMatch[1]);
  }

  const viewMatch = /([\d.,MKk]+)\s+views?/i.exec(raw);
  if (viewMatch !== null) {
    result['views'] = parseCount(viewMatch[1]);
  }

  const likeMatch = /([\d.,MKk]+)\s+likes?/i.exec(raw);
  if (likeMatch !== null) {
    result['likes'] = parseCount(likeMatch[1]);
  }

  const commentMatch = /([\d.,MKk]+)\s+comments?/i.exec(raw);
  if (commentMatch !== null) {
    result['replies'] = parseCount(commentMatch[1]);
  }

  return result;
}

// =============================================================================
// Frontmatter parser
// =============================================================================

function parseFrontmatter(markdown: string): { meta: Record<string, string>; body: string } {
  const fmMatch = /^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (fmMatch === null) {
    throw new Error(
      'Missing frontmatter. The markdown file must start with a --- ... --- block. ' +
        'See CLAUDE-CODE-RESEARCH-WORKFLOW.md for the required format.',
    );
  }

  const fmBlock = fmMatch[1];
  const body = fmMatch[2];

  const meta: Record<string, string> = {};
  for (const line of fmBlock.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) {
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }

  return { meta, body };
}

// =============================================================================
// Bibliography parser
//
// Each line:  [^N]: https://... — <author>, <date>, <engagement>
// =============================================================================

interface BibEntry {
  citation_anchor: string;
  source_url: string;
  title: string;
  author: string;
  provider: ProviderName;
  published_at: string | undefined;
  raw_trailing: string;
  engagement: Record<string, number>;
}

function parseBibliography(bibSection: string): Map<string, BibEntry> {
  const map = new Map<string, BibEntry>();

  for (const line of bibSection.split('\n')) {
    const m = /^\[\^(\d+)\]:\s+(https?:\/\/\S+)\s*(?:—\s*(.+))?$/.exec(line.trim());
    if (m === null) {
      continue;
    }

    const anchor = `[^${m[1]}]`;
    const url = m[2];
    const trailing = m[3] !== undefined ? m[3].trim() : '';

    // trailing: "u/foo, 2026-04-29, 442 upvotes"
    // Split on first two commas to get author / date / rest
    const parts = trailing.split(',');
    const author = parts.length > 0 ? parts[0].trim() : '';
    const rawDate = parts.length > 1 ? parts[1].trim() : '';
    const rawEngagement = parts.length > 2 ? parts.slice(2).join(',').trim() : '';

    // Validate date — must be YYYY-MM-DD
    const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(rawDate);
    const published_at = dateValid ? rawDate : undefined;

    map.set(anchor, {
      citation_anchor: anchor,
      source_url: url,
      title: '',
      author,
      provider: inferProvider(url),
      published_at,
      raw_trailing: trailing,
      engagement: parseEngagement(rawEngagement),
    });
  }

  return map;
}

// =============================================================================
// Sentence extraction helper
// Finds the sentence in body_md that contains the given citation anchor.
// =============================================================================

function extractCitingSentence(bodyMd: string, anchor: string): string {
  // Split on sentence-ending punctuation + newlines
  const sentences = bodyMd.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
  for (const sentence of sentences) {
    if (sentence.includes(anchor)) {
      // Strip the citation markers from the sentence for cleanliness
      return sentence.replace(/\[\^\d+\]/g, '').trim();
    }
  }
  // Fallback: first 200 chars of body
  return bodyMd.replace(/\[\^\d+\]/g, '').slice(0, 200).trim();
}

// =============================================================================
// Main parse function
// =============================================================================

export function parseMarkdownReport(input: {
  markdown: string;
  promptId: string;
}): ParsedMarkdownReport {
  const { markdown, promptId } = input;

  // Strip UTF-8 BOM
  const clean = markdown.replace(/^﻿/, '');

  // -------------------------------------------------------------------------
  // 1. Frontmatter
  // -------------------------------------------------------------------------
  const { meta, body } = parseFrontmatter(clean);

  const rawMeta = {
    prompt_id: meta['prompt_id'] !== undefined ? meta['prompt_id'] : promptId,
    tool: meta['tool'],
    date_anchor: meta['date_anchor'],
    research_started: meta['research_started'],
    research_ended: meta['research_ended'],
    sources_count: meta['sources_count'],
  };

  // Use promptId override if provided (non-empty)
  if (promptId !== '' && promptId !== rawMeta.prompt_id) {
    rawMeta.prompt_id = promptId;
  }

  const metadata = ReportMetadataSchema.parse(rawMeta);

  // -------------------------------------------------------------------------
  // 2. Split body into named sections on ## headings
  // -------------------------------------------------------------------------
  // First extract title (first # heading)
  const titleMatch = /^#\s+(.+)$/m.exec(body);
  const title = titleMatch !== null ? titleMatch[1].trim() : 'Untitled Report';

  // Split on ## headings (level 2)
  const h2Regex = /^## (.+)$/gm;
  const sectionBreaks: Array<{ heading: string; start: number }> = [];
  let h2Match: RegExpExecArray | null;
  while ((h2Match = h2Regex.exec(body)) !== null) {
    sectionBreaks.push({ heading: h2Match[1].trim(), start: h2Match.index });
  }

  if (sectionBreaks.length === 0) {
    throw new Error(
      `No ## sections found in the report body. ` +
        `The report must have at least one ## heading (e.g. ## Executive Summary).`,
    );
  }

  // Extract section bodies
  const rawSections: Array<{ heading: string; body: string }> = [];
  for (let i = 0; i < sectionBreaks.length; i++) {
    const current = sectionBreaks[i];
    const next = sectionBreaks[i + 1];
    const sectionText = next !== undefined
      ? body.slice(current.start, next.start)
      : body.slice(current.start);

    // Strip the heading line itself from the body
    const bodyText = sectionText.replace(/^##\s+.+\n?/, '').trim();
    rawSections.push({ heading: current.heading, body: bodyText });
  }

  // -------------------------------------------------------------------------
  // 3. Separate executive summary from content sections + bibliography
  // -------------------------------------------------------------------------
  let executiveSummary = '';
  const contentSections: Array<{ heading: string; body: string }> = [];
  let bibliographyBody = '';

  for (const sec of rawSections) {
    const headingLower = sec.heading.toLowerCase();
    if (headingLower === 'bibliography' || headingLower === 'references') {
      bibliographyBody = sec.body;
    } else if (
      headingLower === 'executive summary' ||
      headingLower.startsWith('executive')
    ) {
      executiveSummary = sec.body;
    } else {
      contentSections.push(sec);
    }
  }

  if (executiveSummary === '') {
    // Fall back to first content section as summary
    if (contentSections.length > 0) {
      const first = contentSections.shift();
      if (first !== undefined) {
        executiveSummary = first.body;
      }
    }
  }

  if (executiveSummary === '') {
    throw new Error(
      'Could not extract executive summary. ' +
        'Add a ## Executive Summary section or ensure the first ## section has content.',
    );
  }

  // -------------------------------------------------------------------------
  // 4. Parse bibliography
  // -------------------------------------------------------------------------
  const bibMap = parseBibliography(bibliographyBody);

  // -------------------------------------------------------------------------
  // 5. Build SectionDraft objects with inline_citations + source_urls
  // -------------------------------------------------------------------------
  const anchorRegex = /\[\^(\d+)\]/g;

  const sections = contentSections.map((sec, idx) => {
    const anchorsInSection = new Set<string>();
    let match: RegExpExecArray | null;
    const anchorRegexLocal = /\[\^(\d+)\]/g;
    while ((match = anchorRegexLocal.exec(sec.body)) !== null) {
      anchorsInSection.add(`[^${match[1]}]`);
    }

    const inlineCitations: Array<{
      anchor: string;
      source_url: string;
      quote_excerpt: string;
    }> = [];
    const sourceUrlsSet = new Set<string>();

    for (const anchor of anchorsInSection) {
      const bibEntry = bibMap.get(anchor);
      if (bibEntry === undefined) {
        continue;
      }
      sourceUrlsSet.add(bibEntry.source_url);
      inlineCitations.push({
        anchor,
        source_url: bibEntry.source_url,
        quote_excerpt: '',
      });
    }

    const wordCount = sec.body
      .replace(/\[\^\d+\]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

    return {
      section_path: sec.heading,
      heading: sec.heading,
      level: 2,
      body_md: sec.body,
      source_urls: Array.from(sourceUrlsSet),
      inline_citations: inlineCitations,
      word_count: wordCount,
    };
  });

  // -------------------------------------------------------------------------
  // 6. Build bibliography array for FinalReport
  // -------------------------------------------------------------------------
  const bibliography = Array.from(bibMap.values()).map((entry) => ({
    citation_anchor: entry.citation_anchor,
    source_url: entry.source_url,
    title: entry.title,
    author: entry.author,
    provider: entry.provider,
    published_at: entry.published_at,
  }));

  // -------------------------------------------------------------------------
  // 7. Build sourceQuotesByUrl — one VerbatimQuote per (URL, citing-section)
  // -------------------------------------------------------------------------
  const sourceQuotesByUrl = new Map<string, VerbatimQuote[]>();

  // Reset anchorRegex for full-body scan
  void anchorRegex; // not used below — using per-section approach

  for (const sec of contentSections) {
    const anchorRegexLocal = /\[\^(\d+)\]/g;
    let secMatch: RegExpExecArray | null;
    while ((secMatch = anchorRegexLocal.exec(sec.body)) !== null) {
      const anchor = `[^${secMatch[1]}]`;
      const bibEntry = bibMap.get(anchor);
      if (bibEntry === undefined) {
        continue;
      }

      const url = bibEntry.source_url;
      const sentenceText = extractCitingSentence(sec.body, anchor);

      // Build engagement record from bibEntry.engagement
      const engagementRecord: {
        upvotes?: number;
        likes?: number;
        replies?: number;
        views?: number;
      } = {};
      if (bibEntry.engagement['upvotes'] !== undefined) {
        engagementRecord.upvotes = bibEntry.engagement['upvotes'];
      }
      if (bibEntry.engagement['likes'] !== undefined) {
        engagementRecord.likes = bibEntry.engagement['likes'];
      }
      if (bibEntry.engagement['replies'] !== undefined) {
        engagementRecord.replies = bibEntry.engagement['replies'];
      }
      if (bibEntry.engagement['views'] !== undefined) {
        engagementRecord.views = bibEntry.engagement['views'];
      }

      // Parse published_at as ISO datetime if YYYY-MM-DD
      let publishedAt: string | undefined;
      if (bibEntry.published_at !== undefined) {
        publishedAt = `${bibEntry.published_at}T00:00:00Z`;
      }

      const quote: VerbatimQuote = {
        quote: sentenceText,
        context: '',
        source_url: url,
        author: bibEntry.author !== '' ? bibEntry.author : undefined,
        published_at: publishedAt,
        engagement: engagementRecord,
        sentiment: undefined,
        category: undefined,
      };

      const existing = sourceQuotesByUrl.get(url);
      if (existing !== undefined) {
        // Deduplicate by sentence text
        const alreadyPresent = existing.some((q) => q.quote === sentenceText);
        if (!alreadyPresent) {
          existing.push(quote);
        }
      } else {
        sourceQuotesByUrl.set(url, [quote]);
      }
    }
  }

  // Ensure every bibliography URL has at least one entry in sourceQuotesByUrl
  // (needed so the chunker produces source_summary chunks for all sources)
  for (const entry of bibMap.values()) {
    if (!sourceQuotesByUrl.has(entry.source_url)) {
      const publishedAt =
        entry.published_at !== undefined ? `${entry.published_at}T00:00:00Z` : undefined;

      sourceQuotesByUrl.set(entry.source_url, [
        {
          quote: `Source: ${entry.source_url}`,
          context: '',
          source_url: entry.source_url,
          author: entry.author !== '' ? entry.author : undefined,
          published_at: publishedAt,
          engagement: {},
          sentiment: undefined,
          category: undefined,
        },
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // 8. Assemble full_markdown and word_count
  // -------------------------------------------------------------------------
  const full_markdown = clean
    .replace(/^﻿/, '')
    .replace(/^---\r?\n[\s\S]+?\r?\n---\r?\n/, '')
    .trim();

  const word_count = full_markdown
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

  // -------------------------------------------------------------------------
  // 9. Validate via FinalReportSchema
  // -------------------------------------------------------------------------
  const reportRaw = {
    title,
    executive_summary: executiveSummary,
    full_markdown,
    sections,
    bibliography,
    gaps: [],
    word_count,
  };

  let report: FinalReport;
  try {
    report = FinalReportSchema.parse(reportRaw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Report failed FinalReport schema validation: ${message}\n` +
        `Check that executive_summary, sections, and bibliography are all present and non-empty.`,
    );
  }

  return { report, sourceQuotesByUrl, metadata };
}
