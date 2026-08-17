/**
 * Explicit research source modes.
 *
 * Research kinds answer "how deep / how expensive?". Source modes answer
 * "which evidence lanes must actually run?". The resolver is deterministic:
 * every required public lane emits a locked seed subquery, while the LLM
 * planner remains free to add supplemental searches.
 */

import { z } from 'zod';
import { SubquerySchema } from './types.js';
import type { SearchOpts, Subquery, ProviderName, SearchResult } from './types.js';

export const ATOMIC_PUBLIC_SOURCE_MODES = [
  'web',
  'x',
  'reddit',
  'youtube',
  'github',
  'community',
  'instagram',
  'tiktok',
  'facebook_groups',
] as const;

export const TRUSTED_SOURCE_MODES = ['cortex', 'telegram'] as const;

export const SOURCE_MODES = [
  ...ATOMIC_PUBLIC_SOURCE_MODES,
  ...TRUSTED_SOURCE_MODES,
  'all_public',
  'all_social',
  'all',
] as const;

export const SourceModeSchema = z.enum(SOURCE_MODES);
export type SourceMode = z.infer<typeof SourceModeSchema>;
export type AtomicPublicSourceMode = (typeof ATOMIC_PUBLIC_SOURCE_MODES)[number];
export type TrustedSourceMode = (typeof TRUSTED_SOURCE_MODES)[number];
export type AtomicSourceMode = AtomicPublicSourceMode | TrustedSourceMode;

export const SourceBackendSchema = z.enum([
  'tavily',
  'searxng',
  'native_x_api',
  'twitterapi_io',
  'native_reddit_api',
  'native_youtube_api',
  'native_github_api',
  'brightdata',
  'crawl4ai',
  'direct_fetch',
  'apify',
  'hacker_news',
  'rss',
  'podcasts',
  'ora_cortex',
  'braintied_telegram',
]);
export type SourceBackend = z.infer<typeof SourceBackendSchema>;

export interface SourceBackendPolicy {
  backend: SourceBackend;
  role: 'discovery' | 'acquisition' | 'fallback' | 'trusted_recall';
  /** Lower numbers run first. */
  priority: number;
  /** Whether the current package path is implemented, conditional, or planned. */
  state: 'implemented' | 'conditional' | 'planned';
  note: string;
}

export interface SourceModeDefinition {
  mode: AtomicSourceMode;
  visibility: 'public' | 'trusted_local';
  description: string;
  candidateProviders: ProviderName[];
  preferredProviders: ProviderName[];
  adapterId?: string;
  expectedSourceTypes: Subquery['expected_source_types'];
  defaultSearchOptions: Omit<SearchOpts, 'signal' | 'limit'>;
  searchResultLimit?: number;
  backendPolicy: SourceBackendPolicy[];
  minimumDiscoveries: number;
  minimumUniqueSources: number;
}

