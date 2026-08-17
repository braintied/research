/**
 * Instagram Search Provider
 *
 * Bright Data (strict, fail-closed) for hashtag discovery, direct post/reel/tv
 * fetches, and one-segment profile fetches. Instagram posts and profiles must
 * never route through a generic crawl or browser recovery chain.
 *
 * Stories are a separate lane: Bright Data has no Stories dataset, so active
 * public stories are fetched via Apify actor
 * `datavoyantlab/advanced-instagram-stories-scraper` (usernames only, no
 * Instagram session cookie). Stories use `APIFY_API_TOKEN` as the primary
 * transport — they are not gated by `APIFY_ALLOW_FALLBACK`.
 *
 * Env: BRIGHTDATA_API_TOKEN (search/posts/profiles).
 *      APIFY_API_TOKEN (stories only).
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { MissingCredentialError, type ResearchCredentials } from '../credentials.js';
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

/** Apify actor for public Instagram Stories (no session cookie required). */
export const APIFY_INSTAGRAM_STORIES_ACTOR_ID = 'datavoyantlab/advanced-instagram-stories-scraper';
const APIFY_BASE_URL = 'https://api.apify.com/v2';
const APIFY_START_TIMEOUT_MS = 30_000;
const APIFY_POLL_TIMEOUT_MS = 15_000;
const APIFY_DATASET_TIMEOUT_MS = 30_000;
const APIFY_POLL_INTERVAL_MS = 5_000;
const APIFY_MAX_WAIT_MS = 180_000;

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

export interface InstagramStoriesTarget {
  username: string;
  storyId: string | undefined;
  /** Always the active-stories watch URL for the account. */
  watchUrl: string;
  /** Specific story permalink when a story id was present in the input URL. */
  storyUrl: string | undefined;
}

interface NormalizedInstagramStory {
  url: string;
  storyId: string;
  username: string;
  caption: string;
  mediaType: 'image' | 'video' | 'unknown';
  mediaUrls: string[];
  publishedAt: string | undefined;
  expiresAt: string | undefined;
  linkUrl: string | undefined;
  hashtags: string[];
}

function requireBrightDataToken(credentials: ResearchCredentials): string {
  if (credentials.brightdata === undefined) {
    throw new MissingCredentialError('brightdata', 'required for Instagram post/profile/search');
  }
  return credentials.brightdata.apiToken;
}

function requireApifyToken(credentials: ResearchCredentials): string {
  if (credentials.apifyApiToken === undefined) {
    throw new MissingCredentialError('apifyApiToken', 'required for Instagram stories');
  }
  return credentials.apifyApiToken;
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
    throw new Error('Instagram request aborted');
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
      throw new Error(`Instagram request timed out after ${timeoutMs}ms`);
    }
    if (callerAborted) {
      throw new Error('Instagram request aborted');
    }
    throw new Error(`Instagram request failed (${safeErrorName(error)})`);
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

/**
 * Parse `/stories/{username}/` or `/stories/{username}/{storyId}/`.
 * Returns null for non-stories Instagram URLs.
 */
export function parseInstagramStoriesUrl(value: string): InstagramStoriesTarget | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'instagram.com' && hostname !== 'www.instagram.com') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2 || segments[0]?.toLowerCase() !== 'stories') return null;
    const rawUsername = segments[1];
    if (rawUsername === undefined) return null;
    const username = rawUsername.replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(username) || RESERVED_INSTAGRAM_ROUTES.has(username)) {
      return null;
    }
    const rawStoryId = segments[2];
    const storyId = rawStoryId !== undefined && /^[A-Za-z0-9_-]+$/.test(rawStoryId)
      ? rawStoryId
      : undefined;
    const watchUrl = `https://www.instagram.com/stories/${username}/`;
    const storyUrl = storyId !== undefined
      ? `https://www.instagram.com/stories/${username}/${storyId}/`
      : undefined;
    return { username, storyId, watchUrl, storyUrl };
  } catch {
    return null;
  }
}

