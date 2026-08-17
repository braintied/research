# Braintied Research

Cited web research with a budget. You name the question and a dollar cap.
It searches, fetches pages, extracts quotes, synthesizes a report, and
grounds every citation against the fetched evidence.

**1.5.0** · source snapshot of [`@braintied/research`](https://github.com/braintied/stack/tree/main/packages/research). Every package publish updates this repo.

## Install

GitHub Packages (fleet):

```bash
pnpm add @braintied/research
```

The host passes credentials in. The package never reads `process.env`.

```ts
import { resolveResearchCredentials, runResearch } from '@braintied/research';

const credentials = resolveResearchCredentials(process.env);
const { report, costUsd } = await runResearch({
  credentials,
  brief: 'Competitive landscape for AI meeting assistants in 2026',
  kind: 'standard',
  maxCostUsd: 5,
});
```

Kinds: `quick` · `standard` · `deep` · `managed` · `social`.
Lanes: web, X, Reddit, YouTube, GitHub, community. A missing key disables
that lane; it does not silently swap in another.

## This repo

Public source for the engine. Issues and the GitHub page live here.
Publishing to the registry is owned by `braintied/stack` — do not
`npm publish` from this checkout.

## License

Braintied proprietary. Source is public; redistribution is not a grant.
