# Braintied research runtime reference

## Preferred internal execution

Braintied agents should use `run-internal-research.mjs`. Model, search, crawl,
and reranking credentials remain inside Cortex Worker; the caller supplies one
agent-bound Agent Auth token that is validated for the `cortex` product.

```bash
node skills/run-braintied-research/scripts/run-internal-research.mjs \
  --check \
  --kind quick \
  --max-cost-usd 0.25
```

The client resolves `BRAINTIED_AGENT_TOKEN` from its inherited environment,
then from macOS Keychain service `braintied-agent-auth`, account `codex`. When
neither token source exists, preflight fails closed with exit status 2.

`--check` is local-only: it does not call Agent Auth, Cortex Worker, or a model
provider. A live run requires `--allow-external` and writes mode, request ID,
actual cost, bibliography, gaps, and grounding without persisting the token.

The endpoint accepts raw `sat_` tokens and short-lived exchanged JWTs. Every
tool request requires an agent identity, `cortex` product access, and an
execution-capable scope (`execute`, `write`, `admin`, `master`, or `*`). The
initial registry exposes `research.run`; provider keys are never returned.

## Local provider fallback: package and build

The local fallback lives with the canonical `@braintied/research` source package.
`run-research.mjs` imports `dist/index.mjs`, so build the current checkout before
a local-provider live run:

```bash
npm run build
```

The runner refuses a requested kind that is absent from the built export and,
in a source checkout, marks the preflight not ready when `src/**/*.ts`,
`tsup.config.ts`, or `tsconfig.json` is newer than `dist/index.mjs`. This catches
the common case where source supports newer behavior but ignored `dist/` still
contains an older build. Published packages intentionally omit source and report
freshness as unavailable; built-kind and export checks still apply there.

## Local fallback credential matrix

The runner reports only whether a variable is present. Never print, echo, or
paste the value into a brief or log.

| Kind | Required runtime configuration |
|---|---|
| `answer` | Gemini key; at least one enabled general search provider |
| `quick` | Gemini key; at least one enabled general search provider |
| `standard`, `deep` | Gemini key for planning/extraction; the credential required by the selected synthesis model; at least one enabled general search provider |
| `social` | Standard pipeline keys plus the appropriate social-source credentials |
| `managed` | `PERPLEXITY_API_KEY` |

General search providers are enabled by one of `SEARXNG_URLS`,
`SERPER_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, or `SERPAPI_KEY`. Specialist
providers use the variables documented in the package README.

For compatibility, the runner maps `GEMINI_RESEARCH_KEY` to `GEMINI_API_KEY`
inside its child process when the latter is absent. It never persists the alias.

`VOYAGE_API_KEY` is optional: without it, reranking preserves provider order.
Anthropic is optional for Gemini-backed runs: planner retries lose their Claude
fallback, and critique returns its documented permissive fallback.

Use credentials owned and approved for the project being researched. In Codex
Desktop, `--load-shell-env` imports only allowlisted provider variables and
defaults search to Braintied's two SearXNG instances. It never prints values.
Do not inspect or reuse a neighboring project's environment file merely because
it exists.

## Result contract

Every successful run writes:

- a Markdown report from `result.report.full_markdown`; and
- JSON metadata containing the package version, dates and duration, requested
  kind, actual engine, actual cost, word count, quote count, bibliography,
  reported gaps, and grounding result.
  Pipeline metadata and the completion summary also expose
  `grounding_quality`, `grounding_passed`, and the numeric grounding ratio so
  automation does not confuse “the validator ran” with “the evidence passed.”

The runner prints only a compact, non-secret completion summary to stdout.

`grounding: null` is expected for `answer` and `managed`, because those engines
do not expose the pipeline's quote-level evidence. It does not mean the report
was independently verified. For pipeline kinds, grounding is a citation-to-
evidence diagnostic and may still miss false or stale source claims.
A weak or ungrounded pipeline result is still written for auditability, but it
is marked with a visible evidence warning and must be treated as unverified.
The default pass threshold is 60%; 80% or higher is classified as strong.


`maxCostUsd` is enforced only by pipeline kinds (`quick`, `standard`, `deep`,
and `social`). The runner rejects that option for `answer` and provider-managed
research so a caller cannot mistake it for a hard cap.

## Preflight behavior

`--check` and `--dry-run` are offline aliases. They validate arguments, inspect
the built package, list enabled provider names, and report missing required
configuration without making a research request. A not-ready result exits with
status 2 so automation can distinguish configuration failure from a crash. The
preflight echoes `requested_max_cost_usd`; pipeline checks therefore require the
same explicit cap as the intended live run.

Examples:

```bash
node skills/run-braintied-research/scripts/run-research.mjs \
  --check \
  --kind quick \
  --max-cost-usd 0.25 \
  --synthesis-model gemini-3-flash-preview \
  --load-shell-env

node --env-file=/path/owned-by-this-project/.env \
  skills/run-braintied-research/scripts/run-research.mjs \
  --check \
  --kind quick \
  --max-cost-usd 0.25 \
  --synthesis-model gemini-3-flash-preview
```

## Research brief template

```markdown
# Decision

State the exact decision this research should inform.

## Questions

1. List answerable questions.
2. Separate public facts from private or negotiated terms.

## Requirements

- Geography and effective date
- Must-have capabilities
- Forecast or comparison assumptions
- Required primary sources
- Explicit exclusions

## Output

Ask for an executive answer, evidence table, unknowns, alternatives, and a
recommended next action.
```

## Known boundaries

- The package is an evidence-gathering and synthesis engine, not a contract,
  legal opinion, financial opinion, or source of hidden vendor pricing.
- Search-provider availability and model routing depend on current environment
  variables and package version.
- Provider citations can become stale or disappear; record the research date.
- A successful process exit does not waive the need to inspect sources.
- When preflight blocks a live run, incurred cost is `$0.00`; no engine
  `cost_usd` or grounding result exists for that non-run.
