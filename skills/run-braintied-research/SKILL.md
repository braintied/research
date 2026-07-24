---
name: run-braintied-research
description: Run Braintied's @braintied/research engine for fresh cited web research, pricing verification, vendor comparisons, competitive intelligence, market research, grounded decision briefs, and authenticated profile recall from Ora Cortex or the Braintied Telegram corpus. Use when asked to research current facts, verify claims, compare alternatives, or produce source-backed reports. Do not use the local-provider fallback for private corpora or use this skill for enrichment-pipeline operations.
---

# Run Braintied Research

Use the package-owned runner to turn a written brief into a cited report plus
machine-readable run metadata. The engine calls external search, crawl, and
model providers; treat every brief as outbound data.

## Required workflow

1. **Classify the brief before running anything.** Remove secrets, personal
   data, customer data, private financial details, unreleased deal terms, and
   proprietary source text. Replace sensitive specifics with neutral
   placeholders. Never use another project or company's credentials without
   explicit authorization from the credential owner.
2. **Choose the smallest adequate kind, explicit source modes, and a budget.**
   Kind controls depth/cost; source mode controls which evidence lanes must
   actually execute. Pipeline kinds require `--max-cost-usd`; `answer` and
   `managed` do not honor that cap and must be chosen deliberately.
3. **Write a brief file.** Prefer a file over shell-embedded text so quoting is
   deterministic and the exact outbound prompt can be reviewed.
4. **Preflight in two layers.** First verify local Agent Auth availability from
   the package root without a network call:

   ```bash
   node skills/run-braintied-research/scripts/run-internal-research.mjs \
     --check \
     --kind <selected-kind> \
     --max-cost-usd <approved-cap>
   ```

   Omit `--max-cost-usd` only for `answer` or `managed`, where the runner rejects
   the option because the engine cannot enforce it.
   The check reports only whether Agent Auth is available and where it was
   resolved (inherited `BRAINTIED_AGENT_TOKEN` or the configured macOS Keychain
   item). It never prints the token. Model and search credentials stay inside the
   Cortex Worker; agents must not copy those provider keys into local shells.
   Agent Auth is the default internal path; local provider auth is a fallback.

   Then verify that the authenticated production catalog actually advertises
   `research.run` before a live request. This makes one read-only network call
   to Cortex Worker and never calls a model or search provider:

   ```bash
   node skills/run-braintied-research/scripts/run-internal-research.mjs \
     --check \
     --probe \
     --kind <selected-kind> \
     --max-cost-usd <approved-cap>
   ```

   A token-presence check alone is not deployment health. Do not continue on a
   missing route, failed authentication, or a catalog that lacks durable
   protocol v2 submission/status endpoints for `research.run`.

5. **Run only after the outbound brief, credentials, and remote catalog are authorized.** Pass
   `--allow-external`, an explicit report path, and a metadata path:

   ```bash
   node skills/run-braintied-research/scripts/run-internal-research.mjs \
     --brief-file /tmp/research-brief.md \
     --kind deep \
     --max-cost-usd 5 \
     --profile web-design-intelligence@1 \
     --profile-mode snapshot \
     --as-of 2026-07-22 \
     --output /tmp/research-report.md \
     --metadata /tmp/research-run.json \
     --trusted-output /tmp/research-trusted.json \
     --allow-external
   ```

   The server persists the authenticated input before dispatch and returns a
   durable run ID. Before the first submission, the client atomically writes a
   chmod-0600 checkpoint to `--metadata` and prints the generated request ID to
   stderr. Once Cortex accepts the run, the same checkpoint also records the
   durable run ID; terminal success replaces it with final metadata. Submission
   and status requests retry bounded transport and temporary-service failures
   with the same request ID. If the local deadline or process interrupts the
   client, preserve that checkpoint and rerun the identical command with its
   printed `--request-id <id>` to reattach; never choose a fresh ID for the same
   paid attempt. Cortex deploys atomically exclude queued/running research, so a
   normal rolling release cannot cut a paid run in half.

   Use `run-research.mjs` only as an explicitly authorized local fallback when
   the internal service is unavailable. That fallback requires package build
   freshness plus its own provider credentials. When approved credentials live
   in a project dotenv file, prefer the runner's
   `--research-env-file /absolute/path/to/.env` option. Never use Node's built-in
   `--env-file`: Node imports every entry before the runner's allowlist executes,
   and the runner refuses when it detects that preload.
   The runner imports only its documented allowlist, requires every supplied
   file to be a private regular non-symlink on supported POSIX systems, and
   treats blank assignments as explicit masks for inherited values.
   `BRAINTIED_RESEARCH_ENV_FILE` may point to that approved path so the command
   works from any workspace; an explicit `--research-env-file` wins.
   `--load-shell-env` imports the same allowlist from the interactive shell,
   can discover that pointer, and never imports Agent Auth. For multichannel
   research, preflight exact lanes and an exact upper boundary:

   ```bash
   node skills/run-braintied-research/scripts/run-research.mjs \
     --check \
     --kind deep \
     --max-cost-usd 5 \
     --sources web,x,reddit,youtube,github,community \
     --require-providers tavily,x,reddit,youtube,github \
     --as-of 2026-07-21 \
     --load-shell-env
   ```

   Configuration preflight is not provider health. A live run must retain its
   `source_coverage` result, and a missing required lane must be delivered as
   partial rather than described as exhaustive.

