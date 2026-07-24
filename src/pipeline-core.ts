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
import {
  fetchPublicText,
  outboundTargetFingerprint,
  readBoundedWebResponseText,
  resolvePublicHttpUrl,
} from './public-http.js';

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
  id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional().default(''),
  results: z.array(z.object({
    markdown: z.union([z.string().max(5_000_000), z.object({
      raw_markdown: z.string().max(5_000_000).default(''),
      markdown_with_citations: z.string().max(5_000_000).default(''),
      references_markdown: z.string().max(5_000_000).default(''),
      fit_markdown: z.string().max(5_000_000).default(''),
    })]),
    metadata: z.object({
      statusCode: z.number().optional().default(0),
      url: z.string().max(4096).optional().default(''),
    }).passthrough(),
  })).max(4).optional(),
});

const CrawlStatusResponseSchema = z.object({
  status: z.enum(['queued', 'processing', 'completed', 'failed']),
  data: z.array(z.object({
    markdown: z.union([z.string().max(5_000_000), z.object({
      raw_markdown: z.string().max(5_000_000).default(''),
      markdown_with_citations: z.string().max(5_000_000).default(''),
      references_markdown: z.string().max(5_000_000).default(''),
      fit_markdown: z.string().max(5_000_000).default(''),
    })]),
    metadata: z.object({
      statusCode: z.number().optional().default(0),
      url: z.string().max(4096).optional().default(''),
    }).passthrough(),
  })).max(4),
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
export const EXTRACTION_MODEL = 'gemini-3.5-flash-lite';

const CRAWL4AI_ALLOWED_DOMAINS_ENV = 'BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS';
const CRAWL4AI_NETWORK_GUARD_ENV = 'BRAINTIED_CRAWL4AI_NETWORK_GUARD';
const CRAWL4AI_NETWORK_GUARD_VALUE = 'enforced-v1';
const MAX_CRAWL_RESPONSE_BYTES = 8_000_000;

function crawl4aiDomainAllowed(hostname: string): boolean {
  const allowlist = (process.env[CRAWL4AI_ALLOWED_DOMAINS_ENV] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase().replace(/\.$/, ''))
    .filter((value) => value.length > 0);
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) => {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2);
      return suffix.length > 0 && normalized.endsWith(`.${suffix}`);
    }
    return normalized === entry;
  });
}

async function crawlResultMatchesTarget(initial: URL, resultUrl: string): Promise<boolean> {
  if (resultUrl.length === 0) return false;
  try {
    const finalTarget = await resolvePublicHttpUrl(resultUrl);
    if (finalTarget.url.hostname.toLowerCase() !== initial.hostname.toLowerCase()) return false;
    if (initial.protocol === 'https:' && finalTarget.url.protocol !== 'https:') return false;
    return crawl4aiDomainAllowed(finalTarget.url.hostname);
  } catch {
    return false;
  }
}

// ============================================================================
// Helpers — Environment
// ============================================================================

export const GEMINI_KEY_ENV_NAMES = [
  'GEMINI_RESEARCH_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
] as const;

export const GEMINI_KEY_NAME_ENV = 'BRAINTIED_GEMINI_KEY_NAME';

export function getGeminiKey(): string {
  // The package has consumers in both Braintied and Vercel AI SDK ecosystems.
  // Keep one resolver so planning, extraction, and synthesis cannot select
  // different/stale aliases for the same Gemini request path.
  const configuredName = process.env[GEMINI_KEY_NAME_ENV]?.trim();
  if (configuredName !== undefined && configuredName.length > 0
    && !GEMINI_KEY_ENV_NAMES.includes(configuredName as (typeof GEMINI_KEY_ENV_NAMES)[number])) {
    throw new Error(
      `${GEMINI_KEY_NAME_ENV} must name one of: ${GEMINI_KEY_ENV_NAMES.join(', ')}`,
    );
  }

  const candidates = GEMINI_KEY_ENV_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value === undefined || value.trim().length === 0 ? [] : [{ name, value }];
  });
  if (configuredName !== undefined && configuredName.length > 0) {
    const selected = candidates.find((candidate) => candidate.name === configuredName);
    if (selected === undefined) {
      throw new Error(`${GEMINI_KEY_NAME_ENV} selects ${configuredName}, but that variable is not configured`);
    }
    return selected.value;
  }

  if (new Set(candidates.map((candidate) => candidate.value)).size > 1) {
    throw new Error(
      `Conflicting Gemini aliases are configured (${candidates.map((candidate) => candidate.name).join(', ')}); set ${GEMINI_KEY_NAME_ENV}`,
    );
  }
  if (candidates[0] !== undefined) return candidates[0].value;
  throw new Error(`One of ${GEMINI_KEY_ENV_NAMES.join(', ')} must be configured`);
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