export function canonicalizeInstagramStoriesUrl(value: string): string | null {
  const parsed = parseInstagramStoriesUrl(value);
  if (parsed === null) return null;
  if (parsed.storyUrl !== undefined) return parsed.storyUrl;
  return parsed.watchUrl;
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
  if (signal?.aborted === true) throw new Error('Instagram request aborted');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(new Error('Instagram request aborted'));
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
  const accepted = TriggerResponseSchema.safeParse(raw);
  if (accepted.success) {
    await waitForSnapshot(accepted.data.snapshot_id, token, signal);
    return downloadSnapshotRecords(accepted.data.snapshot_id, token, signal);
  }
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


// =============================================================================
// Stories via Apify (primary path — Bright Data has no Stories dataset)
// =============================================================================

interface ApifyRunData {
  id: string;
  defaultDatasetId: string;
  status: string;
}

async function startApifyStoriesRun(
  usernames: string[],
  token: string,
  signal?: AbortSignal,
): Promise<{ runId: string; datasetId: string }> {
  const actorPath = encodeURIComponent(APIFY_INSTAGRAM_STORIES_ACTOR_ID);
  const endpoint = `${APIFY_BASE_URL}/acts/${actorPath}/runs?token=${encodeURIComponent(token)}`;
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames }),
  }, APIFY_START_TIMEOUT_MS, signal);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Apify Instagram stories start failed with HTTP ${response.status}: ${body.slice(0, 200)}`,
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error('Apify Instagram stories start returned invalid JSON');
  }
  const data = (json as { data?: ApifyRunData }).data;
  if (data === undefined || typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error('Apify Instagram stories start response missing run id');
  }
  if (typeof data.defaultDatasetId !== 'string' || data.defaultDatasetId.length === 0) {
    throw new Error('Apify Instagram stories start response missing dataset id');
  }
  return { runId: data.id, datasetId: data.defaultDatasetId };
}

async function pollApifyRunUntilDone(
  runId: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const endpoint = `${APIFY_BASE_URL}/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < APIFY_MAX_WAIT_MS) {
    const response = await fetchWithTimeout(endpoint, {
      method: 'GET',
    }, APIFY_POLL_TIMEOUT_MS, signal);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Apify Instagram stories poll failed with HTTP ${response.status}: ${body.slice(0, 100)}`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error('Apify Instagram stories poll returned invalid JSON');
    }
    const status = (json as { data?: { status?: string } }).data?.status;
    if (status === 'SUCCEEDED') return;
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify Instagram stories run ended with status "${status}"`);
    }
    await abortableSleep(APIFY_POLL_INTERVAL_MS, signal);
  }
  throw new Error(`Apify Instagram stories run timed out after ${APIFY_MAX_WAIT_MS}ms`);
}

