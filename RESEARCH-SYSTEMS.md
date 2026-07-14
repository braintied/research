# RESEARCH-SYSTEMS.md — the canonical registry

**One rule: do not build a new research/search/crawl path.** If you need web research, use `@braintied/research` (this repo). If a surface below is marked *different-purpose*, it is intentionally separate — extend it in place, don't fork a new engine. Anything not listed here that searches/crawls the web is a regression (Momus audit 2026-07-05: "no competing systems" requires this registry + the CI guards to stay true).

Updated: 2026-07-14 (Instagram Bright Data-only provider boundary, v0.6.4).

## The engine

`@braintied/research` — multi-provider search (free-first: searxng $0 → serper free-quota → tavily/exa/serpapi paid, only when free coverage is thin), Crawl4AI→Jina→direct fetch for general web pages (typed Crawl4AI config — the flat shape is silently ignored by 0.8.x), strict Bright Data-only Instagram discovery and post/profile fetch, Gemini quote extraction, Voyage rerank, Claude synthesis + critique loop, globally-renumbered citations + grounded assembly, honest CostTracker (search+extract+rerank+synth all counted; hard cap enforces on the true total), per-stage `onUsage` attribution, `ResearchCacheAdapter`, `indexSink`. Kinds: `quick`/`standard`/`deep`/`managed`(Perplexity, opt-in only)/`social`. Document layer: `prd`, `market-report`, `tech-spec`, `client-brief`, `content-brief`, `estimate-research`.

## Who runs it (consumers of THIS package)

