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
9. **Ground** — validate citation-to-evidence ratio (diagnostic)
10. **Index (optional)** — hand chunks to an injected `indexSink`

Higher layers (this package):
- **Research kinds** — presets (`quick` / `standard` / `deep` / `managed` / `social`) so callers say *what kind* of research instead of tuning knobs
- **Documents** — `generateDocument({ docType, ... })` renders research into typed structured docs: `prd`, `market-report`, `tech-spec`, `client-brief`, `content-brief`, `estimate-research`

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
| TikTok / Instagram / X / FB Groups | social | Bright Data: `BRIGHTDATA_API_TOKEN` (+ dataset IDs) | paid |
| Perplexity | managed deep research | `PERPLEXITY_API_KEY` | ~$0.40–1.30/query (sonar-deep-research) |

Model/pipeline keys: `ANTHROPIC_API_KEY` (synthesis/critique), `GEMINI_RESEARCH_KEY` or `GEMINI_API_KEY` (planner/extraction), `VOYAGE_API_KEY` (rerank/embed), optional `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`.

> Env naming is standardized here — `SERPAPI_KEY` (not `SERP_API_KEY`), `SERPER_API_KEY`, `SEARXNG_URLS`.

## Usage

```ts
import { runDeepResearch } from '@braintied/research';

const { report, quotes, costUsd } = await runDeepResearch({
  brief: 'Competitive landscape for AI meeting assistants in 2026',
  depth: 'standard',          // or 'wide'
  maxCostUsd: 5,
});
console.log(report.full_markdown);
```

Composable stages are exported individually (`planSubqueries`, `getEnabledProviders`, `rerankQuotes`, `synthesizeAllSections`, `critiqueDraft`, `assembleFinalReport`, `validateGrounding`) for consumers that orchestrate their own pipelines (e.g. cortex-worker keeps Inngest step boundaries).

## Consuming

Build a release tgz and reference it (or use a git dependency):

```bash
npm run pack:release          # → releases/braintied-research-<version>.tgz
```

```jsonc
// consumer package.json
"@braintied/research": "file:vendor/braintied-research-0.2.0.tgz"
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm run smoke:searxng   # requires SEARXNG_URLS
```
