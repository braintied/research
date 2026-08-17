# AGENTS.md

How a coding agent runs `@braintied/research`. Humans can start at
[README.md](./README.md). This file is the contract.

**1.5.0** · package-owned skill: `skills/run-braintied-research/`.

## Do this first

1. **Recall** whatever corpus the host already has. Paid web is not a
   prior-art check.
2. **Classify the brief.** Strip secrets, personal data, customer data,
   private financials, unreleased deal terms, proprietary source text.
   Replace specifics with placeholders. Never send another project's
   credentials outbound.
3. **Pick the cheapest tool that can do the job.**
   - Find links → SearXNG (`SEARXNG_URLS`), $0.
   - Fetch a known URL → Crawl4AI (`CRAWL4AI_URL` + reviewed domains +
     `BRAINTIED_CRAWL4AI_NETWORK_GUARD=enforced-v1`), $0.
   - Maps / Shopping tiles → SerpAPI. Not a generic SERP.
   - Extracted page text after Crawl4AI returned empty → Tavily.
   - Cited report with a budget → this package, after a cap is approved.
4. **Estimate, then wait for an approved `maxCostUsd`.** Do not spend
   before that. `answer` and `managed` do not honor the cap; choose them
   on purpose.
5. **Run the smallest adequate kind.** Default `quick` unless the brief
   needs `standard` or an approved `deep`.
6. **Ground the report.** `grounding.passed: false`,
   `grounding_quality: weak`, or `ungrounded` is a verification failure.
   Do not present that report as source-verified.

If the engine did not run and no provider was called, incurred cost is
`$0.00`. Say that `cost_usd` and grounding were **not produced**. Do not
describe either as `null`.

## Free lane (SearXNG + Crawl4AI)

Search and fetch can be $0. Synthesis is not. A Gemini or Anthropic key
is still required to write the report.

```ts
const credentials = resolveResearchCredentials({
  SEARXNG_URLS: 'https://searx.example.com',
  CRAWL4AI_URL: 'https://crawl.example.com',
  BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS: 'docs.example.com,*.wikipedia.org',
  BRAINTIED_CRAWL4AI_NETWORK_GUARD: 'enforced-v1',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
});
```

Rules the unit suite already enforces:

- All three Crawl4AI fields together, or the crawler is off. No default
  endpoint.
- `networkGuard` must equal `enforced-v1`. Any other string disables it.
- `allowedDomains` is exact hosts or `*.example.com`. Bare `*` is the
  open-web opt-in; it waives domain review, never the network guard.
- Use `crawlUrlDetailed`. `crawlUrl` hides a direct-fetch fallback
  behind a healthy-looking result.
- `pnpm smoke:searxng` and `pnpm smoke:crawl4ai` are live wire tests.
  They are not CI. They need `RESEARCH_LIVE_TEST=1` for Crawl4AI.

Do not buy Exa, Firecrawl, or Brave to replace this pair. Do not fire
SerpAPI `engine=google` for "find links."

## Kind and source mode

Kind = depth / cost. Mode = which lanes must execute.

| Kind | When | Cap |
|---|---|---|
| `answer` | one current fact | not enforced |
| `quick` | orientation | required, small |
| `standard` | vendor / pricing / competitor | required |
| `deep` | diligence | required, approved |
| `managed` | hosted Perplexity, asked for by name | not enforced; no quote grounding |
| `social` | audience voice | required |

| Mode | Must actually run |
|---|---|
| `web` | Tavily and/or SearXNG, then Crawl4AI / direct fetch |
| `x` | twitterapi.io, then official X, then Apify if `APIFY_ALLOW_FALLBACK=1` |
| `reddit` | native OAuth |
| `youtube` | native Data API |
| `github` | `BRAINTIED_GITHUB_PUBLIC_TOKEN` only. Ambient `GITHUB_TOKEN` is ignored. |
| `community` | HN + RSS (+ podcasts if keyed) |
| `all_public` | all six, deterministically |
| `cortex` / `telegram` | trusted-local only. Local runner must fail their preflight. |

`--require-providers tavily,x,reddit` fails closed when a named lane is
off. A missing required lane is **partial coverage**, never "web search
covered it." Coverage counts fetched, source-validated evidence.
Snippets do not count.

`--as-of YYYY-MM-DD` is required for exact lane preflight.

## How to invoke

Prefer the **internal** runner. Provider keys stay in the host.
`BRAINTIED_AGENT_TOKEN` or the configured macOS Keychain item. The
check never prints the token.

```bash
# 1. local Agent Auth, no network
node skills/run-braintied-research/scripts/run-internal-research.mjs \
  --check --kind standard --max-cost-usd 2.50

# 2. catalog probe (one read-only network call, no model/search)
node skills/run-braintied-research/scripts/run-internal-research.mjs \
  --check --probe --kind standard --max-cost-usd 2.50

# 3. live, after the brief file and the cap are authorized
node skills/run-braintied-research/scripts/run-internal-research.mjs \
  --brief-file /tmp/research-brief.md \
  --kind standard \
  --max-cost-usd 2.50 \
  --as-of 2026-08-17 \
  --output /tmp/research-report.md \
  --metadata /tmp/research-run.json \
  --allow-external
```

