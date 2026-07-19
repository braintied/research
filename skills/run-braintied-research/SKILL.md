---
name: run-braintied-research
description: Run Braintied's @braintied/research engine for fresh cited web research, pricing verification, vendor comparisons, competitive intelligence, market research, and grounded decision briefs. Use when asked to research current facts, verify claims, compare alternatives, or produce source-backed reports. Do not use for the Braintied Telegram corpus or enrichment-pipeline operations.
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
2. **Choose the smallest adequate kind and an explicit budget.** Use the table
   below. Pipeline kinds require `--max-cost-usd`; `answer` and `managed` do not
   honor that cap and must be chosen deliberately.
3. **Write a brief file.** Prefer a file over shell-embedded text so quoting is
   deterministic and the exact outbound prompt can be reviewed.
4. **Preflight without network access.** From the package root, run:

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

5. **Run only after the outbound brief and credentials are authorized.** Pass
   `--allow-external`, an explicit report path, and a metadata path:

   ```bash
   node skills/run-braintied-research/scripts/run-internal-research.mjs \
     --brief-file /tmp/research-brief.md \
     --kind standard \
     --max-cost-usd 2.50 \
     --output /tmp/research-report.md \
     --metadata /tmp/research-run.json \
     --allow-external
   ```

   Use `run-research.mjs` only as an explicitly authorized local fallback when
   the internal service is unavailable. That fallback requires package build
   freshness plus its own provider credentials; `--load-shell-env` imports only
   the documented provider allowlist and never Agent Auth.

6. **Audit the output.** Read `grounding`, `bibliography_count`, `gaps`, actual
   `cost_usd`, and the report itself. Grounding is diagnostic, not proof that a
   claim is true. Independently verify decision-critical claims against primary
   sources.
   Treat `grounding.passed: false`, `grounding_quality: weak`, or
   `grounding_quality: ungrounded` as an explicit verification failure; do not
   present those reports as source-verified even if the execution succeeded.
7. **Deliver with provenance.** State the research date, kind, engine, actual
   cost, grounding status, known gaps, and which important claims remain
   unverified. Link sources near the claims they support.

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
or grounding is weak, do not silently swap in borrowed credentials or relax the
budget. Report the limitation and continue with authorized first-party sources
or another approved research tool. Say clearly whether the Braintied engine
actually ran. If it did not run, report **incurred cost `$0.00`** and say that
engine `cost_usd` metadata and grounding were **not produced**; do not describe
either as `null`.

Run `node skills/run-braintied-research/scripts/run-internal-research.mjs --help`
for the default internal surface and `run-research.mjs --help` for the local
fallback. Read [references/runtime.md](references/runtime.md) when
configuring Agent Auth, providers, output, or a failed preflight.
