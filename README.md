# Braintied Research

You name the question and a dollar cap. The engine searches, fetches pages,
extracts quotes, synthesizes a report, and grounds every citation against
the fetched evidence.

**1.7.0** of [`@braintied/research`](https://github.com/braintied/stack/tree/main/packages/research).
Every stack publish snapshots this repo. Agents: start in [AGENTS.md](./AGENTS.md).

## Install

```bash
pnpm add @braintied/research
```

The host passes credentials in. The package never reads `process.env`.

```ts
import { resolveResearchCredentials, runResearch } from '@braintied/research';

const credentials = resolveResearchCredentials(process.env);
const { report, costUsd, grounding } = await runResearch({
  credentials,
  brief: 'Competitive landscape for AI meeting assistants in 2026',
  kind: 'standard',
  maxCostUsd: 5,
});
```

A host that sources secrets from a vault can build the `ResearchCredentials`
record itself. The type is public. Absence disables that lane. It does not
swap in another provider.

## Free search and fetch

Search and page fetch can run at **$0**. Synthesis still needs a model key
(Gemini or Anthropic). Do not call that "free research" if a model ran.

### SearXNG ($0 search)

Set `SEARXNG_URLS` to a CSV of instance base URLs. The provider tries them
round-robin. Empty or absent disables the lane.

```bash
export SEARXNG_URLS='https://searx.example.com,https://searx-b.example.com'
pnpm smoke:searxng
```

Web discovery prefers Tavily when that key is present (it can return raw
page text and skip a crawl). SearXNG is the independent, self-hosted
breadth lane. Use it first when the job is "find links."

### Crawl4AI ($0 fetch)

The browser crawler stays off unless **all three** fields are set together.
There is no default endpoint.

| Field | Env | What it is |
|---|---|---|
| `crawl4ai.baseUrl` | `CRAWL4AI_URL` | Your Crawl4AI service. The package ships none. |
| `crawl4ai.allowedDomains` | `BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS` | Exact hosts, or `*.example.com`. A bare `*` opts into open-web targets. |
| `crawl4ai.networkGuard` | `BRAINTIED_CRAWL4AI_NETWORK_GUARD` | Must be exactly `enforced-v1`. |

`enforced-v1` is an operator attestation: the crawler itself must deny
private, link-local, and reserved IPs on every navigation, redirect, and
subresource. The acknowledgement is versioned so a later guard change
cannot inherit an old approval. An allowlist alone is not an SSRF defense.

```bash
export CRAWL4AI_URL='https://crawl.example.com'
export BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS='docs.example.com,*.wikipedia.org'
export BRAINTIED_CRAWL4AI_NETWORK_GUARD=enforced-v1
export RESEARCH_LIVE_TEST=1
pnpm smoke:crawl4ai
```

`crawlUrl` falls back to a direct HTTP fetch when Crawl4AI declines. That
fallback looks like a healthy crawl unless you ask. `crawlUrlDetailed`
returns `{ text, method, declinedReason }` where `method` is `crawl4ai`,
`direct_fetch`, or null. A ledger that records `crawl4ai` for a direct
fetch is lying about the lane.

### Cheap first

1. Find links with SearXNG.
2. Fetch known URLs with Crawl4AI (or `direct_fetch` if the crawler declines).
3. Pay Tavily only when you need extracted page text that Crawl4AI returned empty.
4. SerpAPI is Maps and Shopping (phone, rating, product tiles), not a generic SERP.
5. Do not buy Exa, Firecrawl, or Brave to replace the $0 pair.

## Credentials

`resolveResearchCredentials(env)` maps conventional names onto one record.
Every entry point (`runResearch`, `runDeepResearch`, `runResearchProgram`,
`runAnswer`, `generateDocument`, `probePublicSourceHealth`, stage APIs)
takes that record. The registry is a value, not a module singleton.

```ts
interface ResearchCredentials {
  searxngUrls?: readonly string[];
  tavilyApiKey?: string;
  serperApiKey?: string;
  serpapiKey?: string;
  exaApiKey?: string;
  perplexityApiKey?: string;
  crawl4ai?: { baseUrl: string; allowedDomains: readonly string[]; networkGuard: string };
  reddit?: { clientId: string; clientSecret: string; userAgent: string };
  youtubeApiKey?: string;
  github?: { publicToken?: string; requireAuth: boolean; ambientCredentialsPresent: boolean };
  x?: { bearerToken?: string; twitterapiKey?: string };
  apifyApiToken?: string;
  apifyAllowFallback?: boolean;
  brightdata?: { apiToken: string; unlockerZone?: string; linkedinDatasetId?: string; facebookGroupsDatasetId?: string };
  listennotesApiKey?: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
  voyageApiKey?: string;
  openrouterApiKey?: string;
  deepseekApiKey?: string;
  zaiApiKey?: string;
}
```

### Search and fetch vendors

| Provider | Kind | Env | Cost note |
|---|---|---|---|
| SearXNG | search | `SEARXNG_URLS` (CSV) | $0 |
| Tavily | search + raw page | `TAVILY_API_KEY` | quality tier, ~$8/1k |
| Serper | Google SERP | `SERPER_API_KEY` | 2,500 free/mo, then ~$0.30–1/1k |
| Exa | semantic search | `EXA_API_KEY` | $7/1k, 1k free/mo |
| SerpAPI | Maps / Shopping / PAA | `SERPAPI_KEY` | paid |
| Crawl4AI | fetch | `CRAWL4AI_URL` + domains + `enforced-v1` | $0 |
| Bright Data Unlocker | fetch | `BRIGHTDATA_API_TOKEN` + `BRIGHTDATA_UNLOCKER_ZONE` | per request |

### Social and community

| Provider | Env | Tip |
|---|---|---|
| Reddit | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` + `REDDIT_USER_AGENT` | Free OAuth. All three required. Reddit rejects a generic User-Agent. |
| YouTube | `YOUTUBE_API_KEY` | Free quota. Transcripts + comments. |
| GitHub | `BRAINTIED_GITHUB_PUBLIC_TOKEN`, optional `BRAINTIED_GITHUB_REQUIRE_AUTH=true` | Ambient `GITHUB_TOKEN` / `GH_TOKEN` are ignored on purpose. |
| Hacker News | (none) | $0. The item permalink is the evidence identity. |
| RSS | (none) | $0. Profiles must pass explicit `feedUrls`. |
| Podcasts | `LISTENNOTES_API_KEY` | Paid. |
| X | `TWITTERAPI_IO_KEY` primary, `X_BEARER_TOKEN` official fallback (`TWITTER_BEARER_TOKEN` / `X_APP_BEARER_TOKEN` aliases) | Official v2 only covers a 7-day window. Apify is last, and only when `APIFY_ALLOW_FALLBACK=1`. |
| Instagram | `BRIGHTDATA_API_TOKEN` | Posts `/p/` `/reel/` `/tv/`, profiles, hashtags. **Stories** use Apify actor `datavoyantlab/advanced-instagram-stories-scraper`. Posts never fall back to Apify, Crawl4AI, or a browser. |
| TikTok | `APIFY_API_TOKEN` and/or Bright Data | Paid. |
| Facebook groups | `APIFY_API_TOKEN` / Bright Data dataset | Paid. |
| Perplexity | `PERPLEXITY_API_KEY` | `managed` kind only. ~$0.40–1.30/query. No quote-level grounding. |

### Models

`ANTHROPIC_API_KEY` (synthesis, critique). Gemini via one of
`GEMINI_RESEARCH_KEY`, `GOOGLE_GEMINI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`. If two aliases hold
different values, resolve fails closed. Set `BRAINTIED_GEMINI_KEY_NAME` to
the approved name. `VOYAGE_API_KEY` for rerank. Optional
`OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_API_KEY`.

The full name list is `RESEARCH_ENV_NAMES` in `src/credentials.ts`.

### Vendor traps

- A missing key **disables** the lane. `--require-providers tavily,x` fails
  preflight instead of silently searching the web.
- `MissingCredentialError` names the **config field**, not an env var. The
  host chose how to source it.
- Generic web fetch is fail-closed: public HTTP(S) only, DNS pin, redirect
  revalidation, private/link-local IPv4 and IPv6 blocked, content-type and
  byte limits.
- Instagram stories are the one Apify-primary path. Everything else on
  Instagram is Bright Data or a failed operation.
- Two Gemini aliases with different values is a loud error, not a pick.
- `crawlUrl` vs `crawlUrlDetailed`: meter the detailed form.

## Kinds

Kind is depth and cost. Source mode is which lanes must actually run.

| Kind | Engine | Typical use | Budget |
|---|---|---|---|
| `answer` | one search + cheap synthesis | a current fact | ~$0.002–0.01, 5–15s. `maxCostUsd` is **not** enforced. |
| `quick` | pipeline, no critique | orientation | ~$0.02–0.10. Set a small cap. |
| `standard` | grounded pipeline + critique | pricing, vendors, competitors | ~$0.50–2. Default. Always cap. |
| `deep` | wide pipeline | diligence | ~$2–6. Approved larger cap. |
| `managed` | Perplexity sonar-deep-research | only when you asked for hosted | ~$0.40–1.30. No quote grounding. |
| `social` | pipeline, social providers | audience voice | Always cap. |

Do not pick `managed` because it is convenient. For contractual pricing,
`standard` plus primary-source verification is the starting point.

A brief with numbered questions under a `questions` heading is planned per
question (fair share of the subquery band, headings `Q{n}: …`). Briefs
without that section behave as before.

## Source modes

```ts
sourceModes: ['web']            // or
sourceModes: ['all_public']     // web + x + reddit + youtube + github + community
```

| Mode | Required evidence | Discovery |
|---|---|---|
| `web` | docs, articles, news | Tavily / SearXNG; Crawl4AI acquires URLs |
| `x` | posts and threads | twitterapi.io, then official X, then Apify |
| `reddit` | threads and comments | native OAuth |
| `youtube` | videos, transcripts, comments | native Data API |
| `github` | repos, issues, PRs | dedicated public token only |
| `community` | HN, RSS, podcasts | free HN/RSS |
| `instagram` / `tiktok` / `facebook_groups` | social | paid, opt-in |
| `all_public` | the six public modes | expands deterministically |
| `cortex` / `telegram` | trusted-local | caller-injected adapter. Never sent to public providers. |

Coverage counts **fetched, source-validated** evidence. Search snippets
cannot satisfy a required lane. A missing required lane is `partial`, not
"the web search covered it."

`runResearchProgram` keeps public research and private recall as separate
artifacts. Raw private evidence never enters the public provider pipeline.

## Pipeline

1. Plan 15–35 web-searchable subqueries.
2. Search enabled providers in parallel. Dedup by canonical URL.
3. Fetch pages (Crawl4AI, then direct fetch).
4. Extract verbatim quotes (Gemini).
5. Rerank (Voyage).
6. Synthesize: the model picks evidence IDs; code inserts the exact
   sentences. Inference is labeled `Editorial synthesis — inference, not
   source-validated`.
7. Critique, then re-search the gaps.
8. Assemble the report and bibliography.
9. Ground every citation against fetched evidence.
10. Optional `indexSink` for the caller to persist chunks.

The package does not write a database. The host owns storage, spend
attribution (`onUsage` → `@braintied/cost`), and any corpus.

Document types: `prd`, `market-report`, `tech-spec`, `client-brief`,
`content-brief`, `estimate-research`.

Stage APIs (`planSubqueries`, `getEnabledProviders`, `rerankQuotes`,
`synthesizeAllSections`, `critiqueDraft`, `assembleFinalReport`,
`validateGrounding`) are exported for hosts that keep their own step
boundaries.

## Agents

The shipped skill is [`skills/run-braintied-research/`](skills/run-braintied-research/).
The contract for coding agents is [AGENTS.md](./AGENTS.md).

```bash
# local preflight (no network)
node skills/run-braintied-research/scripts/run-internal-research.mjs \
  --check --kind standard --max-cost-usd 2.50

# confirm the remote catalog exposes research.run (still no model/search)
node skills/run-braintied-research/scripts/run-internal-research.mjs \
  --check --probe --kind standard --max-cost-usd 2.50
```

The internal runner keeps provider keys inside the host. The local
fallback (`run-research.mjs`) is explicit, allowlisted env only. Never
Node `--env-file`: Node imports every entry before the allowlist runs,
and the runner refuses that preload.

Link the skill once for Codex:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$PWD/skills/run-braintied-research" \
  "${CODEX_HOME:-$HOME/.codex}/skills/run-braintied-research"
```

## This repo

Public source snapshot of the engine. Issues live here. Edit
`packages/research/oss/` in `braintied/stack`, not this checkout.

```bash
node scripts/stack.mjs snapshot                        # GitHub only, no npm
node scripts/stack.mjs publish --only @braintied/research
```

`publish` snapshots after a new version, and also when this version is
already on the registry. A docs-only change does not need a bump.
`snapshot` is the same GitHub push without touching npm.

Do not `npm publish` from this checkout.

Do not build a second research, search, or crawl engine beside this one.
If a surface needs web research, depend on the package. The consumer
registry is [`RESEARCH-SYSTEMS.md`](./RESEARCH-SYSTEMS.md).

## License

Braintied proprietary (`UNLICENSED`). Source is public. Redistribution
is not a grant.
