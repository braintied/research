/**
 * YouTube channel ingestion — Data API v3.
 *
 * listChannelVideos resolves a channel's "uploads" playlist
 * (channels.list part=contentDetails) and pages playlistItems.list to the
 * full video catalog. When no API key is provided it falls back to shelling
 * out to `yt-dlp --flat-playlist`, which needs no key but returns less data
 * (no publishedAt; marked undefined explicitly, never defaulted).
 *
 * All keys/config arrive as function arguments — this package never reads
 * process.env (third-party-safe contract).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { logger } from '../logger.js';
import { throttleYoutubeApiCall } from './rate-limit.js';
import { YT_API_BASE, toIsoString } from './util.js';

const execFileAsync = promisify(execFile);

// =============================================================================
// Public types
// =============================================================================

export interface ChannelVideoRef {
  videoId: string;
  title: string;
  /** ISO 8601 publish time. Undefined on the yt-dlp fallback path. */
  publishedAt: string | undefined;
  /** Zero-based position in the channel's upload order. */
  position: number;
}

export interface ChannelPlaylist {
  playlistId: string;
  title: string;
  description: string;
  itemCount: number;
}

// =============================================================================
// API response schemas
// =============================================================================

const YtChannelItemSchema = z.object({
  id: z.string().default(''),
  contentDetails: z.object({
    relatedPlaylists: z.object({
      uploads: z.string().optional(),
    }).optional(),
  }).optional(),
});

const YtChannelsResponseSchema = z.object({
  items: z.array(YtChannelItemSchema).default([]),
});

const YtPlaylistItemSchema = z.object({
  snippet: z.object({
    title: z.string().default(''),
    publishedAt: z.string().default(''),
    position: z.number().default(0),
  }).optional(),
  contentDetails: z.object({
    videoId: z.string().optional(),
    videoPublishedAt: z.string().optional(),
  }).optional(),
});

const YtPlaylistItemsResponseSchema = z.object({
  items: z.array(YtPlaylistItemSchema).default([]),
  nextPageToken: z.string().optional(),
});

const YtPlaylistSchema = z.object({
  id: z.string().default(''),
  snippet: z.object({
    title: z.string().default(''),
    description: z.string().default(''),
  }).optional(),
  contentDetails: z.object({
    itemCount: z.number().optional(),
  }).optional(),
});

const YtPlaylistsResponseSchema = z.object({
  items: z.array(YtPlaylistSchema).default([]),
  nextPageToken: z.string().optional(),
});

// yt-dlp --flat-playlist --dump-single-json output (subset we consume).
const YtDlpEntrySchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
});

const YtDlpPlaylistSchema = z.object({
  entries: z.array(YtDlpEntrySchema.nullable()).default([]),
});

// =============================================================================
// Shared fetch helper
// =============================================================================

