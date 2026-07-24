import assert from 'node:assert/strict';
import test from 'node:test';

import {
  githubProvider,
  publicRepositoryApiUrl,
  resolveGitHubPublicAuthState,
  resolveGitHubSearchKinds,
} from '../src/providers/github.js';
import { getEnabledProviders } from '../src/providers/index.js';

const dedicatedToken = 'github_pat_dedicated_public_research_credential';

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function publicRepositoryResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    items: [{
      id: 42,
      html_url: 'https://github.com/public-owner/public-repository',
      full_name: 'public-owner/public-repository',
      description: 'Public repository description.',
      updated_at: '2026-07-22T12:00:00.000Z',
      pushed_at: '2026-07-22T12:00:00.000Z',
      stargazers_count: 100,
      forks_count: 12,
      open_issues_count: 3,
      language: 'TypeScript',
      owner: { login: 'public-owner' },
      private: false,
      visibility: 'public',
      ...overrides,
    }],
  });
}

test('GitHub auth state is sanitized and ignores broad ambient credentials', () => {
  assert.deepEqual(resolveGitHubPublicAuthState({
    GITHUB_TOKEN: 'ghp_broad_private_credential_must_be_ignored',
    GH_TOKEN: 'gho_broad_cli_credential_must_be_ignored',
  }), {
    ready: true,
    authenticated: false,
    required: false,
    ambientCredentialsIgnored: true,
    code: 'ready_anonymous_ambient_ignored',
  });

  assert.deepEqual(resolveGitHubPublicAuthState({
    BRAINTIED_GITHUB_PUBLIC_TOKEN: dedicatedToken,
    BRAINTIED_GITHUB_REQUIRE_AUTH: 'true',
    GITHUB_TOKEN: 'must-not-win',
  }), {
    ready: true,
    authenticated: true,
    required: true,
    ambientCredentialsIgnored: true,
    code: 'ready_authenticated_ambient_ignored',
  });
});

test('repository verification URLs reject every credential-forwarding ambiguity', () => {
  const hostile = [
    'https://user:password@api.github.com/repos/owner/repository',
    'https://api.github.com:444/repos/owner/repository',
    'https://api.github.com/repos/owner/repository?redirect=https://evil.example',
    'https://api.github.com/repos/owner/repository#fragment',
    'https://api.github.com/repos/owner%2Frepository',
    'https://evil.example/repos/owner/repository',
  ];
  for (const url of hostile) {
    assert.throws(() => publicRepositoryApiUrl(url), /github_repository_identity_invalid/);
  }
  assert.equal(
    publicRepositoryApiUrl('https://api.github.com/repos/owner/repository'),
    'https://api.github.com/repos/owner/repository',
  );
});

test('ambient-only search never sends a bearer credential', async () => {
  const previousPolicy = process.env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  const previousToken = process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  const previousBroad = process.env.GITHUB_TOKEN;
  const previousCli = process.env.GH_TOKEN;
  const previousFetch = globalThis.fetch;
  delete process.env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  delete process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_broad_private_credential_must_be_ignored';
  process.env.GH_TOKEN = 'gho_broad_cli_credential_must_be_ignored';
  let authorization: string | null = 'not-inspected';
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization');
    return publicRepositoryResponse();
  };
  try {
    const results = await githubProvider.search('design system', {
      expected_source_types: ['repository'],
      limit: 1,
    });
    assert.equal(results.length, 1);
    assert.equal(authorization, null);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('BRAINTIED_GITHUB_REQUIRE_AUTH', previousPolicy);
    restoreEnvironment('BRAINTIED_GITHUB_PUBLIC_TOKEN', previousToken);
    restoreEnvironment('GITHUB_TOKEN', previousBroad);
    restoreEnvironment('GH_TOKEN', previousCli);
  }
});

test('GitHub required-auth policy disables the provider before any request', async () => {
  const previousPolicy = process.env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  const previousToken = process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  const previousBroad = process.env.GITHUB_TOKEN;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.BRAINTIED_GITHUB_REQUIRE_AUTH = 'true';
  delete process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_broad_private_credential_must_be_ignored';
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({});
  };
  try {
    assert.equal(githubProvider.enabled, false);
    assert.equal(getEnabledProviders().github, undefined);
    await assert.rejects(
      githubProvider.search('design system', {
        expected_source_types: ['repository'],
        limit: 1,
      }),
      /github_auth_required/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('BRAINTIED_GITHUB_REQUIRE_AUTH', previousPolicy);
    restoreEnvironment('BRAINTIED_GITHUB_PUBLIC_TOKEN', previousToken);
    restoreEnvironment('GITHUB_TOKEN', previousBroad);
  }
});

