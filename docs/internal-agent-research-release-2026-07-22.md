# Internal Agent Research Release — July 22, 2026

## Outcome

`@braintied/research` 0.8.0 is the reproducible agent-facing release for the
Cortex Worker `research.run` gateway. It contains the accepted grounding repair,
long-run client contract, deterministic artifact writer, explicit source modes,
versioned investigation profiles, and canonical skill. The matching Cortex
Worker source owns Agent Auth, provider secrets, cost caps, streaming
heartbeats, trusted recall, and deployment health.

## Website-design intelligence profile

Version 0.8.0 adds `web-design-intelligence@1`, a decision-grade contract for
building Parlor's reusable website-resource repository. It:

- counter-samples bright, warm, optimistic, tactile, editorial, playful,
  hospitality, culture, wellness, beauty, fashion, food, travel, and
  premium-commerce work instead of allowing dark SaaS references to dominate;
- separates award/editorial inspiration, paid templates and their commercial
  rights, maintained implementation repositories, first-party agent guidance,
  deterministic QA harnesses, and practitioner counterevidence;
- pins every run to an explicit as-of date and fails coverage when required
  source packs do not produce enough independent evidence; and
- supports reproducible snapshot, update, and monitor modes.

Public source discovery is executable rather than prompt-only. `all_public`
expands to web, X, Reddit, YouTube, GitHub, and community lanes; each lane has a
bounded search plan and a fail-closed coverage result. Crawl4AI remains an
acquisition backend for discovered URLs and is never represented as a search
authority.

## Trusted recall boundary

Authenticated profile runs may use the tenant-bound
`ora-cortex-braintied` adapter for Cortex and the registered Braintied Research
Telegram corpus. The public research process and trusted recall execute as
separate tasks. Raw private evidence never enters a public search, model,
reranking, cache, log, report, or metadata payload.

The public Markdown contains public-provider research only. Metadata contains a
text-free, reference-only `private_manifest`. A third, explicitly requested
`--trusted-output` file is created with mode `0600` and contains the strictly
validated, bounded, credential-scrubbed trusted-local appendix. The runner
rejects profile executions without this distinct path, raw private-text fields
in a manifest, unknown fields anywhere in either trusted schema, or values over
the appendix limits.

## Grounding repair lineage

The first paid quick canary on 0.7.0 completed but grounded 0/6 citations and was
rejected. Synthesis could cite extractor `key_claims`, while validation examined
only verbatim quotes. Version 0.7.1 aligned the validator with both source-bound
evidence types. A second canary reached only 1/2 because synthesis had changed an
exact HTTP status-code claim and merged propositions beyond the source text.

Version 0.7.2 therefore:

- validates the sentence around every citation use, including repeated anchors;
- excludes bibliography footnote definitions from claim checks;
- requires exact numeric consistency for conservative paraphrase matching;
- includes source-bound extracted key claims in the grounding evidence pool; and
- instructs synthesis to use source-near wording, exact numbers/status codes,
  one supported proposition per sentence, and citation placement at the smallest
  supported sentence.

The final bounded canary request
`574d23e9-b7db-4ce3-92e3-d50b647e63cf` cost `$0.02953845` and passed 1/1
grounding as strong. It proved the acceptance path, not broad market coverage.

## Long-run transport repair

A full deep request started successfully but the client failed at roughly the
five-minute Node/Undici response-header deadline while the healthy worker kept
crawling. The old client collapsed this into “endpoint unavailable,” and a later
clean worker rollout also removed the uncommitted route while its unrelated deep
health remained green.

Version 0.7.3 adds:

- a 3,600-second default deadline for deep runs;
- support for leading JSON-whitespace heartbeats;
- failed-envelope handling even when a streaming server has already committed
  HTTP 200;
- distinct incomplete-stream diagnostics; and
- sanitized transport error name/cause plus request ID, with token and provider
  data excluded.

The matching server sends an immediate whitespace byte, repeats it every 15
seconds, and appends one JSON result. This directly eliminates the response-header
timeout while preserving a normal JSON artifact contract.

## Verification

- package build and typecheck: passed;
- unit tests: 55/55 passed;
- Instagram/Bright Data boundary tests: 8/8 passed;
- source-mode, profile, coverage, private-manifest, trusted-output, heartbeat,
  and interrupted-transport integration cases: passed;
- packed-artifact import, CommonJS, CLI preflight, profile preflight, and
  trusted-output contract checks: passed;
- release archive:
  `releases/braintied-research-0.8.0.tgz`;
- release SHA-256:
  `1ec7e84808e30b46f250de719a40f420dbe85207b4d2a67e42df1022f7719ae3`;
- npm integrity:
  `sha512-TeLH2JhFwqXpnB+qoEKlkUGoeSntFg6p+WnRGwvtRGtksy4AhwX0pP/spTz0iYfUamQF7dkMfzlRG96dye1sSw==`;
- clean install dependency audit: zero vulnerabilities; and
- exact tarball secret scan: passed with Gitleaks plus high-confidence provider,
  GitHub, Slack, and private-key signatures.

## Trust boundary

Public research works through Agent Auth without exposing provider credentials.
`cortex` and `telegram` are trusted modes and require the tenant-bound
`ora-cortex-braintied` adapter. Do not use direct database access or append raw
private evidence to public planner/model/provider payloads. The absence of that
adapter is an explicit coverage gap, not permission to invent a fallback.
