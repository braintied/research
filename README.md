# @braintied/research

Shared deep-research engine for Braintied products (Sentigen, Swishh, ora-ai, Krue).

**Lineage:** ora-ai `cortex-worker` deep-research pipeline → decoupled as `@swishh/research` → promoted to this standalone shared package.

## What it does

`runDeepResearch({ brief })` runs a grounded research pipeline as one plain async function (no Inngest, no DB writes):

1. **Plan** — decompose the brief into 15–35 web-searchable subqueries with per-subquery provider routing
2. **Search** — fan out across enabled providers in parallel, dedup by canonical URL
3. **Fetch** — pull page content (Crawl4AI → fallbacks) as markdown
4. **Extract** — verbatim quotes + key claims per source (Gemini)
5. **Rerank** — Voyage rerank-2 per section
6. **Synthesize** — a model selects immutable evidence IDs; code inserts exact source sentences and citations, while connective inference is visibly labeled
7. **Critique loop** — find gaps, re-plan, re-search, re-synthesize
8. **Assemble** — final report with bibliography
9. **Ground** — validate every citation use against exact fetched evidence with explicit quality and pass/fail; weak reports receive a visible warning
10. **Index (optional)** — hand chunks to an injected `indexSink`

Higher layers (this package):
- **Research kinds** — presets (`answer` / `quick` / `standard` / `deep` / `managed` / `social`) so callers say *what kind* of research instead of tuning knobs
- **Source modes** — explicit, enforceable evidence lanes (`web`, `x`, `reddit`, `youtube`, `github`, `community`, `cortex`, `telegram`); required lanes compile to deterministic searches and fail coverage rather than becoming prompt prose
- **Investigation profiles** — versioned source, coverage, verification, output, update, and data-boundary contracts; coverage counts only fetched, source-validated evidence rather than search snippets, and public/private recall briefs compile separately
- **Documents** — `generateDocument({ docType, ... })` renders research into typed structured docs: `prd`, `market-report`, `tech-spec`, `client-brief`, `content-brief`, `estimate-research`
- **Agent skill** — `skills/run-braintied-research/` provides a safe preflight, explicit cost caps, deterministic report/metadata output, and source-verification rules for Codex and other skill-aware agents

## Providers

All providers are raw `fetch` — no SDK dependencies. A provider is enabled when its env key is present.

| Provider | Kind | Env | Cost note |
|---|---|---|---|
| SearXNG (self-hosted) | search | `SEARXNG_URLS` (CSV of instance URLs) | $0 |
| Serper | search (Google SERP) | `SERPER_API_KEY` | 2,500 free/mo, then ~$0.30–1/1k |
| Tavily | search | `TAVILY_API_KEY` | quality tier, ~$8/1k |
| Exa | search (semantic) | `EXA_API_KEY` | $7/1k, 1k free/mo |
| SerpAPI | SERP + ads/PAA | `SERPAPI_KEY` | paid |
| Crawl4AI (self-hosted) | fetch | reviewed domains plus an egress-hardened crawler attestation | $0 |
| Jina Reader | fetch fallback | `JINA_API_KEY` | free tier |
| Reddit | social | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` | free |
| YouTube | video | `YOUTUBE_API_KEY` | free quota |
| GitHub | repository/issues/PRs | dedicated `BRAINTIED_GITHUB_PUBLIC_TOKEN`; optional `BRAINTIED_GITHUB_REQUIRE_AUTH=true` policy | broad ambient `GITHUB_TOKEN` / `GH_TOKEN` are ignored; authenticated mode fails closed when required |
| Hacker News | forum | (none) | $0; the HN item permalink is the fetchable evidence identity and the outbound article remains metadata |
| RSS | newsletters | (none) | $0; profiles must provide explicit verified RSS/Atom endpoints (`feedUrls`) |
| Podcasts | podcast | `LISTENNOTES_API_KEY` | paid |
| X (Twitter) | social | `TWITTERAPI_IO_KEY` (lower-cost primary), `X_BEARER_TOKEN` (official fallback; `TWITTER_BEARER_TOKEN` / Ora's `X_APP_BEARER_TOKEN` aliases), and/or `APIFY_API_TOKEN` (last fallback) | plan-dependent |
| TikTok | social | `APIFY_API_TOKEN` (search + comment-rich fetch) and/or `BRIGHTDATA_API_TOKEN` (fetch fallback, ~$1.50/1k records) | paid |
| Instagram | social | `BRIGHTDATA_API_TOKEN` (posts dataset `gd_lk5ns7kz21pck8jpis`; profiles dataset `gd_l1vikfch901nx3by4`) | paid |
| FB Groups | social | `APIFY_API_TOKEN` | paid |
| LinkedIn / FB Groups (ingestion layer) | ingestion | Bright Data: `BRIGHTDATA_API_TOKEN` (+ dataset IDs) | paid |
| Perplexity | managed deep research | `PERPLEXITY_API_KEY` | ~$0.40–1.30/query (sonar-deep-research) |

Model/pipeline keys: `ANTHROPIC_API_KEY` (synthesis/critique),
`GEMINI_RESEARCH_KEY`, `GOOGLE_GEMINI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, or `GEMINI_API_KEY` (one shared resolver for
planning/extraction/synthesis),
`VOYAGE_API_KEY` (rerank/embed), optional `OPENROUTER_API_KEY`,
`DEEPSEEK_API_KEY`.

