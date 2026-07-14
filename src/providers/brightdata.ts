/**
 * Bright Data Web Scraper API — read-only knowledge ingestion client.
 *
 * Replaces the failing Apify LinkedIn (HTTP 403) path and the stub Facebook-
 * groups ingestion with Bright Data's Web Scraper API (dataset trigger →
 * snapshot poll → download). Two high-level functions normalize records into
 * `IngestedItem[]` for the continuous ingestion pipeline:
 *   - fetchLinkedInPostsBrightData(identifier, maxItems)
 *   - fetchFacebookGroupPostsBrightData(identifier, maxItems)
 *
 * Dataset IDs are CONFIGURABLE via env (they differ per Bright Data account):
 *   - BRIGHTDATA_LINKEDIN_DATASET_ID    — LinkedIn-posts dataset
 *   - BRIGHTDATA_FB_GROUPS_DATASET_ID   — Facebook-group-posts dataset
 * When a dataset ID env var is unset, the high-level fn logs a clear warning
 * and returns an empty array (tolerated — never crashes the sweep).
 *
 * Auth: Bearer `BRIGHTDATA_API_TOKEN`. Every payload boundary is Zod-validated.
 * Instagram intentionally does not use this tolerant ingestion wrapper. Its
 * strict search/post/profile implementation lives in `instagram.ts` so an
 * empty/error response cannot be converted into a successful empty sweep.
 */

import { z } from 'zod';
import { hashUrl, canonicalizeUrl } from '../types.js';
import { sleep } from '../pipeline-core.js';
import { logger } from '../logger.js';
import type { IngestedItem, IngestEngagement } from '../ingestion/types.js';

// =============================================================================
// Constants
// =============================================================================

const BRIGHTDATA_BASE_URL = 'https://api.brightdata.com/datasets/v3';
const TRIGGER_TIMEOUT_MS = 30_000;
const PROGRESS_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

// Snapshot polling — backoff-capped total wait so a slow snapshot returns a
// tolerated timeout error rather than blocking the whole sweep.
const POLL_INITIAL_INTERVAL_MS = 5_000;
const POLL_MAX_INTERVAL_MS = 15_000;
const POLL_MAX_WAIT_MS = 120_000;

const MIN_CONTENT_CHARS = 80;

// =============================================================================
// Credentials & dataset-id resolution
// =============================================================================

function getBrightDataToken(): string {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (token === undefined || token === '') {
    throw new Error('BRIGHTDATA_API_TOKEN environment variable is not configured');
  }
  return token;
}

function getLinkedInDatasetId(): string | null {
  const id = process.env.BRIGHTDATA_LINKEDIN_DATASET_ID;
  if (id === undefined || id === '') {
    return null;
  }
  return id;
}

function getFacebookGroupsDatasetId(): string | null {
  const id = process.env.BRIGHTDATA_FB_GROUPS_DATASET_ID;
  if (id === undefined || id === '') {
    return null;
  }
  return id;
}

// =============================================================================
// Bright Data API payload schemas
// =============================================================================

const TriggerResponseSchema = z.object({
  snapshot_id: z.string().min(1),
});

const ProgressResponseSchema = z.object({
  status: z.string().min(1),
});

// Bright Data records vary by dataset; be permissive and map whatever fields
// exist. `.passthrough()` keeps unknown keys without failing validation.
const BrightDataRecordSchema = z
  .object({
    url: z.string().optional(),
    post_url: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    post_text: z.string().optional(),
    description: z.string().optional(),
    title: z.string().optional(),
    author: z.string().optional(),
    user_name: z.string().optional(),
    author_name: z.string().optional(),
    profile_name: z.string().optional(),
    date_posted: z.string().optional(),
    timestamp: z.string().optional(),
    likes: z.number().optional(),
    num_likes: z.number().optional(),
    likes_count: z.number().optional(),
    comments: z.number().optional(),
    num_comments: z.number().optional(),
    comments_count: z.number().optional(),
  })
  .passthrough();

type BrightDataRecord = z.infer<typeof BrightDataRecordSchema>;

// =============================================================================
// Low-level client — trigger / poll / download
// =============================================================================

export interface PollSnapshotOptions {
  maxWaitMs?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
}

/**
 * POST a JSON array of input objects to a Bright Data dataset and return the
 * snapshot id for polling.
 */
export async function triggerCollection(
  datasetId: string,
  inputs: Array<Record<string, unknown>>,
): Promise<string> {
  const token = getBrightDataToken();
  const url = `${BRIGHTDATA_BASE_URL}/trigger?dataset_id=${encodeURIComponent(datasetId)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(inputs),
    signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Bright Data trigger error (${datasetId}): HTTP ${response.status} ${body.slice(0, 200)}`,
    );
  }

  const parsed = TriggerResponseSchema.parse(await response.json());
  return parsed.snapshot_id;
}

/**
 * Poll a snapshot until it reports `ready`. Returns when ready; throws a
 * tolerated error string on `failed` or when the wait cap is exceeded.
 */
