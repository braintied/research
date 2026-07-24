/**
 * GitHub public-search provider.
 *
 * Uses GitHub's REST search endpoints for repositories plus issues/pull
 * requests. Only the dedicated public-research credential is eligible for
 * authentication; broad ambient GitHub credentials are deliberately ignored.
 * Page HTML is intentionally fetched by the shared Crawl4AI -> Jina -> direct
 * chain so repository pages, READMEs, issues, and discussions retain one
 * acquisition policy across the engine.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { sleep } from '../pipeline-core.js';
import { GITHUB_PUBLIC_VISIBILITY_ATTESTATION } from '../search-cache.js';
import {
  SearchResultSchema,
  type SearchOpts,
  type SearchProvider,
  type SearchResult,
} from '../types.js';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_USER_AGENT = 'braintied-research/0.8.6';
let lastGitHubCallAt = 0;
let githubRateLimitQueue: Promise<void> = Promise.resolve();

export const GITHUB_PUBLIC_AUTH_CODES = [
  'ready_authenticated',
  'ready_authenticated_ambient_ignored',
  'ready_anonymous',
  'ready_anonymous_ambient_ignored',
  'github_auth_policy_invalid',
  'github_auth_required',
  'github_auth_invalid',
] as const;
export type GitHubPublicAuthCode = (typeof GITHUB_PUBLIC_AUTH_CODES)[number];

export interface GitHubPublicAuthState {
  ready: boolean;
  authenticated: boolean;
  required: boolean;
  ambientCredentialsIgnored: boolean;
  code: GitHubPublicAuthCode;
}

interface GitHubPublicCredentials {
  state: GitHubPublicAuthState;
  token: string | null;
}

class GitHubPublicAuthError extends Error {
  constructor(readonly code: GitHubPublicAuthCode) {
    super(code);
    this.name = 'GitHubPublicAuthError';
  }
}

const RepoItemSchema = z.object({
  id: z.number(),
  html_url: z.string().url(),
  full_name: z.string(),
  description: z.string().nullable().optional(),
  updated_at: z.string(),
  pushed_at: z.string().nullable().optional(),
  stargazers_count: z.number().default(0),
  forks_count: z.number().default(0),
  open_issues_count: z.number().default(0),
  language: z.string().nullable().optional(),
  owner: z.object({ login: z.string() }),
  private: z.literal(false),
  visibility: z.literal('public'),
}).passthrough();

const PublicRepoSchema = z.object({
  private: z.literal(false),
  visibility: z.literal('public'),
}).passthrough();

const IssueItemSchema = z.object({
  id: z.number(),
  number: z.number(),
  html_url: z.string().url(),
  title: z.string(),
  body: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.number().default(0),
  user: z.object({ login: z.string() }),
  repository_url: z.string(),
  pull_request: z.unknown().optional(),
}).passthrough();

const RepoSearchResponseSchema = z.object({
  items: z.array(RepoItemSchema).default([]),
});

const IssueSearchResponseSchema = z.object({
  items: z.array(IssueItemSchema).default([]),
});

function resolveGitHubPublicCredentials(
  env: NodeJS.ProcessEnv = process.env,
): GitHubPublicCredentials {
  const ambientCredentialsIgnored = (
    (env.GITHUB_TOKEN?.trim().length ?? 0) > 0
    || (env.GH_TOKEN?.trim().length ?? 0) > 0
  );
  const rawPolicy = env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  const policy = rawPolicy === undefined || rawPolicy.trim() === ''
    ? 'false'
    : rawPolicy.trim();
  if (policy !== 'true' && policy !== 'false') {
    return {
      token: null,
      state: {
        ready: false,
        authenticated: false,
        required: false,
        ambientCredentialsIgnored,
        code: 'github_auth_policy_invalid',
      },
    };
  }

  const required = policy === 'true';
  const rawToken = env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  const token = rawToken === undefined || rawToken.trim() === ''
    ? null
    : rawToken.trim();
  if (token !== null
      && (token.length < 20
        || token.length > 512
        || /[\s\u0000-\u001f\u007f]/u.test(token))) {
    return {
      token: null,
      state: {
        ready: false,
        authenticated: false,
        required,
        ambientCredentialsIgnored,
        code: 'github_auth_invalid',
      },
    };
  }
  if (required && token === null) {
    return {
      token: null,
      state: {
        ready: false,
        authenticated: false,
        required: true,
        ambientCredentialsIgnored,
        code: 'github_auth_required',
      },
    };
  }

  const authenticated = token !== null;
  return {
    token,
    state: {
      ready: true,
      authenticated,
      required,
      ambientCredentialsIgnored,
      code: authenticated
        ? (ambientCredentialsIgnored
            ? 'ready_authenticated_ambient_ignored'
            : 'ready_authenticated')
        : (ambientCredentialsIgnored
            ? 'ready_anonymous_ambient_ignored'
            : 'ready_anonymous'),
    },
  };
}

/** Metadata-only public health contract; the credential never leaves this module. */
export function resolveGitHubPublicAuthState(
  env: NodeJS.ProcessEnv = process.env,
): GitHubPublicAuthState {
  return resolveGitHubPublicCredentials(env).state;
}

