/**
 * ResearchCredentials — the package's entire configuration surface.
 *
 * This package never reads `process.env`. Every credential, endpoint, and
 * egress acknowledgement it needs is an explicit field on this record, which
 * the HOST resolves at its own process boundary and passes in. A third party
 * can therefore audit exactly which inputs @braintied/research consumes
 * without reading the implementation.
 *
 * Absence is meaningful and never defaulted: a provider whose credential is
 * absent is DISABLED, and the run reports that lane as unavailable rather than
 * silently substituting another one. There is no fallback key, no ambient
 * lookup, and no built-in endpoint.
 *
 * `resolveResearchCredentials(env)` maps the conventional Braintied variable
 * names onto this record. It takes the environment as an argument — a host
 * calls `resolveResearchCredentials(process.env)` at its boundary — so the
 * alias knowledge (Gemini key names, X bearer aliases, twitterapi.io's legacy
 * name) stays in one tested place without the library reaching for ambient
 * state.
 */

// =============================================================================
// Sub-records
// =============================================================================

/** Reddit's OAuth client-credentials grant needs all three values together. */
export interface RedditCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Reddit rejects requests without a descriptive, unique User-Agent. */
  readonly userAgent: string;
}

/**
 * X/Twitter has three independent transports. Each is optional; the provider
 * is enabled when at least one is configured, and reports which backends it
 * actually has.
 */
export interface XCredentials {
  /** Official X API v2 app-only bearer token. */
  readonly bearerToken?: string;
  /** twitterapi.io key (third-party mirror; cheaper, wider history). */
  readonly twitterapiKey?: string;
}

/** Bright Data collection datasets. Instagram routing needs the token only. */
export interface BrightDataCredentials {
  readonly apiToken: string;
  /** Dataset id for the LinkedIn posts collector. */
  readonly linkedinDatasetId?: string;
  /** Dataset id for the Facebook groups collector. */
  readonly facebookGroupsDatasetId?: string;
  /**
   * Web Unlocker zone name (`POST /request`). Absent means news/article
   * URL fetch is disabled even when the token is present. Social datasets
   * do not unlock arbitrary pages.
   */
  readonly unlockerZone?: string;
}

/**
 * GitHub public search. The API answers unauthenticated at a much lower rate
 * limit, so a token is optional — but whether one is REQUIRED is the host's
 * policy, stated explicitly rather than inferred.
 */
export interface GitHubPublicAuthConfig {
  /** Purpose-minted public-research token. Never a general-purpose PAT. */
  readonly publicToken?: string;
  /** When true, an absent or invalid token fails the lane instead of falling back to anonymous. */
  readonly requireAuth: boolean;
  /**
   * True when the host's environment carries general-purpose GitHub
   * credentials (GITHUB_TOKEN/GH_TOKEN) that this package deliberately does
   * NOT use. Reported in the auth state so an operator can see why their
   * ambient token had no effect.
   */
  readonly ambientCredentialsPresent: boolean;
}

/**
 * The external browser crawler. All three fields are required together: an
 * endpoint with no reviewed domain allowlist, or without the operator's
 * egress acknowledgement, is exactly the configuration this guard exists to
 * refuse. Omit the whole record to run without the browser crawler.
 */
export interface Crawl4AiConfig {
  /** Base URL of the Crawl4AI service. The package ships no default endpoint. */
  readonly baseUrl: string;
  /** Hostnames the crawler may be pointed at. Supports leading `*.` wildcards. */
  readonly allowedDomains: readonly string[];
  /**
   * Must equal CRAWL4AI_NETWORK_GUARD_VALUE. Any other value disables the
   * crawler: the acknowledgement is versioned so that a change to what the
   * guard enforces cannot inherit an old operator's approval.
   */
  readonly networkGuard: string;
}

// =============================================================================
// The record
// =============================================================================

export interface ResearchCredentials {
  // --- Search + discovery lanes -------------------------------------------
  readonly tavilyApiKey?: string;
  readonly exaApiKey?: string;
  readonly serperApiKey?: string;
  readonly serpapiKey?: string;
  /** SearXNG instance base URLs, tried round-robin. Empty/absent disables the lane. */
  readonly searxngUrls?: readonly string[];
  readonly perplexityApiKey?: string;
  readonly listennotesApiKey?: string;
  readonly youtubeApiKey?: string;
  readonly reddit?: RedditCredentials;
  readonly x?: XCredentials;
  /** Apify actor runs — Instagram Stories (primary), X fallback, TikTok collector. */
  readonly apifyApiToken?: string;
  /**
   * Policy opt-in for Apify as a last-resort fallback lane, parsed from
   * `APIFY_ALLOW_FALLBACK=1` at resolve time. Absent means not allowed.
   */
  readonly apifyAllowFallback?: boolean;
  readonly brightdata?: BrightDataCredentials;
  readonly github?: GitHubPublicAuthConfig;