| Surface | How | Notes |
|---|---|---|
| **cortex-worker** (`ora-ai/platform/apps/cortex-worker`) | `src/lib/deep-research/*` are re-export shims over this package; Inngest corpus/prompt runners keep step orchestration + `ora_core` writes + `research_report_chunks` pgvector (local `embedAndIndexChunks`) | Serves Sentigen chat/canvas/entity research via the bridge. Free-first tiering in the search step. CONVERGED 2026-07-05 — do not re-fork the stage modules. |
| **Sentigen** `generate_research_doc` chat tool | `src/lib/tools/research/generate-research-doc.ts` — doc layer over completed Cortex runs; onUsage → `trackAIUsageAsync` | The attribution template for all consumers. |
| **Sentigen scribe** blog research | `src/lib/scribe/agents/deep-research.ts` — one `quick` run per article (was 5× Perplexity sonar-pro) | Converged 2026-07-05. |
| **Swishh app** blog pipeline + knowledge ingestion | `inngest/functions/blog-generation.ts` (grounded engine primary), `lib/knowledge-ingestion/*` (`ingestSource`) | `@swishh/research` deleted 2026-07-05 (`packages/research/` + tgzs + root dep). |
| **`@swishh/blog` package** | dep `@braintied/research ^0.3.1` (v0.2.14+) | External consumers must vendor this package's tgz. |
| **Watchtower** | `prd-generator.ts` (prd doc type) + `research.ts` web source (searxng→serper→tavily first-wins) | Legacy Gemini PRD path kept as fallback. |
| **ora-server agentic-research CLI** (`ora-ai/platform/apps/ora-server/scripts/research/agentic-research.ts`) | Engine providers for search (x/tiktok/instagram/youtube engine-first) + deep extraction (provider `fetch` → Tavily raw content → `crawlUrl`); keeps its own query gen, triage, scoring, `ora_core.research_projects` persistence, HTML feed report, knowledge auto-ingest | CONVERGED 2026-07-07 (was an unregistered parallel engine). Reddit search stays local (Tavily-primary hybrid; the package redditProvider's OAuth search rate-limits to 0 after the first call per session — port the hybrid before switching). |

## Intentionally separate (different-purpose — do NOT consolidate)

| Surface | Why it is different |
|---|---|
| **Sentigen KB-enrichment lane** (`src/lib/deep-research/` + `kb-enrichment-pipeline` Inngest family) | Live production batch engine (~150 jobs/wk, ~$1.80/30d) doing SOP-vertical KB enrichment on the ~$0.002/job composite adapter (Tavily→Crawl4AI→NANO). Perplexity removed from its tier routing 2026-07-05. Migrating it onto package stages is optional future work — its cost is already negligible and its DB contract (`public.research_jobs`) is load-bearing. The user-facing "research agents" surface on top of it was RETIRED 2026-07-05 (0 rows ever). |
| **Sentigen cortex bridge** (`src/lib/cortex/research.ts`) | Deployment topology, not an engine: offloads heavy research to cortex-worker's Fly compute + `ora_core.research_reports` storage, which entity-promotion/canvas/briefing read. The engine behind it IS this package (post-convergence). Do not replace with in-process research. |
| **Sentigen `web-research.ts`** (`src/lib/research/`) | `Result<T>` scrape utility with circuit breaker + title/metadata extraction — a richer single-URL contract than the package's `crawlUrl`. Its typed-Crawl4AI fix was ported INTO the package (v0.3.1). Uses no search APIs. |
| **Sentigen Perplexity one-offs** (`ip-intelligence/deep-web-research.ts`, `entity-intelligence/news-perplexity-client.ts` via `scraping/perplexity-client.ts`) | Need Perplexity's answer-engine grounding specifically (brand clearance, entity news); `perplexity-client.ts` carries the circuit breaker + quota handling + `admin_ai_usage_log` tracking. Already attributed. |
| **cortex-worker advice/content discovery** (`advice-tavily.ts`, `content-tavily.ts`) | Depend on Tavily advanced search `include_raw_content` (pre-extraction snippets that avoid a crawl) + relevance scores for quality filtering — free metasearch provides neither. Revisit only if volume makes the spend material. |
| **cortex-worker domain pipelines** (advice/content/product/legal/writing on `research-pipeline-core.ts`) | Domain orchestration + ora_core writes; their crawl/extract primitives mirror the package and can adopt package stages incrementally (open, low priority). |
| **Lens** (`ora-ai/projects/lens` deep-research) | Bookmark-KB synthesis — starts from user bookmarks, no web search/crawl at all. |
| **Swishh `lib/scrape/`** | Social/public-data ingestion (Bright Data, twitterapi.io, ScrapeCreators, yt-dlp) — influencer discovery, not research. |
| **Swishh `lib/research/`** (legacy SYSTEM 2: Gemini Deep Research + Firecrawl + Jina) | Blog FALLBACK path + engine/video research surfaces. Firecrawl retirement is GATED: instrument the grounded-engine fallback rate; retire when <1% of runs fall back over 7 days. Do not build new features on it. |

## Guards

- Sentigen CI: `scripts/check-research-provider-imports.sh` (in `pnpm run guards`) — bans new direct `api.tavily.com` / `api.perplexity.ai` / firecrawl imports outside the allowlist above.
- Package CI: `.github/workflows/ci.yml` runs locked install, typecheck, the offline Instagram transport boundary, and a package dry-run on every pull request and `main` push. The boundary rejects Apify/Crawl4AI/Jina/browser references in `src/providers/instagram.ts` and verifies strict Bright Data errors plus canonical post/profile URLs.
- This registry is the allowlist's source of truth — update both together.

## Env keys (standardized names)

`SEARXNG_URLS` (CSV; cortex-searxng-a/b/c on Fly, scale-to-zero) · `SERPER_API_KEY` · `TAVILY_API_KEY` · `EXA_API_KEY` · `SERPAPI_KEY` · `CRAWL4AI_URL` (default ora-scraper.fly.dev) · `JINA_API_KEY` (optional general-web fetch fallback) · `TWITTERAPI_IO_KEY` (X primary backend as of v0.5.0; `APIFY_API_TOKEN` remains the X fallback plus TikTok/FB-groups backend) · `BRIGHTDATA_API_TOKEN` (the only Instagram transport; also LinkedIn/FB ingestion and TikTok fetch fallback) · `PERPLEXITY_API_KEY` (managed kind only) · `GEMINI_RESEARCH_KEY`/`GEMINI_API_KEY` (interchangeable as of v0.5.0) · `VOYAGE_API_KEY` · `ANTHROPIC_API_KEY`.

### Instagram provider boundary

The package's `instagram` provider uses Bright Data dataset
`gd_lk5ns7kz21pck8jpis` for hashtag discovery and direct post/reel/tv links,
and `gd_l1vikfch901nx3by4` for one-segment profile links. Results retain the
`provider: instagram` SearchProvider contract and record
`instagram_provider: brightdata` plus the dataset ID in provider metadata.
Instagram failures remain failures; the general web-fetch stack and other
social providers are not eligible recovery paths. This policy is specific to
Instagram and does not change the registered X, TikTok, or Facebook providers.
