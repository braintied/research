/**
 * Research Pipeline Core — shared infrastructure for @swishh/research.
 *
 * Harvested from cortex-worker's research-pipeline-core.ts and decoupled from
 * Cortex: the cost-ledger writes (`writeCostRow` / `cortexInsert`) are removed —
 * cost is tracked in-process via CostTracker. Contains crawling, text chunking,
 * env-key access, and retry logic used by the providers, planner, and chunker.
 */

import { z } from 'zod';
import { logger } from './logger.js';

// ============================================================================
// Types — Crawl4AI
// ============================================================================

export interface MarkdownDict {
  raw_markdown: string;
  markdown_with_citations: string;
  references_markdown: string;
  fit_markdown: string;
}

export interface CrawlSyncResult {
  markdown: string | MarkdownDict;
  metadata: { statusCode: number; url: string };
}

export interface CrawlTaskResponse {
  success: boolean;
  id: string;
  results?: CrawlSyncResult[];
}

export interface CrawlStatusData {
  markdown: string | MarkdownDict;
  metadata: { statusCode: number; url: string };
}

export interface CrawlStatusResponse {
  status: string;
  data: CrawlStatusData[];
}

// ============================================================================
// Zod Schemas for External API Validation
// ============================================================================

const CrawlTaskResponseSchema = z.object({
  success: z.boolean(),
  id: z.string().optional().default(''),
  results: z.array(z.object({
    markdown: z.union([z.string(), z.object({
      raw_markdown: z.string().default(''),
      markdown_with_citations: z.string().default(''),
      references_markdown: z.string().default(''),
      fit_markdown: z.string().default(''),
    })]),
    metadata: z.object({
      statusCode: z.number().optional().default(0),
      url: z.string().optional().default(''),
    }).passthrough(),
  })).optional(),
});

const CrawlStatusResponseSchema = z.object({
  status: z.string(),
  data: z.array(z.object({
    markdown: z.union([z.string(), z.object({
      raw_markdown: z.string().default(''),
      markdown_with_citations: z.string().default(''),
      references_markdown: z.string().default(''),
      fit_markdown: z.string().default(''),
    })]),
    metadata: z.object({
      statusCode: z.number().optional().default(0),
      url: z.string().optional().default(''),
    }).passthrough(),
  })),
});

// ============================================================================
// Constants
// ============================================================================

export const SCRAPER_BASE_URL = process.env.CRAWL4AI_URL !== undefined && process.env.CRAWL4AI_URL !== ''
  ? process.env.CRAWL4AI_URL
  : 'https://ora-scraper.fly.dev';

export const CRAWL_POLL_INTERVAL_MS = 2000;
export const CRAWL_POLL_MAX_ATTEMPTS = 30;
export const DOMAIN_DELAY_MS = 2000;
export const EMBED_BATCH_SIZE = 20;
export const CHARS_PER_TOKEN = 4;
export const TARGET_CHUNK_TOKENS = 500;
export const MIN_CONTENT_CHARS_FOR_EXTRACTION = 500;
export const VOYAGE_MODEL = 'voyage-4-large';
export const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
export const GEMINI_MAX_CONTENT_CHARS = 12000;
export const EXTRACTION_MODEL = 'gemini-3.1-flash-lite-preview';

// ============================================================================
// Helpers — Environment
// ============================================================================

export function getGeminiKey(): string {
  const key = process.env.GEMINI_RESEARCH_KEY;
  if (key === undefined || key === '') {
    throw new Error('GEMINI_RESEARCH_KEY environment variable is not configured');
  }
  return key;
}

export function getVoyageKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (key === undefined || key === '') {
    throw new Error('VOYAGE_API_KEY environment variable is not configured');
  }
  return key;
}

// ============================================================================
// Helpers — Utilities
// ============================================================================

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function chunkText(text: string, targetTokens: number): string[] {
  const targetChars = targetTokens * CHARS_PER_TOKEN;

  if (text.length <= targetChars) {
    return [text];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length + 2 > targetChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
    currentChunk += (currentChunk.length > 0 ? '\n\n' : '') + paragraph;
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Extract plain markdown text from Crawl4AI's markdown field,
 * which can be either a plain string (older versions) or a MarkdownDict (v0.8+).
 */
export function extractMarkdown(md: string | MarkdownDict): string {
  if (typeof md === 'string') return md;
  if (typeof md === 'object' && md !== null) {
    const cited = typeof md.markdown_with_citations === 'string' ? md.markdown_with_citations : '';
    const raw = typeof md.raw_markdown === 'string' ? md.raw_markdown : '';
    return cited.length > 0 ? cited : raw;
  }
  return '';
}

// ============================================================================
// Retry Logic
// ============================================================================

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.ok) return response;
    if (response.status === 429 || response.status >= 500) {
      const delay = baseDelayMs * Math.pow(2, attempt);
      logger.warn(
        { url: url.slice(0, 80), status: response.status, attempt, delayMs: delay },
        '[fetchWithRetry] Retryable error, backing off',
      );
      await sleep(delay);
      continue;
    }
    // 4xx non-retry error — return as-is
    return response;
  }
  throw new Error(`Failed after ${maxRetries} retries: ${url.slice(0, 100)}`);
}