async function fetchApifyDatasetItems(
  datasetId: string,
  token: string,
  signal?: AbortSignal,
): Promise<InstagramRecord[]> {
  const endpoint = `${APIFY_BASE_URL}/datasets/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(token)}`;
  const response = await fetchWithTimeout(endpoint, {
    method: 'GET',
  }, APIFY_DATASET_TIMEOUT_MS, signal);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Apify Instagram stories dataset failed with HTTP ${response.status}: ${body.slice(0, 100)}`,
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error('Apify Instagram stories dataset returned invalid JSON');
  }
  const arrayResult = RecordArraySchema.safeParse(raw);
  if (!arrayResult.success) {
    throw new Error('Apify Instagram stories dataset did not return a JSON array');
  }
  const records: InstagramRecord[] = [];
  for (const item of arrayResult.data) {
    const parsed = RecordSchema.safeParse(item);
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

function unixToIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return toIsoString(value.trim());
  }
  return undefined;
}

function mediaTypeFromRecord(record: InstagramRecord): 'image' | 'video' | 'unknown' {
  const mediaType = record['media_type'];
  if (mediaType === 1 || mediaType === '1' || mediaType === 'Image' || mediaType === 'image') {
    return 'image';
  }
  if (mediaType === 2 || mediaType === '2' || mediaType === 'Video' || mediaType === 'video') {
    return 'video';
  }
  const productType = readString(record, 'product_type', 'mediaType');
  if (productType !== null) {
    const lower = productType.toLowerCase();
    if (lower.includes('video')) return 'video';
    if (lower.includes('image') || lower.includes('photo')) return 'image';
  }
  return 'unknown';
}

function extractStoryMediaUrls(record: InstagramRecord): string[] {
  const candidates: string[] = [];
  const imageVersions = record['image_versions2'];
  if (imageVersions !== undefined && typeof imageVersions === 'object' && imageVersions !== null) {
    const candidatesField = (imageVersions as { candidates?: unknown }).candidates;
    if (Array.isArray(candidatesField)) {
      for (const candidate of candidatesField) {
        if (candidate !== null && typeof candidate === 'object') {
          const url = (candidate as { url?: unknown }).url;
          if (typeof url === 'string' && url.trim().length > 0) candidates.push(url.trim());
        }
      }
    }
  }
  const videoVersions = record['video_versions'];
  if (Array.isArray(videoVersions)) {
    for (const version of videoVersions) {
      if (version !== null && typeof version === 'object') {
        const url = (version as { url?: unknown }).url;
        if (typeof url === 'string' && url.trim().length > 0) candidates.push(url.trim());
      }
    }
  }
  for (const key of ['mediaUrl', 'media_url', 'video_url', 'display_url', 'thumbnailUrl', 'thumbnail_url']) {
    const value = readString(record, key);
    if (value !== null) candidates.push(value);
  }
  return uniqueStrings(
    candidates
      .map(normalizeMediaUrl)
      .filter((value): value is string => value !== null),
  );
}

function extractStoryLinkUrl(record: InstagramRecord): string | undefined {
  const direct = readString(record, 'linkUrl', 'link_url', 'story_link_url');
  if (direct !== null) {
    const normalized = normalizeMediaUrl(direct);
    if (normalized !== null) return normalized;
  }
  const stickers = record['story_link_stickers'];
  if (!Array.isArray(stickers)) return undefined;
  for (const sticker of stickers) {
    if (sticker === null || typeof sticker !== 'object') continue;
    const storyLink = (sticker as { story_link?: unknown }).story_link;
    if (storyLink === null || typeof storyLink !== 'object') continue;
    const rawUrl = (storyLink as { url?: unknown; display_url?: unknown }).url
      ?? (storyLink as { display_url?: unknown }).display_url;
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) continue;
    // Instagram wraps destinations; prefer display_url when present.
    const display = (storyLink as { display_url?: unknown }).display_url;
    const preferred = typeof display === 'string' && display.trim().length > 0
      ? display.trim()
      : rawUrl.trim();
    if (preferred.startsWith('http://') || preferred.startsWith('https://')) {
      return preferred.startsWith('http') ? preferred : `https://${preferred}`;
    }
    return `https://${preferred}`;
  }
  return undefined;
}