async function youtubeApiGet(path: string, params: Record<string, string>): Promise<unknown> {
  await throttleYoutubeApiCall();
  const response = await fetch(`${YT_API_BASE}/${path}?${new URLSearchParams(params).toString()}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`YouTube ${path} error: ${response.status} ${body.slice(0, 200)}`);
  }
  return response.json();
}

// =============================================================================
// Uploads-playlist resolution
// =============================================================================

async function resolveUploadsPlaylistId(channelId: string, youtubeApiKey: string): Promise<string> {
  const rawJson = await youtubeApiGet('channels', {
    part: 'contentDetails',
    id: channelId,
    key: youtubeApiKey,
  });
  const parsed = YtChannelsResponseSchema.parse(rawJson);
  const channel = parsed.items[0];
  const uploads = channel !== undefined
    && channel.contentDetails !== undefined
    && channel.contentDetails.relatedPlaylists !== undefined
    ? channel.contentDetails.relatedPlaylists.uploads
    : undefined;
  if (uploads === undefined || uploads.length === 0) {
    throw new Error(`No uploads playlist found for channel ${channelId} — the channel id may be invalid`);
  }
  return uploads;
}

// =============================================================================
// Playlist items
// =============================================================================

async function listPlaylistItems(
  playlistId: string,
  youtubeApiKey: string,
  maxVideos: number | undefined,
): Promise<ChannelVideoRef[]> {
  const refs: ChannelVideoRef[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const params: Record<string, string> = {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: '50',
      key: youtubeApiKey,
    };
    if (pageToken !== undefined) {
      params['pageToken'] = pageToken;
    }

    const rawJson = await youtubeApiGet('playlistItems', params);
    const parsed = YtPlaylistItemsResponseSchema.parse(rawJson);

    for (const item of parsed.items) {
      const videoId = item.contentDetails !== undefined ? item.contentDetails.videoId : undefined;
      if (videoId === undefined || videoId.length === 0) continue;
      const snippet = item.snippet;
      const publishedRaw = item.contentDetails !== undefined && item.contentDetails.videoPublishedAt !== undefined
        ? item.contentDetails.videoPublishedAt
        : (snippet !== undefined ? snippet.publishedAt : '');
      refs.push({
        videoId,
        title: snippet !== undefined ? snippet.title : '',
        publishedAt: toIsoString(publishedRaw),
        position: snippet !== undefined ? snippet.position : refs.length,
      });
      if (maxVideos !== undefined && refs.length >= maxVideos) {
        return refs;
      }
    }

    pageToken = parsed.nextPageToken;
    if (pageToken === undefined || parsed.items.length === 0) {
      return refs;
    }
  }
}

// =============================================================================
// yt-dlp fallback (no API key)
// =============================================================================

const YT_DLP_TIMEOUT_MS = 120_000;
const YT_DLP_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Fallback for listChannelVideos when no Data API key is available.
 * Requires the `yt-dlp` binary on PATH. Flat-playlist mode returns the same
 * shape minus `publishedAt` (left undefined explicitly — flat entries do not
 * carry upload dates) and uses enumeration order for `position`.
 */
async function listChannelVideosViaYtDlp(channelId: string, maxVideos: number | undefined): Promise<ChannelVideoRef[]> {
  const channelUrl = `https://www.youtube.com/channel/${channelId}/videos`;
  let stdout: string;
  try {
    const result = await execFileAsync(
      'yt-dlp',
      ['--flat-playlist', '--dump-single-json', '--no-warnings', channelUrl],
      { timeout: YT_DLP_TIMEOUT_MS, maxBuffer: YT_DLP_MAX_BUFFER_BYTES },
    );
    stdout = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `yt-dlp channel listing failed for ${channelId} (is yt-dlp installed and on PATH?): ${msg.slice(0, 200)}`,
    );
  }

  const rawYtDlpJson: unknown = JSON.parse(stdout);
  const parsed = YtDlpPlaylistSchema.safeParse(rawYtDlpJson);
  if (!parsed.success) {
    throw new Error(`yt-dlp returned an unexpected payload shape for channel ${channelId}`);
  }

  const refs: ChannelVideoRef[] = [];
  for (const entry of parsed.data.entries) {
    if (entry === null) continue;
    if (entry.id === undefined || entry.id.length === 0) continue;
    refs.push({
      videoId: entry.id,
      title: entry.title !== undefined ? entry.title : '',
      publishedAt: undefined,
      position: refs.length,
    });
    if (maxVideos !== undefined && refs.length >= maxVideos) {
      return refs;
    }
  }
  return refs;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * List a channel's uploaded videos in upload order (oldest position 0 is NOT
 * guaranteed — position mirrors the uploads-playlist position, which YouTube
 * orders newest-first). With `youtubeApiKey` uses the Data API; without it,
 * falls back to `yt-dlp --flat-playlist` (no key needed, but no publishedAt).
 */
export async function listChannelVideos(input: {
  channelId: string;
  youtubeApiKey?: string;
  maxVideos?: number;
}): Promise<ChannelVideoRef[]> {
  if (input.youtubeApiKey !== undefined && input.youtubeApiKey.length > 0) {
    const uploadsPlaylistId = await resolveUploadsPlaylistId(input.channelId, input.youtubeApiKey);
    const refs = await listPlaylistItems(uploadsPlaylistId, input.youtubeApiKey, input.maxVideos);
    logger.info({ count: refs.length }, '[YouTube] Channel videos listed via Data API');
    return refs;
  }
  const refs = await listChannelVideosViaYtDlp(input.channelId, input.maxVideos);
  logger.info({ count: refs.length }, '[YouTube] Channel videos listed via yt-dlp fallback');
  return refs;
}

