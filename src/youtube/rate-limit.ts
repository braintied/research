/**
 * YouTube Data API v3 throttle — shared by the channel/metadata/comments
 * ingestion modules. Mirrors the two-layer pattern in
 * `providers/youtube.ts` (per-request floor + daily-quota burst cap) so
 * multi-page channel crawls cannot 429 the key.
 *
 * Layer 1: fixed floor of one request per YT_RATE_LIMIT_MS (~100 req/min).
 * Layer 2: burst cap — if YT_QUOTA_BURST_CAP calls land inside a 60s window,
 * sleep until the oldest call leaves the window (10,000 units/day budget).
 */

import { logger } from '../logger.js';
import { sleep } from '../pipeline-core.js';

const YT_RATE_LIMIT_MS = 650;
let lastYtCallAt = 0;

const YT_QUOTA_WINDOW_MS = 60_000;
const YT_QUOTA_BURST_CAP = 100;
const ytCallTimestamps: number[] = [];

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastYtCallAt;
  if (elapsed < YT_RATE_LIMIT_MS) {
    await sleep(YT_RATE_LIMIT_MS - elapsed);
  }
  lastYtCallAt = Date.now();
}

async function quotaAwareThrottle(): Promise<void> {
  const now = Date.now();
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

/** Await before every YouTube Data API call. */
export async function throttleYoutubeApiCall(): Promise<void> {
  await rateLimit();
  await quotaAwareThrottle();
}
