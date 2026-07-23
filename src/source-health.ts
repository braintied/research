/**
 * Low-cost public source health probe.
 *
 * This module deliberately stops at provider search. It never fetches pages,
 * extracts evidence, invokes a model, or recalls trusted/private corpora.
 * Returned diagnostics contain a deterministic query hash, never query text.
 */

import { createHash } from 'node:crypto';
import { getEnabledSearchProviders } from './providers/index.js';
import {
  ATOMIC_PUBLIC_SOURCE_MODES,
  expandSourceModes,
  resolveSourceExecutionPlan,
} from './source-modes.js';
import type {
  AtomicPublicSourceMode,
  SourceMode,
  SourceModeScope,
  SourceExecutionPlan,
} from './source-modes.js';
import { SearchResultSchema } from './types.js';
import type {
  ProviderName,
  SearchOpts,
  SearchProvider,
  SearchResult,
  Subquery,
} from './types.js';

export const PUBLIC_SOURCE_HEALTH_MODES = [
  ...ATOMIC_PUBLIC_SOURCE_MODES,
  'all_public',
  'all_social',
] as const;

export type PublicSourceHealthMode = (typeof PUBLIC_SOURCE_HEALTH_MODES)[number];

export type PublicSearchProviderRegistry = Partial<Record<ProviderName, SearchProvider>>;

export type PublicSourceLaneStatus =
  | 'healthy'
  | 'ready'
  | 'empty'
  | 'timeout'
  | 'error'
  | 'unavailable';

export type PublicSourceHealthVerdict = 'healthy' | 'ready' | 'partial';

export interface ProbePublicSourceHealthInput {
  /** Public-safe question used only to compile and execute deterministic searches. */
  question: string;
  modes: PublicSourceHealthMode[];
  asOf?: string;
  scopes?: Partial<Record<AtomicPublicSourceMode, SourceModeScope>>;
  requiredProviders?: ProviderName[];
  /** Per-lane result cap. Values above the hard cap are reduced. */
  limit?: number;
  /** Per-lane page cap. Values above the hard cap are reduced. */
  maxPages?: number;
  /** Per-lane wall-clock timeout. Values above the hard cap are reduced. */
  timeoutMs?: number;
}

export interface PublicSourceHealthDependencies {
  /**
   * Explicit registry injection for offline tests or caller-approved free
   * adapters. When omitted, only the package's known no-billing providers are
   * eligible, even if credentials for paid providers exist in the process.
   */
  providerRegistry?: PublicSearchProviderRegistry;
  now?: () => number;
}

export interface PublicSourceHealthError {
  code: 'provider_unavailable' | 'provider_error' | 'timeout' | 'invalid_response';
  /** Constant, sanitized text. Raw provider errors are never returned. */
  message: string;
}

export interface PublicSourceLaneHealth {
  mode: AtomicPublicSourceMode;
  status: PublicSourceLaneStatus;
  provider: ProviderName | null;
  backend: string | null;
  queryHash: string | null;
  resultCount: number;
  uniqueSourceCount: number;
  datedResultCount: number;
  oldestPublishedAt: string | null;
  newestPublishedAt: string | null;
  asOf: string | null;
  latencyMs: number | null;
  checkedAt: string;
  error: PublicSourceHealthError | null;
}

export interface PublicSourceHealthOverall {
  /** The deterministic plan has every requested lane/provider available. */
  ready: boolean;
  /** Every lane met its plan's minimum discovery and unique-source targets. */
  healthy: boolean;
  /** At least one requested lane/provider could not be probed successfully. */
  partial: boolean;
  verdict: PublicSourceHealthVerdict;
}

export interface PublicSourceHealthReport {
  checkedAt: string;
  asOf: string | null;
  requiredProviders: ProviderName[];
  missingRequiredProviders: ProviderName[];
  missingModes: AtomicPublicSourceMode[];
  lanes: PublicSourceLaneHealth[];
  overall: PublicSourceHealthOverall;
}

const DEFAULT_RESULT_LIMIT = 4;
const MAX_RESULT_LIMIT = 8;
const DEFAULT_MAX_PAGES = 1;
const MAX_PAGES = 2;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 15_000;

/** Providers whose default package adapters do not create usage-based bills. */
const NO_BILLING_PROVIDER_NAMES = new Set<ProviderName>([
  'searxng',
  'reddit',
  'youtube',
  'github',
  'hn',
  'rss',
]);