/**
 * Bounded-concurrency map (audit F7): run `fn` over `items` with at most
 * `limit` in flight. Results keep input order. Rejections are the caller's
 * concern — wrap `fn` in try/catch when a failed item should not fail the
 * batch (matches the existing fail-soft fetch/extract semantics).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
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
      await response.body?.cancel().catch(() => undefined);
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
  throw new Error(`Request failed after ${maxRetries} retries`);
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
    if (process.env[CRAWL4AI_NETWORK_GUARD_ENV] !== CRAWL4AI_NETWORK_GUARD_VALUE) {
      logger.debug({}, '[Crawl4AI] External browser crawler is disabled without an enforced network guard');
      return null;
    }
    const target = await resolvePublicHttpUrl(url);
    if (!crawl4aiDomainAllowed(target.url.hostname)) {
      logger.debug(
        { target: outboundTargetFingerprint(url) },
        '[Crawl4AI] Target is not in the reviewed crawler domain allowlist',
      );
      return null;
    }
    const response = await fetchWithRetry(
      `${SCRAPER_BASE_URL}/crawl`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // IMPORTANT: use the TYPED config shape (`browser_config`/`crawler_config`
        // with `{type, params}`). The legacy FLAT `crawler_params` shape is
        // silently IGNORED by the Crawl4AI 0.8.x server — wait/delay never
        // apply, so JS-rendered SPAs come back empty (verified in Sentigen
        // 2026-06-20: flat → 1 char, typed → 5,898 chars on the same URL).
        body: JSON.stringify({
          urls: [target.url.toString()],
          browser_config: {
            type: 'BrowserConfig',
            params: { headless: true, java_script_enabled: true },
          },
          crawler_config: {
            type: 'CrawlerRunConfig',
            params: {
              wait_until: 'domcontentloaded',
              delay_before_return_html: 3,
              page_timeout: 60000,
            },
          },
        }),
        signal: AbortSignal.timeout(70000),
      },
      2,
      2000,
    );

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      logger.warn(
        { target: outboundTargetFingerprint(url), status: response.status },
        '[Crawl4AI] Submission failed',
      );
      return null;
    }

    const responseText = await readBoundedWebResponseText(response, MAX_CRAWL_RESPONSE_BYTES);
    const rawJson: unknown = JSON.parse(responseText);
    const parseResult = CrawlTaskResponseSchema.safeParse(rawJson);
    if (!parseResult.success) {
      logger.warn(
        { target: outboundTargetFingerprint(url), errors: parseResult.error.message },
        '[Crawl4AI] Invalid response shape',
      );
      return null;
    }
    const responseData = parseResult.data;

    // Handle sync response (results inline) — Crawl4AI 0.8.x returns results directly
    if (responseData.results !== undefined && responseData.results.length > 0) {
      const first = responseData.results[0];
      if (first !== undefined) {
        if (!await crawlResultMatchesTarget(target.url, first.metadata.url)) {
          logger.warn(
            { target: outboundTargetFingerprint(url) },
            '[Crawl4AI] Result target did not match the reviewed source',
          );
          return null;
        }
        const md = extractMarkdown(first.markdown as string | MarkdownDict);
        if (md.length > 100) {
          logger.info(
            { target: outboundTargetFingerprint(url), chars: md.length },
            '[Crawl4AI] Sync success',
          );
          return md;
        }
      }
      logger.warn(
        { target: outboundTargetFingerprint(url) },
        '[Crawl4AI] Sync response had empty markdown',
      );
      return null;
    }

    // Handle async response (task ID) — older Crawl4AI versions
    if (!responseData.success || responseData.id.length === 0) {
      logger.warn(
        { target: outboundTargetFingerprint(url) },
        '[Crawl4AI] No task ID and no inline results',
      );
      return null;
    }

    // Poll for result
    for (let attempt = 0; attempt < CRAWL_POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(CRAWL_POLL_INTERVAL_MS);

      const statusResp = await fetch(`${SCRAPER_BASE_URL}/task/${responseData.id}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!statusResp.ok) {
        await statusResp.body?.cancel().catch(() => undefined);
        continue;
      }

      const statusText = await readBoundedWebResponseText(statusResp, MAX_CRAWL_RESPONSE_BYTES);
      const statusRaw: unknown = JSON.parse(statusText);
      const statusResult = CrawlStatusResponseSchema.safeParse(statusRaw);
      if (!statusResult.success) continue;
      const statusData = statusResult.data;

      if (statusData.status === 'completed') {
        if (statusData.data.length > 0) {
          const first = statusData.data[0];
          if (first !== undefined) {
            if (!await crawlResultMatchesTarget(target.url, first.metadata.url)) {
              logger.warn(
                { target: outboundTargetFingerprint(url) },
                '[Crawl4AI] Result target did not match the reviewed source',
              );
              return null;
            }
            const md = extractMarkdown(first.markdown as string | MarkdownDict);
            if (md.length > 100) return md;
          }
        }
        return null;
      }
      if (statusData.status === 'failed') return null;
    }

    logger.warn(
      { target: outboundTargetFingerprint(url), taskId: responseData.id },
      '[Crawl4AI] Poll timed out',
    );
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { target: outboundTargetFingerprint(url), error: msg },
      '[Crawl4AI] Crawl error',
    );
    return null;
  }
}

/**
 * Simple direct HTTP fetch for plain HTML sites (paulgraham.com, blogs, etc.)
 * Strips HTML tags and returns clean text. Used as fallback when Crawl4AI fails.
 */
