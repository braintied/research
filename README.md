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
6. **Synthesize** — Claude section drafts with inline citations, cost-capped
7. **Critique loop** — find gaps, re-plan, re-search, re-synthesize
8. **Assemble** — final report with bibliography
9. **Ground** — validate citation-to-evidence ratio with explicit quality and pass/fail; weak reports receive a visible warning
10. **Index (optional)** — hand chunks to an injected `indexSink`

Higher layers (this package):
- **Research kinds** — presets (`answer` / `quick` / `standard` / `deep` / `managed` / `social`) so callers say *what kind* of research instead of tuning knobs
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
| Crawl4AI (self-hosted) | fetch | `CRAWL4AI_URL` (default `https://ora-scraper.fly.dev`) | $0 |
| Jina Reader | fetch fallback | `JINA_API_KEY` | free tier |
| Reddit | social | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` | free |
| YouTube | video | `YOUTUBE_API_KEY` | free quota |
| Hacker News | forum | (none) | $0 |
| RSS | newsletters | (none) | $0 |
| Podcasts | podcast | `LISTENNOTES_API_KEY` | paid |
| X (Twitter) | social | `TWITTERAPI_IO_KEY` (primary, ~$0.15/1k tweets, datacenter-safe) and/or `APIFY_API_TOKEN` (fallback actor) | cheap |
| TikTok | social | `APIFY_API_TOKEN` (search + comment-rich fetch) and/or `BRIGHTDATA_API_TOKEN` (fetch fallback, ~$1.50/1k records) | paid |
| Instagram | social | `BRIGHTDATA_API_TOKEN` (posts dataset `gd_lk5ns7kz21pck8jpis`; profiles dataset `gd_l1vikfch901nx3by4`) | paid |
| FB Groups | social | `APIFY_API_TOKEN` | paid |
| LinkedIn / FB Groups (ingestion layer) | ingestion | Bright Data: `BRIGHTDATA_API_TOKEN` (+ dataset IDs) | paid |
| Perplexity | managed deep research | `PERPLEXITY_API_KEY` | ~$0.40–1.30/query (sonar-deep-research) |

Model/pipeline keys: `ANTHROPIC_API_KEY` (synthesis/critique), `GEMINI_RESEARCH_KEY` or `GEMINI_API_KEY` (planner/extraction), `VOYAGE_API_KEY` (rerank/embed), optional `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`.

> Env naming is standardized here — `SERPAPI_KEY` (not `SERP_API_KEY`), `SERPER_API_KEY`, `SEARXNG_URLS`.

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

Composable stages are exported individually (`planSubqueries`, `getEnabledProviders`, `rerankQuotes`, `synthesizeAllSections`, `critiqueDraft`, `assembleFinalReport`, `validateGrounding`) for consumers that orchestrate their own pipelines (e.g. cortex-worker keeps Inngest step boundaries).

## Agent skill

The canonical skill is [`skills/run-braintied-research/`](skills/run-braintied-research/).
Its name deliberately differs from the existing Braintied Telegram/Cortex
enrichment-operations skill.

Preflight the package without making a network call:

```bash
node skills/run-braintied-research/scripts/run-internal-research.mjs \
  --check \
  --kind standard \
  --max-cost-usd 2.50
```

The internal runner uses Braintied Agent Auth from `BRAINTIED_AGENT_TOKEN` or
macOS Keychain and keeps all model/search provider credentials in Cortex Worker.
`run-research.mjs` remains available as an explicit local-provider fallback; it
supports allowlisted interactive-shell environment loading and build-freshness
checks.

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
"@braintied/research": "file:vendor/braintied-research-0.6.4.tgz"
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm test                 # offline Instagram provider-boundary tests
npm run smoke:searxng   # requires SEARXNG_URLS
```
