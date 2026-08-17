/**
 * Provider Registry
 *
 * Builds every SearchProvider from a host-supplied credential record, filters
 * to the enabled set, and routes source types onto providers.
 *
 * The registry is a VALUE, not a module singleton: a provider's `enabled` flag
 * is decided by the credentials it was built with, so two callers in one
 * process can hold different registries without leaking each other's keys.
 */

import { createTavilyProvider, tavilyAnswer } from './tavily.js';
import { createExaProvider } from './exa.js';
import { createSerpapiProvider } from './serpapi.js';
import { createSerperProvider } from './serper.js';
import { createSearxngProvider } from './searxng.js';
import { createPerplexityProvider, perplexityAnswer, PerplexityApiError } from './perplexity.js';
import { createRedditProvider } from './reddit.js';
import { createYoutubeProvider } from './youtube.js';
import { createHnProvider } from './hn.js';
import { rssProvider } from './rss.js';
import { createCrawl4aiProvider } from './crawl4ai.js';
import { createFacebookGroupsProvider } from './facebook-groups.js';
import { createTiktokProvider } from './tiktok.js';
import { createInstagramProvider } from './instagram.js';
import { createXProvider } from './x.js';
import { createPodcastsProvider } from './podcasts.js';
import { createGithubProvider } from './github.js';

import type { ResearchCredentials } from '../credentials.js';
import type { SearchProvider, ProviderName, ExpectedSourceType } from '../types.js';

// =============================================================================
// Full registry
// =============================================================================

export type ProviderRegistry = Record<ProviderName, SearchProvider>;

export function createProviderRegistry(credentials: ResearchCredentials): ProviderRegistry {
  return {
    tavily: createTavilyProvider(credentials),
    exa: createExaProvider(credentials),
    serpapi: createSerpapiProvider(credentials),
    serper: createSerperProvider(credentials),
    searxng: createSearxngProvider(credentials),
    perplexity: createPerplexityProvider(credentials),
    reddit: createRedditProvider(credentials),
    youtube: createYoutubeProvider(credentials),
    hn: createHnProvider(credentials),
    rss: rssProvider,
    crawl4ai: createCrawl4aiProvider(credentials),
    facebook_groups: createFacebookGroupsProvider(credentials),
    tiktok: createTiktokProvider(credentials),
    instagram: createInstagramProvider(credentials),
    x: createXProvider(credentials),
    podcasts: createPodcastsProvider(credentials),
    github: createGithubProvider(credentials),
  };
}

export function getAllProviders(credentials: ResearchCredentials): ProviderRegistry {
  return createProviderRegistry(credentials);
}

/**
 * Returns only providers whose credentials are configured (enabled === true).
 */
export function getEnabledProviders(
  credentials: ResearchCredentials,
): Partial<Record<ProviderName, SearchProvider>> {
  const registry = createProviderRegistry(credentials);
  const enabled: Partial<Record<ProviderName, SearchProvider>> = {};

  const providerNames = Object.keys(registry) as ProviderName[];
  for (const name of providerNames) {
    const provider = registry[name];
    if (provider.enabled) {
      enabled[name] = provider;
    }
  }

  return enabled;
}

/**
 * Returns enabled providers that can actually perform discovery. Fetch-only
 * transports such as Crawl4AI never reach the LLM planner or search fan-out.
 */
export function getEnabledSearchProviders(
  credentials: ResearchCredentials,
): Partial<Record<ProviderName, SearchProvider>> {
  const enabled = getEnabledProviders(credentials);
  const searchable: Partial<Record<ProviderName, SearchProvider>> = {};
  for (const [name, provider] of Object.entries(enabled)) {
    if (provider.capabilities?.search === false) continue;
    searchable[name as ProviderName] = provider;
  }
  return searchable;
}

// =============================================================================
// Source-type → provider routing table
// =============================================================================

