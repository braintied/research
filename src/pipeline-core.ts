/**
 * Research Pipeline Core — shared infrastructure for @swishh/research.
 *
 * Harvested from cortex-worker's research-pipeline-core.ts and decoupled from
 * Cortex: the cost-ledger writes (`writeCostRow` / `cortexInsert`) are removed —
 * cost is tracked in-process via CostTracker. Contains crawling, text chunking,
 * and retry logic used by the providers, planner, and chunker. Credentials and
 * endpoints arrive as arguments — see credentials.ts.
 */

import { z } from 'zod';
import { logger } from './logger.js';
import {
  CRAWL4AI_NETWORK_GUARD_VALUE,
  type Crawl4AiConfig,
  type ResearchCredentials,
} from './credentials.js';
import {
  fetchPublicText,
  outboundTargetFingerprint,
  readBoundedWebResponseText,
  resolvePublicHttpUrl,
} from './public-http.js';
import { resolveResearchExtractionModel } from './model-policy.js';

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
    url: z.string().max(4096).optional().default(''),
    redirected_url: z.string().max(4096).optional().default(''),
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
    url: z.string().max(4096).optional().default(''),
    redirected_url: z.string().max(4096).optional().default(''),
    metadata: z.object({
      statusCode: z.number().optional().default(0),
      url: z.string().max(4096).optional().default(''),
    }).passthrough(),
  })).max(4),
});

// ============================================================================
// Constants
// ============================================================================

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
/**
 * Per-page extraction model. This runs once per crawled page and is by far the
 * highest-volume model call in the package (438M input / 76M output tokens in a
 * 24-day sample), so its unit price dominates the whole research bill.
 *
 * Observed GCP unit prices, derived from billed tokens ÷ billed dollars on
 * account 01A205-221AE2-28AB3C (2026-07-24), NOT from release notes:
 *
 *   gemini-2.5-flash-lite            $0.10 in / $0.40 out   (DEAD — see below)
 *   gemini-3.1-flash-lite            $0.25 in / $1.50 out   ← cheapest live, chosen
 *   gemini-3.5-flash-lite            $0.30 in / $2.50 out   (newest lite tier)
 *
 * Newer lite tiers are MORE expensive here, not less. Do not "upgrade" this
 * constant on generation number alone — price it against the billing export
 * first.
 *
 * gemini-2.5-flash-lite was chosen on 2026-07-25 for the $0.10/$0.40 tier, but
 * the id is listed-but-not-callable on this API: it appears in GET /v1beta/models
 * yet every generateContent call returns HTTP 404 on both v1beta and v1 (verified
 * 2026-07-27 against the Ora-App key; gemini-2.0-flash-lite 404s the same way).
 * Between 2026-07-25 and this fix every deep-research run extracted ZERO quotes
 * from every crawled page — the extractor swallows per-page API errors by design,
 * so runs produced uncited reports and profile/canary coverage checks failed
 * (cortex-worker research canary: program_incomplete). A listed model id is not
 * a callable model id: verify with a live generateContent before committing a
 * model change, always. gemini-3.1-flash-lite is the GA successor to the
 * deprecated preview and the cheapest lite tier that answers 200 today.
 *
 * EXTRACTION_INPUT_USD_PER_M / EXTRACTION_OUTPUT_USD_PER_M in index.ts MUST match
 * whatever is set here. They were already $0.10/$0.40 while the model was
 * 3.5-flash-lite, so the package under-reported its own extraction spend 3x on
 * input and 6.25x on output, and its spend cap was enforced against that
 * undercount. Change the model and the rates in the same commit, always.
 */
/**
 * Exact rewrites for retired Gemini ids (preview + dead GA generations).
 * Mirrors `@braintied/cost` `GEMINI_PREVIEW_REQUEST_REWRITES` for previews.
 * Dead GA entries map onto the live models-package extract pick at rewrite time
 * when the target is still a fixed id; unknown previews fall through to
 * `extractionModelId()`.
 */
