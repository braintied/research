/**
 * Instagram Search Provider
 *
 * Strictly uses Bright Data's Instagram datasets for hashtag discovery,
 * direct post/reel fetches, and one-segment profile fetches. Instagram must
 * never route through another scraper or a generic web-fetch chain: missing
 * credentials, provider failures, terminal snapshot states, timeouts, and
 * contentless records all fail closed.
 *
 * Env required: BRIGHTDATA_API_TOKEN.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
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

const BRIGHTDATA_BASE_URL = 'https://api.brightdata.com/datasets/v3';
export const BRIGHTDATA_INSTAGRAM_POSTS_DATASET_ID = 'gd_lk5ns7kz21pck8jpis';
export const BRIGHTDATA_INSTAGRAM_PROFILES_DATASET_ID = 'gd_l1vikfch901nx3by4';

const TRIGGER_TIMEOUT_MS = 30_000;
const PROGRESS_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const SCRAPE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_WAIT_MS = 180_000;
const MAX_SEARCH_RESULTS = 25;
const MAX_HASHTAGS_PER_SEARCH = 2;

const TriggerResponseSchema = z.object({
  snapshot_id: z.string().min(1),
}).passthrough();

const ProgressResponseSchema = z.object({
  status: z.string().min(1),
}).passthrough();

const RecordSchema = z.record(z.string(), z.unknown());
const RecordArraySchema = z.array(z.unknown());

type InstagramRecord = z.infer<typeof RecordSchema>;

interface NormalizedInstagramPost {
  url: string;
  canonicalId: string;
  caption: string;
  author: string | undefined;
  publishedAt: string | undefined;
  mediaUrls: string[];
  comments: NormalizedInstagramComment[];
  hashtags: string[];
  postType: string | undefined;
  viewCount: number | undefined;
  likeCount: number | undefined;
  commentCount: number | undefined;
}

interface NormalizedInstagramComment {
  text: string;
  author: string | undefined;
  likeCount: number | undefined;
}

interface NormalizedInstagramProfile {
  url: string;
  username: string;
  fullName: string | undefined;
  biography: string | undefined;
  externalUrl: string | undefined;
  profileImageUrl: string | undefined;
  businessCategory: string | undefined;
  followersCount: number | undefined;
  followingCount: number | undefined;
  postsCount: number | undefined;
  verified: boolean | undefined;
  private: boolean | undefined;
}

function getBrightDataToken(): string {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (token === undefined || token.trim().length === 0) {
    throw new Error('BRIGHTDATA_API_TOKEN environment variable is not configured');
  }
  return token;
}

function isEnabled(): boolean {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  return token !== undefined && token.trim().length > 0;
}

function safeErrorName(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'request aborted';
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return 'request failed';
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  if (externalSignal?.aborted === true) {
    throw new Error('Bright Data request aborted');
  }

  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = (): void => {
    callerAborted = true;
    controller.abort();
  };
  externalSignal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error(`Bright Data request timed out after ${timeoutMs}ms`);
    }
    if (callerAborted) {
      throw new Error('Bright Data request aborted');
    }
    throw new Error(`Bright Data request failed (${safeErrorName(error)})`);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

async function readJsonResponse(
  response: Response,
  operation: string,
): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Bright Data ${operation} failed with HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Bright Data ${operation} returned invalid JSON`);
  }
}

function parseRecords(raw: unknown, operation: string): InstagramRecord[] {
  const arrayResult = RecordArraySchema.safeParse(raw);
  if (!arrayResult.success) {
    throw new Error(`Bright Data ${operation} did not return a JSON array`);
  }

  const records: InstagramRecord[] = [];
  for (const item of arrayResult.data) {
    const parsed = RecordSchema.safeParse(item);
    if (!parsed.success) continue;
    const providerError = readString(parsed.data, 'error');
    if (providerError !== null) {
      throw new Error(`Bright Data ${operation} returned a provider error`);
    }
    records.push(parsed.data);
  }
  return records;
}

function readString(record: InstagramRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readNumber(record: InstagramRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number.parseFloat(value.replace(/[\s,]/g, ''));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function readBoolean(record: InstagramRecord, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  }
  return undefined;
}

function readStringArray(record: InstagramRecord, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const strings = value.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    );
    if (strings.length > 0) return strings.map(entry => entry.trim());
  }
  return [];
}

function readRecordArray(record: InstagramRecord, ...keys: string[]): InstagramRecord[] {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const records: InstagramRecord[] = [];
    for (const entry of value) {
      const parsed = RecordSchema.safeParse(entry);
      if (parsed.success) records.push(parsed.data);
    }
    if (records.length > 0) return records;
  }
  return [];
}

function toIsoString(value: string | null): string | undefined {
  if (value === null) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

function normalizeAuthor(value: string | null): string | undefined {
  if (value === null) return undefined;
  return value.startsWith('@') ? value : `@${value}`;
}

function normalizeMediaUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function instagramRouteFromType(postType: string | null): 'p' | 'reel' {
  const normalized = postType?.toLowerCase() ?? '';
  return normalized.includes('reel') || normalized.includes('video') || normalized.includes('clip')
    ? 'reel'
    : 'p';
}

export function canonicalizeInstagramPostUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'instagram.com' && hostname !== 'www.instagram.com') return null;
    const match = url.pathname.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)(?:\/|$)/i);
    if (match === null || match[1] === undefined || match[2] === undefined) return null;
    const rawRoute = match[1].toLowerCase();
    const route = rawRoute === 'reels' ? 'reel' : rawRoute;
    return `https://www.instagram.com/${route}/${match[2]}/`;
  } catch {
    return null;
  }
}

const RESERVED_INSTAGRAM_ROUTES = new Set([
  'about',
  'accounts',
  'api',
  'developer',
  'direct',
  'directory',
  'emails',
  'explore',
  'legal',
  'p',
  'privacy',
  'reel',
  'reels',
  'stories',
  'terms',
  'tv',
  'web',
]);

export function canonicalizeInstagramProfileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'instagram.com' && hostname !== 'www.instagram.com') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 1 || segments[0] === undefined) return null;
    const username = segments[0].replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(username) || RESERVED_INSTAGRAM_ROUTES.has(username)) {
      return null;
    }
    return `https://www.instagram.com/${username}/`;
  } catch {
    return null;
  }
}

function shortcodeFromInstagramUrl(value: string): string | null {
  const canonical = canonicalizeInstagramPostUrl(value);
  if (canonical === null) return null;
  const segments = new URL(canonical).pathname.split('/').filter(Boolean);
  return segments[1] ?? null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function extractMediaUrls(record: InstagramRecord): string[] {
  const candidates = [
    ...readStringArray(record, 'photos', 'images', 'display_urls'),
    ...readStringArray(record, 'videos', 'video_urls'),
  ];
  for (const key of ['video_url', 'videoUrl', 'display_url', 'displayUrl', 'thumbnail', 'image_url']) {
    const value = readString(record, key);
    if (value !== null) candidates.push(value);
  }
  return uniqueStrings(
    candidates
      .map(normalizeMediaUrl)
      .filter((value): value is string => value !== null),
  );
}

function extractComments(record: InstagramRecord): NormalizedInstagramComment[] {
  const rawComments = readRecordArray(
    record,
    'latest_comments',
    'top_comments',
    'comments_data',
    'comments_list',
    'comments',
  );
  const comments: NormalizedInstagramComment[] = [];
  for (const raw of rawComments) {
    const text = readString(raw, 'text', 'comment', 'content');
    if (text === null) continue;
    comments.push({
      text,
      author: normalizeAuthor(readString(raw, 'owner_username', 'ownerUsername', 'username', 'user_name')),
      likeCount: readNumber(raw, 'likes', 'likes_count', 'like_count', 'likesCount'),
    });
  }
  return comments.slice(0, 100);
}

function hashtagsFromCaption(caption: string): string[] {
  const matches = caption.match(/#[\p{L}\p{N}_]+/gu);
  return matches === null
    ? []
    : uniqueStrings(matches.map(hashtag => hashtag.slice(1).toLowerCase()));
}

function normalizeInstagramRecord(
  record: InstagramRecord,
  expectedUrl?: string,
): NormalizedInstagramPost | null {
  const caption = readString(record, 'description', 'caption', 'text') ?? '';
  const postType = readString(record, 'content_type', 'type', 'product_type', '__typename');
  const rawUrl = readString(record, 'url', 'post_url');
  const rawShortcode = readString(record, 'shortcode', 'short_code', 'shortCode');
  const expectedCanonical = expectedUrl !== undefined
    ? canonicalizeInstagramPostUrl(expectedUrl)
    : null;
  const expectedShortcode = expectedCanonical !== null
    ? shortcodeFromInstagramUrl(expectedCanonical)
    : null;
  const canonicalFromRecord = rawUrl !== null ? canonicalizeInstagramPostUrl(rawUrl) : null;
  const recordShortcode = rawShortcode ?? (
    canonicalFromRecord !== null ? shortcodeFromInstagramUrl(canonicalFromRecord) : null
  );

  if (expectedCanonical !== null) {
    if (recordShortcode === null || expectedShortcode === null || recordShortcode !== expectedShortcode) {
      return null;
    }
  }

  const canonicalId = recordShortcode;
  if (canonicalId === null) return null;
  const url = expectedCanonical
    ?? canonicalFromRecord
    ?? `https://www.instagram.com/${instagramRouteFromType(postType)}/${canonicalId}/`;

  const mediaUrls = extractMediaUrls(record);
  const comments = extractComments(record);
  if (caption.length === 0 && mediaUrls.length === 0 && comments.length === 0) {
    return null;
  }

  const explicitHashtags = readStringArray(record, 'hashtags')
    .map(value => value.replace(/^#/, '').toLowerCase())
    .filter(value => value.length > 0);

  return {
    url,
    canonicalId,
    caption,
    author: normalizeAuthor(readString(record, 'user_posted', 'username', 'owner_username', 'ownerUsername')),
    publishedAt: toIsoString(readString(record, 'date_posted', 'timestamp', 'taken_at')),
    mediaUrls,
    comments,
    hashtags: uniqueStrings([...explicitHashtags, ...hashtagsFromCaption(caption)]),
    postType: postType ?? undefined,
    viewCount: readNumber(record, 'video_view_count', 'views', 'view_count', 'videoViewCount'),
    likeCount: readNumber(record, 'likes', 'likes_count', 'num_likes', 'likesCount'),
    commentCount: readNumber(record, 'num_comments', 'comments_count', 'comments', 'commentsCount'),
  };
}

function normalizeInstagramProfileRecord(
  record: InstagramRecord,
  expectedUrl: string,
): NormalizedInstagramProfile | null {
  const expectedCanonical = canonicalizeInstagramProfileUrl(expectedUrl);
  if (expectedCanonical === null) return null;
  const expectedUsername = new URL(expectedCanonical).pathname.split('/').filter(Boolean)[0];
  if (expectedUsername === undefined) return null;

  const rawUsername = readString(record, 'account', 'username', 'user_posted', 'handle');
  const profileUrl = readString(record, 'url', 'profile_url', 'profileUrl');
  const usernameFromUrl = profileUrl !== null
    ? canonicalizeInstagramProfileUrl(profileUrl)
    : null;
  const username = (
    rawUsername?.replace(/^@/, '').trim()
    ?? (usernameFromUrl !== null
      ? new URL(usernameFromUrl).pathname.split('/').filter(Boolean)[0]
      : undefined)
  )?.toLowerCase();
  if (username === undefined || username !== expectedUsername) return null;

  const fullName = readString(record, 'full_name', 'fullName', 'name') ?? undefined;
  const biography = readString(record, 'biography', 'bio') ?? undefined;
  const externalUrl = readString(record, 'external_url', 'externalUrl', 'website', 'bio_link')
    ?? undefined;
  const profileImageUrl = readString(
    record,
    'profile_image_link',
    'profile_pic_url_hd',
    'profilePicUrlHD',
    'profile_pic_url',
    'profilePicUrl',
    'avatar',
  ) ?? undefined;
  const businessCategory = readString(
    record,
    'business_category_name',
    'category',
    'category_name',
  ) ?? undefined;
  const followersCount = readNumber(record, 'followers', 'followers_count', 'followersCount');
  const followingCount = readNumber(
    record,
    'following',
    'follows_count',
    'followsCount',
    'followingCount',
  );
  const postsCount = readNumber(record, 'posts_count', 'postsCount', 'media_count', 'posts');
  const verified = readBoolean(record, 'is_verified', 'verified', 'isVerified');
  const isPrivate = readBoolean(record, 'is_private', 'private', 'isPrivate');

  const hasUsefulProfileData = fullName !== undefined
    || biography !== undefined
    || externalUrl !== undefined
    || profileImageUrl !== undefined
    || businessCategory !== undefined
    || followersCount !== undefined
    || followingCount !== undefined
    || postsCount !== undefined
    || verified !== undefined
    || isPrivate !== undefined;
  if (!hasUsefulProfileData) return null;

  return {
    url: expectedCanonical,
    username,
    fullName,
    biography,
    externalUrl,
    profileImageUrl,
    businessCategory,
    followersCount,
    followingCount,
    postsCount,
    verified,
    private: isPrivate,
  };
}

function deriveHashtags(query: string): string[] {
  const normalized = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const words = normalized.split(/\s+/).filter(word => word.length > 1);
  const hashtags: string[] = [];

  const fullSlug = words.join('');
  if (fullSlug.length > 0 && fullSlug.length <= 30) hashtags.push(fullSlug);

  if (words.length >= 2) {
    const pairSlug = words.slice(0, 2).join('');
    if (pairSlug !== fullSlug) hashtags.push(pairSlug);
  }

  if (words.includes('ai') || words.includes('chatgpt')) {
    const topic = words
      .filter(word => !['ai', 'chatgpt', 'for', 'the', 'and'].includes(word))
      .slice(0, 2)
      .join('');
    if (topic.length > 0) {
      hashtags.push(`chatgpt${topic}`, `ai${topic}`);
    }
  }

  if (!hashtags.includes('artificialintelligence')) hashtags.push('artificialintelligence');
  return uniqueStrings(hashtags).slice(0, MAX_HASHTAGS_PER_SEARCH);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 15;
  return Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(limit)));
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new Error('Bright Data request aborted');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(new Error('Bright Data request aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function triggerHashtagDiscovery(
  hashtag: string,
  limit: number,
  token: string,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = `${BRIGHTDATA_BASE_URL}/trigger`
    + `?dataset_id=${BRIGHTDATA_INSTAGRAM_POSTS_DATASET_ID}`
    + '&type=discover_new&discover_by=url';
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{
      url: `https://www.instagram.com/explore/tags/${hashtag}/`,
      num_of_posts: limit,
    }]),
  }, TRIGGER_TIMEOUT_MS, signal);
  const raw = await readJsonResponse(response, 'Instagram discovery trigger');
  const parsed = TriggerResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Bright Data Instagram discovery trigger returned no snapshot_id');
  }
  return parsed.data.snapshot_id;
}

async function waitForSnapshot(
  snapshotId: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const endpoint = `${BRIGHTDATA_BASE_URL}/progress/${encodeURIComponent(snapshotId)}`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_MAX_WAIT_MS) {
    const response = await fetchWithTimeout(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, PROGRESS_TIMEOUT_MS, signal);
    const raw = await readJsonResponse(response, 'Instagram snapshot progress');
    const parsed = ProgressResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('Bright Data Instagram snapshot progress failed validation');
    }
    const status = parsed.data.status.toLowerCase();
    if (status === 'ready') return;
    if (['failed', 'error', 'aborted', 'cancelled', 'canceled'].includes(status)) {
      throw new Error(`Bright Data Instagram snapshot ended with status "${status}"`);
    }
    await abortableSleep(POLL_INTERVAL_MS, signal);
  }

  throw new Error(`Bright Data Instagram snapshot timed out after ${POLL_MAX_WAIT_MS}ms`);
}

async function downloadSnapshotRecords(
  snapshotId: string,
  token: string,
  signal?: AbortSignal,
): Promise<InstagramRecord[]> {
  const endpoint = `${BRIGHTDATA_BASE_URL}/snapshot/${encodeURIComponent(snapshotId)}?format=json`;
  const response = await fetchWithTimeout(endpoint, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, DOWNLOAD_TIMEOUT_MS, signal);
  const raw = await readJsonResponse(response, 'Instagram snapshot download');
  return parseRecords(raw, 'Instagram snapshot download');
}

async function discoverHashtag(
  hashtag: string,
  limit: number,
  token: string,
  signal?: AbortSignal,
): Promise<NormalizedInstagramPost[]> {
  const snapshotId = await triggerHashtagDiscovery(hashtag, limit, token, signal);
  await waitForSnapshot(snapshotId, token, signal);
  const records = await downloadSnapshotRecords(snapshotId, token, signal);
  const posts = records
    .map(record => normalizeInstagramRecord(record))
    .filter((post): post is NormalizedInstagramPost => post !== null);
  if (posts.length === 0) {
    throw new Error('Bright Data Instagram discovery returned no usable content');
  }
  return posts;
}

async function scrapeDataset(
  datasetId: string,
  canonicalUrl: string,
  operation: string,
  token: string,
  signal?: AbortSignal,
): Promise<InstagramRecord[]> {
  const endpoint = `${BRIGHTDATA_BASE_URL}/scrape`
    + `?dataset_id=${datasetId}`
    + '&format=json&include_errors=true';
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ url: canonicalUrl }]),
  }, SCRAPE_TIMEOUT_MS, signal);
  const raw = await readJsonResponse(response, operation);
  return parseRecords(raw, operation);
}

async function scrapePost(
  canonicalUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<NormalizedInstagramPost> {
  const records = await scrapeDataset(
    BRIGHTDATA_INSTAGRAM_POSTS_DATASET_ID,
    canonicalUrl,
    'Instagram post scrape',
    token,
    signal,
  );
  const post = records
    .map(record => normalizeInstagramRecord(record, canonicalUrl))
    .find(candidate => candidate !== null);
  if (post === undefined || post === null) {
    throw new Error('Bright Data Instagram post scrape returned no usable matching content');
  }
  return post;
}

async function scrapeProfile(
  canonicalUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<NormalizedInstagramProfile> {
  const records = await scrapeDataset(
    BRIGHTDATA_INSTAGRAM_PROFILES_DATASET_ID,
    canonicalUrl,
    'Instagram profile scrape',
    token,
    signal,
  );
  const profile = records
    .map(record => normalizeInstagramProfileRecord(record, canonicalUrl))
    .find(candidate => candidate !== null);
  if (profile === undefined || profile === null) {
    throw new Error('Bright Data Instagram profile scrape returned no usable matching content');
  }
  return profile;
}

function postToSearchResult(
  post: NormalizedInstagramPost,
  discoveryHashtag: string,
): SearchResult {
  return SearchResultSchema.parse({
    provider: 'instagram',
    url: post.url,
    canonical_id: post.canonicalId,
    title: post.caption.slice(0, 200),
    snippet: post.caption.slice(0, 500),
    author: post.author,
    published_at: post.publishedAt,
    engagement: {
      view_count: post.viewCount,
      like_count: post.likeCount,
      comment_count: post.commentCount,
    },
    raw_metadata: {
      instagram_provider: 'brightdata',
      brightdata_dataset_id: BRIGHTDATA_INSTAGRAM_POSTS_DATASET_ID,
      discovered_by: 'hashtag',
      hashtag: discoveryHashtag,
      discovery_hashtag: discoveryHashtag,
      discovery_hashtags: [discoveryHashtag],
      post_type: post.postType,
      hashtags: post.hashtags,
      media_urls: post.mediaUrls,
    },
  });
}

function postToFetchResult(post: NormalizedInstagramPost): FetchResult {
  const heading = post.caption.length > 0 ? post.caption.slice(0, 100) : 'Instagram post';
  const lines: string[] = [
    `# ${heading}`,
    '',
    `**Source:** ${post.url}`,
    `**Creator:** ${post.author ?? 'Unknown'}`,
    '**Instagram data provider:** Bright Data',
    '',
  ];

  if (post.caption.length > 0) {
    lines.push('## Caption', '', post.caption, '');
  }
  if (post.mediaUrls.length > 0) {
    lines.push('## Media', '');
    for (const mediaUrl of post.mediaUrls) lines.push(`- ${mediaUrl}`);
    lines.push('');
  }
  if (post.comments.length > 0) {
    lines.push('## Comments', '');
    for (const comment of post.comments) {
      const likes = comment.likeCount !== undefined ? ` (${comment.likeCount} likes)` : '';
      lines.push(`**${comment.author ?? 'Unknown'}**${likes}`, '', comment.text, '');
    }
  }

  return FetchResultSchema.parse({
    provider: 'instagram',
    url: post.url,
    canonical_id: post.canonicalId,
    title: post.caption.slice(0, 200),
    author: post.author,
    published_at: post.publishedAt,
    raw_content: post.caption,
    markdown: lines.join('\n').trim(),
    engagement: {
      view_count: post.viewCount,
      like_count: post.likeCount,
      comment_count: post.commentCount,
      instagram_provider: 'brightdata',
      brightdata_dataset_id: BRIGHTDATA_INSTAGRAM_POSTS_DATASET_ID,
      post_type: post.postType,
      hashtags: post.hashtags,
      media_urls: post.mediaUrls,
    },
    fetch_status: 'ok',
  });
}

function profileToFetchResult(profile: NormalizedInstagramProfile): FetchResult {
  const title = profile.fullName !== undefined
    ? `${profile.fullName} (@${profile.username})`
    : `@${profile.username}`;
  const lines = [
    `# ${title}`,
    '',
    `**Source:** ${profile.url}`,
    '**Instagram data provider:** Bright Data',
    '',
  ];
  if (profile.biography !== undefined) lines.push('## Bio', '', profile.biography, '');
  if (profile.businessCategory !== undefined) lines.push(`**Category:** ${profile.businessCategory}`);
  if (profile.followersCount !== undefined) lines.push(`**Followers:** ${profile.followersCount}`);
  if (profile.followingCount !== undefined) lines.push(`**Following:** ${profile.followingCount}`);
  if (profile.postsCount !== undefined) lines.push(`**Posts:** ${profile.postsCount}`);
  if (profile.verified !== undefined) lines.push(`**Verified:** ${profile.verified ? 'yes' : 'no'}`);
  if (profile.private !== undefined) lines.push(`**Private:** ${profile.private ? 'yes' : 'no'}`);
  if (profile.externalUrl !== undefined) lines.push(`**Website:** ${profile.externalUrl}`);
  if (profile.profileImageUrl !== undefined) lines.push(`**Profile image:** ${profile.profileImageUrl}`);

  const markdown = lines.join('\n').trim();
  return FetchResultSchema.parse({
    provider: 'instagram',
    url: profile.url,
    canonical_id: profile.username,
    title,
    author: `@${profile.username}`,
    raw_content: profile.biography ?? markdown,
    markdown,
    engagement: {
      followers_count: profile.followersCount,
      following_count: profile.followingCount,
      posts_count: profile.postsCount,
      verified: profile.verified,
      private: profile.private,
      instagram_provider: 'brightdata',
      brightdata_dataset_id: BRIGHTDATA_INSTAGRAM_PROFILES_DATASET_ID,
      source_kind: 'profile',
      external_url: profile.externalUrl,
      profile_image_url: profile.profileImageUrl,
      business_category: profile.businessCategory,
    },
    fetch_status: 'ok',
  });
}

function failedFetch(url: string, message: string): FetchResult {
  return FetchResultSchema.parse({
    provider: 'instagram',
    url,
    fetch_status: 'failed',
    fetch_error: message.slice(0, 200),
  });
}

export const instagramProvider: SearchProvider = {
  name: 'instagram',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const token = getBrightDataToken();
    const limit = normalizeLimit(opts.limit);
    const hashtags = deriveHashtags(query);
    if (hashtags.length === 0) {
      throw new Error('Instagram search query did not produce a usable hashtag');
    }

    const byUrl = new Map<string, SearchResult>();
    for (const hashtag of hashtags) {
      const posts = await discoverHashtag(hashtag, limit, token, opts.signal);
      for (const post of posts) {
        const existing = byUrl.get(post.url);
        if (existing === undefined) {
          byUrl.set(post.url, postToSearchResult(post, hashtag));
          continue;
        }
        const metadata = { ...existing.raw_metadata };
        const prior = Array.isArray(metadata.discovery_hashtags)
          ? metadata.discovery_hashtags.filter((value): value is string => typeof value === 'string')
          : [String(metadata.discovery_hashtag ?? '')].filter(value => value.length > 0);
        metadata.discovery_hashtags = uniqueStrings([...prior, hashtag]);
        byUrl.set(post.url, SearchResultSchema.parse({ ...existing, raw_metadata: metadata }));
      }
    }

    const results = [...byUrl.values()].slice(0, limit);
    if (results.length === 0) {
      throw new Error('Bright Data Instagram search returned no usable content');
    }
    logger.info(
      { resultCount: results.length, hashtagCount: hashtags.length },
      '[Instagram] Bright Data search complete',
    );
    return results;
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    const canonicalPostUrl = canonicalizeInstagramPostUrl(url);
    const canonicalProfileUrl = canonicalizeInstagramProfileUrl(url);
    if (canonicalPostUrl === null && canonicalProfileUrl === null) {
      return failedFetch(
        url,
        'Instagram fetch requires a direct /p/, /reel/, /tv/, or one-segment profile URL',
      );
    }

    try {
      const token = getBrightDataToken();
      if (canonicalPostUrl !== null) {
        const post = await scrapePost(canonicalPostUrl, token, signal);
        logger.info('[Instagram] Bright Data post fetch complete');
        return postToFetchResult(post);
      }
      if (canonicalProfileUrl === null) {
        return failedFetch(url, 'Instagram URL could not be canonicalized');
      }
      const profile = await scrapeProfile(canonicalProfileUrl, token, signal);
      logger.info('[Instagram] Bright Data profile fetch complete');
      return profileToFetchResult(profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bright Data Instagram fetch failed';
      return failedFetch(canonicalPostUrl ?? canonicalProfileUrl ?? url, message);
    }
  },

  async extract(raw: FetchResult): Promise<ExtractedQuotes> {
    const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
    if (raw.fetch_status === 'failed' || content.trim().length === 0) {
      throw new Error('Cannot extract Instagram evidence from a failed or empty Bright Data fetch');
    }
    return extractQuotesWithGemini({
      provider: 'instagram',
      url: raw.url,
      content,
      mode: 'reddit',
    });
  },
};
