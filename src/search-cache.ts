import { z } from 'zod';
import { SearchResultSchema, type ProviderName, type SearchResult } from './types.js';

/** Immutable cache namespace for the 0.8.6 GitHub public-visibility proof. */
export const GITHUB_PUBLIC_CACHE_POLICY = 'github-public-attested-v2' as const;
export const GITHUB_PUBLIC_VISIBILITY_ATTESTATION = 'github-public-rest-v2' as const;

const CachedSearchResultsSchema = z.array(SearchResultSchema);

export function searchCachePolicyIdentity(provider: ProviderName): string | null {
  return provider === 'github' ? GITHUB_PUBLIC_CACHE_POLICY : null;
}

function isAttestedPublicGitHubResult(result: SearchResult): boolean {
  let url: URL;
  try {
    url = new URL(result.url);
  } catch {
    return false;
  }
  const repositoryPath = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
  const issuePath = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*$/u;
  return result.provider === 'github'
    && result.raw_metadata['backend'] === 'github_rest_api'
    && result.raw_metadata['visibility_attestation'] === GITHUB_PUBLIC_VISIBILITY_ATTESTATION
    && url.origin === 'https://github.com'
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === ''
    && (repositoryPath.test(url.pathname) || issuePath.test(url.pathname));
}

/** Reject cache entries that predate the active provider security contract. */
export function parseCachedSearchResults(
  provider: ProviderName,
  raw: string,
): SearchResult[] | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = CachedSearchResultsSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.some((result) => result.provider !== provider)) return null;
  if (provider === 'github' && !parsed.data.every(isAttestedPublicGitHubResult)) return null;
  return parsed.data;
}