/** List the public playlists owned by a channel. Requires a Data API key. */
export async function getChannelPlaylists(input: {
  channelId: string;
  youtubeApiKey: string;
}): Promise<ChannelPlaylist[]> {
  const playlists: ChannelPlaylist[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const params: Record<string, string> = {
      part: 'snippet,contentDetails',
      channelId: input.channelId,
      maxResults: '50',
      key: input.youtubeApiKey,
    };
    if (pageToken !== undefined) {
      params['pageToken'] = pageToken;
    }

    const rawJson = await youtubeApiGet('playlists', params);
    const parsed = YtPlaylistsResponseSchema.parse(rawJson);

    for (const item of parsed.items) {
      if (item.id.length === 0) continue;
      playlists.push({
        playlistId: item.id,
        title: item.snippet !== undefined ? item.snippet.title : '',
        description: item.snippet !== undefined ? item.snippet.description : '',
        itemCount: item.contentDetails !== undefined && item.contentDetails.itemCount !== undefined
          ? item.contentDetails.itemCount
          : 0,
      });
    }

    pageToken = parsed.nextPageToken;
    if (pageToken === undefined || parsed.items.length === 0) {
      return playlists;
    }
  }
}

/** List the video ids in a playlist, in playlist order. Requires a Data API key. */
export async function getPlaylistVideoIds(input: {
  playlistId: string;
  youtubeApiKey: string;
  maxVideos?: number;
}): Promise<string[]> {
  const refs = await listPlaylistItems(input.playlistId, input.youtubeApiKey, input.maxVideos);
  return refs.map((ref) => ref.videoId);
}

/**
 * Build a videoId -> playlistIds[] membership map across every playlist on a
 * channel. Rate-limit aware: every API page awaits the shared throttle, so a
 * channel with hundreds of playlists walks its quota budget rather than
 * bursting through it.
 */
export async function buildPlaylistMembership(input: {
  channelId: string;
  youtubeApiKey: string;
}): Promise<Map<string, string[]>> {
  const membership = new Map<string, string[]>();
  const playlists = await getChannelPlaylists({
    channelId: input.channelId,
    youtubeApiKey: input.youtubeApiKey,
  });

  for (const playlist of playlists) {
    const videoIds = await getPlaylistVideoIds({
      playlistId: playlist.playlistId,
      youtubeApiKey: input.youtubeApiKey,
    });
    for (const videoId of videoIds) {
      const existing = membership.get(videoId);
      if (existing === undefined) {
        membership.set(videoId, [playlist.playlistId]);
      } else {
        existing.push(playlist.playlistId);
      }
    }
  }

  logger.info(
    { count: membership.size, results: playlists.length },
    '[YouTube] Playlist membership map built',
  );
  return membership;
}

// =============================================================================
// Channel identifier resolution
// =============================================================================

const CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;

/**
 * Turn whatever a human pasted into a channel id: a bare `UC…` id, a
 * `/channel/UC…` URL, or an `@handle` (bare or as a URL). Handles need the
 * Data API (`channels?forHandle=`), which is one quota unit.
 */
export async function resolveChannelId(input: {
  identifier: string;
  youtubeApiKey?: string;
}): Promise<string> {
  const raw = input.identifier.trim();
  if (CHANNEL_ID_PATTERN.test(raw)) return raw;

  let handle: string | null = null;
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.includes('youtube.com/')) {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const segments = url.pathname.split('/').filter(Boolean);
    const channelIdx = segments.indexOf('channel');
    if (channelIdx !== -1) {
      const id = segments[channelIdx + 1];
      if (id !== undefined && CHANNEL_ID_PATTERN.test(id)) return id;
    }
    const at = segments.find((seg) => seg.startsWith('@'));
    if (at !== undefined) handle = at.slice(1);
  } else if (raw.startsWith('@')) {
    handle = raw.slice(1);
  }

  if (handle === null || handle.length === 0) {
    throw new Error(`YouTube identifier is not a channel id, /channel/ URL, or @handle: ${raw.slice(0, 80)}`);
  }
  if (input.youtubeApiKey === undefined || input.youtubeApiKey.length === 0) {
    throw new Error(`Resolving YouTube handle @${handle} needs youtubeApiKey (channels?forHandle)`);
  }

  await throttleYoutubeApiCall();
  const params = new URLSearchParams({ part: 'id', forHandle: handle, key: input.youtubeApiKey });
  const response = await fetch(`${YT_API_BASE}/channels?${params.toString()}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`YouTube channels?forHandle failed: HTTP ${response.status}`);
  }
  const parsed = HandleLookupSchema.parse(await response.json());
  const id = parsed.items[0]?.id;
  if (id === undefined) {
    throw new Error(`YouTube handle @${handle} resolved to no channel`);
  }
  return id;
}

const HandleLookupSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1) })).default([]),
});