If multiple Gemini aliases contain different values, the shared package
resolver fails closed. Set `BRAINTIED_GEMINI_KEY_NAME` to the approved variable
name; the local runner also accepts `--gemini-key-name` and reports the selected
name without printing its value.

> Env naming is standardized here — `SERPAPI_KEY` (not `SERP_API_KEY`), `SERPER_API_KEY`, `SEARXNG_URLS`.

Generic web fetches are fail-closed. The package accepts only public HTTP(S)
targets on the standard port, pins each DNS-validated connection, revalidates
every redirect, blocks private/link-local/reserved IPv4 and IPv6, and enforces
content-type and byte limits. The self-hosted Crawl4AI service is additionally
deny-by-default because a separate browser process cannot inherit the caller's
pinned DNS result. It remains disabled unless the separate crawler enforces
public-only DNS/IP checks on every navigation, redirect, and subresource and
the caller sets `BRAINTIED_CRAWL4AI_NETWORK_GUARD=enforced-v1` to attest that
boundary. `BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS` is a second, comma-separated,
human-reviewed gate: entries are exact hosts, while `*.example.com` explicitly
allows subdomains. An allowlist alone is not an SSRF defense.

Instagram has a stricter boundary than the general web-fetch stack. Hashtag
search uses Bright Data snapshot discovery; direct `/p/`, `/reel/`, and `/tv/`
links use the Bright Data posts dataset; one-segment profile links use the
Bright Data profiles dataset. A missing token, provider/snapshot failure,
timeout, mismatched record, or response without useful post/profile content is
a failed operation. Instagram does not use Apify, Crawl4AI, Jina, or a browser
as a recovery path.

## Usage

```ts
import { runResearch } from '@braintied/research';

const { report, quotes, costUsd } = await runResearch({
  brief: 'Competitive landscape for AI meeting assistants in 2026',
  kind: 'standard',
  maxCostUsd: 5,
});
console.log(report.full_markdown);
```

Kinds control execution depth and cost; source modes control which lanes must
actually run. Profiles make recurring investigations reproducible. Public
research and private recall execute concurrently but remain separate artifacts:

```ts
import { runResearchProgram } from '@braintied/research';

const result = await runResearchProgram({
  brief: 'How should Ora combine durable workflows and long-running agents?',
  asOf: '2026-07-21',
  profileRef: 'ora-agent-runtime@1',
  kind: 'deep',
  maxCostUsd: 7,
  // Ora injects the tenant-bound `ora-cortex-braintied` adapter here.
  // Raw private evidence never enters the public provider/model pipeline.
  trustedAdapters: [oraCortexBraintiedAdapter],
});

if (result.status !== 'complete') {
  console.warn(result.sourceCoverage.missingModes);
}
```

For an all-public run without private recall, use
`sourceModes: ['all_public']`. The core expansion is web, X, Reddit, YouTube,
GitHub, and community evidence. Paid optional social modes are opt-in.

The provider boundary is intentional: structured APIs perform social
discovery; Bright Data supplies high-fidelity acquisition/backfill where its
dataset contract supports the lane; Apify is the last scraper fallback. Tavily
and SearXNG discover web URLs, while Crawl4AI/Jina/direct HTTP acquire them.