const GEMINI_PREVIEW_REQUEST_REWRITES: Readonly<Record<string, string>> = {
  'gemini-3.1-flash-lite-preview': 'gemini-3.5-flash-lite',
  'gemini-3-flash-preview': 'gemini-3.6-flash',
  'gemini-3-flash': 'gemini-3.6-flash',
  'gemini-2.0-flash': 'gemini-3.5-flash-lite',
  'gemini-2.0-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite',
};

const PREVIEW_ALLOW_SUBSTRINGS: readonly string[] = [
  'image',
  'veo',
  'tts',
  'live',
  'robotics',
  'computer-use',
  'deep-research',
  'lyria',
  'omni',
  'native-audio',
];

/**
 * Request-time rewrite so a stale pin or caller override cannot put retired
 * or banned text-preview ids on the wire. Final fallback is the live
 * `@braintied/models` extraction pick (not a hardcoded generation number).
 */
export function resolveGeminiRequestModel(model: string): string {
  const trimmed = model.trim();
  const id = trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
  if (id.length === 0) {
    return id;
  }
  const exact = GEMINI_PREVIEW_REQUEST_REWRITES[id];
  if (exact !== undefined) {
    return exact;
  }
  const lower = id.toLowerCase();
  if (!lower.includes('preview')) {
    return id;
  }
  for (const token of PREVIEW_ALLOW_SUBSTRINGS) {
    if (lower.includes(token)) {
      return id;
    }
  }
  return resolveResearchExtractionModel();
}

/** Wire id for extraction — always from `@braintied/models`, then rewrite map. */
export function extractionModelId(): string {
  return resolveGeminiRequestModel(resolveResearchExtractionModel());
}

/**
 * @deprecated Prefer `extractionModelId()`. Snapshot of the models-package
 * extract pick at first read — for log labels and sanitize allowlists only.
 */
export function EXTRACTION_MODEL_LABEL(): string {
  return extractionModelId();
}

/** @deprecated Use `extractionModelId()`. */
export const EXTRACTION_MODEL = 'gemini-3.5-flash-lite';

const MAX_CRAWL_RESPONSE_BYTES = 8_000_000;

function crawl4aiDomainAllowed(config: Crawl4AiConfig, hostname: string): boolean {
  const allowlist = config.allowedDomains
    .map((value) => value.trim().toLowerCase().replace(/\.$/, ''))
    .filter((value) => value.length > 0);
  // A bare '*' entry is the host's explicit open-web opt-in (news-style
  // arbitrary-domain crawling). It waives only the per-domain review: the
  // versioned network guard and every SSRF check (public-only DNS, pinned
  // connection, redirect revalidation) still bind.
  if (allowlist.includes('*')) return true;
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) => {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2);
      return suffix.length > 0 && normalized.endsWith(`.${suffix}`);
    }
    return normalized === entry;
  });
}

async function crawlResultMatchesTarget(
  config: Crawl4AiConfig,
  initial: URL,
  resultUrl: string,
): Promise<boolean> {
  if (resultUrl.length === 0) return false;
  try {
    const finalTarget = await resolvePublicHttpUrl(resultUrl);
    if (finalTarget.url.hostname.toLowerCase() !== initial.hostname.toLowerCase()) return false;
    if (initial.protocol === 'https:' && finalTarget.url.protocol !== 'https:') return false;
    return crawl4aiDomainAllowed(config, finalTarget.url.hostname);
  } catch {
    return false;
  }
}

/**
 * The URL a crawl result was actually served from. Crawl4AI 0.8.x reports the
 * post-redirect URL at top level (`redirected_url`); older revisions put it in
 * `metadata.url`. The bare top-level `url` is the REQUESTED URL and is never
 * consulted here: trusting it would pass a silent cross-host redirect through
 * the check that exists to refuse one. Empty when the server reports neither,
 * and the match then fails closed. Measured against ora-scraper (Crawl4AI
 * 0.8.9) on 2026-08-16: `metadata.url` is null there, so reading it alone
 * rejected every crawl as target_mismatch.
 */
