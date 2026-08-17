# RESEARCH-SYSTEMS.md — the canonical registry

**One rule: do not build a new research/search/crawl path.** If you need web research, use `@braintied/research` (this repo). If a surface below is marked *different-purpose*, it is intentionally separate — extend it in place, don't fork a new engine. Anything not listed here that searches/crawls the web is a regression (Momus audit 2026-07-05: "no competing systems" requires this registry + the CI guards to stay true).

Updated: 2026-08-15 (ops state re-verified: worker at PROFILE=full since 2026-08-05 PM; Telegram/enrichment/briefs live; host-crons off; X lanes on but dry; intelligence loop = recall → decide → run; north star doc linked).

**Companions:**

| Doc | Owns |
|-----|------|
| **North star** | [`UNIFIED-RESEARCH-SYSTEM.md`](https://github.com/braintied/ora-ai/blob/main/docs/research/UNIFIED-RESEARCH-SYSTEM.md) — how hosts, corpus, freeze, and agents connect |
| **Edge map** | [`ASSET-MAP.md`](https://github.com/braintied/ora-ai/blob/main/docs/research/braintied-research/ASSET-MAP.md) — sources → pipelines → stores → consumers |
| **Fleet rule** | `~/.agents/rules/research.md` — always-on agent policy |

This file stays the **one-engine allowlist** for web research/search/crawl.

### Intelligence loop (do not skip)

1. **Recall** the corpus (`research_discoveries` / `research_kb`) via `research-recall` or fleet `research_search`.
2. **Decide** if paid web research is still required.
3. **Run** this package with `kind=quick` default and an explicit `maxCostUsd` when using pipeline kinds.
4. **Store / attribute** through a registered host (`onUsage` → Cortex ledger). Never invent a parallel engine or spend table.

### Production ops state (2026-08-15 PT)

The 2026-08-05 "machines scaled to 0 + Inngest freeze stub" posture was reversed the same day (#375): both took the alerting/healing spine dark. cortex-worker now runs `CORTEX_WORKER_INNGEST_PROFILE=full` (fly.toml [env], which overrides `fly secrets` for these names). Live on schedule: the Telegram poller (`*/15`, mints `braintied-research` discoveries daily), the enrichment dispatcher + enricher, and the morning/lane briefs. Off: research host-cron collectors (`enabled:false` since 2026-08-05), the content pipeline (`CONTENT_PIPELINE_ENABLED=0`), and the improve loop (`IMPROVE_LOOP_DISABLED=1`). On but unproductive: the X lanes (firehose last minted 2026-07-23 — 342 rows that day — and `tweets_found:0` in every gauge since; search last minted 2026-08-01). On-demand package runs via skill remain the intended spend path. See north star for unfreeze checklist. Do not treat the freeze dials as permission to fork a local research stack.

## The engine

`@braintied/research` — multi-provider search (quality-first as of v0.9.0: tavily leads the general categories because `include_raw_content` returns server-side page extraction inline and removes a crawl per hit; searxng $0 and serper free-quota remain the fallback tiers), Crawl4AI→direct fetch for general web pages (typed Crawl4AI config — the flat shape is silently ignored by 0.8.x), Bright Data Instagram discovery and post/profile fetch; Apify for active stories only, Gemini quote extraction, Voyage rerank, Claude synthesis + critique loop, globally-renumbered citations + grounded assembly, honest CostTracker (search+extract+rerank+synth all counted; hard cap enforces on the true total), per-stage `onUsage` attribution, `ResearchCacheAdapter`, `indexSink`. Kinds: `quick`/`standard`/`deep`/`managed`(Perplexity, opt-in only)/`social`. Document layer: `prd`, `market-report`, `tech-spec`, `client-brief`, `content-brief`, `estimate-research`.

**Synthesis liveness (0.6.9, 2026-07-20):** every per-section provider call carries `SYNTHESIS_REQUEST_TIMEOUT_MS` (15 min; SDK-level on Anthropic/OpenAI clients + an explicit `withTimeout` wrap on all three providers incl. Gemini) and raises `SynthesisTimeoutError` on expiry — a wedged provider socket can no longer hang a synthesis step forever (the WS-D incident class: 12/12 runs frozen in `synthesizing`). `synthesizeAllSections` also accepts `onSectionComplete?: (progress: SynthesisSectionProgress) => void`, fired after each section draft; the contract is non-blocking + self-swallowing (a heartbeat failure must never kill synthesis) — cortex-worker uses it to heartbeat `research_prompt_runs.updated_at`, which the `deep-research-stuck-run-sweeper` cron reads to fail wedged runs.

**Decision briefs (1.4.0):** a brief carrying numbered questions under a "questions" heading is
planned per question (fair share of the subquery band, section paths namespaced `q{n}.*`, report
headings derived from the question text), and the extract-page budget is allocated round-robin
across sections instead of FIFO — a whole-brief plan starved every late question to an evidence gap
(measured 2026-08-15). `runResearch` also forwards `subqueryBandOverride` now. Briefs without a
questions section behave exactly as before.

## Who runs it (consumers of THIS package)

| Surface | How | Notes |
|---|---|---|
| **cortex-worker** (`ora-ai/platform/apps/cortex-worker`) | `src/lib/deep-research/*` are re-export shims over this package; Inngest corpus/prompt runners keep step orchestration + `ora_core` writes + `research_report_chunks` pgvector (local `embedAndIndexChunks`) | Serves Sentigen chat/canvas/entity research via the bridge. Free-first tiering in the search step. CONVERGED 2026-07-05 — do not re-fork the stage modules. **Ops state 2026-08-15:** machines running at `PROFILE=full` since the 2026-08-05 PM reversal (#375 — scale-0 and the freeze stub both took alerting dark); Telegram poller + enrichment + briefs live; research host-crons off; X lanes on but minting zero; spend held by `CONTENT_PIPELINE_ENABLED=0` + `IMPROVE_LOOP_DISABLED=1`. |
| **Sentigen** `generate_research_doc` chat tool | `src/lib/tools/research/generate-research-doc.ts` — doc layer over completed Cortex runs; onUsage → `trackAIUsageAsync` | The attribution template for all consumers. |
| **Sentigen scribe** blog research | `src/lib/scribe/agents/deep-research.ts` — one `quick` run per article (was 5× Perplexity sonar-pro) | Converged 2026-07-05. |
| **Swishh app** blog pipeline + knowledge ingestion | `inngest/functions/blog-generation.ts` (grounded engine primary), `lib/knowledge-ingestion/*` (`ingestSource`) | `@swishh/research` deleted 2026-07-05 (`packages/research/` + tgzs + root dep). |
| **`@swishh/blog` package** | dep `@braintied/research ^0.3.1` (v0.2.14+) | External consumers must vendor this package's tgz. |
| **Watchtower** | `prd-generator.ts` (prd doc type) + `research.ts` web source (searxng→serper→tavily first-wins) | Legacy Gemini PRD path kept as fallback. |
| **ora-server research-source collectors** (`ora-ai/platform/apps/ora-server/scripts/research/run-collector.ts` + `collectors/`) | `perplexity-collector.ts` is now the engine web-search collector: free-first `searxngProvider → serperProvider → tavilyProvider` first-wins ladder (converged 2026-07-17 — it previously called api.perplexity.ai directly and sat dark whenever the separate Perplexity account was quota'd; source_type stays `perplexity` so `ora_core.research_sources` rows are untouched) | Host-cron jobs (`research-all-due-collector`, reddit/HN, enrichers, signal/brief chains) **disabled 2026-08-05** for cost freeze; they minted until that day. Re-enable only with operator unfreeze. Separately, the `agent-reddit` / `agent-hackernews` / `agent-perplexity` curation channels died **2026-04-01** — never diagnosed, and no writer for those channel values exists in the current tree. REMAINING DRIFT (open, incremental): `tavily-collector.ts`, `web-collector.ts`/`crawl4ai-client.ts`, `reddit-collector.ts` still call providers directly — port onto package providers next; extend in place, do not fork. |
| **ora-server agentic-research CLI** (`ora-ai/platform/apps/ora-server/scripts/research/agentic-research.ts`) | Engine providers for search (x/tiktok/instagram/youtube engine-first) + deep extraction (provider `fetch` → Tavily raw content → `crawlUrl`); keeps its own query gen, triage, scoring, `ora_core.research_projects` persistence, HTML feed report, knowledge auto-ingest | CONVERGED 2026-07-07 (was an unregistered parallel engine). Reddit search stays local (Tavily-primary hybrid; the package redditProvider's OAuth search rate-limits to 0 after the first call per session — port the hybrid before switching). |

## Intentionally separate (different-purpose — do NOT consolidate)

| Surface | Why it is different |
|---|---|
| **Sentigen KB-enrichment lane** (`src/lib/deep-research/` + `kb-enrichment-pipeline` Inngest family) | Live production batch engine (~150 jobs/wk, ~$1.80/30d) doing SOP-vertical KB enrichment on the ~$0.002/job composite adapter (Tavily→Crawl4AI→NANO). Perplexity removed from its tier routing 2026-07-05. Migrating it onto package stages is optional future work — its cost is already negligible and its DB contract (`public.research_jobs`) is load-bearing. The user-facing "research agents" surface on top of it was RETIRED 2026-07-05 (0 rows ever). |
| **Sentigen cortex bridge** (`src/lib/cortex/research.ts`) | Deployment topology, not an engine: offloads heavy research to cortex-worker's Fly compute + `ora_core.research_reports` storage, which entity-promotion/canvas/briefing read. The engine behind it IS this package (post-convergence). Do not replace with in-process research. |
| **Sentigen `web-research.ts`** (`src/lib/research/`) | `Result<T>` scrape utility with circuit breaker + title/metadata extraction — a richer single-URL contract than the package's `crawlUrl`. Its typed-Crawl4AI fix was ported INTO the package (v0.3.1). Uses no search APIs. |
| **Sentigen Perplexity one-offs** (`ip-intelligence/deep-web-research.ts`, `entity-intelligence/news-perplexity-client.ts` via `scraping/perplexity-client.ts`) | Need Perplexity's answer-engine grounding specifically (brand clearance, entity news); `perplexity-client.ts` carries the circuit breaker + quota handling + `admin_ai_usage_log` tracking. Already attributed. |
| **cortex-worker advice/content discovery** (`advice-tavily.ts`, `content-tavily.ts`) | Depend on Tavily advanced search `include_raw_content` (pre-extraction snippets that avoid a crawl) + relevance scores for quality filtering — free metasearch provides neither. Revisit only if volume makes the spend material. |
| **cortex-worker domain pipelines** (advice/content/product/legal/writing on `research-pipeline-core.ts`) | Domain orchestration + ora_core writes; their crawl/extract primitives mirror the package and can adopt package stages incrementally (open, low priority). **2026-07-19 revival in flight:** these pipelines went stale Apr–May 2026 (last KB writes 2026-04-02→2026-05-22). The revival approach is corpus-seeded backfill `<domain>/research.start` events that re-feed the EXISTING corpus through the pipelines — deliberately no re-crawl of seed sources — plus `CONTENT_PIPELINE_ENABLED=1` for the content pipeline, which is additionally feature-gated (`content-research-pipeline.ts`). |
| **Lens** (`ora-ai/projects/lens` deep-research) | Bookmark-KB synthesis — starts from user bookmarks, no web search/crawl at all. |
| **Swishh `lib/scrape/`** | Social/public-data ingestion (Bright Data, twitterapi.io, ScrapeCreators, yt-dlp) — influencer discovery, not research. |
| **Swishh `lib/research/`** (legacy SYSTEM 2: Gemini Deep Research + Firecrawl + Jina) | Blog FALLBACK path + engine/video research surfaces. Firecrawl retirement is GATED: instrument the grounded-engine fallback rate; retire when <1% of runs fall back over 7 days. Do not build new features on it. |

## Guards

- Sentigen CI: `scripts/check-research-provider-imports.sh` (in `pnpm run guards`) — bans new direct `api.tavily.com` / `api.perplexity.ai` / firecrawl imports outside the allowlist above.
- Package CI: `.github/workflows/ci.yml` runs locked install, typecheck, the offline Instagram transport boundary, and a package dry-run on every pull request and `main` push. The offline Instagram boundary tests keep posts/profiles on Bright Data, allow Apify only for stories (`datavoyantlab/advanced-instagram-stories-scraper`), and still reject Crawl4AI/Jina/browser recovery paths.
- This registry is the allowlist's source of truth — update both together.

## Env keys (standardized names)

`SEARXNG_URLS` (CSV; cortex-searxng-a/b/c on Fly, scale-to-zero) · `SERPER_API_KEY` · `TAVILY_API_KEY` · `EXA_API_KEY` · `SERPAPI_KEY` · `CRAWL4AI_URL` (default ora-scraper.fly.dev) · `TWITTERAPI_IO_KEY` (X primary backend as of v0.5.0; `APIFY_API_TOKEN` remains the X fallback plus TikTok/FB-groups backend) · `BRIGHTDATA_API_TOKEN` (Instagram posts/profiles/hashtags; also LinkedIn/FB ingestion and TikTok fetch); `APIFY_API_TOKEN` (Instagram stories primary + other social fallbacks) · `PERPLEXITY_API_KEY` (managed kind only) · `GEMINI_RESEARCH_KEY`/`GEMINI_API_KEY` (interchangeable as of v0.5.0) · `VOYAGE_API_KEY` · `ANTHROPIC_API_KEY`.

### Instagram provider boundary

The package's `instagram` provider uses Bright Data dataset
`gd_lk5ns7kz21pck8jpis` for hashtag discovery and direct post/reel/tv links,
and `gd_l1vikfch901nx3by4` for one-segment profile links. Active stories use Apify actor `datavoyantlab/advanced-instagram-stories-scraper` (not Bright Data). Results retain the
`provider: instagram` SearchProvider contract and record
`instagram_provider: brightdata` plus the dataset ID in provider metadata.
Instagram failures remain failures; the general web-fetch stack and other
social providers are not eligible recovery paths. This policy is specific to
Instagram and does not change the registered X, TikTok, or Facebook providers.
