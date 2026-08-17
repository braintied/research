/**
 * TikTok Search Provider
 *
 * Search + comment-rich fetch: Apify actor `clockworks/free-tiktok-scraper`
 * (searches by query string, returns videos with inline comments when
 * `shouldDownloadComments: true`).
 *
 * Preferred path (Bright Data, same datasets as Swishh production):
 *   - keyword discovery: discover_new + discover_by=keyword on posts dataset
 *     `gd_lu702nij2f790tmv9h`
 *   - URL fetch: synchronous scrape on the same posts dataset
 *
 * Apify (`clockworks/free-tiktok-scraper`) is last-resort only and requires
 * both APIFY_API_TOKEN and APIFY_ALLOW_FALLBACK=1.
 *
 * Env: BRIGHTDATA_API_TOKEN (primary). Optional APIFY_* for explicit fallback.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import {
  isApifyFallbackAllowed,
  type ResearchCredentials,
} from '../credentials.js';
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
import { discoverAndDownload, scrapeDataset } from './brightdata.js';

// =============================================================================
// Rate limiter — 5-second queue between Apify calls
// =============================================================================

const TT_RATE_LIMIT_MS = 5000;
let lastTtCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastTtCallAt;
  if (elapsed < TT_RATE_LIMIT_MS) {
    await sleep(TT_RATE_LIMIT_MS - elapsed);
  }
  lastTtCallAt = Date.now();
}

// =============================================================================
// Apify API helpers
// =============================================================================

const APIFY_BASE_URL = 'https://api.apify.com/v2';
const ACTOR_ID = 'clockworks/free-tiktok-scraper';
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 5 * 60 * 1_000;

function apifyTokenOf(credentials: ResearchCredentials): string | null {
  if (credentials.apifyApiToken === undefined) return null;
  return credentials.apifyApiToken;
}

function brightDataTokenOf(credentials: ResearchCredentials): string | null {
  if (credentials.brightdata === undefined) return null;
  return credentials.brightdata.apiToken;
}

function hasAnyBackend(credentials: ResearchCredentials): boolean {
  return (
    brightDataTokenOf(credentials) !== null || isApifyFallbackAllowed(credentials)
  );
}

interface ApifyRunData {
  id: string;
  defaultDatasetId: string;
  status: string;
  usageTotalUsd?: number;
}

async function startApifyRun(
  actorId: string,
  input: Record<string, unknown>,
  token: string,
): Promise<{ runId: string; datasetId: string }> {
  const url = `${APIFY_BASE_URL}/acts/${encodeURIComponent(actorId)}/runs?token=${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Apify start error (${actorId}): HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as { data: ApifyRunData };
  const runId = json.data.id;
  const datasetId = json.data.defaultDatasetId;

  if (runId === '' || runId === undefined) {
    throw new Error(`Apify actor "${actorId}" start response missing run id`);
  }

  return { runId, datasetId };
}

async function pollRunUntilDone(runId: string, token: string): Promise<{ usageUsd: number }> {
  const startTime = Date.now();
  const statusUrl = `${APIFY_BASE_URL}/actor-runs/${runId}?token=${token}`;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Apify poll error: HTTP ${response.status} ${body.slice(0, 100)}`);
    }

    const json = (await response.json()) as { data: ApifyRunData };
    const status = json.data.status;

    if (status === 'SUCCEEDED') {
      const usageUsd = json.data.usageTotalUsd !== undefined ? json.data.usageTotalUsd : 0;
      return { usageUsd };
    }

    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run "${runId}" ended with status "${status}"`);
    }
  }

  throw new Error(`Apify run "${runId}" timed out after ${MAX_WAIT_MS / 1000}s`);
}

async function fetchDatasetItems(datasetId: string, token: string): Promise<unknown[]> {
  const url = `${APIFY_BASE_URL}/datasets/${datasetId}/items?token=${token}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Apify dataset fetch error: HTTP ${response.status} ${body.slice(0, 100)}`);
  }

  return (await response.json()) as unknown[];
}

// =============================================================================
// Bright Data scrape fallback (TikTok posts dataset)
// =============================================================================

const BRIGHTDATA_TIKTOK_POSTS_DATASET = 'gd_lu702nij2f790tmv9h';

// Bright Data dataset field names drift between snake_case variants across
// dataset versions — read every observed candidate, first defined wins.
const BrightDataTikTokRecordSchema = z.object({
  url: z.string().optional(),
  post_id: z.string().optional(),
  id: z.string().optional(),
  description: z.string().optional(),
  desc: z.string().optional(),
  text: z.string().optional(),
  create_time: z.union([z.string(), z.number()]).optional(),
  createTime: z.union([z.string(), z.number()]).optional(),
  profile_username: z.string().optional(),
  author_name: z.string().optional(),
  play_count: z.number().optional(),
  playcount: z.number().optional(),
  digg_count: z.number().optional(),
  diggcount: z.number().optional(),
  comment_count: z.number().optional(),
  commentcount: z.number().optional(),
  share_count: z.number().optional(),
  sharecount: z.number().optional(),
  error: z.string().optional(),
}).passthrough();

type BrightDataTikTokRecord = z.infer<typeof BrightDataTikTokRecordSchema>;

function bdCaption(record: BrightDataTikTokRecord): string {
  if (record.description !== undefined && record.description.length > 0) return record.description;
  if (record.desc !== undefined && record.desc.length > 0) return record.desc;
  if (record.text !== undefined) return record.text;
  return '';
}

function bdAuthor(record: BrightDataTikTokRecord): string | undefined {
  const handle = record.profile_username !== undefined && record.profile_username.length > 0
    ? record.profile_username
    : record.author_name;
  if (handle === undefined || handle.length === 0) return undefined;
  return handle.startsWith('@') ? handle : `@${handle}`;
}

function bdCount(...candidates: Array<number | undefined>): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

function bdPublishedAt(record: BrightDataTikTokRecord): string | undefined {
  const value = record.create_time !== undefined ? record.create_time : record.createTime;
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    if (Number.isFinite(d.getTime())) return d.toISOString();
    return undefined;
  }
  return toIsoString(value);
}

/**
 * Fetch a single TikTok video via Bright Data's immediate-or-snapshot scrape.
 * Returns null on any failure so the caller can report the combined error.
 */