function extractStoryHashtags(record: InstagramRecord): string[] {
  const fromArray = readStringArray(record, 'hashtags', 'stickerTypes');
  if (fromArray.length > 0) {
    return uniqueStrings(fromArray.map(tag => tag.replace(/^#/, '').toLowerCase()));
  }
  const stickers = record['story_hashtags'];
  if (!Array.isArray(stickers)) return [];
  const tags: string[] = [];
  for (const sticker of stickers) {
    if (sticker === null || typeof sticker !== 'object') continue;
    const hashtag = (sticker as { hashtag?: unknown }).hashtag;
    if (hashtag === null || typeof hashtag !== 'object') continue;
    const name = (hashtag as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim().length > 0) {
      tags.push(name.trim().replace(/^#/, '').toLowerCase());
    }
  }
  return uniqueStrings(tags);
}

function extractStoryCaption(record: InstagramRecord): string {
  const direct = readString(record, 'caption', 'text', 'title');
  if (direct !== null) return direct;
  const captionObj = record['caption'];
  if (captionObj !== null && typeof captionObj === 'object') {
    const text = (captionObj as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim().length > 0) return text.trim();
  }
  return '';
}

function extractStoryUsername(record: InstagramRecord, fallback: string): string {
  const top = readString(record, 'username', 'user_posted', 'ownerUsername');
  if (top !== null) return top.replace(/^@/, '').toLowerCase();
  const user = record['user'];
  if (user !== null && typeof user === 'object') {
    const username = (user as { username?: unknown }).username;
    if (typeof username === 'string' && username.trim().length > 0) {
      return username.trim().replace(/^@/, '').toLowerCase();
    }
  }
  return fallback;
}

function extractStoryId(record: InstagramRecord): string | null {
  const direct = readString(record, 'storyId', 'story_id', 'pk', 'id', 'code', 'strong_id__');
  if (direct !== null) {
    // Prefer the numeric pk portion when id is "pk_userid"
    const pkOnly = direct.split('_')[0];
    if (pkOnly !== undefined && pkOnly.length > 0) return pkOnly;
    return direct;
  }
  const pk = record['pk'];
  if (typeof pk === 'number' && Number.isFinite(pk)) return String(pk);
  if (typeof pk === 'string' && pk.trim().length > 0) return pk.trim();
  return null;
}

function normalizeInstagramStoryRecord(
  record: InstagramRecord,
  expectedUsername: string,
): NormalizedInstagramStory | null {
  const providerError = readString(record, 'error', 'error_message');
  if (providerError !== null) {
    throw new Error(`Apify Instagram stories returned a provider error: ${providerError.slice(0, 120)}`);
  }
  const username = extractStoryUsername(record, expectedUsername);
  if (username !== expectedUsername.toLowerCase()) {
    // Actor may return multi-user batches; ignore other usernames.
    if (username.length > 0 && username !== expectedUsername.toLowerCase()) {
      return null;
    }
  }
  const storyId = extractStoryId(record);
  if (storyId === null) return null;
  const mediaUrls = extractStoryMediaUrls(record);
  const caption = extractStoryCaption(record);
  const linkUrl = extractStoryLinkUrl(record);
  const hashtags = extractStoryHashtags(record);
  const mediaType = mediaTypeFromRecord(record);
  // A story with neither media nor caption nor link is not usable evidence.
  if (mediaUrls.length === 0 && caption.length === 0 && linkUrl === undefined) {
    return null;
  }
  return {
    url: `https://www.instagram.com/stories/${username}/${storyId}/`,
    storyId,
    username,
    caption,
    mediaType,
    mediaUrls,
    publishedAt: unixToIso(record['taken_at'] ?? record['timestamp'] ?? record['device_timestamp']),
    expiresAt: unixToIso(record['expiring_at'] ?? record['expiresAt'] ?? record['expires_at']),
    linkUrl,
    hashtags,
  };
}

async function scrapeStories(
  target: InstagramStoriesTarget,
  token: string,
  signal?: AbortSignal,
): Promise<NormalizedInstagramStory[]> {
  const { runId, datasetId } = await startApifyStoriesRun([target.username], token, signal);
  await pollApifyRunUntilDone(runId, token, signal);
  const records = await fetchApifyDatasetItems(datasetId, token, signal);
  const stories = records
    .map(record => normalizeInstagramStoryRecord(record, target.username))
    .filter((story): story is NormalizedInstagramStory => story !== null);

  const filtered = target.storyId !== undefined
    ? stories.filter(story => story.storyId === target.storyId || story.url.endsWith(`/${target.storyId}/`))
    : stories;

  if (filtered.length === 0) {
    if (target.storyId !== undefined) {
      throw new Error(
        `Apify Instagram stories scrape returned no matching story "${target.storyId}" for @${target.username}`,
      );
    }
    throw new Error(
      `Apify Instagram stories scrape returned no active stories for @${target.username}`,
    );
  }
  return filtered;
}

function storiesToFetchResult(
  target: InstagramStoriesTarget,
  stories: NormalizedInstagramStory[],
): FetchResult {
  const title = stories.length === 1
    ? `Instagram story from @${target.username}`
    : `${stories.length} Instagram stories from @${target.username}`;
  const lines: string[] = [
    `# ${title}`,
    '',
    `**Source:** ${target.storyUrl ?? target.watchUrl}`,
    `**Creator:** @${target.username}`,
    `**Stories:** ${stories.length}`,
    '**Instagram data provider:** Apify',
    `**Apify actor:** ${APIFY_INSTAGRAM_STORIES_ACTOR_ID}`,
    '',
  ];
  for (const [index, story] of stories.entries()) {
    lines.push(`## Story ${index + 1}`, '');
    lines.push(`- **URL:** ${story.url}`);
    lines.push(`- **Story ID:** ${story.storyId}`);
    lines.push(`- **Media type:** ${story.mediaType}`);
    if (story.publishedAt !== undefined) lines.push(`- **Posted:** ${story.publishedAt}`);
    if (story.expiresAt !== undefined) lines.push(`- **Expires:** ${story.expiresAt}`);
    if (story.linkUrl !== undefined) lines.push(`- **Link:** ${story.linkUrl}`);
    if (story.hashtags.length > 0) lines.push(`- **Hashtags:** ${story.hashtags.map(tag => `#${tag}`).join(' ')}`);
    if (story.caption.length > 0) {
      lines.push('', story.caption, '');
    }
    if (story.mediaUrls.length > 0) {
      lines.push('**Media:**');
      for (const mediaUrl of story.mediaUrls) lines.push(`- ${mediaUrl}`);
      lines.push('');
    }
  }
  const rawContent = stories
    .map(story => {
      const parts = [story.caption];
      if (story.linkUrl !== undefined) parts.push(story.linkUrl);
      return parts.filter(part => part.length > 0).join('\n');
    })
    .filter(part => part.length > 0)
    .join('\n\n');
  return FetchResultSchema.parse({
    provider: 'instagram',
    url: target.storyUrl ?? target.watchUrl,
    canonical_id: target.storyId ?? target.username,
    title,
    author: `@${target.username}`,
    published_at: stories[0]?.publishedAt,
    raw_content: rawContent,
    markdown: lines.join('\n'),
    engagement: {
      story_count: stories.length,
      instagram_provider: 'apify',
      apify_actor_id: APIFY_INSTAGRAM_STORIES_ACTOR_ID,
      source_kind: 'stories',
      stories: stories.map(story => ({
        story_id: story.storyId,
        url: story.url,
        media_type: story.mediaType,
        media_urls: story.mediaUrls,
        published_at: story.publishedAt,
        expires_at: story.expiresAt,
        link_url: story.linkUrl,
        hashtags: story.hashtags,
        caption: story.caption,
      })),
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

export function createInstagramProvider(credentials: ResearchCredentials): SearchProvider {
  return {
    name: 'instagram',

    // Enabled when either transport is configured. Search/posts/profiles still
    // require Bright Data; stories require Apify. Callers hit the missing-key
    // error on the path they actually use.
    enabled: credentials.brightdata !== undefined || credentials.apifyApiToken !== undefined,

    async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
      const token = requireBrightDataToken(credentials);
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
      const storiesTarget = parseInstagramStoriesUrl(url);
      if (storiesTarget !== null) {
        try {
          const apifyToken = requireApifyToken(credentials);
          const stories = await scrapeStories(storiesTarget, apifyToken, signal);
          logger.info(
            { username: storiesTarget.username, storyCount: stories.length },
            '[Instagram] Apify stories fetch complete',
          );
          return storiesToFetchResult(storiesTarget, stories);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Apify Instagram stories fetch failed';
          return failedFetch(storiesTarget.storyUrl ?? storiesTarget.watchUrl, message);
        }
      }

      const canonicalPostUrl = canonicalizeInstagramPostUrl(url);
      const canonicalProfileUrl = canonicalizeInstagramProfileUrl(url);
      if (canonicalPostUrl === null && canonicalProfileUrl === null) {
        return failedFetch(
          url,
          'Instagram fetch requires a direct /p/, /reel/, /tv/, /stories/{user}/, or one-segment profile URL',
        );
      }

      try {
        const token = requireBrightDataToken(credentials);
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
        throw new Error('Cannot extract Instagram evidence from a failed or empty Instagram fetch');
      }
      return extractQuotesWithGemini({
        credentials,
        provider: 'instagram',
        url: raw.url,
        content,
        mode: 'reddit',
      });
    },
  };
}