export async function directFetchAsText(url: string): Promise<string | null> {
  try {
    const response = await fetchPublicText(url, {
      acceptedContentTypes: ['text/html', 'application/xhtml+xml', 'text/plain'],
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      maxBytes: 2_000_000,
      timeoutMs: 15_000,
    });

    if (!response.ok) return null;

    const html = response.text;
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
    logger.info(
      { target: outboundTargetFingerprint(url), chars: result.length },
      '[DirectFetch] Success',
    );
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { target: outboundTargetFingerprint(url), error: msg },
      '[DirectFetch] Failed',
    );
    return null;
  }
}

/**
 * Jina Reader fallback — https://r.jina.ai/{url} returns the page as clean
 * markdown. Free tier; only attempted when JINA_API_KEY is configured.
 * Handles JS-rendered pages that DirectFetch can't, without self-hosted infra.
 */
export async function jinaReaderFetch(url: string): Promise<string | null> {
  const key = process.env.JINA_API_KEY;
  if (key === undefined || key === '') return null;

  try {
    const target = await resolvePublicHttpUrl(url);
    const response = await fetchPublicText(`https://r.jina.ai/${target.url.toString()}`, {
      acceptedContentTypes: ['text/markdown', 'text/plain'],
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'text/plain',
      },
      maxBytes: 2_000_000,
      maxRedirects: 0,
      timeoutMs: 30_000,
    });

    if (!response.ok) {
      logger.warn(
        { target: outboundTargetFingerprint(target.url.toString()), status: response.status },
        '[JinaReader] Non-OK response',
      );
      return null;
    }

    const markdown = response.text;
    if (markdown.trim().length < 200) return null;

    logger.info(
      { target: outboundTargetFingerprint(target.url.toString()), chars: markdown.length },
      '[JinaReader] Success',
    );
    return markdown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { target: outboundTargetFingerprint(url), error: msg },
      '[JinaReader] Failed',
    );
    return null;
  }
}

/**
 * Orchestrator: Crawl4AI (self-hosted, $0) → Jina Reader (free tier, only if
 * JINA_API_KEY set) → DirectFetch (plain HTML).
 */
export async function crawlUrl(url: string): Promise<string | null> {
  const content = await crawlWithCrawl4AI(url);
  if (content !== null && content.trim().length >= 200) {
    return content;
  }
  const jinaContent = await jinaReaderFetch(url);
  if (jinaContent !== null) {
    return jinaContent;
  }
  return directFetchAsText(url);
}
