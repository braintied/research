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
| **1 — Correctness** | F1 provenance + P0 runner swap + F8 planner cost + F2a (return grounding in result) | S–M | Bugs first; F1 unblocks every quality metric; P0 is a drop-in |
| **2 — Measurement** | Eval harness + baseline grounding/cost per consumer + fan-out ablation (15–35 may be over-spend) | M | Can't defend improvements without it |
| **3 — Trust** | F2b entailment verification + F4 credibility/diversity/recency + F7 concurrency pool | M | The visible-quality tier jump |
| **4 — Intelligence** | F3 content-aware refinement + one-hop entity following + P2 semantic memory + F9 partial re-synthesis | M–L | The "agentic" tier jump + big cost cut |
| **5 — Polish** | F6 outline + F5 contradictions + streaming onProgress + PDF lane | M | Report craft + UX |

## Buy-don't-build / hype flags (Metis, frontier-surveyed)
- **Keep Perplexity managed kind** for fresh+citation-critical one-shots (~90% citation accuracy, $0.40) — don't out-build it there.
- **Exa Websets** if/when Sentigen needs verified structured entity lists — different capability, not a search replacement.
- **DO NOT build**: supervisor multi-agent (15× tokens; token count explains 80% of lift), multi-agent debate (degenerates to conformance), learned/dense-only retrievers (BM25 beats dense on names/dates; hybrid later optional), bigger fan-out (three triangulates — current band is a cost-AUDIT target).

## Open questions (answer during Phase 2)
Freshness TTL per consumer; cross-org memory reuse (default: NO); reference-free vs reference-based evals; ANN index status on research_report_chunks; is wide mode ever used in prod (F7/F9 severity scales with it).
