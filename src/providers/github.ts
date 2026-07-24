/**
 * GitHub public-search provider.
 *
 * Uses GitHub's REST search endpoints for repositories plus issues/pull
 * requests. Authentication is optional: unauthenticated requests use the free
 * public allowance; GITHUB_TOKEN/GH_TOKEN increases the rate limit. Page HTML
 * is intentionally fetched by the shared Crawl4AI -> Jina -> direct chain so
 * repository pages, READMEs, issues, and discussions retain one acquisition
 * policy across the engine.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { sleep } from '../pipeline-core.js';
import {
  SearchResultSchema,
  type SearchOpts,
  type SearchProvider,
  type SearchResult,
} from '../types.js';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_USER_AGENT = 'braintied-research/0.8';
let lastGitHubCallAt = 0;

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

function getToken(): string | null {
  const primary = process.env.GITHUB_TOKEN;
  if (primary !== undefined && primary.trim().length > 0) return primary.trim();
  const gh = process.env.GH_TOKEN;
  if (gh !== undefined && gh.trim().length > 0) return gh.trim();
  return null;
}

async function rateLimit(): Promise<void> {
  // GitHub's public search allowance is much smaller than authenticated
  // search. Keep anonymous mode conservative and deterministic.
  const minimumGapMs = getToken() === null ? 6_500 : 2_100;
  const elapsed = Date.now() - lastGitHubCallAt;
  if (elapsed < minimumGapMs) await sleep(minimumGapMs - elapsed);
  lastGitHubCallAt = Date.now();
}

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': GITHUB_USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = getToken();
  if (token !== null) headers.Authorization = `Bearer ${token}`;
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

async function getJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
  await rateLimit();
  const response = await fetch(url, {
    headers: requestHeaders(),
    signal: signal !== undefined ? signal : AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub search error: HTTP ${response.status} ${body.slice(0, 180)}`);
  }
  return response.json();
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

async function searchRepositories(query: string, opts: SearchOpts, limit: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: scopedQuery(query, opts, 'pushed'),
    per_page: String(Math.min(limit, 100)),
    page: '1',
  });
  const sort = repoSort(opts);
  if (sort !== null) {
    params.set('sort', sort);
    params.set('order', 'desc');
  }
  const raw = await getJson(`${GITHUB_API_BASE}/search/repositories?${params.toString()}`, opts.signal);
  const parsed = RepoSearchResponseSchema.parse(raw);
  const results: SearchResult[] = [];
  for (const repo of parsed.items) {
    const timestamp = repo.pushed_at ?? repo.updated_at;
    if (!withinUpperBound(timestamp, opts)) continue;
    const candidate = SearchResultSchema.safeParse({
      provider: 'github',
      url: repo.html_url,
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
        result_kind: 'repository',
        language: repo.language,
        forks: repo.forks_count,
      },
    });
    if (candidate.success) results.push(candidate.data);
  }
  return results;
}

async function searchIssues(query: string, opts: SearchOpts, limit: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: scopedQuery(query, opts, 'updated'),
    per_page: String(Math.min(limit, 100)),
    page: '1',
  });
  const sort = issueSort(opts);
  if (sort !== null) {
    params.set('sort', sort);
    params.set('order', 'desc');
  }
  const raw = await getJson(`${GITHUB_API_BASE}/search/issues?${params.toString()}`, opts.signal);
  const parsed = IssueSearchResponseSchema.parse(raw);
  const results: SearchResult[] = [];
  for (const issue of parsed.items) {
    if (!withinUpperBound(issue.updated_at, opts)) continue;
    const repoName = issue.repository_url.split('/').slice(-2).join('/');
    const resultKind = issue.pull_request === undefined ? 'issue' : 'pull_request';
    const candidate = SearchResultSchema.safeParse({
      provider: 'github',
      url: issue.html_url,
      canonical_id: String(issue.id),
      title: `${repoName} #${issue.number}: ${issue.title}`,
      snippet: (issue.body ?? '').slice(0, 500),
      author: issue.user.login,
      published_at: new Date(issue.created_at).toISOString(),
      engagement: { comment_count: issue.comments, score: issue.comments },
      raw_metadata: {
        backend: 'github_rest_api',
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

  // Public REST search works without a token. A token only expands quota.
  enabled: true,

  capabilities: {
    search: true,
    fetch: false,
    extract: false,
    backends: ['github_rest_api', 'crawl4ai', 'jina', 'direct_fetch'],
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
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
      if (kinds.repositories) searches.push(searchRepositories(query, strategy, perStrategyLimit));
      if (kinds.issues) searches.push(searchIssues(query, strategy, perStrategyLimit));
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
        authenticated: getToken() !== null,
        kinds,
      },
      '[GitHub] Search complete',
    );
    return results;
  },
};