// Tavily leads the general categories. It is nominally the pricier tier at
// $0.008/search, but `include_raw_content` returns server-side page extraction
// INLINE with each result, which the fetch stage short-circuits on — so a
// Tavily hit removes a crawl that a searxng-first route would have forced, and
// that extraction survives JS/paywalls/bot-walls a headless re-crawl fails on.
// Cheaper per search is not cheaper per usable source.
//
// Specialists keep their leads where they are genuinely better: reddit for
// forums/audience voice, youtube for video, github for code, exa for semantic
// and academic retrieval, rss for newsletters, podcasts for audio. searxng and
// serper stay in every general list as free fallbacks. Disabled providers are
// filtered at routing time, so listing extras is free.
const SOURCE_TYPE_ROUTING: Record<ExpectedSourceType, ProviderName[]> = {
  forum:          ['reddit', 'tavily', 'searxng', 'facebook_groups'],
  social:         ['reddit', 'x', 'tiktok', 'instagram'],
  video:          ['youtube', 'tavily'],
  video_comments: ['youtube'],
  social_video:   ['tiktok', 'instagram'],
  longform:       ['exa', 'tavily', 'searxng'],
  academic:       ['exa', 'tavily', 'searxng'],
  // NOTE: perplexity is deliberately NOT in any routing entry — pipeline runs
  // never spend on it implicitly. It participates only via kind='managed'
  // (runManagedResearch) or an explicit RunDeepResearchInput.providers list.
  news:           ['tavily', 'searxng', 'serper', 'hn', 'x'],
  serp:           ['serper', 'serpapi'],
  course_page:    ['tavily', 'serper', 'serpapi'],
  audience_voice: ['reddit', 'youtube', 'facebook_groups', 'tiktok', 'instagram'],
  newsletter:     ['rss', 'tavily', 'searxng'],
  documentation:  ['tavily', 'searxng', 'exa'],
  podcast:        ['podcasts'],
  course_review:  ['reddit', 'youtube', 'serper', 'serpapi', 'facebook_groups'],
  repository:     ['github', 'tavily', 'searxng'],
  issue:          ['github', 'tavily', 'searxng'],
  code:           ['github', 'exa', 'tavily'],
};

/**
 * Maps a list of ExpectedSourceType values to deduplicated ProviderName list,
 * preserving first-seen order across all source types. Disabled providers
 * (missing API keys) are filtered out so the caller never invokes them.
 */
export function routeProvidersForSourceTypes(
  registry: ProviderRegistry,
  types: ExpectedSourceType[],
): ProviderName[] {
  const seen = new Set<ProviderName>();
  const result: ProviderName[] = [];

  for (const sourceType of types) {
    const providers = SOURCE_TYPE_ROUTING[sourceType];
    for (const providerName of providers) {
      if (seen.has(providerName)) continue;
      seen.add(providerName);
      if (registry[providerName].enabled) {
        result.push(providerName);
      }
    }
  }

  return result;
}

// Re-export the individual provider factories for direct construction
export {
  createTavilyProvider,
  tavilyAnswer,
  createExaProvider,
  createSerpapiProvider,
  createSerperProvider,
  createSearxngProvider,
  createPerplexityProvider,
  perplexityAnswer,
  PerplexityApiError,
  createRedditProvider,
  createYoutubeProvider,
  createHnProvider,
  rssProvider,
  createCrawl4aiProvider,
  createFacebookGroupsProvider,
  createTiktokProvider,
  createInstagramProvider,
  createXProvider,
  createPodcastsProvider,
  createGithubProvider,
};
export {
  BRIGHTDATA_INSTAGRAM_POSTS_DATASET_ID,
  BRIGHTDATA_INSTAGRAM_PROFILES_DATASET_ID,
  APIFY_INSTAGRAM_STORIES_ACTOR_ID,
  canonicalizeInstagramPostUrl,
  canonicalizeInstagramProfileUrl,
  canonicalizeInstagramStoriesUrl,
  parseInstagramStoriesUrl,
} from './instagram.js';
export type { InstagramStoriesTarget } from './instagram.js';
export { resolveGitHubPublicAuthState } from './github.js';
export type { GitHubPublicAuthCode, GitHubPublicAuthState } from './github.js';

// Re-export the extractor for use outside providers
export { extractQuotesWithGemini } from './gemini-extractor.js';

// Tolerant Bright Data ingestion client (LinkedIn + Facebook groups).
// Instagram Bright Data routing is strict and encapsulated by instagramProvider.
export {
  triggerCollection,
  pollSnapshot,
  downloadSnapshot,
  scrapeDataset,
  unlockUrl,
  fetchLinkedInPostsBrightData,
  fetchFacebookGroupPostsBrightData,
} from './brightdata.js';
export type {
  PollSnapshotOptions,
  ScrapeDatasetOptions,
  BrightDataRecord,
  UnlockUrlOptions,
  UnlockedPage,
} from './brightdata.js';
export type {
  PerplexityAnswerModel,
  PerplexityAnswerOptions,
  PerplexityAnswerResult,
} from './perplexity.js';
export type { TavilyAnswerOptions, TavilyAnswerResult } from './tavily.js';