function crawlResultServedUrl(result: { redirected_url: string; metadata: { url: string } }): string {
  if (result.redirected_url.length > 0) return result.redirected_url;
  return result.metadata.url;
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
 * Which lane produced the text in a CrawlUrlDetailedResult.
 */
export type CrawlMethod = 'crawl4ai' | 'direct_fetch';

/**
 * Why the Crawl4AI lane did not serve a crawl. Surfaced so a caller's ledger
 * can record that the primary lane declined — and why — instead of silently
 * metering a direct fetch as a crawl.
 */
export type Crawl4AIDeclineReason =
  | 'not_configured'
  | 'network_guard_not_enforced'
  | 'domain_not_allowed'
  | 'submission_failed'
  | 'invalid_response_shape'
  | 'target_mismatch'
  | 'empty_markdown'
  | 'no_task_id'
  | 'poll_failed'
  | 'poll_timeout'
  | 'crawl_error'
  | 'content_too_short';

export interface CrawlUrlDetailedResult {
  /** The extracted text, or null when neither lane produced anything usable. */
  text: string | null;
  /** Which lane served `text`; null when `text` is null. */
  method: CrawlMethod | null;
  /** Why the Crawl4AI lane did not serve, when it did not. */
  declinedReason?: Crawl4AIDeclineReason;
}

interface Crawl4AIOutcome {
  text: string | null;
  reason?: Crawl4AIDeclineReason;
}

/**
 * Crawl a URL using Crawl4AI (ora-scraper).
 * Handles both sync (results inline) and async (task ID + poll) response modes.
 */
export async function crawlWithCrawl4AI(
  credentials: ResearchCredentials,
  url: string,
): Promise<string | null> {
  const outcome = await crawlWithCrawl4AIDiagnosed(credentials, url);
  return outcome.text;
}

async function crawlWithCrawl4AIDiagnosed(
  credentials: ResearchCredentials,
  url: string,
): Promise<Crawl4AIOutcome> {
  try {
    const config = credentials.crawl4ai;
    if (config === undefined) {
      logger.debug({}, '[Crawl4AI] External browser crawler is not configured');
      return { text: null, reason: 'not_configured' };
    }
    if (config.networkGuard !== CRAWL4AI_NETWORK_GUARD_VALUE) {
      logger.debug({}, '[Crawl4AI] External browser crawler is disabled without an enforced network guard');
      return { text: null, reason: 'network_guard_not_enforced' };
    }
    const target = await resolvePublicHttpUrl(url);
    if (!crawl4aiDomainAllowed(config, target.url.hostname)) {
      logger.debug(
        { target: outboundTargetFingerprint(url) },
        '[Crawl4AI] Target is not in the reviewed crawler domain allowlist',
      );
      return { text: null, reason: 'domain_not_allowed' };
    }
    const response = await fetchWithRetry(
      `${config.baseUrl}/crawl`,
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
      return { text: null, reason: 'submission_failed' };
    }

    const responseText = await readBoundedWebResponseText(response, MAX_CRAWL_RESPONSE_BYTES);
    const rawJson: unknown = JSON.parse(responseText);
    const parseResult = CrawlTaskResponseSchema.safeParse(rawJson);
    if (!parseResult.success) {
      logger.warn(
        { target: outboundTargetFingerprint(url), errors: parseResult.error.message },
        '[Crawl4AI] Invalid response shape',
      );
      return { text: null, reason: 'invalid_response_shape' };
    }
    const responseData = parseResult.data;

    // Handle sync response (results inline) — Crawl4AI 0.8.x returns results directly
    if (responseData.results !== undefined && responseData.results.length > 0) {
      const first = responseData.results[0];
      if (first !== undefined) {
        if (!await crawlResultMatchesTarget(config, target.url, crawlResultServedUrl(first))) {
          logger.warn(
            { target: outboundTargetFingerprint(url) },
            '[Crawl4AI] Result target did not match the reviewed source',
          );
          return { text: null, reason: 'target_mismatch' };
        }
        const md = extractMarkdown(first.markdown as string | MarkdownDict);
        if (md.length > 100) {
          logger.info(
            { target: outboundTargetFingerprint(url), chars: md.length },
            '[Crawl4AI] Sync success',
          );
          return { text: md };
        }
      }
      logger.warn(
        { target: outboundTargetFingerprint(url) },
        '[Crawl4AI] Sync response had empty markdown',
      );
      return { text: null, reason: 'empty_markdown' };
    }

    // Handle async response (task ID) — older Crawl4AI versions
    if (!responseData.success || responseData.id.length === 0) {
      logger.warn(
        { target: outboundTargetFingerprint(url) },
        '[Crawl4AI] No task ID and no inline results',
      );
      return { text: null, reason: 'no_task_id' };
    }

    // Poll for result
    for (let attempt = 0; attempt < CRAWL_POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(CRAWL_POLL_INTERVAL_MS);

      const statusResp = await fetch(`${config.baseUrl}/task/${responseData.id}`, {
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
            if (!await crawlResultMatchesTarget(config, target.url, crawlResultServedUrl(first))) {
              logger.warn(
                { target: outboundTargetFingerprint(url) },
                '[Crawl4AI] Result target did not match the reviewed source',
              );
              return { text: null, reason: 'target_mismatch' };
            }
            const md = extractMarkdown(first.markdown as string | MarkdownDict);
            if (md.length > 100) return { text: md };
          }
        }
        return { text: null, reason: 'empty_markdown' };
      }
      if (statusData.status === 'failed') return { text: null, reason: 'poll_failed' };
    }

    logger.warn(
      { target: outboundTargetFingerprint(url), taskId: responseData.id },
      '[Crawl4AI] Poll timed out',
    );
    return { text: null, reason: 'poll_timeout' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { target: outboundTargetFingerprint(url), error: msg },
      '[Crawl4AI] Crawl error',
    );
    return { text: null, reason: 'crawl_error' };
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
 * Orchestrator: Crawl4AI (self-hosted, $0) → DirectFetch (plain HTML).
 *
 * Jina Reader used to sit between these two. It was removed in 0.9.0: its job
 * was rendering JS/paywalled pages that a plain crawl fails on, and Tavily's
 * `include_raw_content` now does that earlier, better, and for free at the
 * search step — the caller short-circuits on raw content before any fetch
 * runs. What was left for Jina was a third attempt at pages the first two had
 * already failed on, from a hosted reader whose free tier rate-limits, costing
 * a full 30s-timeout round-trip on the slowest path.
 */
export async function crawlUrl(
  credentials: ResearchCredentials,
  url: string,
): Promise<string | null> {
  const result = await crawlUrlDetailed(credentials, url);
  return result.text;
}

/**
 * crawlUrl with provenance. The direct-fetch fallback is deliberate, but a
 * caller that cannot tell which lane served also cannot tell a healthy crawl
 * service from a silently degraded one — auspex metered days of direct fetches
 * as `service: 'crawl4ai'` before this existed (2026-08-16). The reason enum
 * is aggregation-friendly on purpose: group by it.
 */
export async function crawlUrlDetailed(
  credentials: ResearchCredentials,
  url: string,
): Promise<CrawlUrlDetailedResult> {
  const crawled = await crawlWithCrawl4AIDiagnosed(credentials, url);
  if (crawled.text !== null && crawled.text.trim().length >= 200) {
    return { text: crawled.text, method: 'crawl4ai' };
  }
  let declinedReason: Crawl4AIDeclineReason;
  if (crawled.text !== null) {
    declinedReason = 'content_too_short';
  } else if (crawled.reason !== undefined) {
    declinedReason = crawled.reason;
  } else {
    declinedReason = 'crawl_error';
  }
  const fetched = await directFetchAsText(url);
  if (fetched !== null) {
    return { text: fetched, method: 'direct_fetch', declinedReason };
  }
  return { text: null, method: null, declinedReason };
}
