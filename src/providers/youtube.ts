/**
 * YouTube Search Provider
 *
 * Uses YouTube Data API v3 for search + statistics + comments.
 * Transcript via youtube-transcript package (reused from advice-youtube.ts pattern).
 * Rate limit: 100 req/min (well under 10,000 units/day quota).
 *
 * Phase 1.5 enhancements:
 * - 200 comments per video (500 for >1M views), paginated
 * - Reply trees for top 30 comments by likeCount
 * - order=relevance enforced
 * - Transcript segments prefixed with [t=<sec>] for timestamp anchoring
 * - Quota-aware throttle: sleep if >100 API calls in <60s
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
import { fetchYouTubeTranscript, extractVideoId } from '../advice-youtube.js';

// =============================================================================
// Rate limiter — 100 req/min = 1 req per 620ms
// =============================================================================

const YT_RATE_LIMIT_MS = 650;
let lastYtCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastYtCallAt;
  if (elapsed < YT_RATE_LIMIT_MS) {
    await sleep(YT_RATE_LIMIT_MS - elapsed);
  }
  lastYtCallAt = Date.now();
}

// =============================================================================
// Quota-aware throttle — YouTube Data API: 10,000 units/day
// commentThreads.list = 1 unit, comments.list = 1 unit
// If >100 calls happen in <60s, sleep to avoid burst exhaustion
// =============================================================================

const YT_QUOTA_WINDOW_MS = 60_000;
const YT_QUOTA_BURST_CAP = 100;
const ytCallTimestamps: number[] = [];

async function quotaAwareThrottle(): Promise<void> {
  const now = Date.now();
  // Evict entries older than the window
  while (ytCallTimestamps.length > 0 && (ytCallTimestamps[0] !== undefined) && ytCallTimestamps[0] < now - YT_QUOTA_WINDOW_MS) {
    ytCallTimestamps.shift();
  }
  if (ytCallTimestamps.length >= YT_QUOTA_BURST_CAP) {
    const oldest = ytCallTimestamps[0];
    if (oldest !== undefined) {
      const waitMs = YT_QUOTA_WINDOW_MS - (now - oldest) + 100;
      if (waitMs > 0) {
        logger.info({ waitMs }, '[YouTube] Quota burst cap reached, throttling');
        await sleep(waitMs);
      }
    }
  }
  ytCallTimestamps.push(Date.now());
}

// =============================================================================
// API key
// =============================================================================

function getApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (key === undefined || key === '') {
    throw new Error('YOUTUBE_API_KEY environment variable is not configured');
  }
  return key;
}

function isEnabled(): boolean {
  const key = process.env.YOUTUBE_API_KEY;
  return key !== undefined && key !== '';
}

// =============================================================================
// YouTube API response schemas
// =============================================================================

const YtSearchItemSchema = z.object({
  id: z.object({
    videoId: z.string().optional(),
  }),
  snippet: z.object({
    title: z.string().default(''),
    description: z.string().default(''),
    channelTitle: z.string().default(''),
    publishedAt: z.string().default(''),
    channelId: z.string().default(''),
  }),
});

const YtSearchResponseSchema = z.object({
  items: z.array(YtSearchItemSchema).default([]),
});

const YtVideoItemSchema = z.object({
  id: z.string(),
  statistics: z.object({
    viewCount: z.string().optional(),
    likeCount: z.string().optional(),
    commentCount: z.string().optional(),
  }).default({}),
  contentDetails: z.object({
    duration: z.string().default(''),
  }).default({ duration: '' }),
});

const YtVideosResponseSchema = z.object({
  items: z.array(YtVideoItemSchema).default([]),
});

const YtCommentThreadItemSchema = z.object({
  id: z.string().default(''),
  snippet: z.object({
    topLevelComment: z.object({
      id: z.string().default(''),
      snippet: z.object({
        textDisplay: z.string().default(''),
        authorDisplayName: z.string().default(''),
        likeCount: z.number().default(0),
        publishedAt: z.string().default(''),
      }),
    }),
    totalReplyCount: z.number().default(0),
  }),
});

const YtCommentThreadsResponseSchema = z.object({
  items: z.array(YtCommentThreadItemSchema).default([]),
  nextPageToken: z.string().optional(),
});

// Reply thread (comments.list with parentId)
const YtReplyItemSchema = z.object({
  id: z.string().default(''),
  snippet: z.object({
    textDisplay: z.string().default(''),
    authorDisplayName: z.string().default(''),
    likeCount: z.number().default(0),
    publishedAt: z.string().default(''),
  }),
});

const YtRepliesResponseSchema = z.object({
  items: z.array(YtReplyItemSchema).default([]),
});

// =============================================================================
// Helpers
// =============================================================================

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

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

function safeParseInt(val: string | undefined): number | undefined {
  if (val === undefined || val === '') return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

async function fetchVideoStats(
  videoIds: string[],
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<Map<string, { viewCount: number | undefined; likeCount: number | undefined; commentCount: number | undefined }>> {
  const map = new Map<string, { viewCount: number | undefined; likeCount: number | undefined; commentCount: number | undefined }>();

  if (videoIds.length === 0) return map;

  // Batch by 50
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    await rateLimit();

    const params = new URLSearchParams({
      part: 'statistics,contentDetails',
      id: batch.join(','),
      key: apiKey,
    });

    const response = await fetch(`${YT_BASE}/videos?${params.toString()}`, {
      signal: signal !== undefined ? signal : AbortSignal.timeout(15000),
    });

    if (!response.ok) continue;

    const rawJson: unknown = await response.json();
    const parsed = YtVideosResponseSchema.safeParse(rawJson);
    if (!parsed.success) continue;

    for (const item of parsed.data.items) {
      map.set(item.id, {
        viewCount: safeParseInt(item.statistics.viewCount),
        likeCount: safeParseInt(item.statistics.likeCount),
        commentCount: safeParseInt(item.statistics.commentCount),
      });
    }
  }

  return map;
}

// =============================================================================
// Provider
// =============================================================================

export const youtubeProvider: SearchProvider = {
  name: 'youtube',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const apiKey = getApiKey();
    await rateLimit();

    const params: Record<string, string> = {
      part: 'snippet',
      q: query,
      type: 'video',
      maxResults: String(opts.limit !== undefined ? Math.min(opts.limit, 50) : 15),
      order: 'relevance',
      key: apiKey,
    };

    if (opts.recency_days !== undefined && opts.recency_days > 0) {
      const cutoff = new Date(Date.now() - opts.recency_days * 24 * 60 * 60 * 1000);
      params['publishedAfter'] = cutoff.toISOString();
    }

    const searchParams = new URLSearchParams(params);

    const response = await fetch(`${YT_BASE}/search?${searchParams.toString()}`, {
      signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`YouTube search error: ${response.status} ${body.slice(0, 200)}`);
    }

    const rawJson: unknown = await response.json();
    const parsed = YtSearchResponseSchema.safeParse(rawJson);

    if (!parsed.success) {
      logger.warn({ query: query.slice(0, 60), errors: parsed.error.message }, '[YouTube] Invalid search response');
      return [];
    }

    // Collect video IDs for batch stats fetch
    const videoIds: string[] = [];
    for (const item of parsed.data.items) {
      const vid = item.id.videoId;
      if (vid !== undefined && vid.length > 0) {
        videoIds.push(vid);
      }
    }

    const statsMap = await fetchVideoStats(videoIds, apiKey, opts.signal);

    const results: SearchResult[] = [];

    for (const item of parsed.data.items) {
      const videoId = item.id.videoId;
      if (videoId === undefined || videoId.length === 0) continue;

      const stats = statsMap.get(videoId);
      const publishedAt = toIsoString(item.snippet.publishedAt);

      const candidate = {
        provider: 'youtube' as const,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        canonical_id: videoId,
        title: item.snippet.title,
        snippet: item.snippet.description.slice(0, 500),
        author: item.snippet.channelTitle.length > 0 ? item.snippet.channelTitle : undefined,
        published_at: publishedAt,
        engagement: {
          view_count: stats !== undefined ? stats.viewCount : undefined,
          like_count: stats !== undefined ? stats.likeCount : undefined,
          comment_count: stats !== undefined ? stats.commentCount : undefined,
        },
        raw_metadata: {
          channel_id: item.snippet.channelId,
        },
      };

      const validated = SearchResultSchema.safeParse(candidate);
      if (validated.success) {
        results.push(validated.data);
      }
    }

    logger.info(
      { query: query.slice(0, 60), count: results.length },
      '[YouTube] Search complete',
    );

    return results;
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    const apiKey = getApiKey();

    const videoId = extractVideoId(url);
    if (videoId === null) {
      return FetchResultSchema.parse({
        provider: 'youtube',
        url,
        fetch_status: 'failed',
        fetch_error: `Could not extract video ID from URL: ${url}`,
      });
    }

    // Fetch transcript using existing helper
    const transcriptResult = await fetchYouTubeTranscript(url);

    // Determine comment budget: 500 for videos >1M views, else 200
    const viewCount = transcriptResult.viewCount;
    const maxCommentTarget = viewCount > 1_000_000 ? 500 : 200;

    // -------------------------------------------------------------------------
    // Phase 1.5: Paginated comment fetch (up to maxCommentTarget), order=relevance
    // -------------------------------------------------------------------------
    type CommentRecord = { id: string; author: string; text: string; likes: number; publishedAt: string; totalReplyCount: number };
    let topComments: CommentRecord[] = [];

    try {
      let pageToken: string | undefined = undefined;
      let fetched = 0;

      while (fetched < maxCommentTarget) {
        const remaining = maxCommentTarget - fetched;
        const pageSize = Math.min(remaining, 100); // API max is 100

        await rateLimit();
        await quotaAwareThrottle();

        const commentParams = new URLSearchParams({
          part: 'snippet',
          videoId,
          maxResults: String(pageSize),
          order: 'relevance',
          key: apiKey,
        });
        if (pageToken !== undefined) {
          commentParams.set('pageToken', pageToken);
        }

        const commentResponse = await fetch(`${YT_BASE}/commentThreads?${commentParams.toString()}`, {
          signal: signal !== undefined ? signal : AbortSignal.timeout(20000),
        });

        if (!commentResponse.ok) {
          break;
        }

        const rawComments: unknown = await commentResponse.json();
        const commentsParsed = YtCommentThreadsResponseSchema.safeParse(rawComments);

        if (!commentsParsed.success) {
          break;
        }

        for (const thread of commentsParsed.data.items) {
          const tlc = thread.snippet.topLevelComment;
          topComments.push({
            id: tlc.id,
            author: tlc.snippet.authorDisplayName,
            text: tlc.snippet.textDisplay,
            likes: tlc.snippet.likeCount,
            publishedAt: tlc.snippet.publishedAt,
            totalReplyCount: thread.snippet.totalReplyCount,
          });
          fetched++;
        }

        const nextPage = commentsParsed.data.nextPageToken;
        if (nextPage === undefined || commentsParsed.data.items.length === 0) {
          break;
        }
        pageToken = nextPage;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ videoId, error: msg }, '[YouTube] Comment fetch failed, continuing without comments');
    }

    // Sort by likes desc before reply fetch so we pick the top 30 by engagement
    topComments.sort((a, b) => b.likes - a.likes);

    // -------------------------------------------------------------------------
    // Phase 1.5: Fetch reply threads for top 30 comments (up to 5 replies each)
    // -------------------------------------------------------------------------
    type ReplyRecord = { parentId: string; author: string; text: string; likes: number; publishedAt: string };
    const replysByParentId: Record<string, ReplyRecord[]> = {};

    const commentsWithReplies = topComments.slice(0, 30).filter((c) => c.totalReplyCount > 0);

    for (const comment of commentsWithReplies) {
      try {
        await rateLimit();
        await quotaAwareThrottle();

        const replyParams = new URLSearchParams({
          part: 'snippet',
          parentId: comment.id,
          maxResults: '5',
          key: apiKey,
        });

        const replyResponse = await fetch(`${YT_BASE}/comments?${replyParams.toString()}`, {
          signal: signal !== undefined ? signal : AbortSignal.timeout(15000),
        });

        if (!replyResponse.ok) {
          continue;
        }

        const rawReplies: unknown = await replyResponse.json();
        const repliesParsed = YtRepliesResponseSchema.safeParse(rawReplies);

        if (!repliesParsed.success) {
          continue;
        }

        replysByParentId[comment.id] = repliesParsed.data.items.map((r) => ({
          parentId: comment.id,
          author: r.snippet.authorDisplayName,
          text: r.snippet.textDisplay,
          likes: r.snippet.likeCount,
          publishedAt: r.snippet.publishedAt,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ videoId, parentId: comment.id, error: msg }, '[YouTube] Reply fetch failed, skipping');
      }
    }

    // -------------------------------------------------------------------------
    // Phase 1.5: Build timestamp-anchored transcript text
    // Each segment prefixed with [t=<sec>] for Gemini to emit source_url#t=<sec>
    // -------------------------------------------------------------------------
    let timestampedTranscript = '';
    if (transcriptResult.success && transcriptResult.segments.length > 0) {
      const segmentLines: string[] = [];
      for (const seg of transcriptResult.segments) {
        const secInt = Math.floor(seg.start);
        segmentLines.push(`[t=${secInt}] ${seg.text}`);
      }
      timestampedTranscript = segmentLines.join('\n');
    }

    // Build markdown
    const title = transcriptResult.title.length > 0 ? transcriptResult.title : `YouTube Video ${videoId}`;
    const lines: string[] = [`# ${title}`, ''];

    if (transcriptResult.channelName.length > 0) {
      lines.push(`**Channel:** ${transcriptResult.channelName}`, '');
    }

    if (timestampedTranscript.length > 0) {
      lines.push('## Transcript (with timestamps)', '', timestampedTranscript, '');
    } else if (transcriptResult.success && transcriptResult.transcript.length > 0) {
      lines.push('## Transcript', '', transcriptResult.transcript, '');
    } else if (transcriptResult.error !== null) {
      lines.push(`*Transcript unavailable: ${transcriptResult.error}*`, '');
    }

    if (topComments.length > 0) {
      lines.push('## Top Comments', '');
      for (const comment of topComments) {
        lines.push(`**${comment.author}** (${comment.likes} likes)`);
        lines.push('');
        lines.push(comment.text);

        const replies = replysByParentId[comment.id];
        if (replies !== undefined && replies.length > 0) {
          lines.push('');
          lines.push('*Replies:*');
          for (const reply of replies) {
            lines.push(`  > **${reply.author}** (${reply.likes} likes): ${reply.text}`);
          }
        }

        lines.push('');
        lines.push('---');
        lines.push('');
      }
    }

    const markdown = lines.join('\n');
    const publishedAt = transcriptResult.publishDate.length > 0 ? toIsoString(transcriptResult.publishDate) : undefined;

    const result = FetchResultSchema.parse({
      provider: 'youtube',
      url,
      canonical_id: videoId,
      title,
      author: transcriptResult.channelName.length > 0 ? transcriptResult.channelName : undefined,
      published_at: publishedAt,
      raw_content: timestampedTranscript.length > 0 ? timestampedTranscript : transcriptResult.transcript,
      markdown,
      engagement: {
        view_count: transcriptResult.viewCount > 0 ? transcriptResult.viewCount : undefined,
        like_count: transcriptResult.likeCount > 0 ? transcriptResult.likeCount : undefined,
        comment_count: topComments.length > 0 ? topComments.length : undefined,
      },
      fetch_status: transcriptResult.success ? 'ok' : 'partial',
      fetch_error: transcriptResult.error !== null ? transcriptResult.error : undefined,
      raw_metadata: {
        top_comments: topComments,
        replies_by_parent_id: replysByParentId,
        segments: transcriptResult.segments,
        duration_seconds: transcriptResult.durationSeconds,
        keywords: transcriptResult.keywords,
      },
    });

    logger.info(
      {
        url: url.slice(0, 60),
        videoId,
        transcriptWords: transcriptResult.wordCount,
        comments: topComments.length,
        commentsWithReplies: commentsWithReplies.length,
        maxCommentTarget,
      },
      '[YouTube] Fetch complete (Phase 1.5)',
    );

    return result;
  },

  async extract(raw: FetchResult): Promise<ExtractedQuotes> {
    const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
    return extractQuotesWithGemini({
      provider: 'youtube',
      url: raw.url,
      content,
      mode: 'youtube',
    });
  },
};