  // --- Models + infrastructure --------------------------------------------
  /** Gemini: per-page extraction, planning, and the cheap synthesis tier. */
  readonly geminiApiKey?: string;
  /** Voyage: embeddings + rerank. */
  readonly voyageApiKey?: string;
  /** Anthropic: planner fallback, synthesis, critique, assembly. */
  readonly anthropicApiKey?: string;
  /** OpenRouter: `qwen-*` synthesis models. */
  readonly openrouterApiKey?: string;
  /** DeepSeek via its Anthropic-compatible endpoint: `deepseek-*` models. */
  readonly deepseekApiKey?: string;
  /** Z.ai via its Anthropic-compatible endpoint: `glm-*` models. */
  readonly zaiApiKey?: string;
  readonly crawl4ai?: Crawl4AiConfig;
}

// =============================================================================
// Env-name conventions
// =============================================================================

/**
 * Gemini alias set. The package has consumers in both the Braintied and Vercel
 * AI SDK ecosystems, which name the same credential differently; one resolver
 * keeps planning, extraction, and synthesis from selecting different or stale
 * aliases for the same request path.
 */
export const GEMINI_KEY_ENV_NAMES = [
  'GEMINI_RESEARCH_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
] as const;

export const GEMINI_KEY_NAME_ENV = 'BRAINTIED_GEMINI_KEY_NAME';

export const CRAWL4AI_ALLOWED_DOMAINS_ENV = 'BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS';
export const CRAWL4AI_NETWORK_GUARD_ENV = 'BRAINTIED_CRAWL4AI_NETWORK_GUARD';
export const CRAWL4AI_NETWORK_GUARD_VALUE = 'enforced-v1';

/**
 * Every variable name `resolveResearchCredentials` consults, in the order a
 * README would list them. Hosts use this to report which credentials they
 * actually have without duplicating the mapping.
 */
export const RESEARCH_ENV_NAMES = [
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'SERPER_API_KEY',
  'SERPAPI_KEY',
  'SEARXNG_URLS',
  'PERPLEXITY_API_KEY',
  'LISTENNOTES_API_KEY',
  'YOUTUBE_API_KEY',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'REDDIT_USER_AGENT',
  'X_BEARER_TOKEN',
  'X_APP_BEARER_TOKEN',
  'TWITTER_BEARER_TOKEN',
  'TWITTERAPI_IO_KEY',
  'TWITTERAPI_KEY',
  'APIFY_API_TOKEN',
  'APIFY_ALLOW_FALLBACK',
  'BRIGHTDATA_API_TOKEN',
  'BRIGHTDATA_LINKEDIN_DATASET_ID',
  'BRIGHTDATA_FB_GROUPS_DATASET_ID',
  'BRIGHTDATA_UNLOCKER_ZONE',
  'BRAINTIED_GITHUB_PUBLIC_TOKEN',
  'BRAINTIED_GITHUB_REQUIRE_AUTH',
  ...GEMINI_KEY_ENV_NAMES,
  GEMINI_KEY_NAME_ENV,
  'VOYAGE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'ZAI_API_KEY',
  'CRAWL4AI_URL',
  CRAWL4AI_ALLOWED_DOMAINS_ENV,
  CRAWL4AI_NETWORK_GUARD_ENV,
] as const;

/** The environment shape the resolver reads. Node's `process.env` satisfies it. */
export type ResearchEnvironment = Readonly<Record<string, string | undefined>>;

// =============================================================================
// Resolver
// =============================================================================

function trimmed(env: ResearchEnvironment, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value.length === 0 ? undefined : value;
}