class SourceHealthTimeoutError extends Error {
  constructor() {
    super('source-health-timeout');
    this.name = 'SourceHealthTimeoutError';
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive finite number.`);
  }
  return Math.min(Math.floor(candidate), maximum);
}

function defaultProviderRegistry(): PublicSearchProviderRegistry {
  const enabled = getEnabledSearchProviders();
  const registry: PublicSearchProviderRegistry = {};
  for (const providerName of NO_BILLING_PROVIDER_NAMES) {
    const provider = enabled[providerName];
    if (provider !== undefined) registry[providerName] = provider;
  }
  return registry;
}

function searchableProviderNames(registry: PublicSearchProviderRegistry): ProviderName[] {
  return (Object.keys(registry) as ProviderName[]).filter((providerName) => {
    const provider = registry[providerName];
    return provider !== undefined && providerIsSearchable(provider);
  });
}

function providerIsSearchable(provider: SearchProvider): boolean {
  try {
    return provider.enabled && provider.capabilities?.search !== false;
  } catch {
    return false;
  }
}

function assertPublicModes(modes: PublicSourceHealthMode[]): void {
  if (modes.length === 0) throw new Error('At least one public source mode is required.');
  const expanded = expandSourceModes(modes as SourceMode[]);
  const invalid = expanded.some((mode) =>
    !ATOMIC_PUBLIC_SOURCE_MODES.includes(mode as AtomicPublicSourceMode));
  if (invalid) throw new Error('Trusted source modes are not supported by the public health probe.');
}

function hashQuery(query: string): string {
  return createHash('sha256').update(query).digest('hex');
}

function sanitizeBackend(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[a-z0-9][a-z0-9_.+:-]{0,79}$/i.test(trimmed)) return null;
  return trimmed;
}

function backendFor(provider: SearchProvider, results: SearchResult[]): string | null {
  let allowedBackends: string[];
  try {
    allowedBackends = (provider.capabilities?.backends ?? [])
      .flatMap((candidate) => {
        const sanitized = sanitizeBackend(candidate);
        return sanitized !== null ? [sanitized] : [];
      });
  } catch {
    return null;
  }
  const allowed = new Set(allowedBackends);
  for (const result of results) {
    const backend = sanitizeBackend(result.raw_metadata['backend']);
    if (backend !== null && allowed.has(backend)) return backend;
  }
  return allowedBackends[0] ?? null;
}

function dateSummary(results: SearchResult[]): {
  datedResultCount: number;
  oldestPublishedAt: string | null;
  newestPublishedAt: string | null;
} {
  const dates = results
    .flatMap((result) => result.published_at !== undefined ? [result.published_at] : [])
    .sort((left, right) => left.localeCompare(right));
  return {
    datedResultCount: dates.length,
    oldestPublishedAt: dates[0] ?? null,
    newestPublishedAt: dates[dates.length - 1] ?? null,
  };
}

function safeIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

async function searchWithTimeout(
  provider: SearchProvider,
  query: string,
  options: Omit<SearchOpts, 'signal'>,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new SourceHealthTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      provider.search(query, { ...options, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function unavailableLane(
  plan: SourceExecutionPlan,
  mode: AtomicPublicSourceMode,
  checkedAt: string,
  asOf: string | null,
): PublicSourceLaneHealth {
  const entry = plan.entries.find((candidate) => candidate.mode === mode);
  return {
    mode,
    status: 'unavailable',
    provider: entry?.selectedProviders[0] ?? null,
    backend: null,
    queryHash: null,
    resultCount: 0,
    uniqueSourceCount: 0,
    datedResultCount: 0,
    oldestPublishedAt: null,
    newestPublishedAt: null,
    asOf,
    latencyMs: null,
    checkedAt,
    error: {
      code: 'provider_unavailable',
      message: 'No eligible public search provider is available for this lane.',
    },
  };
}

async function probeSeededLane(
  plan: SourceExecutionPlan,
  subquery: Subquery,
  registry: PublicSearchProviderRegistry,
  resultLimit: number,
  pageLimit: number,
  timeoutMs: number,
  now: () => number,
  asOf: string | null,
): Promise<PublicSourceLaneHealth> {
  const mode = subquery.source_mode as AtomicPublicSourceMode;
  const providerName = subquery.providers[0];
  const provider = providerName !== undefined ? registry[providerName] : undefined;
  const startedAt = now();
  const checkedAt = safeIso(startedAt);
  const queryHash = hashQuery(subquery.query);

  if (providerName === undefined || provider === undefined || !providerIsSearchable(provider)) {
    return {
      ...unavailableLane(plan, mode, checkedAt, asOf),
      provider: providerName ?? null,
      queryHash,
      latencyMs: 0,
    };
  }

  const options: Omit<SearchOpts, 'signal'> = {
    ...subquery.search_options,
    limit: Math.min(subquery.search_options.limit ?? resultLimit, resultLimit),
    max_pages: Math.min(subquery.search_options.max_pages ?? pageLimit, pageLimit),
  };

  try {
    const rawResults = await searchWithTimeout(
      provider,
      subquery.query,
      options,
      timeoutMs,
    );
    const results: SearchResult[] = [];
    let invalidResultCount = 0;
    for (const rawResult of rawResults) {
      const parsed = SearchResultSchema.safeParse(rawResult);
      if (parsed.success) results.push(parsed.data);
      else invalidResultCount += 1;
    }

    const latencyMs = Math.max(0, now() - startedAt);
    if (invalidResultCount > 0 && results.length === 0) {
      return {
        mode,
        status: 'error',
        provider: providerName,
        backend: backendFor(provider, results),
        queryHash,
        resultCount: 0,
        uniqueSourceCount: 0,
        datedResultCount: 0,
        oldestPublishedAt: null,
        newestPublishedAt: null,
        asOf,
        latencyMs,
        checkedAt,
        error: {
          code: 'invalid_response',
          message: 'The provider returned an invalid search response.',
        },
      };
    }

    const entry = plan.entries.find((candidate) => candidate.mode === mode);
    const uniqueSourceCount = new Set(results.map((result) => result.url)).size;
    const metMinimums = results.length >= (entry?.minimumDiscoveries ?? 1)
      && uniqueSourceCount >= (entry?.minimumUniqueSources ?? 1);
    const status: PublicSourceLaneStatus = results.length === 0
      ? 'empty'
      : metMinimums && invalidResultCount === 0 ? 'healthy' : 'ready';
    return {
      mode,
      status,
      provider: providerName,
      backend: backendFor(provider, results),
      queryHash,
      resultCount: results.length,
      uniqueSourceCount,
      ...dateSummary(results),
      asOf,
      latencyMs,
      checkedAt,
      error: null,
    };
  } catch (error: unknown) {
    const latencyMs = Math.max(0, now() - startedAt);
    const timedOut = error instanceof SourceHealthTimeoutError;
    return {
      mode,
      status: timedOut ? 'timeout' : 'error',
      provider: providerName,
      backend: backendFor(provider, []),
      queryHash,
      resultCount: 0,
      uniqueSourceCount: 0,
      datedResultCount: 0,
      oldestPublishedAt: null,
      newestPublishedAt: null,
      asOf,
      latencyMs,
      checkedAt,
      error: timedOut
        ? { code: 'timeout', message: 'The public search provider timed out.' }
        : { code: 'provider_error', message: 'The public search provider failed.' },
    };
  }
}

/**
 * Compile and execute a bounded, search-only health check for public lanes.
 */
export async function probePublicSourceHealth(
  input: ProbePublicSourceHealthInput,
  dependencies: PublicSourceHealthDependencies = {},
): Promise<PublicSourceHealthReport> {
  if (input.question.trim().length < 3) {
    throw new Error('A public question of at least three characters is required.');
  }
  assertPublicModes(input.modes);

  const resultLimit = boundedPositiveInteger(
    input.limit,
    DEFAULT_RESULT_LIMIT,
    MAX_RESULT_LIMIT,
    'Source health result limit',
  );
  const pageLimit = boundedPositiveInteger(
    input.maxPages,
    DEFAULT_MAX_PAGES,
    MAX_PAGES,
    'Source health page limit',
  );
  const timeoutMs = boundedPositiveInteger(
    input.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    'Source health timeout',
  );
  const registry = dependencies.providerRegistry ?? defaultProviderRegistry();
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const checkedAt = safeIso(startedAt);
  const asOf = input.asOf !== undefined
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(input.asOf)
      ? `${input.asOf}T23:59:59.999Z`
      : input.asOf).toISOString()
    : null;

  const plan = resolveSourceExecutionPlan({
    question: input.question,
    modes: input.modes,
    availableProviders: searchableProviderNames(registry),
    requiredProviders: input.requiredProviders,
    asOf: input.asOf,
    scopes: input.scopes,
  });

  const probes = new Map<AtomicPublicSourceMode, Promise<PublicSourceLaneHealth>>();
  for (const subquery of plan.seededSubqueries) {
    const mode = subquery.source_mode as AtomicPublicSourceMode;
    probes.set(mode, probeSeededLane(
      plan,
      subquery,
      registry,
      resultLimit,
      pageLimit,
      timeoutMs,
      now,
      asOf,
    ));
  }

  const lanes = await Promise.all(plan.publicModes.map(async (mode) => {
    const probe = probes.get(mode);
    return probe !== undefined
      ? probe
      : unavailableLane(plan, mode, checkedAt, asOf);
  }));
  const completed = lanes.every((lane) =>
    lane.status === 'healthy' || lane.status === 'ready' || lane.status === 'empty');
  const ready = plan.ready && completed;
  const healthy = ready && lanes.length > 0
    && lanes.every((lane) => lane.status === 'healthy');
  const partial = !ready;
  const verdict: PublicSourceHealthVerdict = healthy
    ? 'healthy'
    : ready ? 'ready' : 'partial';

  return {
    checkedAt,
    asOf,
    requiredProviders: plan.requiredProviders,
    missingRequiredProviders: plan.missingRequiredProviders,
    missingModes: plan.missingModes.filter((mode): mode is AtomicPublicSourceMode =>
      ATOMIC_PUBLIC_SOURCE_MODES.includes(mode as AtomicPublicSourceMode)),
    lanes,
    overall: { ready, healthy, partial, verdict },
  };
}
