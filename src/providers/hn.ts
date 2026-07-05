/**
 * Hacker News Provider (Algolia API)
 *
 * No API key required. Rate limit: 1000/hour (very generous).
 * Uses https://hn.algolia.com/api/v1/search for discovery
 * and https://hn.algolia.com/api/v1/items/<id> for full comment tree.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { sleep } from '../pipeline-core.js';
import {
  SearchResultSchema,
  FetchResultSchema,
  type SearchProvider,
  type SearchResult,
  type FetchResult,
  type ExtractedQuotes,
  type SearchOpts,
} from '../types.js';
import { extractQuotesWithGemini } from './gemini-extractor.js';

// =============================================================================
// Rate limiter — 1000/hour = ~3.6 req/sec; use 300ms min spacing to be polite
// =============================================================================

const HN_RATE_LIMIT_MS = 300;
let lastHnCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastHnCallAt;
  if (elapsed < HN_RATE_LIMIT_MS) {
    await sleep(HN_RATE_LIMIT_MS - elapsed);
  }
  lastHnCallAt = Date.now();
}

// =============================================================================
// Algolia search response schema
// =============================================================================

const HnHitSchema = z.object({
  objectID: z.string(),
  url: z.string().optional(),
  title: z.string().default(''),
  story_text: z.string().optional(),
  author: z.string().default(''),
  created_at: z.string().default(''),
  points: z.number().default(0),
  num_comments: z.number().default(0),
  _tags: z.array(z.string()).default([]),
});

const HnSearchResponseSchema = z.object({
  hits: z.array(HnHitSchema).default([]),
});

// =============================================================================
// Item (full comment tree) schema
// =============================================================================

const HnItemSchema: z.ZodType<HnItem> = z.lazy(() =>
  z.object({
    id: z.number().default(0),
    type: z.string().default(''),
    author: z.string().optional(),
    text: z.string().optional(),
    points: z.number().optional(),
    created_at: z.string().optional(),
    children: z.array(HnItemSchema).default([]),
  }),
);

interface HnItem {
  id: number;
  type: string;
  author?: string;
  text?: string;
  points?: number;
  created_at?: string;
  children: HnItem[];
}

// =============================================================================
// Helpers
// =============================================================================

const HN_BASE = 'https://hn.algolia.com/api/v1';

function toIsoString(dateStr: string): string | undefined {
  if (dateStr.length === 0) return undefined;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString();
  } catch {
    return undefined;
  }
}

function hnItemUrl(objectId: string): string {
  return `https://news.ycombinator.com/item?id=${objectId}`;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .trim();
}

interface FlatComment {
  id: number;
  author: string;
  text: string;
  points: number;
}

function flattenComments(children: HnItem[], maxDepth: number, currentDepth: number): FlatComment[] {
  if (currentDepth > maxDepth) return [];

  const flat: FlatComment[] = [];

  for (const child of children) {
    if (child.type !== 'comment') continue;
    if (child.text === undefined || child.text.length === 0) continue;
    if (child.author === undefined || child.author === '') continue;

    const cleanText = stripHtmlTags(child.text);
    if (cleanText.length > 0) {
      flat.push({
        id: child.id,
        author: child.author,
        text: cleanText,
        points: child.points !== undefined ? child.points : 0,
      });
    }

    if (child.children.length > 0) {
      flat.push(...flattenComments(child.children, maxDepth, currentDepth + 1));
    }
  }

  return flat;
}

// =============================================================================
// Provider
// =============================================================================

export const hnProvider: SearchProvider = {
  name: 'hn',

  get enabled(): boolean {
    return true; // No API key required
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    await rateLimit();

    const params = new URLSearchParams({
      query,
      tags: 'story',
      hitsPerPage: String(opts.limit !== undefined ? opts.limit : 20),
    });

    if (opts.recency_days !== undefined && opts.recency_days > 0) {
      const cutoffUnix = Math.floor((Date.now() - opts.recency_days * 24 * 60 * 60 * 1000) / 1000);
      params.set('numericFilters', `created_at_i>=${cutoffUnix}`);
    }

    const response = await fetch(`${HN_BASE}/search?${params.toString()}`, {
      headers: { 'User-Agent': 'OraResearch/1.0 (deep-research; contact: team@braintied.com)' },
      signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HN Algolia search error: ${response.status} ${body.slice(0, 200)}`);
    }

    const rawJson: unknown = await response.json();
    const parsed = HnSearchResponseSchema.safeParse(rawJson);

    if (!parsed.success) {
      logger.warn({ query: query.slice(0, 60), errors: parsed.error.message }, '[HN] Invalid response shape');
      return [];
    }

    const results: SearchResult[] = [];

    for (const hit of parsed.data.hits) {
      // Use the external URL if present, otherwise the HN item URL
      const url = (hit.url !== undefined && hit.url.length > 0) ? hit.url : hnItemUrl(hit.objectID);
      const snippet = hit.story_text !== undefined ? hit.story_text.slice(0, 500) : '';
      const publishedAt = toIsoString(hit.created_at);

      const candidate = {
        provider: 'hn' as const,
        url,
        canonical_id: hit.objectID,
        title: hit.title,
        snippet,
        author: hit.author.length > 0 ? hit.author : undefined,
        published_at: publishedAt,
        engagement: {
          upvotes: hit.points,
          comment_count: hit.num_comments,
        },
        raw_metadata: {
          hn_url: hnItemUrl(hit.objectID),
          tags: hit._tags,
        },
      };

      const validated = SearchResultSchema.safeParse(candidate);
      if (validated.success) {
        results.push(validated.data);
      }
    }

    logger.info(
      { query: query.slice(0, 60), count: results.length },
      '[HN] Search complete',
    );

    return results;
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    // Extract the HN item ID — handle both external URLs and HN item URLs
    let objectId: string | null = null;

    // Try HN item URL first: https://news.ycombinator.com/item?id=12345678
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'news.ycombinator.com' && parsed.pathname === '/item') {
        const idParam = parsed.searchParams.get('id');
        if (idParam !== null && idParam.length > 0) {
          objectId = idParam;
        }
      }
    } catch {
      // Not a valid URL, try to extract numeric ID
    }

    // If not an HN URL, we can't directly fetch the HN item tree
    // Return a failed result — callers should use crawl4ai for external URLs
    if (objectId === null) {
      return FetchResultSchema.parse({
        provider: 'hn',
        url,
        fetch_status: 'failed',
        fetch_error: 'HN provider fetch requires an HN item URL (news.ycombinator.com/item?id=...)',
      });
    }

    await rateLimit();

    const response = await fetch(`${HN_BASE}/items/${objectId}`, {
      headers: { 'User-Agent': 'OraResearch/1.0 (deep-research; contact: team@braintied.com)' },
      signal: signal !== undefined ? signal : AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const body = await response.text();
      return FetchResultSchema.parse({
        provider: 'hn',
        url,
        fetch_status: 'failed',
        fetch_error: `HN item fetch error: ${response.status} ${body.slice(0, 100)}`,
      });
    }

    const rawJson: unknown = await response.json();
    const parsed = HnItemSchema.safeParse(rawJson);

    if (!parsed.success) {
      return FetchResultSchema.parse({
        provider: 'hn',
        url,
        fetch_status: 'failed',
        fetch_error: `Parse error: ${parsed.error.message.slice(0, 200)}`,
      });
    }

    const item = parsed.data;

    // Flatten all comments, sort by points desc, take top 20
    const allComments = flattenComments(item.children, 5, 0);
    allComments.sort((a, b) => b.points - a.points);
    const topComments = allComments.slice(0, 20);

    // Build markdown
    const storyTitle = item.text !== undefined ? stripHtmlTags(item.text) : '';
    const lines: string[] = [
      `# HN Discussion: ${objectId}`,
      '',
    ];

    if (item.author !== undefined) {
      lines.push(`**Author:** ${item.author} | **Points:** ${item.points !== undefined ? item.points : 0}`, '');
    }

    if (storyTitle.length > 0) {
      lines.push('## Story', '', storyTitle, '');
    }

    if (topComments.length > 0) {
      lines.push('## Top Comments', '');
      for (const comment of topComments) {
        lines.push(`**${comment.author}** (${comment.points} points)`);
        lines.push('');
        lines.push(comment.text);
        lines.push('');
        lines.push('---');
        lines.push('');
      }
    }

    const markdown = lines.join('\n');

    const result = FetchResultSchema.parse({
      provider: 'hn',
      url,
      canonical_id: String(item.id),
      author: item.author,
      published_at: item.created_at !== undefined ? toIsoString(item.created_at) : undefined,
      raw_content: storyTitle,
      markdown,
      engagement: {
        upvotes: item.points,
        comment_count: allComments.length,
      },
      fetch_status: 'ok',
      raw_metadata: {
        top_comments: topComments,
      },
    });

    logger.info(
      { url: url.slice(0, 60), objectId, comments: topComments.length },
      '[HN] Fetch complete',
    );

    return result;
  },

  async extract(raw: FetchResult): Promise<ExtractedQuotes> {
    const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
    return extractQuotesWithGemini({
      provider: 'hn',
      url: raw.url,
      content,
      mode: 'hn',
    });
  },
};
