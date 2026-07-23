# Internal Agent Research Release — July 23, 2026

## Outcome

`@braintied/research` 0.8.1 replaces the long-lived HTTP execution contract
with resumable, idempotent durable polling. It is the client-side half of Cortex
internal-tools protocol v2 and is required for paid agent research.

## Root cause

Version 0.8.0 kept a deep research request attached to one Fly Machine. JSON
whitespace heartbeats prevented idle proxy timeouts, but a rolling Machine
replacement still severed the live request after provider work had begun. The
client could not determine whether work or billing continued and a retry risked
starting a second attempt.

## Durable contract

- The authenticated catalog must advertise protocol v2 and exact same-origin
  submission/status paths.
- Submission uses one caller request ID as its idempotency key. The client may
  retry a dropped submission without creating another durable record.
- The server returns a run UUID; the client polls its authenticated status and
  validates the final result before writing any artifact.
- `--request-id` reattaches a later CLI process to the same attempt.
- Temporary transport, `404`, `408`, `425`, `429`, `502`, `503`, and `504`
  responses use bounded retry delays within the caller's deadline.
- Metadata and stdout expose the request ID and durable run ID, never the Agent
  Auth token, provider credentials, raw trusted recall, or provider error body.
- A protocol-v1/stream-only deployment is rejected before a paid call.

## Deployment exclusion

The matching Cortex release persists tenant-bound runs before Inngest dispatch.
Its deployment script acquires an atomic database lease only when no unexpired
run is queued/running. The same locked row pauses new submissions until the
rolling deploy completes, closing the check-then-deploy race. Lease expiry is
bounded so a dead deploy process cannot create an indefinite outage.

## Operator recovery

When a client deadline or local process interruption occurs, do not infer zero
cost and do not issue a new request ID. Repeat the identical command with the
reported `--request-id`; the client will retrieve or continue polling the
existing durable record. A fresh ID is a deliberately separate paid run.

## Acceptance gates

Package acceptance passed:

- unit and contract tests: 56/56;
- Instagram/Bright Data boundary tests: 8/8;
- TypeScript and production build;
- CommonJS, ESM, packaged CLI, and exact version import from a clean tarball
  consumer;
- clean production dependency audit: zero vulnerabilities;
- exact 14-file tarball audit plus Gitleaks and high-confidence provider,
  Agent Auth, Swishh, GitHub, Slack, and private-key signatures: no leaks;
- archive: `releases/braintied-research-0.8.1.tgz`;
- SHA-256:
  `901a1734195d060e47fe5f34bb9b5fb540f7afa3a81e374fed9aebff7e0c05ea`;
- npm integrity:
  `sha512-w/GrdkCn56vmlQ+gExVPE4F/NHDbttS2xAkgE33N7fKBJcbwZ8eBEacYKXJbfwF0FQaTxBVNUmFuoTw2gd9zPw==`.

Production acceptance additionally requires a protocol-v2 catalog probe plus a
transport-loss canary that destroys the first submission socket after
persistence and proves the retry returns the same run.
