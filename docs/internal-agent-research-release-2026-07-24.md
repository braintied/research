# Internal Agent Research Release — July 24, 2026

## 0.8.5 — Evidence-bound synthesis and honest source coverage

The July 22 website-intelligence run exposed a contract mismatch rather than a
search shortage: section synthesis paraphrased or combined exact extractor
evidence while grounding correctly required complete source sentences. Only 5
of 41 cited sources passed, even though the fetched evidence pool was much
larger. Required practitioner searches could also be broadened into SearXNG,
and raw discovery snippets could satisfy coverage before their pages produced
any accepted evidence.

Version 0.8.5 fixes those causes at the package boundary:

- section models select immutable `{{EVIDENCE:EN}}` handles; the renderer alone
  inserts exact source sentences and citation anchors;
- every model-authored connective segment is visibly quarantined as
  `Editorial synthesis — inference, not source-validated`;
- report and section headings are deterministic rather than model-authored;
- the executive summary is assembled from the same complete evidence sentences
  after global citation renumbering instead of using an abstractive summary;
- missing grounding is a failure, and source/profile coverage counts only exact
  evidence accepted from fetched content, never search titles or snippets;
- required source-pack providers remain locked, repeated query hints share one
  synthesis section, GitHub repository/code packs no longer pull issue noise;
- RSS packs declare explicit verified feed URLs rather than treating domain
  filters as feed endpoints; and
- Hacker News uses its item permalink as the fetchable evidence identity while
  retaining the linked article as outbound metadata.

Package acceptance passed:

- TypeScript and production build;
- 123 unit/contract tests plus 8 Instagram/Bright Data boundary tests;
- CommonJS and ESM imports from a clean tarball consumer;
- clean production dependency audit with zero vulnerabilities;
- exact 15-file archive inspection and a redacted Gitleaks scan with no leaks;
- archive: `releases/braintied-research-0.8.5.tgz`;
- SHA-256:
  `5f211c1f340cd21f9fb1f263c15a347599bc171d9a4b7402dfadcebc4d67a1e8`; and
- npm integrity:
  `sha512-SFpkLIpxRAHU3dflNP959FlhAOnZRcc0vXLWbCgj43WG9a7fw2lnGMTMsQogQ1SePiNvk4axyfYhScmjajyhdQ==`.

Production acceptance still requires the matching Cortex migration/runtime
release, then a profile canary with strong grounding, complete required
coverage, and successful trusted-local recall.
