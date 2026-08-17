/**
 * YouTube video comments — Data API v3 commentThreads.list.
 *
 * Fetches top-level threads (part=snippet,replies, order=relevance) and
 * flattens the embedded reply trees into one list. `parentCommentId` is null
 * for top-level comments and set to the top-level id for replies.
 *
 * Comments-disabled videos return an empty array with a logged reason rather
 * than throwing — a disabled comment section is data, not a failure.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { throttleYoutubeApiCall } from './rate-limit.js';
import { YT_API_BASE, toIsoString } from './util.js';

// =============================================================================
// Public type
// =============================================================================

export interface YoutubeComment {
  youtubeCommentId: string;
  parentCommentId: string | null;
  isReply: boolean;
  author: string;
  text: string;
  likeCount: number;
  publishedAt: string | undefined;
  updatedAt: string | undefined;
}

// =============================================================================
// API response schemas
// =============================================================================

const YtCommentSnippetSchema = z.object({
  authorDisplayName: z.string().default(''),
  textDisplay: z.string().default(''),
  likeCount: z.number().default(0),
  publishedAt: z.string().default(''),
  updatedAt: z.string().default(''),
});

const YtCommentSchema = z.object({
  id: z.string().default(''),
  snippet: YtCommentSnippetSchema,
});

const YtCommentThreadItemSchema = z.object({
  id: z.string().default(''),
  snippet: z.object({
    topLevelComment: YtCommentSchema,
    totalReplyCount: z.number().default(0),
  }),
  replies: z.object({
    comments: z.array(YtCommentSchema).default([]),
  }).optional(),
});

const YtCommentThreadsResponseSchema = z.object({
  items: z.array(YtCommentThreadItemSchema).default([]),
  nextPageToken: z.string().optional(),
});

const YtApiErrorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    errors: z.array(z.object({
      reason: z.string().optional(),
      message: z.string().optional(),
    })).optional(),
  }).optional(),
});

// =============================================================================
// Public API
// =============================================================================

const DEFAULT_MAX_COMMENTS = 200;
const COMMENTS_PAGE_SIZE = 100;

/**
 * Fetch up to `maxComments` top-level comment threads for a video (default
 * 200), plus the reply trees embedded in each thread. Returns an empty array
 * when comments are disabled on the video.
 */
export async function getVideoComments(input: {
  videoId: string;
  youtubeApiKey: string;
  maxComments?: number;
}): Promise<YoutubeComment[]> {
  const maxComments = input.maxComments !== undefined ? input.maxComments : DEFAULT_MAX_COMMENTS;
  const comments: YoutubeComment[] = [];
  let pageToken: string | undefined;
  let fetchedTopLevel = 0;

  while (fetchedTopLevel < maxComments) {
    const pageSize = Math.min(maxComments - fetchedTopLevel, COMMENTS_PAGE_SIZE);

    const params: Record<string, string> = {
      part: 'snippet,replies',
      videoId: input.videoId,
      maxResults: String(pageSize),
      order: 'relevance',
      key: input.youtubeApiKey,
    };
    if (pageToken !== undefined) {
      params['pageToken'] = pageToken;
    }

    await throttleYoutubeApiCall();
    const response = await fetch(`${YT_API_BASE}/commentThreads?${new URLSearchParams(params).toString()}`, {
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const body = await response.text();
      const reason = extractApiErrorReason(body);
      if (reason === 'commentsDisabled') {
        logger.info({ videoId: input.videoId, reason: 'commentsDisabled' }, '[YouTube] Comments disabled on video, returning none');
        return [];
      }
      throw new Error(`YouTube commentThreads.list error: ${response.status} ${body.slice(0, 200)}`);
    }

    const rawJson: unknown = await response.json();
    const parsed = YtCommentThreadsResponseSchema.parse(rawJson);

    for (const thread of parsed.items) {
      const topLevel = thread.snippet.topLevelComment;
      comments.push({
        youtubeCommentId: topLevel.id.length > 0 ? topLevel.id : thread.id,
        parentCommentId: null,
        isReply: false,
        author: topLevel.snippet.authorDisplayName,
        text: topLevel.snippet.textDisplay,
        likeCount: topLevel.snippet.likeCount,
        publishedAt: toIsoString(topLevel.snippet.publishedAt),
        updatedAt: toIsoString(topLevel.snippet.updatedAt),
      });
      fetchedTopLevel += 1;

      const embedded = thread.replies !== undefined ? thread.replies.comments : [];
      for (const reply of embedded) {
        comments.push({
          youtubeCommentId: reply.id,
          parentCommentId: thread.id,
          isReply: true,
          author: reply.snippet.authorDisplayName,
          text: reply.snippet.textDisplay,
          likeCount: reply.snippet.likeCount,
          publishedAt: toIsoString(reply.snippet.publishedAt),
          updatedAt: toIsoString(reply.snippet.updatedAt),
        });
      }
    }

    pageToken = parsed.nextPageToken;
    if (pageToken === undefined || parsed.items.length === 0) {
      break;
    }
  }

  logger.info(
    { videoId: input.videoId, count: comments.length, results: fetchedTopLevel },
    '[YouTube] Comments fetched',
  );
  return comments;
}

/** Pull the first machine reason out of a YouTube API error body. */
function extractApiErrorReason(body: string): string | undefined {
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(body);
  } catch {
    return undefined;
  }
  const parsed = YtApiErrorSchema.safeParse(rawJson);
  if (!parsed.success) return undefined;
  if (parsed.data.error === undefined || parsed.data.error.errors === undefined) return undefined;
  const first = parsed.data.error.errors[0];
  return first !== undefined ? first.reason : undefined;
}