function firstConfigured(env: ResearchEnvironment, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = trimmed(env, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function csv(env: ResearchEnvironment, name: string): string[] {
  const raw = trimmed(env, name);
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve the Gemini key from the alias set.
 *
 * Throws on genuine misconfiguration — an unknown selector, a selector naming
 * an unset variable, or two aliases holding DIFFERENT keys with no selector to
 * break the tie. Silently picking one of two conflicting keys is how a run
 * bills the wrong project or hits a dead key: the host learns at its boundary
 * instead of inside an extraction call an hour later.
 */
export function resolveGeminiApiKey(env: ResearchEnvironment): string | undefined {
  const configuredName = trimmed(env, GEMINI_KEY_NAME_ENV);
  if (configuredName !== undefined
    && !GEMINI_KEY_ENV_NAMES.includes(configuredName as (typeof GEMINI_KEY_ENV_NAMES)[number])) {
    throw new Error(
      `${GEMINI_KEY_NAME_ENV} must name one of: ${GEMINI_KEY_ENV_NAMES.join(', ')}`,
    );
  }

  const candidates = GEMINI_KEY_ENV_NAMES.flatMap((name) => {
    const value = trimmed(env, name);
    return value === undefined ? [] : [{ name, value }];
  });

  if (configuredName !== undefined) {
    const selected = candidates.find((candidate) => candidate.name === configuredName);
    if (selected === undefined) {
      throw new Error(`${GEMINI_KEY_NAME_ENV} selects ${configuredName}, but that variable is not configured`);
    }
    return selected.value;
  }

  if (new Set(candidates.map((candidate) => candidate.value)).size > 1) {
    throw new Error(
      `Conflicting Gemini aliases are configured (${candidates.map((candidate) => candidate.name).join(', ')}); set ${GEMINI_KEY_NAME_ENV}`,
    );
  }
  if (candidates[0] !== undefined) return candidates[0].value;
  return undefined;
}

function resolveGitHub(env: ResearchEnvironment): GitHubPublicAuthConfig {
  const rawPolicy = env.BRAINTIED_GITHUB_REQUIRE_AUTH;
  const policy = rawPolicy === undefined || rawPolicy.trim() === '' ? 'false' : rawPolicy.trim();
  if (policy !== 'true' && policy !== 'false') {
    throw new Error('BRAINTIED_GITHUB_REQUIRE_AUTH must be "true" or "false"');
  }
  const publicToken = trimmed(env, 'BRAINTIED_GITHUB_PUBLIC_TOKEN');
  return {
    ...(publicToken === undefined ? {} : { publicToken }),
    requireAuth: policy === 'true',
    ambientCredentialsPresent: trimmed(env, 'GITHUB_TOKEN') !== undefined
      || trimmed(env, 'GH_TOKEN') !== undefined,
  };
}

function resolveReddit(env: ResearchEnvironment): RedditCredentials | undefined {
  const clientId = trimmed(env, 'REDDIT_CLIENT_ID');
  const clientSecret = trimmed(env, 'REDDIT_CLIENT_SECRET');
  const userAgent = trimmed(env, 'REDDIT_USER_AGENT');
  if (clientId === undefined || clientSecret === undefined || userAgent === undefined) {
    return undefined;
  }
  return { clientId, clientSecret, userAgent };
}

function resolveX(env: ResearchEnvironment): XCredentials | undefined {
  const bearerToken = firstConfigured(env, ['X_BEARER_TOKEN', 'X_APP_BEARER_TOKEN', 'TWITTER_BEARER_TOKEN']);
  const twitterapiKey = firstConfigured(env, ['TWITTERAPI_IO_KEY', 'TWITTERAPI_KEY']);
  if (bearerToken === undefined && twitterapiKey === undefined) return undefined;
  return {
    ...(bearerToken === undefined ? {} : { bearerToken }),
    ...(twitterapiKey === undefined ? {} : { twitterapiKey }),
  };
}

function resolveBrightData(env: ResearchEnvironment): BrightDataCredentials | undefined {
  const apiToken = trimmed(env, 'BRIGHTDATA_API_TOKEN');
  if (apiToken === undefined) return undefined;
  const linkedinDatasetId = trimmed(env, 'BRIGHTDATA_LINKEDIN_DATASET_ID');
  const facebookGroupsDatasetId = trimmed(env, 'BRIGHTDATA_FB_GROUPS_DATASET_ID');
  const unlockerZone = trimmed(env, 'BRIGHTDATA_UNLOCKER_ZONE');
  return {
    apiToken,
    ...(linkedinDatasetId === undefined ? {} : { linkedinDatasetId }),
    ...(facebookGroupsDatasetId === undefined ? {} : { facebookGroupsDatasetId }),
    ...(unlockerZone === undefined ? {} : { unlockerZone }),
  };
}

function resolveCrawl4Ai(env: ResearchEnvironment): Crawl4AiConfig | undefined {
  const baseUrl = trimmed(env, 'CRAWL4AI_URL');
  if (baseUrl === undefined) return undefined;
  const networkGuard = trimmed(env, CRAWL4AI_NETWORK_GUARD_ENV);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    allowedDomains: csv(env, CRAWL4AI_ALLOWED_DOMAINS_ENV),
    networkGuard: networkGuard === undefined ? '' : networkGuard,
  };
}

/**
 * Build the credential record from an environment map.
 *
 * The host owns the environment: call this with `process.env` (or any map it
 * assembled from a secrets manager) at the process boundary, then pass the
 * result to every entry point. Optional fields stay absent when unconfigured;
 * that absence disables the corresponding lane and is reported by preflight.
 */
export function resolveResearchCredentials(env: ResearchEnvironment): ResearchCredentials {
  const tavilyApiKey = trimmed(env, 'TAVILY_API_KEY');
  const exaApiKey = trimmed(env, 'EXA_API_KEY');
  const serperApiKey = trimmed(env, 'SERPER_API_KEY');
  const serpapiKey = trimmed(env, 'SERPAPI_KEY');
  const searxngUrls = csv(env, 'SEARXNG_URLS').map((url) => url.replace(/\/+$/, ''));
  const perplexityApiKey = trimmed(env, 'PERPLEXITY_API_KEY');
  const listennotesApiKey = trimmed(env, 'LISTENNOTES_API_KEY');
  const youtubeApiKey = trimmed(env, 'YOUTUBE_API_KEY');
  const apifyApiToken = trimmed(env, 'APIFY_API_TOKEN');
  const apifyAllowFallback = trimmed(env, 'APIFY_ALLOW_FALLBACK') === '1';
  const reddit = resolveReddit(env);
  const x = resolveX(env);
  const brightdata = resolveBrightData(env);
  const geminiApiKey = resolveGeminiApiKey(env);
  const voyageApiKey = trimmed(env, 'VOYAGE_API_KEY');
  const anthropicApiKey = trimmed(env, 'ANTHROPIC_API_KEY');
  const openrouterApiKey = trimmed(env, 'OPENROUTER_API_KEY');
  const deepseekApiKey = trimmed(env, 'DEEPSEEK_API_KEY');
  const zaiApiKey = trimmed(env, 'ZAI_API_KEY');
  const crawl4ai = resolveCrawl4Ai(env);

  return {
    ...(tavilyApiKey === undefined ? {} : { tavilyApiKey }),
    ...(exaApiKey === undefined ? {} : { exaApiKey }),
    ...(serperApiKey === undefined ? {} : { serperApiKey }),
    ...(serpapiKey === undefined ? {} : { serpapiKey }),
    ...(searxngUrls.length === 0 ? {} : { searxngUrls }),
    ...(perplexityApiKey === undefined ? {} : { perplexityApiKey }),
    ...(listennotesApiKey === undefined ? {} : { listennotesApiKey }),
    ...(youtubeApiKey === undefined ? {} : { youtubeApiKey }),
    ...(reddit === undefined ? {} : { reddit }),
    ...(x === undefined ? {} : { x }),
    ...(apifyApiToken === undefined ? {} : { apifyApiToken }),
    ...(apifyAllowFallback ? { apifyAllowFallback } : {}),
    ...(brightdata === undefined ? {} : { brightdata }),
    github: resolveGitHub(env),
    ...(geminiApiKey === undefined ? {} : { geminiApiKey }),
    ...(voyageApiKey === undefined ? {} : { voyageApiKey }),
    ...(anthropicApiKey === undefined ? {} : { anthropicApiKey }),
    ...(openrouterApiKey === undefined ? {} : { openrouterApiKey }),
    ...(deepseekApiKey === undefined ? {} : { deepseekApiKey }),
    ...(zaiApiKey === undefined ? {} : { zaiApiKey }),
    ...(crawl4ai === undefined ? {} : { crawl4ai }),
  };
}

/**
 * Whether the host opted in to Apify as a last-resort fallback. True only
 * when `APIFY_ALLOW_FALLBACK` was exactly `1` at resolve time — the documented
 * opt-in per the provider notes. Token presence is a separate check the
 * callers make, so an allowed fallback without a token still errors clearly.
 */
export function isApifyFallbackAllowed(credentials: ResearchCredentials): boolean {
  return credentials.apifyAllowFallback === true;
}

// =============================================================================
// Required-credential accessors
// =============================================================================

/**
 * Thrown when a lane the caller explicitly asked for has no credential. The
 * field name is the one on ResearchCredentials, not an environment variable —
 * the host chose how to source it.
 */
export class MissingCredentialError extends Error {
  constructor(
    public readonly field: string,
    detail: string,
  ) {
    super(`ResearchCredentials.${field} is not configured — ${detail}`);
    this.name = 'MissingCredentialError';
  }
}

export function requireGeminiApiKey(credentials: ResearchCredentials): string {
  if (credentials.geminiApiKey === undefined) {
    throw new MissingCredentialError('geminiApiKey', 'required for quote extraction, planning, and gemini-* synthesis');
  }
  return credentials.geminiApiKey;
}

export function requireVoyageApiKey(credentials: ResearchCredentials): string {
  if (credentials.voyageApiKey === undefined) {
    throw new MissingCredentialError('voyageApiKey', 'required for embedding and rerank');
  }
  return credentials.voyageApiKey;
}

export function requireAnthropicApiKey(credentials: ResearchCredentials): string {
  if (credentials.anthropicApiKey === undefined) {
    throw new MissingCredentialError('anthropicApiKey', 'required for claude-* planning, synthesis, critique, and assembly');
  }
  return credentials.anthropicApiKey;
}