test('GitHub auth reports invalid policy and credential states without returning secrets', () => {
  assert.deepEqual(resolveGitHubPublicAuthState({
    BRAINTIED_GITHUB_REQUIRE_AUTH: '1',
  }).code, 'github_auth_policy_invalid');
  assert.deepEqual(resolveGitHubPublicAuthState({
    BRAINTIED_GITHUB_PUBLIC_TOKEN: 'line\nbreak',
  }).code, 'github_auth_invalid');
  assert.equal(
    'token' in resolveGitHubPublicAuthState({ BRAINTIED_GITHUB_PUBLIC_TOKEN: dedicatedToken }),
    false,
  );
});

test('authenticated repository search forces and attests public-only results', async () => {
  const previousPolicy = process.env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  const previousToken = process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BRAINTIED_GITHUB_REQUIRE_AUTH = 'true';
  process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN = dedicatedToken;
  let requestUrl = '';
  let requestHeaders = new Headers();
  let redirect: RequestRedirect | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    redirect = init?.redirect;
    return publicRepositoryResponse();
  };
  try {
    const results = await githubProvider.search('design system', {
      expected_source_types: ['repository'],
      limit: 1,
    });
    const request = new URL(requestUrl);
    assert.equal(request.origin, 'https://api.github.com');
    assert.match(request.searchParams.get('q') ?? '', /(?:^|\s)is:public(?:\s|$)/);
    assert.equal(requestHeaders.get('authorization'), `Bearer ${dedicatedToken}`);
    assert.equal(redirect, 'error');
    assert.equal(results.length, 1);
    assert.equal(results[0]?.url, 'https://github.com/public-owner/public-repository');
    assert.equal(results[0]?.raw_metadata['visibility_attestation'], 'github-public-rest-v2');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('BRAINTIED_GITHUB_REQUIRE_AUTH', previousPolicy);
    restoreEnvironment('BRAINTIED_GITHUB_PUBLIC_TOKEN', previousToken);
  }
});