async function fetchViaBrightData(
  credentials: ResearchCredentials,
  url: string,
): Promise<FetchResult | null> {
  let records: unknown;
  try {
    records = await scrapeDataset(credentials, BRIGHTDATA_TIKTOK_POSTS_DATASET, [{ url }], {
      maxWaitMs: 180_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ url: url.slice(0, 60), error: msg.slice(0, 100) }, '[TikTok] Bright Data scrape failed');
    return null;
  }

  const recordArray = Array.isArray(records) ? records : [records];
  if (recordArray.length === 0) return null;

  const parsed = BrightDataTikTokRecordSchema.safeParse(recordArray[0]);
  if (!parsed.success) return null;

  const record = parsed.data;
  if (record.error !== undefined && record.error.length > 0) {
    logger.warn({ url: url.slice(0, 60), error: record.error.slice(0, 100) }, '[TikTok] Bright Data record error');
    return null;
  }

  const caption = bdCaption(record);
  if (caption.length === 0) return null;

  const author = bdAuthor(record);
  const views = bdCount(record.play_count, record.playcount);
  const likes = bdCount(record.digg_count, record.diggcount);
  const commentCount = bdCount(record.comment_count, record.commentcount);
  const shares = bdCount(record.share_count, record.sharecount);

  const lines: string[] = [
    `# TikTok: ${caption.slice(0, 100)}`,
    '',
    `**Creator:** ${author !== undefined ? author : 'Unknown'} | **Views:** ${views !== undefined ? views : 0} | **Likes:** ${likes !== undefined ? likes : 0}`,
    '',
    '## Caption',
    '',
    caption,
    '',
  ];

  const canonicalId = record.post_id !== undefined && record.post_id.length > 0
    ? record.post_id
    : record.id;

  return FetchResultSchema.parse({
    provider: 'tiktok',
    url,
    canonical_id: canonicalId !== undefined && canonicalId.length > 0 ? canonicalId : undefined,
    title: caption.slice(0, 200),
    author,
    published_at: bdPublishedAt(record),
    raw_content: caption,
    markdown: lines.join('\n'),
    engagement: {
      view_count: views,
      like_count: likes,
      comment_count: commentCount,
    },
    fetch_status: 'ok',
    raw_metadata: {
      share_count: shares,
      backend: 'brightdata',
    },
  });
}