const DEFINITIONS: Record<AtomicSourceMode, SourceModeDefinition> = {
  web: {
    mode: 'web', visibility: 'public',
    description: 'Broad public web discovery with Tavily quality/raw-content first and self-hosted breadth fallback.',
    candidateProviders: ['tavily', 'searxng', 'serper', 'serpapi', 'exa'],
    preferredProviders: ['tavily', 'searxng'],
    expectedSourceTypes: ['documentation', 'longform', 'news'],
    defaultSearchOptions: { sort: 'relevance', max_pages: 1 },
    searchResultLimit: 12,
    backendPolicy: [
      { backend: 'tavily', role: 'discovery', priority: 1, state: 'implemented', note: 'Advanced search plus raw page content when available.' },
      { backend: 'searxng', role: 'fallback', priority: 2, state: 'implemented', note: 'Free/self-hosted breadth and independent discovery.' },
      { backend: 'crawl4ai', role: 'acquisition', priority: 1, state: 'implemented', note: 'Preferred page acquisition when search did not return raw content.' },
      { backend: 'direct_fetch', role: 'fallback', priority: 2, state: 'implemented', note: 'Last-resort plain HTTP extraction.' },
    ],
    minimumDiscoveries: 4, minimumUniqueSources: 3,
  },
  x: {
    mode: 'x', visibility: 'public',
    description: 'Direct X posts and threads sampled across fresh and high-engagement rankings.',
    candidateProviders: ['x'], preferredProviders: ['x'],
    expectedSourceTypes: ['social'],
    defaultSearchOptions: { sort: 'mixed', recency_days: 90, max_pages: 2 },
    searchResultLimit: 16,
    backendPolicy: [
      { backend: 'twitterapi_io', role: 'discovery', priority: 1, state: 'implemented', note: 'Lower-cost primary search/fetch path across Braintied; supports the profile historical window.' },
      { backend: 'native_x_api', role: 'fallback', priority: 2, state: 'implemented', note: 'Official X API v2 fallback only when its seven-day recent window fully covers the requested recency/as-of range.' },
      { backend: 'brightdata', role: 'acquisition', priority: 3, state: 'planned', note: 'Known-URL/profile enrichment only; the current catalog does not replace global X keyword or conversation search.' },
      { backend: 'apify', role: 'fallback', priority: 4, state: 'implemented', note: 'Last transport fallback only when APIFY_ALLOW_FALLBACK=1 after native X search fails.' },
    ],
    minimumDiscoveries: 2, minimumUniqueSources: 2,
  },
  reddit: {
    mode: 'reddit', visibility: 'public',
    description: 'Reddit threads and comment trees using the free native OAuth API.',
    candidateProviders: ['reddit'], preferredProviders: ['reddit'],
    expectedSourceTypes: ['forum', 'audience_voice'],
    defaultSearchOptions: { sort: 'mixed', recency_days: 365, max_pages: 2 },
    searchResultLimit: 18,
    backendPolicy: [
      { backend: 'native_reddit_api', role: 'discovery', priority: 1, state: 'implemented', note: 'Free OAuth search plus native thread/comment retrieval.' },
      { backend: 'brightdata', role: 'fallback', priority: 2, state: 'planned', note: 'Reserved for backfill only if native completeness becomes insufficient.' },
      { backend: 'apify', role: 'fallback', priority: 3, state: 'planned', note: 'Backup scraper, not the default while native access is healthy.' },
    ],
    minimumDiscoveries: 3, minimumUniqueSources: 3,
  },
  youtube: {
    mode: 'youtube', visibility: 'public',
    description: 'YouTube videos, transcripts, and comment threads via the free native Data API quota.',
    candidateProviders: ['youtube'], preferredProviders: ['youtube'],
    expectedSourceTypes: ['video', 'video_comments'],
    defaultSearchOptions: { sort: 'mixed', recency_days: 365, max_pages: 1 },
    searchResultLimit: 12,
    backendPolicy: [
      { backend: 'native_youtube_api', role: 'discovery', priority: 1, state: 'implemented', note: 'Native metadata/comments with transcript retrieval; quota-aware.' },
      { backend: 'brightdata', role: 'fallback', priority: 2, state: 'planned', note: 'Use for backfill only after a YouTube dataset is configured.' },
      { backend: 'apify', role: 'fallback', priority: 3, state: 'planned', note: 'Backup scraper rather than primary discovery.' },
    ],
    minimumDiscoveries: 2, minimumUniqueSources: 2,
  },
  github: {
    mode: 'github', visibility: 'public',
    description: 'GitHub repositories, issues, and pull requests using the public REST API.',
    candidateProviders: ['github', 'tavily', 'searxng'], preferredProviders: ['github'],
    expectedSourceTypes: ['repository', 'issue', 'code'],
    defaultSearchOptions: { sort: 'mixed', recency_days: 365, max_pages: 1 },
    searchResultLimit: 12,
    backendPolicy: [
      { backend: 'native_github_api', role: 'discovery', priority: 1, state: 'implemented', note: 'Free public search; dedicated public-research auth can be required by policy.' },
      { backend: 'tavily', role: 'fallback', priority: 2, state: 'implemented', note: 'Site-scoped fallback for GitHub discussions/docs not covered by REST.' },
      { backend: 'crawl4ai', role: 'acquisition', priority: 1, state: 'implemented', note: 'Fetches repository, issue, release, and discussion pages.' },
    ],
    minimumDiscoveries: 2, minimumUniqueSources: 2,
  },
  community: {
    mode: 'community', visibility: 'public',
    description: 'Independent community and long-form practitioner signal from HN, RSS, and podcasts.',
    candidateProviders: ['hn', 'rss', 'podcasts'], preferredProviders: ['hn', 'rss', 'podcasts'],
    expectedSourceTypes: ['forum', 'newsletter', 'podcast'],
    defaultSearchOptions: { sort: 'relevance', recency_days: 365, max_pages: 1 },
    backendPolicy: [
      { backend: 'hacker_news', role: 'discovery', priority: 1, state: 'implemented', note: 'Free Algolia-backed technical discussion discovery.' },
      { backend: 'rss', role: 'discovery', priority: 2, state: 'implemented', note: 'First-party feeds and newsletters.' },
      { backend: 'podcasts', role: 'discovery', priority: 3, state: 'conditional', note: 'Enabled when the podcast API is configured.' },
    ],
    minimumDiscoveries: 2, minimumUniqueSources: 2,
  },
  instagram: {
    mode: 'instagram', visibility: 'public',
    description: 'Instagram hashtag/post/profile research through Bright Data; active stories via Apify.',
    candidateProviders: ['instagram'], preferredProviders: ['instagram'],
    expectedSourceTypes: ['social', 'social_video'],
    defaultSearchOptions: { sort: 'relevance', recency_days: 180, max_pages: 1 },
    backendPolicy: [
      { backend: 'brightdata', role: 'discovery', priority: 1, state: 'implemented', note: 'Strict fail-closed posts/profiles/hashtag path.' },
      { backend: 'apify', role: 'acquisition', priority: 1, state: 'implemented', note: 'Stories only (datavoyantlab/advanced-instagram-stories-scraper); not gated by APIFY_ALLOW_FALLBACK.' },
    ],
    minimumDiscoveries: 2, minimumUniqueSources: 2,
  },
  tiktok: {
    mode: 'tiktok', visibility: 'public',
    description: 'TikTok posts and comments; Bright Data is preferred for URL acquisition and Apify currently supplies keyword discovery.',
    candidateProviders: ['tiktok'], preferredProviders: ['tiktok'],
    expectedSourceTypes: ['social_video'],
    defaultSearchOptions: { sort: 'relevance', recency_days: 180, max_pages: 1 },
    backendPolicy: [
      { backend: 'brightdata', role: 'discovery', priority: 1, state: 'implemented', note: 'Keyword discovery (discover_new) + preferred URL fetch on posts dataset gd_lu702nij2f790tmv9h.' },
      { backend: 'apify', role: 'fallback', priority: 2, state: 'implemented', note: 'Last resort only when APIFY_ALLOW_FALLBACK=1.' },
    ],
    minimumDiscoveries: 2, minimumUniqueSources: 2,
  },
  facebook_groups: {
    mode: 'facebook_groups', visibility: 'public',
    description: 'Facebook-group practitioner evidence with Bright Data target ingestion and Apify search fallback.',
    candidateProviders: ['facebook_groups'], preferredProviders: ['facebook_groups'],
    expectedSourceTypes: ['forum', 'social'],
    defaultSearchOptions: { sort: 'relevance', recency_days: 180, max_pages: 1 },
    backendPolicy: [
      { backend: 'brightdata', role: 'acquisition', priority: 1, state: 'conditional', note: 'Preferred when BRIGHTDATA_FB_GROUPS_DATASET_ID is configured for known groups.' },
      { backend: 'apify', role: 'fallback', priority: 2, state: 'implemented', note: 'Last resort only when APIFY_ALLOW_FALLBACK=1.' },
    ],
    minimumDiscoveries: 2, minimumUniqueSources: 2,
  },
  cortex: {
    mode: 'cortex', visibility: 'trusted_local',
    description: 'Tenant-scoped Ora Cortex reports, discoveries, and operational evidence.',
    candidateProviders: [], preferredProviders: [], adapterId: 'ora-cortex-braintied',
    expectedSourceTypes: [], defaultSearchOptions: {},
    backendPolicy: [
      { backend: 'ora_cortex', role: 'trusted_recall', priority: 1, state: 'conditional', note: 'Caller-injected tenant-scoped adapter; never sent to external providers.' },
    ],
    minimumDiscoveries: 3, minimumUniqueSources: 2,
  },
  telegram: {
    mode: 'telegram', visibility: 'trusted_local',
    description: 'Braintied Research Telegram messages and linked discoveries.',
    candidateProviders: [], preferredProviders: [], adapterId: 'ora-cortex-braintied',
    expectedSourceTypes: [], defaultSearchOptions: {},
    backendPolicy: [
      { backend: 'braintied_telegram', role: 'trusted_recall', priority: 1, state: 'conditional', note: 'Caller-injected scoped corpus adapter; never sent to external providers.' },
    ],
    minimumDiscoveries: 3, minimumUniqueSources: 2,
  },
};