6. **Audit the output.** Read `grounding`, `bibliography_count`, `gaps`, actual
   `cost_usd`, and the report itself. Grounding is diagnostic, not proof that a
   claim is true. Independently verify decision-critical claims against primary
   sources.
   For an authenticated profile run, inspect the separate chmod-0600
   `--trusted-output` artifact as trusted-local evidence. Its bounded,
   credential-scrubbed excerpts and resource URLs may inform the authenticated
   task, but must not be copied into the public report, a public-provider
   follow-up prompt, shared cache, or log. The client recursively allowlists the
   reference-only manifest and trusted appendix schemas before writing; an
   unknown field is a boundary failure.
   Treat `grounding.passed: false`, `grounding_quality: weak`, or
   `grounding_quality: ungrounded` as an explicit verification failure; do not
   present those reports as source-verified even if the execution succeeded.
   Treat prose explicitly labeled `Editorial synthesis — inference, not
   source-validated` as analysis, never as a supported source claim. Profile
   coverage counts only fetched, exact evidence; search snippets cannot satisfy
   a required lane.
7. **Deliver with provenance.** State the research date, kind, engine, actual
   cost, grounding status, known gaps, and which important claims remain
   unverified. For source-mode runs, also state requested modes, per-lane
   coverage, exact as-of boundary, and backend failures. Link sources near the
   claims they support.

## Choose a research kind

| Kind | Use it for | Budget behavior |
|---|---|---|
| `answer` | One narrow current-fact lookup | Very cheap single-pass answer; `maxCostUsd` is not enforced; grounding is `null` |
| `quick` | Fast orientation or a small comparison | Pipeline; always set a small explicit cap |
| `standard` | Pricing, vendor, market, and competitor decision briefs | Default pipeline; always set an explicit cap |
| `deep` | High-stakes diligence needing broad coverage and critique | Wide pipeline; use only with an approved larger cap |
| `managed` | Explicitly requested hosted Perplexity deep research | Provider-managed; no quote-level grounding and no pipeline cap |
| `social` | Audience voice, community sentiment, and verbatim language | Pipeline focused on social sources; always set a cap |

Do not select `managed` merely because it is convenient. For contractual
pricing or procurement, `standard` plus direct primary-source verification is
usually the right starting point.

## Choose source modes

Source modes are independent of research kind:

| Mode | Required evidence | Default discovery policy |
|---|---|---|
| `web` | Public docs, articles, news | Tavily/SearXNG; Crawl4AI only acquires discovered URLs |
| `x` | Direct posts/threads | twitterapi.io primary; official X v2 fallback; Bright Data known-URL/profile enrichment; Apify last |
| `reddit` | Threads and comments | Free native OAuth; Bright Data backfill; Apify last |
| `youtube` | Videos, transcripts, comments | Free native Data API/transcript path; Bright Data backfill |
| `github` | Repositories, issues, pull requests | Native public REST; optional token recommended |
| `community` | HN, RSS, podcasts | Free HN/RSS plus configured podcast provider |
| `all_public` | All six public modes above | Expands deterministically and enforces every lane |

`cortex` and `telegram` are trusted modes, not ordinary provider modes. The
local skill runner has no tenant database credentials and must fail their
preflight. Only Ora may inject the authenticated `ora-cortex-braintied` adapter;
retrieved private content must never enter public search, model, cache, or log
payloads. The internal runner accepts `--profile`, `--profile-mode`, and
`--as-of`; its Markdown output remains the public report, JSON metadata
contains a separately labeled, reference-only `private_manifest`, and the
required `--trusted-output` path receives the bounded trusted-local findings
appendix with mode `0600`. The runner rejects unknown or over-limit appendix
fields. A partial source/profile coverage result is still written for audit and
exits with status 2.

For operational diagnosis before synthesis, callers may use the exported
`probePublicSourceHealth` API. It runs only bounded deterministic searches and
returns query hashes, backend/count/date/latency metadata, and sanitized failure
classes. Its default registry excludes usage-billed providers; passing X,
Tavily, Bright Data, Apify, or another metered provider registry is an explicit
cost authorization and must use a small result/page cap.

## Evidence standards

- Prefer vendor documentation, official pricing pages, filings, standards, and
  original research over summaries.
- Treat sales-call recollections, private quotes not provided to the agent, and
  quote-only pricing as unverified. Never infer a private unit rate from a plan
  name or marketing page.
- Use recent independent sources for reliability, shutdowns, customer
  experience, or sentiment, and label their evidence strength.
- Keep quoted text short and preserve its source URL. Do not let a synthesis
  model's citation substitute for inspecting the cited page.
- For medical, legal, financial, security, or contractual decisions, use the
  package for evidence gathering, then independently verify the conclusion.

## Failure handling

If credentials are absent, the network is blocked, the cost cap is exhausted,
grounding is weak, or a required source lane is unhealthy, do not silently swap
in borrowed credentials, relax the budget, or claim the lane was covered by a
general web search. Report the limitation and continue with authorized
first-party sources or another approved research tool. Say clearly whether the
Braintied engine actually ran. If it did not run and no provider call was made,
report **incurred cost `$0.00`** and say that engine `cost_usd` metadata and
grounding were **not produced**; do not describe either as `null`. If standalone
provider probes were made, report their known quota/credit cost separately.

For an interrupted internal run, distinguish client transport from server
execution. Read the request ID from the private `--metadata` checkpoint or the
pre-submission stderr diagnostic and use `--request-id` to retrieve the same
durable record. A `submission_pending` checkpoint does not prove the server did
or did not accept the request; resubmitting that same ID is the safe recovery
operation. Do not report `$0.00`, infer provider cost, or start a replacement run
until the durable status proves the original attempt terminal.

Run `node skills/run-braintied-research/scripts/run-internal-research.mjs --help`
for the default internal surface and `run-research.mjs --help` for the local
fallback. Read [references/runtime.md](references/runtime.md) when
configuring Agent Auth, providers, output, or a failed preflight.
