/**
 * Crawl4AI Fetch Provider
 *
 * Wraps crawlWithCrawl4AI + directFetchAsText from research-pipeline-core.ts.
 * This is a fetch-only provider — search() is not supported.
 * extract() uses Gemini in longform mode for up to 30 verbatim pull-quotes.
 */

import { logger } from '../logger.js';
import { crawlWithCrawl4AI, directFetchAsText } from '../pipeline-core.js';
import {
  FetchResultSchema,
  type SearchProvider,
  type SearchResult,
  type FetchResult,
  type ExtractedQuotes,
  type SearchOpts,
} from '../types.js';
import { extractQuotesWithGemini } from './gemini-extractor.js';

// =============================================================================
// Provider
// =============================================================================

export const crawl4aiProvider: SearchProvider = {
  name: 'crawl4ai',

  get enabled(): boolean {
    return true; // No API key — uses internal ora-scraper service
  },

  async search(_query: string, _opts: SearchOpts): Promise<SearchResult[]> {
    throw new Error(
      'crawl4ai does not support search; use it via .fetch(url)',
    );
  },

  async fetch(url: string, _signal?: AbortSignal): Promise<FetchResult> {
    // Try Crawl4AI first
    let markdown: string | null = null;

    try {
      markdown = await crawlWithCrawl4AI(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ url: url.slice(0, 60), error: msg }, '[Crawl4AI] crawlWithCrawl4AI threw, falling back to directFetch');
    }

    // Fall back to direct HTTP fetch
    if (markdown === null || markdown.trim().length < 200) {
      try {
        markdown = await directFetchAsText(url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ url: url.slice(0, 60), error: msg }, '[Crawl4AI] directFetchAsText also failed');
      }
    }

    if (markdown === null || markdown.trim().length === 0) {
      const result = FetchResultSchema.parse({
        provider: 'crawl4ai',
        url,
        fetch_status: 'failed',
        fetch_error: 'Both crawlWithCrawl4AI and directFetchAsText returned no content',
      });
      return result;
    }

    // Extract title from first H1 or first line
    let title = '';
    const firstLine = markdown.split('\n').find(l => l.trim().length > 0);
    if (firstLine !== undefined) {
      title = firstLine.replace(/^#+\s*/, '').trim().slice(0, 200);
    }

    const fetchStatus = markdown.trim().length >= 500 ? 'ok' : 'partial';

    const result = FetchResultSchema.parse({
      provider: 'crawl4ai',
      url,
      title,
      raw_content: markdown,
      markdown,
      fetch_status: fetchStatus,
      engagement: {},
      raw_metadata: {},
    });

    logger.info(
      { url: url.slice(0, 60), chars: markdown.length, status: fetchStatus },
      '[Crawl4AI] Fetch complete',
    );

    return result;
  },

  async extract(raw: FetchResult): Promise<ExtractedQuotes> {
    const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
    return extractQuotesWithGemini({
      provider: 'crawl4ai',
      url: raw.url,
      content,
      mode: 'longform',
    });
  },
};
