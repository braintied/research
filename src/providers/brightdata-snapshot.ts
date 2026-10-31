/**
 * Bright Data snapshot progress polling, shared by the strict Instagram
 * provider and the tolerant ingestion client.
 *
 * A snapshot is billed when it is triggered, so the poll loop must not give
 * one up on a single bad poll. On 2026-10-12 two Instagram snapshots
 * (sd_mv53pox21s8ltw4a99, sd_mv53pozfqe4eux0dh) reached `ready` with 3 records
 * each while the search failed with "Instagram request timed out after
 * 15000ms": one progress request stalled on a CPU-saturated host and threw
 * out of the whole wait. Inside the overall ceiling, a poll that times out,
 * hits a network error, or gets HTTP 5xx/429 now counts and retries. A
 * terminal snapshot status, a caller abort, and any other 4xx still fail at
 * once, because retrying cannot change them.
 */

import { z } from 'zod';
import { logger } from '../logger.js';

const BRIGHTDATA_PROGRESS_BASE_URL = 'https://api.brightdata.com/datasets/v3/progress';

const ProgressResponseSchema = z.object({
  status: z.string().min(1),
}).passthrough();

/** Statuses after which a snapshot will never become ready. */
const TERMINAL_SNAPSHOT_STATUSES: ReadonlySet<string> = new Set([
  'failed', 'error', 'aborted', 'cancelled', 'canceled',
]);

export interface WaitForBrightDataSnapshotOptions {
  snapshotId: string;
  token: string;
  /** Overall ceiling for the whole wait, retries included. */
  maxWaitMs: number;
  /** Per-request ceiling for one progress poll; clamped to the time left. */
  progressTimeoutMs: number;
  /** Delay before the first poll; 0 polls immediately. */
  initialDelayMs: number;
  /** Delay between polls after the first. */
  intervalMs: number;
  /** Interval growth per poll (1 = fixed). Capped by maxIntervalMs. */
  backoffFactor?: number;
  maxIntervalMs?: number;
  signal?: AbortSignal;
  /** Prefix for request-level errors: "Instagram" gives "Instagram request timed out ...". */
  label: string;
  /** Names the snapshot in status errors: "Bright Data Instagram snapshot". */
  subject: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export type BrightDataSnapshotWaitResult =
  | { ready: true; transientFailures: number }
  | { ready: false; waitedMs: number; transientFailures: number; lastTransientError: string | undefined };

/** A progress poll that failed in a way another poll can recover from. */
class TransientPollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientPollError';
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return 'request failed';
}

function abortedError(label: string): Error {
  return new Error(`${label} request aborted`);
}

async function delay(ms: number, label: string, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) throw abortedError(label);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(abortedError(label));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * One progress poll. Returns the lowercased status, throws TransientPollError
 * for a retryable failure, and throws a plain Error for everything else.
 */
async function pollProgressOnce(
  url: string,
  options: WaitForBrightDataSnapshotOptions,
  timeoutMs: number,
): Promise<string> {
  const { label, signal } = options;
  if (signal?.aborted === true) throw abortedError(label);
  const fetchImpl = options.fetch !== undefined ? options.fetch : fetch;

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
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${options.token}` },
        signal: controller.signal,
      });
    } catch (error) {
      if (callerAborted) throw abortedError(label);
      if (timedOut) throw new TransientPollError(`${label} request timed out after ${timeoutMs}ms`);
      throw new TransientPollError(`${label} request failed (${errorName(error)})`);
    }

    if (response.status === 429 || response.status >= 500) {
      throw new TransientPollError(`${options.subject} progress failed with HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`${options.subject} progress failed with HTTP ${response.status}`);
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      if (callerAborted) throw abortedError(label);
      if (timedOut) throw new TransientPollError(`${label} request timed out after ${timeoutMs}ms`);
      throw new TransientPollError(`${options.subject} progress body read failed (${errorName(error)})`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new Error(`${options.subject} progress returned invalid JSON`);
    }
    const parsed = ProgressResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${options.subject} progress failed validation`);
    }
    return parsed.data.status.toLowerCase();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * Poll a snapshot until it is ready or the ceiling passes. Resolves
 * `{ ready: true }` on ready and `{ ready: false, ... }` at the ceiling so each
 * caller throws its own resumable error carrying the snapshot id. Throws at
 * once on a terminal status, a caller abort, a non-retryable HTTP status, or a
 * malformed progress body.
 */
export async function waitForBrightDataSnapshot(
  options: WaitForBrightDataSnapshotOptions,
): Promise<BrightDataSnapshotWaitResult> {
  const { snapshotId, maxWaitMs, label, signal } = options;
  const url = `${BRIGHTDATA_PROGRESS_BASE_URL}/${encodeURIComponent(snapshotId)}`;
  const backoffFactor = options.backoffFactor !== undefined ? options.backoffFactor : 1;
  const maxIntervalMs = options.maxIntervalMs !== undefined ? options.maxIntervalMs : options.intervalMs;
  const startedAt = Date.now();
  const remaining = (): number => maxWaitMs - (Date.now() - startedAt);

  let nextDelayMs = options.initialDelayMs;
  let intervalMs = Math.min(options.intervalMs, maxIntervalMs);
  let transientFailures = 0;
  let lastTransientError: string | undefined;

  while (true) {
    if (remaining() <= 0) break;
    await delay(Math.min(nextDelayMs, remaining()), label, signal);
    const timeLeft = remaining();
    if (timeLeft <= 0) break;

    try {
      const status = await pollProgressOnce(url, options, Math.max(1, Math.min(options.progressTimeoutMs, timeLeft)));
      if (status === 'ready') return { ready: true, transientFailures };
      if (TERMINAL_SNAPSHOT_STATUSES.has(status)) {
        throw new Error(`${options.subject} ended with status "${status}"`);
      }
    } catch (error) {
      if (!(error instanceof TransientPollError)) throw error;
      transientFailures += 1;
      lastTransientError = error.message;
      logger.warn(
        { snapshotId, transientFailures, error: error.message },
        '[BrightData] Snapshot progress poll failed transiently; retrying inside the wait ceiling',
      );
    }

    nextDelayMs = intervalMs;
    intervalMs = Math.min(intervalMs * backoffFactor, maxIntervalMs);
  }

  return { ready: false, waitedMs: Date.now() - startedAt, transientFailures, lastTransientError };
}
