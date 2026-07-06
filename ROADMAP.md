# ROADMAP — from "solid internal tool" to best-possible (Momus+Metis audit, 2026-07-05)

**Momus verdict: REVISE** — well-engineered plumbing around a research loop that is the "naive pipeline" mid-2026 SOTA has moved past. One tier below commercial deep-research (OpenAI/Gemini DR, Perplexity). **Metis**: the 20% that gets 80% = runner citation fix + semantic memory + entailment verification + evals + streaming. Both audits verified against source; F1/F2/F8 confirmed by direct read.

## Dimension scores (vs best-possible mid-2026)

| Dimension | Score | Highest-leverage fix |
|---|---|---|
| Retrieval | 3/10 | F1 provenance bucketing |
| Agentic adaptivity | 3/10 | F3 content-aware refinement |
| Grounding | 2/10 | F2 return+gate+entailment |
| Synthesis | 4/10 | F6 outline + F5 contradictions |
| Cost | 6/10 | F8 planner spend + F9 partial re-synthesis |
| Speed | 5/10 | F7 bounded concurrency |
| Evals | 1/10 | golden-brief harness |
| UX/streaming | 3/10 | onProgress + surface grounding |

Strengths to keep: 16-provider breadth incl. social (commercial tools lack this), free-first tiering, honest cost core, global citation renumbering, fail-soft posture.

## Findings register

### BLOCKERS (structurally cap quality)
- **F1 — evidence bucketed by PROVIDER IDENTITY, not retrieving subquery** (`src/index.ts:911-923`). `sectionToUrls` assigns each section the first N urls from the GLOBAL deduped list whose provider matches — two sections routed to searxng get the SAME urls; later sections inherit earlier sections' sources. `SearchResult` carries no subquery/section provenance (dropped at dedup). Every downstream stage (rerank, synthesis, citations, grounding) operates on mis-assigned evidence. **Fix first — unblocks everything.**
- **F2 — grounding computed then DISCARDED** (`src/index.ts:641-649` vs `RunDeepResearchResult:341-345`). Callers can't see ratio/hallucinated/ungrounded. Also the trigram metric punishes faithful paraphrase (synthesis prompt says "flowing paragraphs") and rewards copy-paste. Fix: return it, gate on it (flag/re-synthesize weak sections), add claim-level entailment (NLI-first cheap model, LLM-judge on the 0.3–0.6 ambiguous band only, ≤$0.02/report).
- **F3 — critique loop is CORPUS-BLIND**. Refinement re-plans from brief + one-line hint (`serializeCritiqueHint`); retrieved content never re-enters planning. Fix: feed compressed retrieved-digest + covered/missing state into refinement; per-subquery reformulation; ONE bounded entity-following hop (depth 1 standard / 2 wide, same hardCap). NOT full ReAct/multi-agent (15× tokens, hype — see below).
- **P0 (Metis) — cortex runner synthesis is a STALE PRE-CITATION copy.** The runner imports its local harvested `synthesis.js` which predates quote injection — zero inline citations in every cortex report (July-3 baseline identical). Wave-1 convergence shimmed the module files, but the runner path exercised does not inject quotes. Drop-in swap to package `synthesizeAllSections`/`assembleFinalReport`; acceptance: grounding ratio > 0 on a real corpus run.