function requireGitHubPublicCredentials(): GitHubPublicCredentials {
  const credentials = resolveGitHubPublicCredentials();
  if (!credentials.state.ready) throw new GitHubPublicAuthError(credentials.state.code);
  return credentials;
}

async function rateLimit(auth: GitHubPublicCredentials): Promise<void> {
  // GitHub's public search allowance is much smaller than authenticated
  // search. Serialize the timestamp reservation so concurrent repository and
  // issue strategies cannot wake together and burst the same credential.
  const minimumGapMs = auth.token === null ? 6_500 : 2_100;
  const turn = githubRateLimitQueue.then(async () => {
    const elapsed = Date.now() - lastGitHubCallAt;
    if (elapsed < minimumGapMs) await sleep(minimumGapMs - elapsed);
    lastGitHubCallAt = Date.now();
  });
  githubRateLimitQueue = turn.catch(() => undefined);
  await turn;
}

function requestHeaders(auth: GitHubPublicCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': GITHUB_USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (auth.token !== null) headers.Authorization = `Bearer ${auth.token}`;
  return headers;
}

function dateOnly(input: Date): string {
  return input.toISOString().slice(0, 10);
}

function dateRangeQualifier(opts: SearchOpts, field: 'pushed' | 'updated'): string {
  if (opts.recency_days === undefined && opts.published_before === undefined) return '';
  const end = opts.published_before !== undefined ? new Date(opts.published_before) : new Date();
  if (Number.isNaN(end.getTime())) return '';
  if (opts.recency_days === undefined) return `${field}:<=${dateOnly(end)}`;
  const start = new Date(end.getTime() - opts.recency_days * 86_400_000);
  return `${field}:${dateOnly(start)}..${dateOnly(end)}`;
}

function scopedQuery(query: string, opts: SearchOpts, field: 'pushed' | 'updated'): string {
  const parts = [query.trim()];
  const range = dateRangeQualifier(opts, field);
  if (range.length > 0) parts.push(range);
  if (opts.communities !== undefined && opts.communities.length > 0) {
    const orgs = opts.communities
      .map((org) => org.replace(/^@/, '').trim())
      .filter((org) => org.length > 0)
      .map((org) => `org:${org}`);
    if (orgs.length === 1 && orgs[0] !== undefined) parts.push(orgs[0]);
    if (orgs.length > 1) parts.push(`(${orgs.join(' OR ')})`);
  }
  return parts.join(' ');
}

function beforeBoundary(opts: SearchOpts): number | null {
  if (opts.published_before === undefined) return null;
  const timestamp = new Date(opts.published_before).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function withinUpperBound(timestamp: string, opts: SearchOpts): boolean {
  const boundary = beforeBoundary(opts);
  if (boundary === null) return true;
  const value = new Date(timestamp).getTime();
  return !Number.isNaN(value) && value <= boundary;
}

/** @internal Exported for adversarial contract tests; not part of the root API. */
export function publicRepositoryApiUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('github_repository_identity_invalid');
  }
  if (
    parsed.origin !== GITHUB_API_BASE
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(parsed.pathname)
  ) {
    throw new Error('github_repository_identity_invalid');
  }
  return `${GITHUB_API_BASE}${parsed.pathname}`;
}

/** @internal Exported for adversarial contract tests; not part of the root API. */
export function exactPublicGitHubHtmlUrl(raw: string, expectedPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('github_result_identity_invalid');
  }
  if (
    parsed.origin !== 'https://github.com'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.pathname.toLowerCase() !== expectedPath.toLowerCase()
  ) {
    throw new Error('github_result_identity_invalid');
  }
  return `https://github.com${expectedPath}`;
}