// =============================================================================
// TikTok item schema (clockworks/free-tiktok-scraper output shape)
// =============================================================================

const TikTokAuthorMetaSchema = z.object({
  name: z.string().optional(),
  nickName: z.string().optional(),
  id: z.string().optional(),
}).passthrough();

const TikTokCommentSchema = z.object({
  text: z.string().optional(),
  uniqueId: z.string().optional(),
  diggCount: z.number().optional(),
  createTime: z.number().optional(),
}).passthrough();

const TikTokItemSchema = z.object({
  id: z.string().optional(),
  webVideoUrl: z.string().optional(),
  text: z.string().optional(),
  createTimeISO: z.string().optional(),
  createTime: z.number().optional(),
  authorMeta: TikTokAuthorMetaSchema.optional(),
  playCount: z.number().optional(),
  diggCount: z.number().optional(),
  commentCount: z.number().optional(),
  shareCount: z.number().optional(),
  comments: z.array(TikTokCommentSchema).optional(),
}).passthrough();

// =============================================================================
// Helpers
// =============================================================================

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

function unixToIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function extractVideoUrl(item: z.infer<typeof TikTokItemSchema>): string | null {
  if (item.webVideoUrl !== undefined && item.webVideoUrl.length > 0) {
    return item.webVideoUrl;
  }
  if (item.id !== undefined && item.id.length > 0) {
    return `https://www.tiktok.com/@unknown/video/${item.id}`;
  }
  return null;
}

function extractAuthor(item: z.infer<typeof TikTokItemSchema>): string | undefined {
  if (item.authorMeta === undefined) return undefined;
  const name = item.authorMeta.nickName !== undefined && item.authorMeta.nickName.length > 0
    ? item.authorMeta.nickName
    : item.authorMeta.name;
  if (name === undefined || name.length === 0) return undefined;
  return `@${name}`;
}

function extractPublishedAt(item: z.infer<typeof TikTokItemSchema>): string | undefined {
  if (item.createTimeISO !== undefined && item.createTimeISO.length > 0) {
    return toIsoString(item.createTimeISO);
  }
  if (item.createTime !== undefined && item.createTime > 0) {
    return unixToIso(item.createTime);
  }
  return undefined;
}

// =============================================================================
// Provider
// =============================================================================