const CORE_PUBLIC: AtomicPublicSourceMode[] = ['web', 'x', 'reddit', 'youtube', 'github', 'community'];
const ALL_SOCIAL: AtomicPublicSourceMode[] = ['x', 'reddit', 'youtube', 'instagram', 'tiktok', 'facebook_groups'];

export interface SourceModeScope {
  includeDomains?: string[];
  excludeDomains?: string[];
  communities?: string[];
  handles?: string[];
  channelIds?: string[];
  recencyDays?: number;
  maxPages?: number;
}

export interface ResolveSourceExecutionPlanInput {
  question: string;
  modes: SourceMode[];
  availableProviders: ProviderName[];
  availableTrustedAdapters?: string[];
  requiredProviders?: ProviderName[];
  asOf?: string;
  scopes?: Partial<Record<AtomicSourceMode, SourceModeScope>>;
}

export interface SourceModePlanEntry {
  mode: AtomicSourceMode;
  visibility: 'public' | 'trusted_local';
  ready: boolean;
  selectedProviders: ProviderName[];
  missingReason: string | null;
  adapterId?: string;
  backendPolicy: SourceBackendPolicy[];
  minimumDiscoveries: number;
  minimumUniqueSources: number;
}

export interface SourceExecutionPlan {
  requestedModes: SourceMode[];
  expandedModes: AtomicSourceMode[];
  publicModes: AtomicPublicSourceMode[];
  trustedModes: TrustedSourceMode[];
  providerAllowlist: ProviderName[];
  requiredProviders: ProviderName[];
  missingRequiredProviders: ProviderName[];
  entries: SourceModePlanEntry[];
  missingModes: AtomicSourceMode[];
  ready: boolean;
  seededSubqueries: Subquery[];
  outboundPreamble: string;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function expandSourceModes(modes: SourceMode[]): AtomicSourceMode[] {
  const expanded: AtomicSourceMode[] = [];
  for (const mode of modes) {
    if (mode === 'all_public') expanded.push(...CORE_PUBLIC);
    else if (mode === 'all_social') expanded.push(...ALL_SOCIAL);
    else if (mode === 'all') expanded.push(...CORE_PUBLIC, ...TRUSTED_SOURCE_MODES);
    else expanded.push(mode);
  }
  return unique(expanded);
}

function isoUpperBoundary(asOf: string | undefined): string | undefined {
  if (asOf === undefined) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? `${asOf}T23:59:59.999Z` : asOf;
  const parsed = new Date(dateOnly);
  if (Number.isNaN(parsed.getTime())) throw new Error('Source execution asOf must be an ISO date or timestamp.');
  return parsed.toISOString();
}

function searchOptionsFor(
  definition: SourceModeDefinition,
  scope: SourceModeScope | undefined,
  asOf: string | undefined,
): Subquery['search_options'] {
  const options: Subquery['search_options'] = {
    ...definition.defaultSearchOptions,
    ...(definition.searchResultLimit !== undefined ? { limit: definition.searchResultLimit } : {}),
  };
  const boundary = isoUpperBoundary(asOf);
  if (boundary !== undefined) options.published_before = boundary;
  if (scope?.recencyDays !== undefined) options.recency_days = scope.recencyDays;
  if (scope?.maxPages !== undefined) options.max_pages = scope.maxPages;
  if (scope?.includeDomains !== undefined) options.include_domains = scope.includeDomains;
  if (scope?.excludeDomains !== undefined) options.exclude_domains = scope.excludeDomains;
  if (scope?.communities !== undefined) options.communities = scope.communities;
  if (scope?.handles !== undefined) options.handles = scope.handles;
  if (scope?.channelIds !== undefined) options.channel_ids = scope.channelIds;
  return options;
}

function seededQuery(question: string, mode: AtomicPublicSourceMode): string {
  if (mode === 'github') return `${question} implementation repository issue discussion`;
  if (mode === 'youtube') return `${question} engineering talk demo interview`;
  if (mode === 'reddit') return `${question} production experience failure architecture`;
  if (mode === 'x') return `${question} agents loops graphs engineering`;
  if (mode === 'community') return `${question} practitioner engineering discussion`;
  return question;
}

export function resolveSourceExecutionPlan(input: ResolveSourceExecutionPlanInput): SourceExecutionPlan {
  const parsedModes = input.modes.map((mode) => SourceModeSchema.parse(mode));
  const expandedModes = expandSourceModes(parsedModes);
  const available = new Set(input.availableProviders);
  const trustedAdapters = new Set(input.availableTrustedAdapters ?? []);
  const entries: SourceModePlanEntry[] = [];
  const providerAllowlist: ProviderName[] = [];
  const seededSubqueries: Subquery[] = [];

  for (const mode of expandedModes) {
    const definition = DEFINITIONS[mode];
    if (definition.visibility === 'trusted_local') {
      const adapterId = definition.adapterId;
      const ready = adapterId !== undefined && trustedAdapters.has(adapterId);
      entries.push({
        mode, visibility: definition.visibility, ready, selectedProviders: [],
        missingReason: ready ? null : `trusted adapter ${adapterId ?? mode} is unavailable`,
        adapterId, backendPolicy: definition.backendPolicy,
        minimumDiscoveries: definition.minimumDiscoveries,
        minimumUniqueSources: definition.minimumUniqueSources,
      });
      continue;
    }

    const candidates = definition.candidateProviders.filter((provider) => available.has(provider));
    const preferred = definition.preferredProviders.filter((provider) => available.has(provider));
    const selected = preferred.length > 0 ? preferred.slice(0, 1) : candidates.slice(0, 1);
    const ready = selected.length > 0;
    entries.push({
      mode, visibility: definition.visibility, ready, selectedProviders: selected,
      missingReason: ready ? null : `no enabled provider for ${mode} (${definition.candidateProviders.join(', ')})`,
      backendPolicy: definition.backendPolicy,
      minimumDiscoveries: definition.minimumDiscoveries,
      minimumUniqueSources: definition.minimumUniqueSources,
    });
    providerAllowlist.push(...candidates);

    if (ready) {
      const publicMode = mode as AtomicPublicSourceMode;
      const scope = input.scopes?.[publicMode];
      seededSubqueries.push(SubquerySchema.parse({
        section_path: `source.${mode}`,
        query: seededQuery(input.question, publicMode),
        providers: selected,
        expected_source_types: definition.expectedSourceTypes,
        rationale: `Required deterministic ${mode} source-mode search.`,
        source_pack_id: `mode-${mode}`,
        source_mode: mode,
        required: true,
        search_options: searchOptionsFor(definition, scope, input.asOf),
      }));
    }
  }

  const requiredProviders = unique(input.requiredProviders ?? []);
  const missingRequiredProviders = requiredProviders.filter((provider) => !available.has(provider));
  providerAllowlist.push(...requiredProviders.filter((provider) => available.has(provider)));
  const missingModes = entries.filter((entry) => !entry.ready).map((entry) => entry.mode);
  const publicModes = expandedModes.filter((mode): mode is AtomicPublicSourceMode =>
    ATOMIC_PUBLIC_SOURCE_MODES.includes(mode as AtomicPublicSourceMode));
  const trustedModes = expandedModes.filter((mode): mode is TrustedSourceMode =>
    TRUSTED_SOURCE_MODES.includes(mode as TrustedSourceMode));

  const outboundPreamble = [
    'Required source lanes are enforced by deterministic searches in addition to the planner.',
    `Public lanes: ${publicModes.join(', ') || 'none'}.`,
    'Preserve direct URLs, authors, publication dates, engagement, and disagreement.',
    'Treat social/community evidence as practitioner signal rather than proof.',
    'Do not claim a lane was covered unless its deterministic search returned eligible evidence.',
  ].join(' ');

  return {
    requestedModes: unique(parsedModes), expandedModes, publicModes, trustedModes,
    providerAllowlist: unique(providerAllowlist), requiredProviders,
    missingRequiredProviders, entries, missingModes,
    ready: missingModes.length === 0 && missingRequiredProviders.length === 0,
    seededSubqueries, outboundPreamble,
  };
}

export interface SourceModeCoverageEntry {
  mode: AtomicSourceMode;
  required: boolean;
  passed: boolean;
  discoveryCount: number;
  uniqueSourceCount: number;
  providers: ProviderName[];
  reasons: string[];
}

export interface SourceModeCoverageReport {
  passed: boolean;
  entries: SourceModeCoverageEntry[];
  missingModes: AtomicSourceMode[];
}

/** Evaluate public discovery coverage. Trusted counts are supplied by caller. */
export function evaluateSourceModeCoverage(
  plan: SourceExecutionPlan,
  discoveries: SearchResult[],
  trustedCounts: Partial<Record<TrustedSourceMode, { evidence: number; sources: number }>> = {},
): SourceModeCoverageReport {
  const entries = plan.entries.map((entry): SourceModeCoverageEntry => {
    if (entry.visibility === 'trusted_local') {
      const count = trustedCounts[entry.mode as TrustedSourceMode] ?? { evidence: 0, sources: 0 };
      const reasons: string[] = [];
      if (!entry.ready) reasons.push(entry.missingReason ?? 'trusted adapter unavailable');
      if (count.evidence < entry.minimumDiscoveries) reasons.push(`needs ${entry.minimumDiscoveries} evidence items; found ${count.evidence}`);
      if (count.sources < entry.minimumUniqueSources) reasons.push(`needs ${entry.minimumUniqueSources} unique sources; found ${count.sources}`);
      return {
        mode: entry.mode, required: true, passed: reasons.length === 0,
        discoveryCount: count.evidence, uniqueSourceCount: count.sources,
        providers: [], reasons,
      };
    }
    const matching = discoveries.filter((result) => result.source_modes.includes(entry.mode));
    const sources = new Set(matching.map((result) => result.url));
    const providers = unique(matching.map((result) => result.provider));
    const reasons: string[] = [];
    if (!entry.ready) reasons.push(entry.missingReason ?? 'source mode unavailable');
    if (matching.length < entry.minimumDiscoveries) reasons.push(`needs ${entry.minimumDiscoveries} discoveries; found ${matching.length}`);
    if (sources.size < entry.minimumUniqueSources) reasons.push(`needs ${entry.minimumUniqueSources} unique sources; found ${sources.size}`);
    return {
      mode: entry.mode, required: true, passed: reasons.length === 0,
      discoveryCount: matching.length, uniqueSourceCount: sources.size,
      providers, reasons,
    };
  });
  const missingModes = entries.filter((entry) => !entry.passed).map((entry) => entry.mode);
  return { passed: missingModes.length === 0, entries, missingModes };
}

export function getSourceModeDefinition(mode: AtomicSourceMode): SourceModeDefinition {
  return DEFINITIONS[mode];
}
