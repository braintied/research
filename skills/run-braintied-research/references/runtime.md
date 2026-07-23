# Braintied research runtime reference

## Preferred internal execution

Braintied agents should use `run-internal-research.mjs`. Model, search, crawl,
and reranking credentials remain inside Cortex Worker; the caller supplies one
agent-bound Agent Auth token that is validated for the `cortex` product.

```bash
node skills/run-braintied-research/scripts/run-internal-research.mjs \
  --check \
  --probe \
  --kind quick \
  --max-cost-usd 0.25
```

The client resolves `BRAINTIED_AGENT_TOKEN` from its inherited environment,
then from macOS Keychain service `braintied-agent-auth`, account `codex`. When
neither token source exists, preflight fails closed with exit status 2.

`--check` is local-only unless `--probe` is supplied. With `--probe`, the runner
makes an authenticated, read-only request to the Cortex Worker tool catalog and
requires it to advertise `research.run`; it does not call a model or search
provider. A live run requires `--allow-external` and writes mode, request ID,
actual cost, bibliography, gaps, and grounding without persisting the token.

Versioned internal profile runs add an exact evidence boundary while keeping
their public and private data planes separate:

```bash
node skills/run-braintied-research/scripts/run-internal-research.mjs \
  --brief-file /tmp/design-brief.md \
  --kind deep \
  --max-cost-usd 5 \
  --profile web-design-intelligence@1 \
  --profile-mode snapshot \
  --as-of 2026-07-22 \
  --output /tmp/design-report.md \
  --metadata /tmp/design-run.json \
  --trusted-output /tmp/design-trusted.json \
  --allow-external
```

The Markdown file is always the public-provider report. Before submission, the
metadata path contains a minimal chmod-0600 recovery checkpoint with the
request ID and no brief, token, or provider content. Cortex acceptance adds the
durable run ID; terminal success atomically replaces that checkpoint with final
metadata. Final metadata adds `program_status`, `source_coverage`,
`profile_coverage`, a pointer to the trusted artifact, and a separately labeled
reference-only `private_manifest`.
The third file is a chmod-0600 trusted-local appendix for the authenticated
agent: up to 20 findings balanced across Cortex and Telegram, each with
credential-scrubbed excerpts capped at 1,200 Unicode characters, bounded
resource URLs, hashes, dates, and source-pack identity. The client strictly
validates that contract before writing it. It allowlists every manifest,
evidence-reference, lineage, coverage, failure, appendix, and finding field
recursively; unknown fields and over-limit values fail before any artifact is
written.

The endpoint accepts raw `sat_` tokens and short-lived exchanged JWTs. Every
tool request requires an agent identity, `cortex` product access, and an
execution-capable scope (`execute`, `write`, `admin`, `master`, or `*`). The
initial registry exposes `research.run`; provider keys are never returned.

Live runs require internal-tools protocol v2. The client POSTs the request once
to the catalog-advertised durable submission path, then polls the advertised
tenant-bound status path until it receives a terminal result. Cortex persists
the validated input before Inngest dispatch, binds idempotency to the complete
organization/user/agent/request identity, and retains results for 24 hours.
Submission retries, temporary `404`/`429`/`5xx` responses, and transport loss
reuse the same request ID. A response lost after persistence therefore
reattaches instead of paying for a second run.

Deep requests default to a 3,600-second local client deadline; other kinds
default to 1,200 seconds. The deadline stops polling, not the server-owned run.
The client fsyncs and atomically renames a private checkpoint, then flushes a
compact request-ID diagnostic to stderr, before it sends the first paid
submission. Preserve the request ID from that checkpoint or diagnostic and
repeat the same invocation with `--request-id <id>` to resume. A
`submission_pending` checkpoint is intentionally ambiguous about remote
acceptance; resubmission with its same ID is idempotent. Accepted and final
metadata record both `request_id` and `durable_run_id`. A successful HTTP
response is not itself success: the client requires the strict completed
result envelope and a non-empty report before it writes final artifacts.

Cortex deployments acquire an atomic database exclusion lease. Lease
acquisition fails while any unexpired research run is queued/running, and new
submissions receive retryable `503` responses while the lease is held. The
lease has a bounded expiry so a killed deploy client cannot pause research
indefinitely.

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

For project-owned dotenv credentials, use the runner's allowlisted loader:

```bash
node skills/run-braintied-research/scripts/run-research.mjs \
  --check \
  --kind standard \
  --max-cost-usd 2 \
  --research-env-file /absolute/path/to/.env.production.local
```

Never use Node's built-in `--env-file` for this runner: Node loads every entry
before the runner starts, bypassing its allowlist; the runner refuses when it
detects that preload. `--research-env-file`
deliberately replaces stale allowlisted values and treats an explicit blank as
a mask that prevents shell fallback. It never imports unrelated dotenv entries.
On POSIX, every supplied file must be a regular non-symlink with owner-only
permissions (0600 or stricter), and it is checked and read through one open file
handle. Secure dotenv loading fails closed on Windows; inject approved process
environment values there instead. `BRAINTIED_RESEARCH_ENV_FILE` may point to the
same approved absolute path so commands work from any workspace; an explicit
`--research-env-file` wins. The pointer contains no secret value, but access to
the target file still controls credential authority.

The allowlisted parser intentionally accepts single-line dotenv assignments
only: optional `export`, unquoted values with `#` comments, and single-, double-,
or backtick-quoted values. Multiline values are rejected. Double-quoted `\\n`
and `\\r` escapes are expanded; other backslashes are preserved.

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