export function createTiktokProvider(credentials: ResearchCredentials): SearchProvider {
  return {
    name: 'tiktok',

    capabilities: {
      search: true,
      fetch: true,
      extract: true,
      backends: ['brightdata', 'apify'],
    },

    enabled: hasAnyBackend(credentials),

    async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
      const limit = opts.limit !== undefined ? Math.min(opts.limit, 25) : 15;

      // Primary: Bright Data keyword discovery (same path as Swishh production).
      if (brightDataTokenOf(credentials) !== null) {
        try {
          const records = await discoverAndDownload(
            credentials,
            BRIGHTDATA_TIKTOK_POSTS_DATASET,
            'keyword',
            { keyword: query, num_of_posts: limit },
          );
          const results: SearchResult[] = [];
          for (const record of records) {
            const parsed = BrightDataTikTokRecordSchema.safeParse(record);
            if (!parsed.success) continue;
            const item = parsed.data;
            if (item.error !== undefined && item.error.length > 0) continue;
            const videoUrl =
              item.url !== undefined && item.url.length > 0 ? item.url : null;
            if (videoUrl === null) continue;
            const caption = bdCaption(item);
            const candidate = {
              provider: 'tiktok' as const,
              url: videoUrl,
              canonical_id:
                item.id !== undefined && item.id.length > 0
                  ? item.id
                  : item.post_id !== undefined && item.post_id.length > 0
                    ? item.post_id
                    : undefined,
              title: caption.slice(0, 200),
              snippet: caption.slice(0, 300),
              author: bdAuthor(item),
              published_at: bdPublishedAt(item),
              engagement: {
                view_count: bdCount(item.play_count, item.playcount),
                like_count: bdCount(item.digg_count, item.diggcount),
                comment_count: bdCount(item.comment_count, item.commentcount),
              },
              raw_metadata: {
                backend: 'brightdata',
                dataset_id: BRIGHTDATA_TIKTOK_POSTS_DATASET,
              },
            };
            const validated = SearchResultSchema.safeParse(candidate);
            if (validated.success) results.push(validated.data);
          }
          logger.info(
            { query: query.slice(0, 60), count: results.length, backend: 'brightdata' },
            '[TikTok] Search complete',
          );
          if (results.length > 0 || !isApifyFallbackAllowed(credentials)) {
            return results;
          }
          logger.warn(
            { query: query.slice(0, 60) },
            '[TikTok] Bright Data keyword discovery empty — trying Apify fallback',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            { query: query.slice(0, 60), error: msg.slice(0, 120) },
            '[TikTok] Bright Data keyword discovery failed',
          );
          if (!isApifyFallbackAllowed(credentials)) {
            return [];
          }
        }
      }

      if (!isApifyFallbackAllowed(credentials)) {
        logger.warn(
          { query: query.slice(0, 60) },
          '[TikTok] No Bright Data path and APIFY_ALLOW_FALLBACK is not set — search disabled',
        );
        return [];
      }

      const token = apifyTokenOf(credentials);
      if (token === null) {
        return [];
      }
      await rateLimit();

      const input: Record<string, unknown> = {
        searchQueries: [query],
        resultsPerPage: limit,
        shouldDownloadComments: true,
        shouldDownloadCommentReplies: false,
      };

      let items: unknown[] = [];

      try {
        const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
        await pollRunUntilDone(runId, token);
        items = await fetchDatasetItems(datasetId, token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ query: query.slice(0, 60), error: msg }, '[TikTok] Apify search failed');
        return [];
      }

      const results: SearchResult[] = [];

      for (const rawItem of items) {
        const parsed = TikTokItemSchema.safeParse(rawItem);
        if (!parsed.success) continue;

        const item = parsed.data;
        const videoUrl = extractVideoUrl(item);
        if (videoUrl === null) continue;

        const caption = item.text !== undefined ? item.text : '';

        const candidate = {
          provider: 'tiktok' as const,
          url: videoUrl,
          canonical_id: item.id !== undefined && item.id.length > 0 ? item.id : undefined,
          title: caption.slice(0, 200),
          snippet: caption.slice(0, 300),
          author: extractAuthor(item),
          published_at: extractPublishedAt(item),
          engagement: {
            view_count: item.playCount,
            like_count: item.diggCount,
            comment_count: item.commentCount,
          },
          raw_metadata: {
            backend: 'apify',
            share_count: item.shareCount,
            comments: item.comments !== undefined ? item.comments.slice(0, 50) : [],
          },
        };

        const validated = SearchResultSchema.safeParse(candidate);
        if (validated.success) {
          results.push(validated.data);
        }
      }

      logger.info(
        { query: query.slice(0, 60), count: results.length, backend: 'apify' },
        '[TikTok] Search complete',
      );

      return results;
    },

    async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
      // signal reserved for future cancellation support
      void signal;

      const apifyToken = apifyTokenOf(credentials);
      const brightDataToken = brightDataTokenOf(credentials);

      // Braintied policy: prefer Bright Data for URL acquisition.
      // Apify is last-resort only (APIFY_ALLOW_FALLBACK=1).
      if (brightDataToken !== null) {
        const bdResult = await fetchViaBrightData(credentials, url);
        if (bdResult !== null) {
          logger.info({ url: url.slice(0, 60), backend: 'brightdata' }, '[TikTok] Fetch complete');
          return bdResult;
        }
        if (!isApifyFallbackAllowed(credentials)) {
          return FetchResultSchema.parse({
            provider: 'tiktok',
            url,
            fetch_status: 'failed',
            fetch_error: 'Bright Data fetch failed and APIFY_ALLOW_FALLBACK is not set',
          });
        }
        logger.warn(
          { url: url.slice(0, 60) },
          '[TikTok] Bright Data fetch failed — trying Apify fallback',
        );
      }

      // Extract video ID from URL for targeted fetch
      const videoIdMatch = /\/video\/(\d+)/.exec(url);
      const videoId = videoIdMatch !== null ? videoIdMatch[1] : null;

      let apifyError = isApifyFallbackAllowed(credentials)
        ? 'APIFY_API_TOKEN not configured'
        : 'APIFY_ALLOW_FALLBACK is not set (Bright Data is the primary path)';

      if (isApifyFallbackAllowed(credentials) && apifyToken !== null) {
        await rateLimit();

        const input: Record<string, unknown> = videoId !== null
          ? {
              videoUrls: [url],
              commentsPerPage: 100,
              shouldDownloadComments: true,
              shouldDownloadCommentReplies: false,
            }
          : {
              searchQueries: [url],
              resultsPerPage: 1,
              shouldDownloadComments: true,
              shouldDownloadCommentReplies: false,
            };

        try {
          const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, apifyToken);
          await pollRunUntilDone(runId, apifyToken);
          const items = await fetchDatasetItems(datasetId, apifyToken);
          const firstItem = items[0];

          if (firstItem === undefined) {
            apifyError = 'No items returned from Apify';
          } else {
            const parsed = TikTokItemSchema.safeParse(firstItem);
            if (!parsed.success) {
              apifyError = `Invalid item shape: ${parsed.error.message.slice(0, 100)}`;
            } else {
              const item = parsed.data;
              const caption = item.text !== undefined ? item.text : '';
              const author = extractAuthor(item);

              // Build markdown with caption + top comments
              const lines: string[] = [
                `# TikTok: ${caption.slice(0, 100)}`,
                '',
                `**Creator:** ${author !== undefined ? author : 'Unknown'} | **Views:** ${item.playCount !== undefined ? item.playCount : 0} | **Likes:** ${item.diggCount !== undefined ? item.diggCount : 0}`,
                '',
                '## Caption',
                '',
                caption,
                '',
              ];

              const comments = item.comments;
              if (comments !== undefined && Array.isArray(comments) && comments.length > 0) {
                lines.push('## Top Comments', '');

                // Sort by diggCount desc
                const sortedComments = [...comments]
                  .map(c => TikTokCommentSchema.safeParse(c))
                  .filter(r => r.success)
                  .map(r => r.data)
                  .sort((a, b) => (b.diggCount !== undefined ? b.diggCount : 0) - (a.diggCount !== undefined ? a.diggCount : 0))
                  .slice(0, 100);

                for (const comment of sortedComments) {
                  const commentText = comment.text !== undefined ? comment.text : '';
                  if (commentText.length === 0) continue;
                  const commentAuthor = comment.uniqueId !== undefined ? `@${comment.uniqueId}` : 'Unknown';
                  lines.push(`**${commentAuthor}** (${comment.diggCount !== undefined ? comment.diggCount : 0} likes)`);
                  lines.push('');
                  lines.push(commentText);
                  lines.push('');
                  lines.push('---');
                  lines.push('');
                }
              }

              const markdown = lines.join('\n');

              const result = FetchResultSchema.parse({
                provider: 'tiktok',
                url,
                canonical_id: item.id !== undefined && item.id.length > 0 ? item.id : undefined,
                title: caption.slice(0, 200),
                author,
                published_at: extractPublishedAt(item),
                raw_content: caption,
                markdown,
                engagement: {
                  view_count: item.playCount,
                  like_count: item.diggCount,
                  comment_count: item.commentCount,
                },
                fetch_status: 'ok',
                raw_metadata: {
                  share_count: item.shareCount,
                  comments: item.comments !== undefined ? item.comments.slice(0, 100) : [],
                  backend: 'apify',
                },
              });

              logger.info(
                { url: url.slice(0, 60), comments: comments !== undefined ? comments.length : 0, backend: 'apify' },
                '[TikTok] Fetch complete',
              );

              return result;
            }
          }
        } catch (err) {
          apifyError = err instanceof Error ? err.message : String(err);
        }

        logger.warn(
          { url: url.slice(0, 60), error: apifyError.slice(0, 100) },
          '[TikTok] Apify fallback fetch failed',
        );
      }

      return FetchResultSchema.parse({
        provider: 'tiktok',
        url,
        fetch_status: 'failed',
        fetch_error: `TikTok fetch failed: ${apifyError.slice(0, 150)}`,
      });
    },

    async extract(raw: FetchResult): Promise<ExtractedQuotes> {
      const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
      return extractQuotesWithGemini({
        credentials,
        provider: 'tiktok',
        url: raw.url,
        content,
        mode: 'reddit', // closest equivalent — comment threads with engagement
      });
    },
  };
}
