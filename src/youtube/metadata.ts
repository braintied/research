/**
 * YouTube video metadata — Data API v3 videos.list.
 *
 * Batched 50 ids per call (the API's per-request id cap), part
 * snippet+contentDetails+statistics. The full Zod-validated API item is
 * preserved on `raw` so future extraction passes never need a re-fetch.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { throttleYoutubeApiCall } from './rate-limit.js';
import {
  YT_API_BASE,
  iso8601DurationToSeconds,
  safeParseInt,
  selectThumbnailUrl,
  toIsoString,
} from './util.js';

// =============================================================================
// API response schemas
// =============================================================================

const YtThumbnailSchema = z.object({
  url: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const YtVideoItemSchema = z.object({
  id: z.string(),
  snippet: z.object({
    publishedAt: z.string().default(''),
    channelId: z.string().default(''),
    channelTitle: z.string().default(''),
    title: z.string().default(''),
    description: z.string().default(''),
    tags: z.array(z.string()).default([]),
    categoryId: z.string().default(''),
    defaultLanguage: z.string().optional(),
    thumbnails: z.record(z.string(), YtThumbnailSchema).default({}),
  }).default({
    publishedAt: '',
    channelId: '',
    channelTitle: '',
    title: '',
    description: '',
    tags: [],
    categoryId: '',
    thumbnails: {},
  }),
  contentDetails: z.object({
    duration: z.string().default(''),
  }).default({ duration: '' }),
  statistics: z.object({
    viewCount: z.string().optional(),
    likeCount: z.string().optional(),
    commentCount: z.string().optional(),
  }).default({}),
});

const YtVideosResponseSchema = z.object({
  items: z.array(YtVideoItemSchema).default([]),
});

type YtVideoItem = z.infer<typeof YtVideoItemSchema>;

// =============================================================================
// Public type
// =============================================================================

export interface YoutubeVideoMetadata {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  durationSeconds: number;
  publishedAt: string | undefined;
  tags: string[];
  categoryId: string;
  defaultLanguage: string | undefined;
  thumbnailUrl: string | undefined;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  /** The full Zod-validated API item, preserved for future re-extraction. */
  raw: unknown;
}

// =============================================================================
// Mapping
// =============================================================================

function toMetadata(item: YtVideoItem): YoutubeVideoMetadata {
  const viewCount = safeParseInt(item.statistics.viewCount);
  const likeCount = safeParseInt(item.statistics.likeCount);
  const commentCount = safeParseInt(item.statistics.commentCount);
  return {
    videoId: item.id,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    title: item.snippet.title,
    description: item.snippet.description,
    durationSeconds: iso8601DurationToSeconds(item.contentDetails.duration),
    publishedAt: toIsoString(item.snippet.publishedAt),
    tags: item.snippet.tags,
    categoryId: item.snippet.categoryId,
    defaultLanguage: item.snippet.defaultLanguage !== undefined && item.snippet.defaultLanguage.length > 0
      ? item.snippet.defaultLanguage
      : undefined,
    thumbnailUrl: selectThumbnailUrl(item.snippet.thumbnails),
    viewCount: viewCount !== undefined ? viewCount : 0,
    likeCount: likeCount !== undefined ? likeCount : 0,
    commentCount: commentCount !== undefined ? commentCount : 0,
    raw: item,
  };
}

// =============================================================================
// Public API
// =============================================================================

const YT_VIDEOS_BATCH_SIZE = 50;

/** Fetch full metadata for up to any number of video ids (batched 50/request). */
export async function getVideoMetadata(input: {
  videoIds: string[];
  youtubeApiKey: string;
}): Promise<YoutubeVideoMetadata[]> {
  const out: YoutubeVideoMetadata[] = [];

  for (let i = 0; i < input.videoIds.length; i += YT_VIDEOS_BATCH_SIZE) {
    const batch = input.videoIds.slice(i, i + YT_VIDEOS_BATCH_SIZE);
    if (batch.length === 0) continue;

    await throttleYoutubeApiCall();
    const params = new URLSearchParams({
      part: 'snippet,contentDetails,statistics',
      id: batch.join(','),
      key: input.youtubeApiKey,
    });

    const response = await fetch(`${YT_API_BASE}/videos?${params.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`YouTube videos.list error: ${response.status} ${body.slice(0, 200)}`);
    }

    const rawJson: unknown = await response.json();
    const parsed = YtVideosResponseSchema.parse(rawJson);
    for (const item of parsed.items) {
      out.push(toMetadata(item));
    }
  }

  logger.info({ count: out.length, results: input.videoIds.length }, '[YouTube] Video metadata fetched');
  return out;
}
