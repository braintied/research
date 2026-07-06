# Evals — the measurement layer (ROADMAP Phase 2)

The rule: **no Phase 3+ improvement ships without moving a number here.** These
scripts turn a research run into a row of deterministic, reproducible metrics so
"better retrieval" / "better grounding" is a diff, not a vibe.

## What's measured

All metrics are computed from the `FinalReport` (+ the F2a grounding verdict)
with **no extra LLM calls** — a sweep re-runs for free and diffs cleanly across
package versions:

| metric | meaning |
|---|---|
| `word_count` | report length |
| `bibliography_count` | distinct cited sources (== runner `citation_count`) |
| `inline_anchors` | `[^N]` marks actually in the markdown |
| `citation_density_per_1k` | anchors per 1,000 words — length-normalized |
| `distinct_source_domains` | unique hostnames cited |
| `distinct_providers` | search providers represented |
| `section_source_dispersion` | fraction of sections with a UNIQUE cited-source set (the F1 fix metric — low = sections sharing evidence) |
| `uncited_sections` | sections that ended up with zero citations |
| `grounding_ratio` / `status` | faithfulness verdict (reference-free trigram; F2a) |
| `cost_usd`, `latency_s` | per run |

LLM-judged quality (RACE-style comprehensiveness/insight) is intentionally NOT
here yet — it costs money per eval and belongs in an opt-in Phase-2b layer.

## Corpus

`golden-briefs.ts` — ~24 briefs across five domains (technical, market,
audience, product, client) matching real consumer usage. **IDs are stable** —
they key the result JSON so baselines diff. Add briefs; never renumber.

## Running

```bash
# Cheap proof run — one brief per domain, cheapest kind (~$0.30-0.50)
pnpm eval:baseline --subset --label proof

# Full sweep at each brief's suggested kind
pnpm eval:baseline --label full-YYYY-MM-DD

# Force a single kind across all briefs
pnpm eval:baseline --kind quick --label all-quick

# One domain / explicit ids / cap
pnpm eval:baseline --domain technical
pnpm eval:baseline --ids tech-01-crawlers,market-03-search-apis

# Fan-out ablation — does the 15-35 band over-spend? (marginal src/$ per band)
pnpm eval:ablation --brief tech-01-crawlers --bands 4x8,8x16,15x35
```

Results land in `evals/results/baseline-<date>-<label>.{json,md}`. The
`.source-cache.json` (gitignored) persists fetched page content between runs so
re-runs reuse fetch+extract spend.

## Env

Same as the smoke script: `SEARXNG_URLS` / `SERPER_API_KEY` / `TAVILY_API_KEY`,
`CRAWL4AI_URL`, `GEMINI_RESEARCH_KEY` or `GEMINI_API_KEY`, `VOYAGE_API_KEY`,
`ANTHROPIC_API_KEY`.
