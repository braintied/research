/**
 * Provider Registry
 *
 * Exports all SearchProvider instances, enabled-provider filtering,
 * and source-type → provider routing.
 */

import { tavilyProvider } from './tavily.js';
import { exaProvider } from './exa.js';
import { serpapiProvider } from './serpapi.js';
import { serperProvider } from './serper.js';
import { searxngProvider } from './searxng.js';
import { perplexityProvider } from './perplexity.js';
import { redditProvider } from './reddit.js';
import { youtubeProvider } from './youtube.js';
import { hnProvider } from './hn.js';
import { rssProvider } from './rss.js';
import { crawl4aiProvider } from './crawl4ai.js';
import { facebookGroupsProvider } from './facebook-groups.js';
import { tiktokProvider } from './tiktok.js';
import { instagramProvider } from './instagram.js';
import { xProvider } from './x.js';
import { podcastsProvider } from './podcasts.js';

import type { SearchProvider, ProviderName, ExpectedSourceType } from '../types.js';

// =============================================================================
// Full registry
// =============================================================================

const ALL_PROVIDERS: Record<ProviderName, SearchProvider> = {
  tavily: tavilyProvider,
  exa: exaProvider,
  serpapi: serpapiProvider,
  serper: serperProvider,
  searxng: searxngProvider,
  perplexity: perplexityProvider,
  reddit: redditProvider,
  youtube: youtubeProvider,
  hn: hnProvider,
  rss: rssProvider,
  crawl4ai: crawl4aiProvider,
  facebook_groups: facebookGroupsProvider,
  tiktok: tiktokProvider,
  instagram: instagramProvider,
  x: xProvider,
  podcasts: podcastsProvider,
};

export function getAllProviders(): Record<ProviderName, SearchProvider> {
  return ALL_PROVIDERS;
}

/**
 * Returns only providers whose API keys are configured (enabled === true).
 */
export function getEnabledProviders(): Partial<Record<ProviderName, SearchProvider>> {
  const enabled: Partial<Record<ProviderName, SearchProvider>> = {};

  const providerNames = Object.keys(ALL_PROVIDERS) as ProviderName[];
  for (const name of providerNames) {
    const provider = ALL_PROVIDERS[name];
    if (provider.enabled) {
      enabled[name] = provider;
    }
  }

  return enabled;
}

// =============================================================================
// Source-type → provider routing table
// =============================================================================

// Free/cheap breadth tiers (searxng $0, serper 2.5k free/mo) lead the general
// categories; specialist providers stay first where they're clearly better
// (reddit for forums, youtube for video, exa for semantic/academic). Disabled
// providers are filtered at routing time, so listing extras is free.
const SOURCE_TYPE_ROUTING: Record<ExpectedSourceType, ProviderName[]> = {
  forum:          ['reddit', 'searxng', 'tavily', 'facebook_groups'],
  social:         ['reddit', 'x', 'tiktok', 'instagram'],
  video:          ['youtube', 'tavily'],
  video_comments: ['youtube'],
  social_video:   ['tiktok', 'instagram'],
  longform:       ['exa', 'searxng', 'tavily', 'crawl4ai'],
  academic:       ['exa', 'tavily', 'searxng'],
  // NOTE: perplexity is deliberately NOT in any routing entry — pipeline runs
  // never spend on it implicitly. It participates only via kind='managed'
  // (runManagedResearch) or an explicit RunDeepResearchInput.providers list.
  news:           ['searxng', 'serper', 'tavily', 'hn', 'x'],
  serp:           ['serper', 'serpapi'],
  course_page:    ['serper', 'serpapi', 'crawl4ai'],
  audience_voice: ['reddit', 'youtube', 'facebook_groups', 'tiktok', 'instagram'],
  newsletter:     ['rss', 'searxng', 'tavily'],
  documentation:  ['searxng', 'tavily', 'crawl4ai'],
  podcast:        ['podcasts'],
  course_review:  ['reddit', 'youtube', 'serper', 'serpapi', 'facebook_groups'],
};

/**
 * Maps a list of ExpectedSourceType values to deduplicated ProviderName list,
 * preserving first-seen order across all source types. Disabled providers
 * (missing API keys) are filtered out so the caller never invokes them.
 */
export function routeProvidersForSourceTypes(types: ExpectedSourceType[]): ProviderName[] {
  const seen = new Set<ProviderName>();
  const result: ProviderName[] = [];

  for (const sourceType of types) {
    const providers = SOURCE_TYPE_ROUTING[sourceType];
    for (const providerName of providers) {
      if (seen.has(providerName)) continue;
      seen.add(providerName);
      const provider = ALL_PROVIDERS[providerName];
      if (provider.enabled) {
        result.push(providerName);
      }
    }
  }

  return result;
}

// Re-export individual providers for direct import
export {
  tavilyProvider,
  exaProvider,
  serpapiProvider,
  serperProvider,
  searxngProvider,
  perplexityProvider,
  redditProvider,
  youtubeProvider,
  hnProvider,
  rssProvider,
  crawl4aiProvider,
  facebookGroupsProvider,
  tiktokProvider,
  instagramProvider,
  xProvider,
  podcastsProvider,
};

// Re-export the extractor for use outside providers
export { extractQuotesWithGemini } from './gemini-extractor.js';

// Bright Data Web Scraper API ingestion client (LinkedIn + Facebook groups).
export {
  triggerCollection,
  pollSnapshot,
  downloadSnapshot,
  fetchLinkedInPostsBrightData,
  fetchFacebookGroupPostsBrightData,
} from './brightdata.js';
export type { PollSnapshotOptions } from './brightdata.js';