### MAJOR
- **F4** — no credibility/diversity/recency layer: `published_at` and engagement captured, never used; `recency_days` never passed; no per-domain cap (content-farm risk = Anthropic's documented #1 failure). Fix: domain cap 2–3/root + domain tiers + recency half-life by query temporal type, before rerank.
- **F5** — no contradiction handling/triangulation: conflicting sources silently merged. Fix: agreement pass pre-synthesis; surface contested claims per-side.
- **F6** — no outline curation: sections = planner buckets, written in isolation, stapled. Fix: outline-curation step between plan and synthesis; coherence pass.
- **F7** — unbounded concurrency: Promise.all over ≤400 fetches / all extractions / all searches; DOMAIN_DELAY_MS defined never used. Wide mode = 429 storm vs own scraper. Fix: pool 8–12 + per-domain delay.
- **F8** — planner LLM spend never recorded ('plan' category is dead code) — cap undercounts, worst at wide (8 re-plans).
- **F9** — critique pass re-synthesizes ALL sections and adds full 15–35 band (docs claim 10–15). Fix: changed-sections-only + smaller refinement band.
- **P2 (Metis) — semantic research memory is FREE**: `ora_core.research_report_chunks` already has Voyage embeddings + fts + chunk_kind + RLS. One query-time kNN read (tenant-scoped, freshness-gated: fast 3d / slow 30d / stable ∞; reuse only quote/source_summary kinds as evidence; sim ≥0.82; <3 hits → live web exactly like free-first fallthrough). Prereq: verify ANN index. Big cost/speed win on repeat topics.
- **Evals** — 20–40 Braintied golden briefs tagged by temporal type; reference-free RACE-style 4-dim LLM-judge + FACT citation accuracy; nightly, ≥10% regression alerts. Without this nothing above is measurable.

### MINOR
Near-dup content not deduped (only canonical URL); evidence-empty sections still get a synthesis call; hallucinated-anchor strip is silent (uncited sentence remains); no PDF/academic lane; no table extraction; no injection defense on fetched pages; DeepSeek promo branch dead (expired).

## Execution order (dependency-correct, solo-dev sized)

| Phase | Items | Effort | Why this order |
|---|---|---|---|
| **1 — Correctness** ✅ SHIPPED 2026-07-06 (v0.4.0 + cortex-worker v346) | F1 provenance + P0 runner swap + F8 planner cost + F2a (return grounding in result) | S–M | Bugs first; F1 unblocks every quality metric; P0 is a drop-in |

### Phase 1 execution notes (2026-07-06)
- **F1** — `SearchResult.retrieved_for[]` (tagged per-subquery at search, MERGED at dedup); `extractQuotes` buckets by provenance with legacy provider fallback for untagged callers; also fixed the per-subquery map overwrite (only a section's last subquery counted). Live quick run: 4 sections → 3 distinct source sets (pre-fix: identical). Package `c92d039`.
- **P0 correction** — the runner already consumed package synthesis via the Wave-2 shims; the zero-citation reports were the runner's OWN F1-pattern bucketing (its `sectionToUrls` + a dead `urlToSectionPaths` map that assigned every url to every section) starving `quotesBySection`. Fixed symmetrically in `deep-research-prompt-runner.ts` (ora-ai `5051daf8`).
- **F8** — `planSubqueries` reports per-call token usage (Gemini `usageMetadata` + Claude `usage`) via `usageSink`; recorded under the previously-dead `'plan'` category. Live: `plan: 2ev` in onUsage.
- **F2a** — `grounding` now on `RunDeepResearchResult` + `KindResearchResult` (null for managed).
- **NEW DEFECT found during P0** (fold into Phase 4 / F3+F9): the runner's retry pass SEARCHES for new results but never fetches/extracts them — retry synthesis reuses the old evidence pool, so retry-search spend is pure waste. Documented in-code.
- **Replay proof** (run `012397f6`, worker v346, convergence-smoke): **citation_count 5 / 11 inline anchors vs 0 on both baselines** — first cited cortex report ever. 1,167 words, 41 sources, $0.048. Grounding ratio 0 on this run is the Phase 3 gap by construction (paraphrase prose vs strict 0.6 trigram; only 4 of 152 quote chunks belong to the 5 cited urls) — the package smoke run scores 0.25. Phase 2 evals must baseline grounding per kind before Phase 3 tunes it.
- **NEW DEFECT #2 (FIXED same day)**: runner persisted grounding to `research_reports.metadata` — column never existed; UPDATE failed every run, swallowed by `.catch(() => undefined)`. Column added to Cortex prod + catch now logs (ora-ai `f5b19c65`).
| **2 — Measurement** 🟡 HARNESS SHIPPED 2026-07-06 (`evals/`) | Eval harness + baseline grounding/cost per consumer + fan-out ablation (15–35 may be over-spend) | M | Can't defend improvements without it |
| **3 — Trust** | F2b entailment verification + F4 credibility/diversity/recency + F7 concurrency pool | M | The visible-quality tier jump |
| **4 — Intelligence** | F3 content-aware refinement + one-hop entity following + P2 semantic memory + F9 partial re-synthesis | M–L | The "agentic" tier jump + big cost cut |
| **5 — Polish** | F6 outline + F5 contradictions + streaming onProgress + PDF lane | M | Report craft + UX |

### Phase 2 execution notes (2026-07-06) — harness built + first real numbers
- **Harness** (`evals/`, `pnpm eval:baseline` / `eval:ablation`): 24-brief stable-ID golden corpus (5 domains), deterministic $0 metrics extractor (grounding/cost/latency/citation-density/source-diversity + `section_source_dispersion` = the F1 metric), cache-aware baseline runner, fan-out ablation. Additive package change: `subqueryBandOverride` on `runDeepResearch`. Unit tests 16/16.
- **Baseline proof** (5-brief subset, real, $0.51): **`section_source_dispersion = 1.0` on every brief** — end-to-end confirmation F1 works (no two sections share an identical cited-source set). Grounding **0.25 mean** (0.17–0.50) — the reference-free trigram matcher is the measured bottleneck (Phase 3 target). Cost/latency: quick ≈ $0.045/130s, social ≈ $0.33/480s (7× cost). ~1.4 sections/report still uncited (Phase 4 target).
- **Fan-out ablation** (tech-01, standard depth, warm cache, **n=1 — directional only**): the narrowest band **4×8 was the WORST on every axis** ($0.336, 394s, ground 0.22, but 18 bib) — a thin initial plan makes the critique loop re-plan a full extra band (F9), exploding cost onto lower-quality sources. **8×16 is the cost sweet spot** ($0.097, 161s, ground 0.58, 12 bib); **15×35** (default) grounds best (0.67) but costs slightly more than 8×16 for fewer sources. **Verdict: the ROADMAP "15–35 over-spends" hypothesis is directionally right vs 8×16, but "shrink the band" BACKFIRES — the real cost lever is fixing F9 (critique re-synthesis), not the band.** This ablation is independent evidence to promote F9. Needs a multi-brief × multi-seed confirmation run before any default change.
- **OPEN**: multi-brief/multi-seed confirmation (variance); per-consumer baselines (Sentigen/Watchtower); LLM-judged RACE layer (opt-in, paid).

## Buy-don't-build / hype flags (Metis, frontier-surveyed)
- **Keep Perplexity managed kind** for fresh+citation-critical one-shots (~90% citation accuracy, $0.40) — don't out-build it there.
- **Exa Websets** if/when Sentigen needs verified structured entity lists — different capability, not a search replacement.
- **DO NOT build**: supervisor multi-agent (15× tokens; token count explains 80% of lift), multi-agent debate (degenerates to conformance), learned/dense-only retrievers (BM25 beats dense on names/dates; hybrid later optional), bigger fan-out (three triangulates — current band is a cost-AUDIT target).

## Open questions (answer during Phase 2)
Freshness TTL per consumer; cross-org memory reuse (default: NO); reference-free vs reference-based evals; ANN index status on research_report_chunks; is wide mode ever used in prod (F7/F9 severity scales with it).