// ============================================================================
// Crawling
// ============================================================================

/**
 * Crawl a URL using Crawl4AI (ora-scraper).
 * Handles both sync (results inline) and async (task ID + poll) response modes.
 */
export async function crawlWithCrawl4AI(url: string): Promise<string | null> {
  try {
    const response = await fetchWithRetry(
      `${SCRAPER_BASE_URL}/crawl`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: [url],
          crawler_params: {
            wait_until: 'domcontentloaded',
            delay_before_return_html: 3,
            page_timeout: 60000,
          },
        }),
        signal: AbortSignal.timeout(70000),
      },
      2,
      2000,
    );

    if (!response.ok) {
      const body = await response.text();
      logger.warn({ url, status: response.status, body: body.slice(0, 100) }, '[Crawl4AI] Submission failed');
      return null;
    }

    const rawJson: unknown = await response.json();
    const parseResult = CrawlTaskResponseSchema.safeParse(rawJson);
    if (!parseResult.success) {
      logger.warn({ url, errors: parseResult.error.message }, '[Crawl4AI] Invalid response shape');
      return null;
    }
    const responseData = parseResult.data;

    // Handle sync response (results inline) — Crawl4AI 0.8.x returns results directly
    if (responseData.results !== undefined && responseData.results.length > 0) {
      const first = responseData.results[0];
      if (first !== undefined) {
        const md = extractMarkdown(first.markdown as string | MarkdownDict);
        if (md.length > 100) {
          logger.info({ url: url.slice(0, 60), chars: md.length }, '[Crawl4AI] Sync success');
          return md;
        }
      }
      logger.warn({ url }, '[Crawl4AI] Sync response had empty markdown');
      return null;
    }

    // Handle async response (task ID) — older Crawl4AI versions
    if (!responseData.success || responseData.id.length === 0) {
      logger.warn({ url }, '[Crawl4AI] No task ID and no inline results');
      return null;
    }

    // Poll for result
    for (let attempt = 0; attempt < CRAWL_POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(CRAWL_POLL_INTERVAL_MS);

      const statusResp = await fetch(`${SCRAPER_BASE_URL}/task/${responseData.id}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!statusResp.ok) continue;

      const statusRaw: unknown = await statusResp.json();
      const statusResult = CrawlStatusResponseSchema.safeParse(statusRaw);
      if (!statusResult.success) continue;
      const statusData = statusResult.data;

      if (statusData.status === 'completed') {
        if (statusData.data.length > 0) {
          const first = statusData.data[0];
          if (first !== undefined) {
            const md = extractMarkdown(first.markdown as string | MarkdownDict);
            if (md.length > 100) return md;
          }
        }
        return null;
      }
      if (statusData.status === 'failed') return null;
    }

    logger.warn({ url, taskId: responseData.id }, '[Crawl4AI] Poll timed out');
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ url, error: msg }, '[Crawl4AI] Crawl error');
    return null;
  }
}

/**
 * Simple direct HTTP fetch for plain HTML sites (paulgraham.com, blogs, etc.)
 * Strips HTML tags and returns clean text. Used as fallback when Crawl4AI fails.
 */
export async function directFetchAsText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return null;

    const html = await response.text();
    if (html.length < 200) return null;

    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    const title = titleMatch !== null && titleMatch[1] !== undefined ? titleMatch[1].trim() : '';

    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length < 200) return null;

    const result = title.length > 0 ? `# ${title}\n\n${cleaned}` : cleaned;
    logger.info({ url: url.slice(0, 60), chars: result.length }, '[DirectFetch] Success');
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ url, error: msg }, '[DirectFetch] Failed');
    return null;
  }
}

/**
 * Orchestrator: tries Crawl4AI first, falls back to DirectFetch.
 */
export async function crawlUrl(url: string): Promise<string | null> {
  const content = await crawlWithCrawl4AI(url);
  if (content !== null && content.trim().length >= 200) {
    return content;
  }
  return directFetchAsText(url);
}