Composable stages are exported individually (`planSubqueries`, `getEnabledProviders`, `rerankQuotes`, `synthesizeAllSections`, `critiqueDraft`, `assembleFinalReport`, `validateGrounding`) for consumers that orchestrate their own pipelines (e.g. cortex-worker keeps Inngest step boundaries).

## Agent skill

The canonical skill is [`skills/run-braintied-research/`](skills/run-braintied-research/).
Its name deliberately differs from the existing Braintied Telegram/Cortex
enrichment-operations skill.

Verify Agent Auth locally, then add `--probe` to confirm the deployed Cortex
catalog exposes `research.run` without calling a model or search provider:

```bash
node skills/run-braintied-research/scripts/run-internal-research.mjs \
  --check \
  --probe \
  --kind standard \
  --max-cost-usd 2.50
```

The internal runner uses Braintied Agent Auth from `BRAINTIED_AGENT_TOKEN` or
macOS Keychain and keeps all model/search provider credentials in Cortex Worker.
Live execution requires the authenticated catalog's durable protocol v2: the
client submits one idempotent request, records the server-owned run ID, and
polls the tenant-bound result. A dropped response or rolling deployment is
retried with the same request ID instead of starting a second paid run. Before
the first submission, the client atomically writes a chmod-0600 checkpoint to
`--metadata` and prints its generated request ID to stderr. After Cortex accepts
the run, that checkpoint also records the durable run ID; terminal success
replaces it with final metadata. Preserve the checkpoint and use
`--request-id <id>` to reattach after a local timeout or interruption.
`run-research.mjs` remains available as an explicit local-provider fallback; it
supports permission-checked, allowlisted dotenv loading, allowlisted
interactive-shell environment loading, and build-freshness checks. Use
`--research-env-file /absolute/path/to/.env` (or the
`BRAINTIED_RESEARCH_ENV_FILE` pointer) when approved credentials live in a
project file; this intentionally replaces or masks stale inherited research
variables without importing unrelated env entries. Never use Node's built-in
`--env-file` for this runner because Node imports every entry before the
allowlist can run; the runner refuses when it detects that preload. Exact lane
preflight requires an as-of date:

```bash
node skills/run-braintied-research/scripts/run-research.mjs \
  --check \
  --kind deep \
  --max-cost-usd 5 \
  --sources all_public \
  --require-providers tavily,x,reddit,youtube,github \
  --as-of 2026-07-21 \
  --load-shell-env
```

This check validates build/configuration and compiles the source plan; it does
not prove credentials are accepted remotely. A live run records source and
profile coverage in metadata and exits non-zero when a required lane is partial.

For a bounded search-only health check with no model, fetch, extraction, or
trusted recall, use `probePublicSourceHealth`. Its default registry permits only
known no-usage-billing adapters; pass the enabled registry explicitly when a
caller has authorized X/Tavily or another metered probe:

```ts
import {
  getEnabledSearchProviders,
  probePublicSourceHealth,
} from '@braintied/research';

const health = await probePublicSourceHealth({
  question: 'long-running agents loops work graphs',
  modes: ['all_public'],
  asOf: '2026-07-21T23:59:59-07:00',
  limit: 4,
  maxPages: 1,
}, {
  providerRegistry: getEnabledSearchProviders(), // explicit metered-call opt-in
});
```

The report contains query hashes, backend names, counts, dates, latency, and
sanitized failure classes—not query text or provider error bodies.

To make this checkout discoverable in Codex without copying or drifting the
skill, link the canonical folder once (fail if a path with that name already
exists; inspect it rather than replacing it):

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$PWD/skills/run-braintied-research" \
  "${CODEX_HOME:-$HOME/.codex}/skills/run-braintied-research"
```

Then invoke it as `$run-braintied-research`. See the skill's `SKILL.md` for
brief classification, mode selection, cost controls, runtime configuration,
and evidence standards. The `skills` directory is included in package releases.

## Consuming

Build a release tgz and reference it (or use a git dependency):

```bash
npm run pack:release          # → releases/braintied-research-<version>.tgz
```

```jsonc
// consumer package.json
"@braintied/research": "file:vendor/braintied-research-0.8.6.tgz"
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm test                 # offline Instagram provider-boundary tests
npm run smoke:searxng   # requires SEARXNG_URLS
```