test('private or cross-bound repository results fail with a stable sanitized code', async () => {
  const previousPolicy = process.env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  const previousToken = process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BRAINTIED_GITHUB_REQUIRE_AUTH = 'true';
  process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN = dedicatedToken;
  const sensitive = `private-description-${dedicatedToken}`;
  globalThis.fetch = async () => publicRepositoryResponse({
    private: true,
    visibility: 'private',
    description: sensitive,
  });
  try {
    let message = '';
    try {
      await githubProvider.search('private design system', {
        expected_source_types: ['repository'],
        limit: 1,
      });
      assert.fail('private repository response must be rejected');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.equal(message, 'github_public_repository_attestation_failed');
    assert.doesNotMatch(message, new RegExp(dedicatedToken));
    assert.doesNotMatch(message, /private-description/);

    globalThis.fetch = async () => publicRepositoryResponse({
      html_url: 'https://github.com/public-owner/different-repository',
    });
    await assert.rejects(
      githubProvider.search('cross-bound design system', {
        expected_source_types: ['repository'],
        limit: 1,
      }),
      (error: unknown) => error instanceof Error
        && error.message === 'github_result_identity_invalid',
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('BRAINTIED_GITHUB_REQUIRE_AUTH', previousPolicy);
    restoreEnvironment('BRAINTIED_GITHUB_PUBLIC_TOKEN', previousToken);
  }
});

test('malformed and HTTP error bodies cannot reach exceptions', async () => {
  const previousPolicy = process.env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  const previousToken = process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BRAINTIED_GITHUB_REQUIRE_AUTH = 'true';
  process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN = dedicatedToken;
  let mode: 'malformed' | 'forbidden' | 'network' = 'malformed';
  globalThis.fetch = async () => {
    if (mode === 'network') throw new Error(`transport-${dedicatedToken}`);
    return mode === 'malformed'
      ? new Response(`not-json-${dedicatedToken}`, { status: 200 })
      : new Response(`forbidden-${dedicatedToken}`, { status: 403 });
  };
  try {
    await assert.rejects(
      githubProvider.search('design system', { expected_source_types: ['repository'], limit: 1 }),
      (error: unknown) => error instanceof Error
        && error.message === 'github_search_response_invalid'
        && !error.message.includes(dedicatedToken),
    );
    mode = 'network';
    await assert.rejects(
      githubProvider.search('design system', { expected_source_types: ['repository'], limit: 1 }),
      (error: unknown) => error instanceof Error
        && error.message === 'github_search_request_failed'
        && !error.message.includes(dedicatedToken),
    );
    mode = 'forbidden';
    await assert.rejects(
      githubProvider.search('design system', { expected_source_types: ['repository'], limit: 1 }),
      (error: unknown) => error instanceof Error
        && error.message === 'github_search_http_403'
        && !error.message.includes(dedicatedToken),
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('BRAINTIED_GITHUB_REQUIRE_AUTH', previousPolicy);
    restoreEnvironment('BRAINTIED_GITHUB_PUBLIC_TOKEN', previousToken);
  }
});

test('hostile issue repository identities never receive the bearer credential', async () => {
  const previousPolicy = process.env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  const previousToken = process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BRAINTIED_GITHUB_REQUIRE_AUTH = 'true';
  process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN = dedicatedToken;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return Response.json({ items: [{
      id: 77,
      number: 1,
      html_url: 'https://github.com/public-owner/public-repository/issues/1',
      title: 'Issue title',
      body: 'Issue body',
      created_at: '2026-07-22T12:00:00.000Z',
      updated_at: '2026-07-22T12:00:00.000Z',
      comments: 0,
      user: { login: 'contributor' },
      repository_url: 'https://evil.example/repos/private-owner/private-repository',
    }] });
  };
  try {
    await assert.rejects(
      githubProvider.search('design issue', { expected_source_types: ['issue'], limit: 1 }),
      /github_repository_identity_invalid/,
    );
    assert.equal(requested.length, 1);
    assert.equal(new URL(requested[0] ?? '').origin, 'https://api.github.com');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('BRAINTIED_GITHUB_REQUIRE_AUTH', previousPolicy);
    restoreEnvironment('BRAINTIED_GITHUB_PUBLIC_TOKEN', previousToken);
  }
});

test('issue HTML identity is cross-bound to its attested public repository', async () => {
  const previousPolicy = process.env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  const previousToken = process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BRAINTIED_GITHUB_REQUIRE_AUTH = 'true';
  process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN = dedicatedToken;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (new URL(url).pathname === '/search/issues') {
      return Response.json({ items: [{
        id: 88,
        number: 9,
        html_url: 'https://github.com/different-owner/different-repository/issues/9',
        title: 'Cross-bound issue',
        body: 'Issue body',
        created_at: '2026-07-22T12:00:00.000Z',
        updated_at: '2026-07-22T12:00:00.000Z',
        comments: 0,
        user: { login: 'contributor' },
        repository_url: 'https://api.github.com/repos/public-owner/public-repository',
      }] });
    }
    return Response.json({ private: false, visibility: 'public' });
  };
  try {
    await assert.rejects(
      githubProvider.search('design issue', { expected_source_types: ['issue'], limit: 1 }),
      /github_result_identity_invalid/,
    );
    assert.deepEqual(
      requested.map((url) => new URL(url).origin),
      ['https://api.github.com', 'https://api.github.com'],
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('BRAINTIED_GITHUB_REQUIRE_AUTH', previousPolicy);
    restoreEnvironment('BRAINTIED_GITHUB_PUBLIC_TOKEN', previousToken);
  }
});

test('concurrent repository and issue strategies share one serialized rate-limit queue', async () => {
  const previousPolicy = process.env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  const previousToken = process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BRAINTIED_GITHUB_REQUIRE_AUTH = 'true';
  process.env.BRAINTIED_GITHUB_PUBLIC_TOKEN = dedicatedToken;
  const requestTimes: number[] = [];
  globalThis.fetch = async (input) => {
    requestTimes.push(Date.now());
    return new URL(String(input)).pathname === '/search/repositories'
      ? Response.json({ items: [] })
      : Response.json({ items: [] });
  };
  try {
    await githubProvider.search('design system', { limit: 1 });
    assert.equal(requestTimes.length, 2);
    const first = requestTimes[0];
    const second = requestTimes[1];
    assert.ok(first !== undefined && second !== undefined);
    assert.ok(second - first >= 2_000, `requests were only ${second - first}ms apart`);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('BRAINTIED_GITHUB_REQUIRE_AUTH', previousPolicy);
    restoreEnvironment('BRAINTIED_GITHUB_PUBLIC_TOKEN', previousToken);
  }
});

test('repository/code searches exclude GitHub issues and pull requests', () => {
  assert.deepEqual(
    resolveGitHubSearchKinds({ expected_source_types: ['repository', 'code'] }),
    { repositories: true, issues: false },
  );
});

test('issue searches exclude repository results unless explicitly requested', () => {
  assert.deepEqual(
    resolveGitHubSearchKinds({ expected_source_types: ['issue'] }),
    { repositories: false, issues: true },
  );
  assert.deepEqual(
    resolveGitHubSearchKinds({ expected_source_types: ['issue', 'repository'] }),
    { repositories: true, issues: true },
  );
});

test('legacy GitHub searches preserve mixed results when no GitHub kind is supplied', () => {
  assert.deepEqual(resolveGitHubSearchKinds({}), { repositories: true, issues: true });
  assert.deepEqual(
    resolveGitHubSearchKinds({ expected_source_types: ['documentation'] }),
    { repositories: true, issues: true },
  );
});