async function getJson(
  rawUrl: string,
  signal: AbortSignal | undefined,
  auth: GitHubPublicCredentials,
): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('github_request_identity_invalid');
  }
  const isSearch = url.pathname === '/search/repositories' || url.pathname === '/search/issues';
  const isRepository = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(url.pathname);
  if (
    url.origin !== GITHUB_API_BASE
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || (!isSearch && !isRepository)
    || (isRepository && url.search !== '')
  ) {
    throw new Error('github_request_identity_invalid');
  }
  await rateLimit(auth);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: requestHeaders(auth),
      redirect: 'error',
      signal: signal !== undefined ? signal : AbortSignal.timeout(25_000),
    });
  } catch {
    throw new Error('github_search_request_failed');
  }
  if (!response.ok) {
    if (response.body !== null) await response.body.cancel().catch(() => undefined);
    throw new Error(`github_search_http_${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('github_search_response_invalid');
  }
}

function repoSort(opts: SearchOpts): string | null {
  if (opts.sort === 'latest' || opts.sort === 'new') return 'updated';
  if (opts.sort === 'top' || opts.sort === 'views') return 'stars';
  return null;
}

function issueSort(opts: SearchOpts): string | null {
  if (opts.sort === 'latest' || opts.sort === 'new') return 'created';
  if (opts.sort === 'top' || opts.sort === 'comments' || opts.sort === 'views') return 'comments';
  return null;
}

export interface GitHubSearchKinds {
  repositories: boolean;
  issues: boolean;
}

/**
 * Honor the planner's requested source classes. Repository/code research must
 * not be polluted by coincidentally matching pull requests; issue retrieval
 * remains available only when it is explicitly requested. Empty or unrelated
 * legacy inputs retain the historical mixed behavior.
 */
export function resolveGitHubSearchKinds(opts: SearchOpts): GitHubSearchKinds {
  const expected = new Set(opts.expected_source_types ?? []);
  const hasGitHubKind = expected.has('repository') || expected.has('code') || expected.has('issue');
  if (!hasGitHubKind) return { repositories: true, issues: true };
  return {
    repositories: expected.has('repository') || expected.has('code'),
    issues: expected.has('issue'),
  };
}

async function searchRepositories(
  query: string,
  opts: SearchOpts,
  limit: number,
  auth: GitHubPublicCredentials,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: `${scopedQuery(query, opts, 'pushed')} is:public`,
    per_page: String(Math.min(limit, 100)),
    page: '1',
  });
  const sort = repoSort(opts);
  if (sort !== null) {
    params.set('sort', sort);
    params.set('order', 'desc');
  }
  const raw = await getJson(
    `${GITHUB_API_BASE}/search/repositories?${params.toString()}`,
    opts.signal,
    auth,
  );
  const parsed = RepoSearchResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('github_public_repository_attestation_failed');
  const results: SearchResult[] = [];
  for (const repo of parsed.data.items) {
    const timestamp = repo.pushed_at ?? repo.updated_at;
    if (!withinUpperBound(timestamp, opts)) continue;
    const fullNameParts = repo.full_name.split('/');
    const ownerName = fullNameParts[0];
    const repositoryName = fullNameParts[1];
    if (
      fullNameParts.length !== 2
      || ownerName === undefined
      || repositoryName === undefined
      || !/^[A-Za-z0-9_.-]+$/u.test(ownerName)
      || !/^[A-Za-z0-9_.-]+$/u.test(repositoryName)
      || ownerName.toLowerCase() !== repo.owner.login.toLowerCase()
    ) {
      throw new Error('github_result_identity_invalid');
    }
    const publicUrl = exactPublicGitHubHtmlUrl(
      repo.html_url,
      `/${ownerName}/${repositoryName}`,
    );
    const candidate = SearchResultSchema.safeParse({
      provider: 'github',
      url: publicUrl,
      canonical_id: String(repo.id),
      title: repo.full_name,
      snippet: repo.description ?? '',
      author: repo.owner.login,
      published_at: new Date(timestamp).toISOString(),
      engagement: {
        upvotes: repo.stargazers_count,
        comment_count: repo.open_issues_count,
        score: repo.stargazers_count + repo.forks_count,
      },
      raw_metadata: {
        backend: 'github_rest_api',
        visibility_attestation: GITHUB_PUBLIC_VISIBILITY_ATTESTATION,
        result_kind: 'repository',
        language: repo.language,
        forks: repo.forks_count,
      },
    });
    if (candidate.success) results.push(candidate.data);
  }
  return results;
}

async function searchIssues(
  query: string,
  opts: SearchOpts,
  limit: number,
  auth: GitHubPublicCredentials,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: `${scopedQuery(query, opts, 'updated')} is:public`,
    per_page: String(Math.min(limit, 100)),
    page: '1',
  });
  const sort = issueSort(opts);
  if (sort !== null) {
    params.set('sort', sort);
    params.set('order', 'desc');
  }
  const raw = await getJson(
    `${GITHUB_API_BASE}/search/issues?${params.toString()}`,
    opts.signal,
    auth,
  );
  const parsed = IssueSearchResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('github_public_issue_attestation_failed');
  const results: SearchResult[] = [];
  const publicRepositories = new Set<string>();
  for (const issue of parsed.data.items) {
    const repositoryUrl = publicRepositoryApiUrl(issue.repository_url);
    if (!publicRepositories.has(repositoryUrl)) {
      const repository = PublicRepoSchema.safeParse(
        await getJson(repositoryUrl, opts.signal, auth),
      );
      if (!repository.success) throw new Error('github_public_repository_attestation_failed');
      publicRepositories.add(repositoryUrl);
    }
    if (!withinUpperBound(issue.updated_at, opts)) continue;
    const repoName = new URL(repositoryUrl).pathname.split('/').slice(-2).join('/');
    const resultKind = issue.pull_request === undefined ? 'issue' : 'pull_request';
    const publicUrl = exactPublicGitHubHtmlUrl(
      issue.html_url,
      `/${repoName}/${resultKind === 'issue' ? 'issues' : 'pull'}/${issue.number}`,
    );
    const candidate = SearchResultSchema.safeParse({
      provider: 'github',
      url: publicUrl,
      canonical_id: String(issue.id),
      title: `${repoName} #${issue.number}: ${issue.title}`,
      snippet: (issue.body ?? '').slice(0, 500),
      author: issue.user.login,
      published_at: new Date(issue.created_at).toISOString(),
      engagement: { comment_count: issue.comments, score: issue.comments },
      raw_metadata: {
        backend: 'github_rest_api',
        visibility_attestation: GITHUB_PUBLIC_VISIBILITY_ATTESTATION,
        result_kind: resultKind,
        repository: repoName,
        updated_at: issue.updated_at,
      },
    });
    if (candidate.success) results.push(candidate.data);
  }
  return results;
}

