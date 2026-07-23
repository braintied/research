# Internal Agent Research Release — July 23, 2026

## Outcome

`@braintied/research` 0.8.2 makes Cortex protocol-v2 research recoverable even
when the local CLI is killed before a terminal response. The request ID now
exists in a private durable checkpoint and a flushed diagnostic before the
first paid submission instead of living only in process memory.

## Root cause

Version 0.8.1 replaced the long-lived 0.8.0 request with resumable durable
polling, but a generated request ID was written to stdout and metadata only
after terminal success. A SIGINT, process death, or local machine failure after
submission could therefore lose the only reattachment key even though Cortex
still owned a queued or running paid attempt.

## Durable contract

- The authenticated catalog must advertise protocol v2 and exact same-origin
  submission/status paths.
- Submission uses one caller request ID as its idempotency key. The client may
  retry a dropped submission without creating another durable record.
- Before the first submission, the client fsyncs a mode-0600 temporary
  checkpoint, atomically renames it onto `--metadata`, fsyncs the parent
  directory, and flushes a compact request-ID recovery diagnostic to stderr.
  The checkpoint contains no brief, Agent Auth token, provider credential, or
  provider result.
- The server returns a run UUID; the client polls its authenticated status and
  validates the final result. Immediately after acceptance, the checkpoint is
  atomically replaced with one that also records the durable run ID and status.
- Terminal success atomically replaces the checkpoint with final run metadata.
- `--request-id` reattaches a later CLI process to the same attempt.
- Temporary transport, `404`, `408`, `425`, `429`, `502`, `503`, and `504`
  responses use bounded retry delays within the caller's deadline.
- Private checkpoint metadata and pre-submission stderr expose the request ID;
  accepted/final metadata and final stdout also expose the durable run ID.
  None expose the Agent Auth token, provider credentials, raw trusted recall,
  brief, or provider error body.
- A protocol-v1/stream-only deployment is rejected before a paid call.

## Deployment exclusion

The matching Cortex release persists tenant-bound runs before Inngest dispatch.
Its deployment script acquires an atomic database lease only when no unexpired
run is queued/running. The same locked row pauses new submissions until the
rolling deploy completes, closing the check-then-deploy race. Lease expiry is
bounded so a dead deploy process cannot create an indefinite outage.

## Operator recovery

When a client deadline or local process interruption occurs, do not infer zero
cost and do not issue a new request ID. Read `request_id` from `--metadata` or
copy it from the pre-submission stderr line, then repeat the identical command
with `--request-id <id>`. A `submission_pending` checkpoint does not prove
whether Cortex accepted the request; resubmitting its same ID is safe because
server admission is idempotent. A fresh ID is a deliberately separate paid
run.

## Acceptance gates

Package acceptance passed:

- unit and contract tests: 57/57, including forced SIGINT before terminal
  status plus a second-process `--request-id` reattachment proof;
- Instagram/Bright Data boundary tests: 8/8;
- TypeScript and production build;
- CommonJS, ESM, packaged CLI, and exact version import from a clean tarball
  consumer;
- clean production dependency audit: zero vulnerabilities;
- exact 14-file tarball audit plus Gitleaks and high-confidence provider,
  Agent Auth, Swishh, GitHub, Slack, and private-key signatures: no leaks;
- archive: `releases/braintied-research-0.8.2.tgz`;
- SHA-256:
  `cbb5fa5d255914728a213085dc3b0e379e7da678901538d9576e46b99f47e155`;
- npm integrity:
  `sha512-67nLLm7tme3GaUDYrZFi7Eap+B0qIVnA4NKaVYdFMi63SNJGODUDvU6jXibTDXiw807y95Lwvv5OcdloCqSqvA==`.

Production acceptance additionally requires a protocol-v2 catalog probe plus a
transport-loss canary that destroys the first submission socket after
persistence and proves the retry returns the same run.