For exact source-mode runs, the local runner also recognizes Reddit OAuth,
YouTube, X, Apify, Bright Data, GitHub, Jina, and Crawl4AI variables in its
explicit shell allowlist. `--sources` and `--profile` require `--as-of`; use
`--require-providers` when a particular backend is part of the decision
contract. `--check` proves only that configuration is present and the source
plan compiles. Only a bounded live query proves that a credential is accepted
and a provider returns eligible current evidence.

Recommended role/order:

- Tavily/SearXNG discover public web URLs; provider raw content or
  Crawl4AI/Jina/direct HTTP acquires them.
- twitterapi.io is the lower-cost primary X search/fetch transport; official X
  v2 is the seven-day fallback, Bright Data enriches known URLs/profiles, and
  Apify is last.
- Native Reddit OAuth and YouTube Data API are the free structured discovery
  paths; Bright Data is the preferred secondary discovery/backfill path;
  Apify is last.
- GitHub REST performs repository/issue/PR discovery; an optional project-owned
  token raises the restrictive unauthenticated quota.

The Gemini resolver accepts `GEMINI_RESEARCH_KEY`, `GOOGLE_GEMINI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, and `GEMINI_API_KEY`. If multiple aliases contain
different values, the shared package resolver fails without printing them.
Direct package consumers must set `BRAINTIED_GEMINI_KEY_NAME=NAME`; the runner
also accepts `--gemini-key-name NAME`. The chosen value becomes the canonical
planning/extraction/synthesis key for that process. Preflight reports only the
selected variable name, and the runner never persists the value.

`VOYAGE_API_KEY` is optional: without it, reranking preserves provider order.
Anthropic is optional for Gemini-backed runs: planner retries lose their Claude
fallback, and critique returns its documented permissive fallback.

Use credentials owned and approved for the project being researched. In Codex
Desktop, `--research-env-file` imports only allowlisted values from the explicit
approved file. `--load-shell-env` then fills unmasked gaps from the interactive
shell and defaults search to Braintied's two SearXNG instances. Neither prints
values. Do not inspect or reuse a neighboring project's environment file merely
because it exists.

## Result contract

Every successful run writes:

- a Markdown report from `result.report.full_markdown`; and
- JSON metadata containing the package version, dates and duration, requested
  kind, actual engine, actual cost, word count, quote count, bibliography,
  reported gaps, and grounding result.
  Pipeline metadata and the completion summary also expose
  `grounding_quality`, `grounding_passed`, and the numeric grounding ratio so
  automation does not confuse “the validator ran” with “the evidence passed.”

Source-mode output also includes `source_plan`, `source_coverage`, and, for a
profile, `profile_coverage`. A run with a missing required lane is written for
audit but exits with status 2 and must be described as partial.

Internal profile metadata additionally contains a trusted-local
`private_manifest` with evidence hashes, source references, lane/source-pack
IDs, lineage, and coverage. It never contains quotes, message bodies, report
Markdown, or other private evidence text. A live profile invocation also
requires a distinct `--trusted-output` path. That restricted JSON artifact is
the consumable authenticated-agent reconciliation surface; it contains only
the bounded and credential-scrubbed findings contract described above and is
created with mode `0600`. It is never embedded in the public Markdown or
metadata.

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

## Trusted source boundary

`cortex` and `telegram` source modes require a caller-injected, tenant-scoped
`ora-cortex-braintied` adapter. The local provider runner intentionally has no
such adapter and fails closed. Trusted evidence is returned as a separate
private manifest plus a separately labeled trusted-local findings appendix.
Neither may be appended to the public planner, search, extraction, reranking,
synthesis, provider payload, or shared cache. The appendix is constructed only
after the public-provider execution has completed and is exposed only by the
Agent Auth-protected tool response; the CLI writes it solely to the explicit
chmod-0600 `--trusted-output` artifact. Tenant identity must come from
authenticated server context rather than request input. Ora binds that identity
from the Agent Auth `workspace_id`; neither the brief nor internal-runner flags
accept an organization override. Telegram recall is further limited to the
authenticated organization’s explicitly registered `braintied-research` corpus
channels.

## Preflight behavior

`--check` and `--dry-run` validate arguments and configuration without making a
research request. The internal runner remains offline by default; add `--probe`
to authenticate against the remote catalog and detect deployment or route
drift. The local-provider runner inspects the built package, lists enabled
providers, and has no remote-catalog probe. A not-ready result exits with status
2 so automation can distinguish configuration failure from a crash. Preflight
echoes `requested_max_cost_usd`; pipeline checks therefore require the same
explicit cap as the intended live run.

Examples:

```bash
node skills/run-braintied-research/scripts/run-research.mjs \
  --check \
  --kind quick \
  --max-cost-usd 0.25 \
  --synthesis-model gemini-3-flash-preview \
  --load-shell-env

node skills/run-braintied-research/scripts/run-research.mjs \
  --check \
  --kind quick \
  --max-cost-usd 0.25 \
  --synthesis-model gemini-3-flash-preview \
  --research-env-file /absolute/path/owned-by-this-project/.env \
  --gemini-key-name GOOGLE_GEMINI_API_KEY

node skills/run-braintied-research/scripts/run-research.mjs \
  --check \
  --kind deep \
  --max-cost-usd 5 \
  --sources all_public \
  --require-providers tavily,x,reddit,youtube,github \
  --as-of 2026-07-21 \
  --load-shell-env
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