function interleave(groups: SearchResult[][], limit: number): SearchResult[] {
  const result: SearchResult[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (result.length < limit) {
    let added = false;
    for (const group of groups) {
      const item = group[index];
      if (item === undefined || seen.has(item.url)) continue;
      seen.add(item.url);
      result.push(item);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added && groups.every((group) => index >= group.length)) break;
    index += 1;
  }
  return result;
}

export const githubProvider: SearchProvider = {
  name: 'github',

  // Anonymous search remains an explicit supported mode unless policy requires
  // the dedicated public-research credential.
  get enabled(): boolean {
    return resolveGitHubPublicAuthState().ready;
  },

  capabilities: {
    search: true,
    fetch: false,
    extract: false,
    backends: ['github_rest_api', 'crawl4ai', 'jina', 'direct_fetch'],
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const auth = requireGitHubPublicCredentials();
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
    const kinds = resolveGitHubSearchKinds(opts);
    const strategies = opts.sort === 'mixed'
      ? [
          { ...opts, sort: 'latest' as const },
          { ...opts, sort: 'top' as const },
          { ...opts, sort: 'relevance' as const },
        ]
      : [opts];

    const groups: SearchResult[][] = [];
    const failures: string[] = [];
    const perStrategyLimit = Math.max(2, Math.ceil(limit / strategies.length));
    for (const strategy of strategies) {
      const searches: Array<Promise<SearchResult[]>> = [];
      if (kinds.repositories) {
        searches.push(searchRepositories(query, strategy, perStrategyLimit, auth));
      }
      if (kinds.issues) searches.push(searchIssues(query, strategy, perStrategyLimit, auth));
      const settled = await Promise.allSettled(searches);
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') groups.push(outcome.value);
        else failures.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
      }
    }

    if (groups.length === 0 && failures.length > 0) throw new Error(failures.join('; '));
    const results = interleave(groups, limit);
    logger.info(
      {
        query: query.slice(0, 60),
        count: results.length,
        failures: failures.length,
        authenticated: auth.state.authenticated,
        auth_code: auth.state.code,
        kinds,
      },
      '[GitHub] Search complete',
    );
    return results;
  },
};