Write the brief to a file. Shell-embedded text is a quoting hazard and
hides the outbound prompt.

Durable protocol v2: one idempotent request, server-owned run ID, poll
the tenant-bound result. Before submit, the client writes a chmod-0600
checkpoint to `--metadata` and prints the request ID on stderr. A
dropped response retries **the same request ID**. If you are
interrupted, rerun with `--request-id <id>`. Never mint a fresh ID for
the same paid attempt. A `submission_pending` checkpoint does not prove
the server accepted; resubmitting that ID is the safe recovery.

`run-research.mjs` is the **local-provider fallback**. It requires a
fresh package build and its own keys.

```bash
node skills/run-braintied-research/scripts/run-research.mjs \
  --check \
  --kind deep \
  --max-cost-usd 5 \
  --sources all_public \
  --require-providers tavily,x,reddit,youtube,github \
  --as-of 2026-08-17 \
  --load-shell-env
```

Env resolution (1.0.0+): the **runner** is the only process boundary.
It allowlists, then calls `resolveResearchCredentials(process.env)`
once. The package `src/` never reads the environment (regression test:
`test/no-direct-env.test.ts`).

- `--research-env-file /absolute/path/to/.env` or
  `BRAINTIED_RESEARCH_ENV_FILE`. Allowlisted keys only. Blank
  assignments mask inherited values.
- Never Node `--env-file`. The runner refuses that preload.
- `--load-shell-env` imports the same allowlist from the interactive
  shell. It never imports Agent Auth.
- Two Gemini aliases with different values, or an unparseable
  `BRAINTIED_GITHUB_REQUIRE_AUTH`, fail at that boundary.

## Credentials the package actually consumes

Build a `ResearchCredentials` record. Do not reach around it.

Search: `searxngUrls`, `tavilyApiKey`, `serperApiKey`, `serpapiKey`,
`exaApiKey`, `perplexityApiKey`.

Fetch: `crawl4ai` (`baseUrl` + `allowedDomains` + `networkGuard`),
`brightdata.unlockerZone`.

Social: `reddit` (all three), `youtubeApiKey`, `github.publicToken` +
`github.requireAuth`, `x.twitterapiKey` / `x.bearerToken`,
`apifyApiToken` + `apifyAllowFallback`, `brightdata.apiToken`.

Models: `geminiApiKey`, `anthropicApiKey`, `voyageApiKey`,
`openrouterApiKey`, `deepseekApiKey`, `zaiApiKey`.

`RESEARCH_ENV_NAMES` in `src/credentials.ts` is the name list. Hosts
report from that constant rather than duplicating the mapping.

`probePublicSourceHealth` is search-only, no model, no fetch. Its
default registry excludes usage-billed adapters. Passing Tavily / X /
Bright Data / Apify as the registry is an explicit cost authorization.
Cap `limit` and `maxPages`. The report is hashes, backend names,
counts, dates, latency, sanitized failure classes. Not query text. Not
provider error bodies.

## Grounding and delivery

Read `grounding`, `bibliography_count`, `gaps`, actual `cost_usd`, and
the report. Grounding is diagnostic, not proof a claim is true. Verify
decision-critical claims against the primary page.

Treat prose labeled `Editorial synthesis — inference, not
source-validated` as analysis, never as a supported source claim.

Deliver: research date, kind, engine, actual cost, grounding status,
known gaps, which important claims remain unverified. For source-mode
runs also: requested modes, per-lane coverage, as-of boundary, backend
failures. Link sources next to the claims they support.

For an authenticated profile run, `--trusted-output` is chmod-0600
trusted-local evidence. Bounded, credential-scrubbed excerpts. Do not
copy them into the public report, a public-provider follow-up, a shared
cache, or a log. Unknown appendix fields are a boundary failure.
Partial coverage still writes the audit artifact and exits 2.

## Trusted-local

`cortex` and `telegram` are not ordinary provider modes. The local
skill runner has no tenant database credentials and must fail their
preflight. Only the host may inject `ora-cortex-braintied`. Retrieved
private content must never enter public search, model, cache, or log
payloads. The Markdown output stays the public report. JSON metadata
carries a separately labeled `private_manifest`.

## Do not

- Invent a second research, search, or crawl engine. Depend on this
  package. See `RESEARCH-SYSTEMS.md`.
- Spend without an approved cap.
- Silently swap credentials, relax the budget, or claim a missing lane
  was covered by general web search.
- Use `managed` as a shortcut around grounding.
- Read `process.env` inside new `src/` code. Resolve at the host
  boundary.
- Log credentials. GitHub public-auth health returns metadata only.
- Default a missing credential to another provider.
- Ship a built-in Crawl4AI endpoint.
- Persist from the package. The caller owns `indexSink` and `--output`.
- Attribute spend anywhere except `@braintied/cost` / the host ledger.

If credentials are absent, the network is blocked, the cap is exhausted,
grounding is weak, or a required lane is unhealthy: report the
limitation and stop or continue with authorized first-party sources.
Say whether this engine actually ran.

## Help

```bash
node skills/run-braintied-research/scripts/run-internal-research.mjs --help
node skills/run-braintied-research/scripts/run-research.mjs --help
```

Runtime, Agent Auth, and failed-preflight detail:
`skills/run-braintied-research/references/runtime.md`.