export async function pollSnapshot(
  snapshotId: string,
  opts: PollSnapshotOptions = {},
): Promise<void> {
  const token = getBrightDataToken();
  const maxWaitMs = opts.maxWaitMs !== undefined ? opts.maxWaitMs : POLL_MAX_WAIT_MS;
  const initialIntervalMs =
    opts.initialIntervalMs !== undefined ? opts.initialIntervalMs : POLL_INITIAL_INTERVAL_MS;
  const maxIntervalMs = opts.maxIntervalMs !== undefined ? opts.maxIntervalMs : POLL_MAX_INTERVAL_MS;

  const url = `${BRIGHTDATA_BASE_URL}/progress/${encodeURIComponent(snapshotId)}`;
  const startedAt = Date.now();
  let intervalMs = initialIntervalMs;

  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(intervalMs);

    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROGRESS_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Bright Data progress error (${snapshotId}): HTTP ${response.status} ${body.slice(0, 100)}`,
      );
    }

    const status = ProgressResponseSchema.parse(await response.json()).status.toLowerCase();

    if (status === 'ready') {
      return;
    }
    if (status === 'failed') {
      throw new Error(`Bright Data snapshot "${snapshotId}" ended with status "failed"`);
    }

    // status === 'running' (or any other transient state): back off and retry.
    intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
  }

  throw new Error(
    `Bright Data snapshot "${snapshotId}" not ready after ${Math.round(maxWaitMs / 1000)}s (tolerated timeout)`,
  );
}

/**
 * Download a ready snapshot as JSON and Zod-validate each record.
 */
export async function downloadSnapshot(snapshotId: string): Promise<BrightDataRecord[]> {
  const token = getBrightDataToken();
  const url = `${BRIGHTDATA_BASE_URL}/snapshot/${encodeURIComponent(snapshotId)}?format=json`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Bright Data download error (${snapshotId}): HTTP ${response.status} ${body.slice(0, 100)}`,
    );
  }

  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) {
    throw new Error(`Bright Data download (${snapshotId}) did not return a JSON array`);
  }

  const records: BrightDataRecord[] = [];
  for (const entry of raw) {
    const parsed = BrightDataRecordSchema.safeParse(entry);
    if (parsed.success) {
      records.push(parsed.data);
    }
  }
  return records;
}

// =============================================================================
// Record → IngestedItem mapping
// =============================================================================

function firstString(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function recordToItem(
  record: BrightDataRecord,
  sourceType: 'linkedin' | 'facebook',
): IngestedItem | null {
  const url = firstString(record.url, record.post_url);
  if (url === null) {
    return null;
  }

  const content = firstString(record.text, record.content, record.post_text, record.description);
  if (content === null || content.trim().length < MIN_CONTENT_CHARS) {
    return null;
  }

  const author = firstString(
    record.author,
    record.author_name,
    record.user_name,
    record.profile_name,
  );

  const publishedAt = firstString(record.date_posted, record.timestamp);

  const likes = firstNumber(record.likes, record.num_likes, record.likes_count);
  const comments = firstNumber(record.comments, record.num_comments, record.comments_count);

  const engagement: IngestEngagement = {};
  if (likes !== undefined) {
    engagement.likes = likes;
  }
  if (comments !== undefined) {
    engagement.comments = comments;
  }

  const title = firstString(record.title);
  const canonical = canonicalizeUrl(url);
  const contentMd = content.trim();

  return {
    sourceId: null, // overwritten by caller
    sourceType,
    url: canonical,
    urlHash: hashUrl(canonical),
    title: title !== null ? title.slice(0, 200) : contentMd.slice(0, 200),
    contentMd,
    excerpt: contentMd.length <= 320 ? contentMd : `${contentMd.slice(0, 320).trim()}…`,
    author,
    publishedAt,
    engagement,
    qualityScore: null,
    category: 'other',
    tags: [],
    whyItMatters: null,
    quotes: [],
    embedding: null,
  };
}

// =============================================================================
// High-level ingestion fns
// =============================================================================

async function collectViaBrightData(
  datasetId: string,
  inputs: Array<Record<string, unknown>>,
  sourceType: 'linkedin' | 'facebook',
  maxItems: number,
): Promise<IngestedItem[]> {
  const snapshotId = await triggerCollection(datasetId, inputs);
  await pollSnapshot(snapshotId);
  const records = await downloadSnapshot(snapshotId);

  const items: IngestedItem[] = [];
  for (const record of records) {
    if (items.length >= maxItems) {
      break;
    }
    const item = recordToItem(record, sourceType);
    if (item !== null) {
      items.push(item);
    }
  }
  return items;
}

/**
 * Fetch LinkedIn posts for a profile/company identifier via Bright Data.
 * `identifier` is the LinkedIn profile or company URL.
 */
export async function fetchLinkedInPostsBrightData(
  identifier: string,
  maxItems: number,
): Promise<IngestedItem[]> {
  const datasetId = getLinkedInDatasetId();
  if (datasetId === null) {
    logger.warn(
      { identifier: identifier.slice(0, 60) },
      '[BrightData] BRIGHTDATA_LINKEDIN_DATASET_ID not set — returning empty (tolerated)',
    );
    return [];
  }

  const inputs: Array<Record<string, unknown>> = [{ url: identifier }];
  return collectViaBrightData(datasetId, inputs, 'linkedin', maxItems);
}

/**
 * Fetch Facebook group posts for a group identifier via Bright Data.
 * `identifier` is the Facebook group URL.
 */
export async function fetchFacebookGroupPostsBrightData(
  identifier: string,
  maxItems: number,
): Promise<IngestedItem[]> {
  const datasetId = getFacebookGroupsDatasetId();
  if (datasetId === null) {
    logger.warn(
      { identifier: identifier.slice(0, 60) },
      '[BrightData] BRIGHTDATA_FB_GROUPS_DATASET_ID not set — returning empty (tolerated)',
    );
    return [];
  }

  const inputs: Array<Record<string, unknown>> = [{ url: identifier }];
  return collectViaBrightData(datasetId, inputs, 'facebook', maxItems);
}
