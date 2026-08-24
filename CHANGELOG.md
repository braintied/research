## Unreleased

## 1.5.3

### Patch Changes

- Updated dependencies
  - @braintied/cost@3.3.0

## 1.5.2

### Patch Changes

- Updated dependencies [228faa2]
  - @braintied/models@1.7.3

## 1.5.1

### Patch Changes

- Updated dependencies [bfa9c5e]

  - @braintied/cost@3.2.0

- Public GitHub snapshot (`braintied/research`) now ships a comprehensive
  README plus `AGENTS.md` from `packages/research/oss/`. Sync substitutes
  `{{VERSION}}` so the next `stack.mjs publish` of `@braintied/research`
  does not wipe the product page back to the short stub.
- `stack.mjs snapshot` refreshes GitHub without an npm publish.
  `publish` also snapshots on a registry skip: `oss/` is outside the
  tarball, so "already on the registry" used to leave the public page
  stale (measured 2026-08-17 at 1.5.0).

## 1.5.0

### Minor Changes

- a216855: Catalog rates and first-class helpers for Tavily, Serper, SerpAPI, Bright Data, twitterapi.io, and official X.

  Search/scrape spend was already in `ora_core.ai_usage_events` ($156.48 / 30d) but could not be rolled up by app, agent, or run: `trackSearch` dropped those fields, Tavily/SerpAPI rows stored a NULL vendor, and Twitter had no helper at all. `estimateVendorCost` / `analyzeVendorSpend` own the list prices and the cheaper-or-self-host recs so `@braintied/research` no longer keeps a second `SEARCH_COST_PER_CALL_USD` table.

### Patch Changes

- Updated dependencies [ef6fed2]
- Updated dependencies [a216855]
  - @braintied/cost@3.1.0

## 1.4.0

### Minor Changes

- 181eb26: Add `crawlUrlDetailed`: crawl provenance (`method: 'crawl4ai' | 'direct_fetch' | null`, `declinedReason`) so callers can tell the primary crawl lane apart from the direct-fetch fallback instead of papering over a disabled lane. Fix the Crawl4AI client against the 0.8.x response shape: the served URL is read from top-level `redirected_url` (legacy `metadata.url` remains as fallback; the requested `url` is never trusted for the target check). Against Crawl4AI 0.8.9 the old code rejected every crawl as `target_mismatch`, so the lane had never actually served. Adds the gated live smoke test `smoke:crawl4ai` (never in CI), which caught the drift on its first run.
- 2d8e969: Decision-brief support: multi-question briefs now research every question instead of the first few.

  - Per-question planning: a brief with numbered questions under a "questions" heading is split and
    planned question-by-question, each with a fair share of the subquery band; section paths are
    namespaced `q{n}.*`. Briefs without such a section behave exactly as before.
  - Fair-share extract budget: the run-level page budget is allocated round-robin across sections
    instead of FIFO by subquery order, which starved every late section to an evidence gap
    (measured 2026-08-15 on standard-depth multi-question runs).
  - `runResearch` now forwards `subqueryBandOverride` (previously silently dropped; only
    `runDeepResearch` callers could widen retrieval).
  - Question-derived report headings: `q{n}.*` sections render `Q{n}: <question…>` instead of the
    ordinal "Research Findings N". Headings remain code-owned.

  New pure exports: `splitDecisionBriefQuestions`, `questionHeadingFor`, `allocateExtractBudgetFairShare`.

### Patch Changes

- 8b58271: Implement `isApifyFallbackAllowed`, exported by #364 but never defined, which broke the package build on main. The resolver now parses `APIFY_ALLOW_FALLBACK=1` into `ResearchCredentials.apifyAllowFallback` (exact `1` only, trimmed like every other env value); tiktok and facebook-groups already gated on the function.
- 97c76c5: Section synthesis retries an unbound draft once, then records an evidence gap instead of throwing. A missing evidence token no longer aborts a paid run after extract/rerank. Kind-aware synthesis default when no override is set.

## 1.3.5

### Patch Changes

- Crawl4AI lane: a bare `*` entry in `BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS` is
  now an explicit open-web opt-in for workloads whose targets cannot be
  enumerated (news-style arbitrary-domain crawling). It waives only the
  per-domain review — the versioned network guard
  (`BRAINTIED_CRAWL4AI_NETWORK_GUARD=enforced-v1`) and every SSRF check still
  bind, and an empty allowlist remains deny-all.

## 1.3.4

### Patch Changes

- Section synthesis no longer aborts the process when a model draft omits
  `{{EVIDENCE:EN}}` tokens. The renderer still fails closed. The section
  retries once, then writes the existing evidence-gap notice so critique
  can run. Measured 2026-08-15: a $1 `quick` run on cortex-worker died as
  `TOOL_EXECUTION_FAILED` after plan + extract + one Voyage rerank, with
  no synth usage row, because the first unbound draft threw out of
  `synthesizeSection`.

- `synthModelDefault` now takes the research kind. A missing override
  no longer jumps a `quick` run onto the standard catalog model.

## 1.3.3

### Patch Changes

- ac077a2: Make @google/genai an optional peer and lazy-load it for gemini-\* synthesis so hosts that never call Gemini (Watchtower) do not pull the SDK into their image.
- Updated dependencies [ac077a2]
  - @braintied/models@1.7.2

## 1.3.2

### Patch Changes

- Updated dependencies [e680ef1]
  - @braintied/models@1.7.1

## 1.3.1

### Patch Changes

- Updated dependencies [758e265]
  - @braintied/models@1.7.0

## 1.3.0

### Minor Changes

- c737217: `categorizeItems` accepts a caller-supplied taxonomy, and the `CategorizeTaxonomy` type is exported.

  The categorizer prompt hardcoded "curating a knowledge base FOR CONTRACTORS" with a fixed `tip|tool|news|win|pain_point|trend|competitor|other` set, which is the most domain-coupled code in the least domain-coupled package. Any other domain run through it was classified against the wrong universe, so a silversmithing studio came back `competitor`. `@braintied/knowledge`'s `taxonomy.ts` already documented this defect and named the fix; this is the half that never landed, and `project-nusa-glm` has been unable to typecheck against a `CategorizeTaxonomy` that was never published.

  Non-breaking. The taxonomy is an optional third argument defaulting to the exported `CONTRACTOR_TAXONOMY`, which reproduces the previous prompt and category set exactly. `IngestedItem` gains a category type parameter that defaults to `KnowledgeCategory`, so every existing annotation keeps the type it had and consumers keep exhaustiveness checking on `item.category`.

  A taxonomy that cannot produce a coherent prompt now throws `CategorizeTaxonomyError` rather than being half-applied: an undescribed category would otherwise reach the model as a blank line, so the model classifies against a category it was never told the meaning of.

## 1.2.13

### Patch Changes

- Updated dependencies
  - @braintied/models@1.6.1

## 1.2.12

### Patch Changes

- 887253a: Count Gemini thinking tokens as billable output.

  Google reports `thoughtsTokenCount` DISJOINT from `candidatesTokenCount` and
  bills it as output. Three sites counted candidates alone — `synthesis.ts`,
  `planner.ts`, and `providers/gemini-extractor.ts` — so every thinking-enabled
  call under-booked its output. Both zod schemas omitted the field entirely, so it
  was stripped before anyone could read it.

  This is the largest single cause of the fleet's Google metering gap: the research
  key's GCP project (`gen-lang-client-0848607770`) measured $143.78 billed against
  $72.54 ledgered over 7 days — 50.4% metered — while its per-row pricing was
  exactly the catalog rate.

  `thoughtsTokenCount` is optional on `GeminiExtractionUsage`: non-thinking models
  omit it, and an absent field must read as 0 rather than NaN, which would fail the
  payload schema and null the entire extraction rather than just the usage block.

  Same semantics as `@braintied/cost` `extractGeminiUsage`, which already had this
  right.

## 1.2.11

### Patch Changes

- Updated dependencies [164c689]
  - @braintied/models@1.6.0

## 1.2.10

### Patch Changes

- Model policy resolves every stage solely via `resolveForUseCase` (no dual
  `model(role)` try/catch). Answer/quick use new `research-synthesis-quick`.
  Requires `@braintied/models` ≥ 1.5.3.

## 1.2.9

### Patch Changes

- fab22ec: Record deep-research critique spend with the real critique model and catalog rates so ledger rows never land as synthetic `anthropic:deep-research` / unpriced.

## 1.2.8

### Patch Changes

- Source-mode coverage counts all discoveries (not only extract-validated). GitHub/HN/RSS native hits can cover community+github modes without HTML extract — fixes canary program_incomplete after 1.2.7 pack admission.

# @braintied/research

## 1.2.7

### Patch Changes

- Admit GitHub REST search hits as provider-native pack evidence (title + description) when HTML extract is empty. Fixes web-design-intelligence@2 canary implementation-coverage 0e/0s after models policy ships.

## 1.2.6

### Patch Changes

- Research pipeline defaults to Google for every LLM stage (extract/synth/critique/assembly) via @braintied/models role ladders + provider filter. Deep synthesis and critique no longer resolve to Sonnet/DeepSeek when those keys are missing or invalid; escalate with synthesisModelOverride. research-synthesis-deep → STANDARD, research-critique → MICRO. Planner Anthropic fallback uses resolveForStyle('STRONG').
- Updated dependencies
  - @braintied/models@1.5.1

## 1.2.5

### Patch Changes

- Resolve every research stage model through `@braintied/models` (no hardcoded
  gemini generation pins at call sites). Extract uses google-filtered `cheap`
  ladder; synthesis/critique use research-\* use-cases. Retired Gemini ids
  (`gemini-2.0-flash`, `gemini-2.5-flash-lite`) rewrite onto the live pick —
  fixes the 2026-08 canary `ApiError` 404 when a dead model was still named.

## 1.2.3

### Patch Changes

- Fill remaining web-design-intelligence@2 canary under-counts (2026-08-04).

  After 1.2.2 shipped to cortex-worker, release canaries still failed:
  `guidance-harness-coverage` at **0e/0s**, `template-rights-coverage` at
  **6e/6s** (floor 10e/6s), `implementation-coverage` at **5e/5s** (floor 8e/5s).

  - Compile up to **4** pack query hints (was 2) so expanded seeds actually run.
  - Retune v2 guidance hosts/queries toward high-yield a11y/docs surfaces;
    drop `github.com` from guidance (implementation owns native GitHub).
  - Raise template and implementation search limits; lead with high-recall
    license/repo queries.
  - Admit provider-native title+snippet evidence for **tavily/searxng** the
    same way as HN/RSS when seed or domain pack attribution already exists
    (extract failures no longer zero a full pack).

  v1 `profileSha256` remains `5fa862b9…`. v2 moves to
  `3e34c922f038ad0a8f2672b890a6280be5573ccf16126de298886a280d22f3e1`.

## 1.2.2

### Patch Changes

- Fix web-design-intelligence@2 release canary empty packs (2026-08-04).

  Live cortex-worker canaries measured `award-source-coverage` at 5–6 of 8
  while `guidance-harness-coverage` and `practitioner-counterevidence` sat at
  **0e/0s** even with HN/RSS/Tavily reachable. Two root causes:

  1. **Community evidence assembly** required Gemini re-fetch quotes.
     HN/RSS discoveries never carry page HTML, so extract returned empty and
     the pack ledger stayed empty despite successful search. Assembly now
     admits provider-native title+snippet bodies for `hn` / `rss` / `podcasts`
     when the discovery already has seed or domain pack attribution
     (`validation: provider_native_discovery`). Exact-fetched quotes still win
     when both exist.

  2. **Profile pack seeds** were too thin for the failing lanes: guidance
     apex-domain filters + long queries under-hit docs hosts; practitioner
     packs had no `includeDomains`, no web recovery providers, undated-hostile
     coverage, and RSS word-match queries that rejected real feed items.
     Expanded guidance docs hosts + shorter queries; practitioner adds
     tavily/searxng + publisher domains, shorter queries, `allowUndated: true`.
     Award pack search limits slightly raised (still 8e/5s floor).

## 1.2.1

### Minor Changes

- Instagram **Stories** acquisition: `/stories/{username}/` (and optional story id)
  fetches via Apify actor `datavoyantlab/advanced-instagram-stories-scraper`
  when `APIFY_API_TOKEN` is set. Primary path for stories (not gated by
  `APIFY_ALLOW_FALLBACK`). Posts, reels, IGTV, profiles, and hashtag search stay
  Bright Data-only and fail closed. Provider enables when either Bright Data or
  Apify is configured. Exports: `parseInstagramStoriesUrl`,
  `canonicalizeInstagramStoriesUrl`, `APIFY_INSTAGRAM_STORIES_ACTOR_ID`.

## 1.2.0

### Minor Changes

- f3247a4: Cap research Gemini extract fan-out per run, and rewrite banned text-preview model ids at the Gemini client so stale pins cannot re-bill the July 2026 preview tax.

  - `@braintied/cost`: `resolveGeminiRequestModel` / `isBannedGeminiTextPreview` — request-time rewrite in `wrapGoogleGenAI` and `createMeteredGeminiRest`. Image/veo/tts/live previews stay allowed.
  - `@braintied/research`: per-depth `maxExtractPages` + `extractConcurrency` shared across main + critique passes; skip already-extracted URLs; local preview rewrite on extract/planner/categorize wire paths.

- d51c646: Cost program: tighter depth extract budgets, cheaper default synthesis models, extract page cache keys, quick as coerceResearchKind fallback — cuts research Gemini burn (~$393/30d on research-agents).

### Patch Changes

- 5e9b012: Republish cost program as 1.1.2 — npm 1.1.0 was an earlier build; main #186 content needs a unique version to publish.
- Updated dependencies [fee40d9]
- Updated dependencies [3312280]
  - @braintied/models@1.3.0

## 1.1.3

**Profile canary extract floor (2026-08-02).** Cost-program `wide.maxExtractPages=36`
was below the sum of `web-design-intelligence@2` public coverage floors (~41), so
the cortex-worker release canary failed deterministically with
`profile_coverage_incomplete` on award / implementation / guidance /
practitioner packs (trusted cortex+telegram priors still passed). Raise wide
to **64** (still under the pre-program 80). Product defaults (quick/standard)
unchanged.

## 1.1.2

**Republish of the 2026-08-01 cost program** (git 1.1.0 on main; npm 1.1.0 was a prior build without depth cuts). Same content as main after #186: tighter extract budgets, cheaper synthesis defaults, extract cache, quick coerce fallback.

## 1.1.0

**Cost program (2026-08-01)** — research-agents GCP project was ~$393/30d
(~$200/7d), dominated by per-page Gemini extract + 3.6-flash synthesis.

- **Tighter depth budgets**: standard maxExtractPages 48→20, critique 3→1,
  hardCap $10→$3; wide 80→36 extract pages; quick/blog trimmed similarly.
- **Cheaper default models**: answer/quick synthesis → `gemini-3.1-flash-lite`;
  standard/assembly/critique → `gemini-3.5-flash-lite`; deep keeps 3.6-flash.
- **Extract page cache**: when a `ResearchCacheAdapter` is provided, extract
  results key by model+url+content fingerprint (14d TTL). Cache hits bill $0.
- **coerceResearchKind** fallback: `standard` → `quick`.
- Export `extractCacheKey` for hosts building their own extract stores.

## 1.0.1

- `generateDocument` default model from fleet modality **`doc-synthesis`**.

## 1.0.0

### Major Changes

- c195d9e: fix(research): no-direct-env — one explicit ResearchCredentials record replaces 50 ambient env reads

  `src/` read `process.env` in 50 places across 17 provider modules, the planner,
  the synthesis dispatcher, and the crawler — roughly 25 distinct variables. A
  third party could not audit what this package consumes without reading the
  implementation, and behavior depended on whatever happened to be set on the
  machine that ran it.

  Every one of those values is now an explicit field on a single
  `ResearchCredentials` record (`src/credentials.ts`), which the HOST resolves at
  its own process boundary and passes in.

  - New `resolveResearchCredentials(env)` maps the conventional variable names
    onto the record. It takes the environment as an ARGUMENT, so the alias
    knowledge (the four Gemini names, X's three bearer aliases, twitterapi.io's
    legacy name) stays in one tested place without the library reaching for
    ambient state. Also exported: `resolveGeminiApiKey`, `requireGeminiApiKey`,
    `requireVoyageApiKey`, `requireAnthropicApiKey`, `MissingCredentialError`,
    `RESEARCH_ENV_NAMES`, and the `Crawl4AiConfig` / `GitHubPublicAuthConfig` /
    `RedditCredentials` / `XCredentials` / `BrightDataCredentials` types.
  - `credentials` is a required field on `RunResearchInput`,
    `RunDeepResearchInput`, `RunAnswerInput`, `RunManagedResearchInput`,
    `RunResearchProgramInput`, `GenerateDocumentInput`,
    `ProbePublicSourceHealthInput`, `PlanSubqueriesInput`, `CritiqueDraftInput`,
    `RerankQuotesInput`, `SynthesizeSectionInput`, `SynthesizeAllInput`,
    `GeminiExtractInput`, and the `synthesisGenerate` argument object.
  - Provider singletons become factories: `createTavilyProvider(credentials)`,
    `createExaProvider`, `createSerperProvider`, `createSerpapiProvider`,
    `createSearxngProvider`, `createPerplexityProvider`, `createRedditProvider`,
    `createYoutubeProvider`, `createHnProvider`, `createCrawl4aiProvider`,
    `createFacebookGroupsProvider`, `createTiktokProvider`,
    `createInstagramProvider`, `createXProvider`, `createPodcastsProvider`,
    `createGithubProvider`. `rssProvider` stays a singleton (no credentials, no
    model call). New `createProviderRegistry(credentials)` builds the whole set;
    `getAllProviders`, `getEnabledProviders`, and `getEnabledSearchProviders` now
    take `credentials`, and `routeProvidersForSourceTypes` /
    `providersForSubquery` take the registry as their first argument. The
    registry is a value, not a module singleton, so two callers in one process
    can hold different credentials.
  - Positional-argument changes: `tavilyAnswer(credentials, query, options)`,
    `perplexityAnswer(credentials, query, options)`,
    `searxngSearch(credentials, query, opts)`,
    `crawlUrl(credentials, url)`, `crawlWithCrawl4AI(credentials, url)`,
    `embedTexts(credentials, texts)`, `embedItems(credentials, items)`,
    `categorizeItems(credentials, items)`, `ingestSource(credentials, source,
opts)`, `summarizePromptBrief(credentials, promptMd)`, and every Bright Data
    primitive (`triggerCollection`, `pollSnapshot`, `downloadSnapshot`,
    `scrapeDataset`, `fetchLinkedInPostsBrightData`,
    `fetchFacebookGroupPostsBrightData`).
  - `resolveGitHubPublicAuthState` takes a `GitHubPublicAuthConfig` instead of an
    env map. The `github_auth_policy_invalid` state code is replaced by
    `github_auth_unconfigured` (no GitHub config supplied): an unparseable
    `BRAINTIED_GITHUB_REQUIRE_AUTH` value now throws from
    `resolveResearchCredentials` at the host boundary rather than quietly
    disabling the lane, because a typo in a security policy should be loud.
  - `SCRAPER_BASE_URL` is removed along with its hardcoded `ora-scraper.fly.dev`
    default. The browser crawler now requires `crawl4ai.baseUrl`,
    `crawl4ai.allowedDomains`, and the versioned `crawl4ai.networkGuard`
    acknowledgement together, or it stays off. `getGeminiKey` / `getVoyageKey`
    are removed in favour of `requireGeminiApiKey` / `requireVoyageApiKey`, which
    take the record.
  - Conflicting Gemini aliases now fail at resolve time instead of at first use.
    A host with two different Gemini keys and no `BRAINTIED_GEMINI_KEY_NAME`
    selector learns at its boundary rather than an hour into a run.

  Breaking: every host resolves its own env and passes the record in, e.g.
  `runResearch({ credentials: resolveResearchCredentials(process.env), brief, kind })`.
  This package no longer reads `process.env` anywhere in `src/`; the shipped
  runner (`skills/run-braintied-research/scripts/run-research.mjs`) is the one
  process boundary, and a new package test walks `src/` and fails on any
  reintroduced ambient read.

## 0.13.0

### Minor Changes

- 98ea87d: Price Gemini synthesis models correctly, and stop guessed rates escaping as facts.

  `gemini-3.6-flash` (the default synthesis model for the `quick` kind),
  `gemini-3.5-flash-lite`, and `claude-sonnet-5` were absent from
  `MODEL_PRICING`, so every call fell through to the conservative fallback: recorded
  at Sonnet's $3/$15 and tagged `provider: 'anthropic'`. cortex-worker forwards that
  number to the Cortex ledger as `vendorReportedCostUsd`, the tier that outranks the
  catalog, so deep-research Gemini spend was booked at roughly 2x the real rate
  ($1.50/$7.50) under the wrong provider, and no catalog correction could override it.

  All three now carry their live catalog rates. New `tryGetModelPricing()` returns
  `null` for an unknown model rather than substituting a rate, so callers writing to a
  system of record can tell a measured price from a guess. `getModelPricing()` is
  unchanged for local budget enforcement, where a spend cap must still bound an
  unrecognized model.

## 0.12.1

### Patch Changes

- Enforce provider compatibility when attributing a discovery to a source pack.

  0.11.2's domain-matched attribution keyed on host alone, and
  `validatedPublicEvidenceItems` stamped every evidence item with the
  discovery's own provider without checking the pack's declared `providers`.
  Two forbidden pairs resulted on web-design-intelligence@2: a tavily/searxng
  result on github.com was attributed to `open-implementation-sources`, whose
  v2 contract is native GitHub evidence only, and a github-native repository
  record was attributed to `ai-design-guidance`, whose contract is web
  providers. The release canary's independent per-pack provider whitelist
  rejected the manifest with `public_manifest_invalid` on 2026-07-27.

  Evidence assembly now skips any (pack, discovery) pair where
  `discovery.provider` is not in `pack.providers`. Seed attribution satisfies
  this by construction (`compileProfileExecution` builds pack seeds from the
  same providers list), so the filter only drops domain-matched
  over-attribution; a discovery whose provider matches a different pack on the
  same host still lands there. Dropped discoveries continue to inform
  synthesis — they never enter the pack's evidence ledger.

- Enforce the snapshot as-of boundary at evidence assembly.

  GitHub repository discoveries stamp `published_at` from the repo's
  `pushed_at`, and planner subqueries carry no `published_before` bound, so a
  planner-found repository pushed after the program's as-of date entered the
  public evidence ledger with a future date. Coverage evaluation already
  excluded such items (`futureEvidenceCount`), but the release canary rejects
  any manifest that contains one (`public_manifest_invalid` — one github item
  stamped 2026-07-26 against a 2026-07-22 as-of, found by the post-fix
  diagnostic replay). Assembly now drops any dated discovery whose
  `published_at` exceeds the exact as-of boundary, so the ledger can never
  contradict the snapshot it claims to be.

## 0.12.0

### Minor Changes

- 5f8792e: Move the `openai` dependency from ^6.49.0 to ^7.0.0.

  This is consumer-visible in a way the other 2026-07-28 dependency waves were
  not. `openai` sits in `dependencies` here, not in `peerDependencies`, so
  research bundles its own copy — installing this version pulls openai 7
  alongside whatever the consuming app already has. Every consuming app is
  currently on openai 6.x, so until they move, an app that depends on research
  will resolve two majors of the OpenAI SDK side by side. That is not a
  correctness problem (the SDK is used behind one internal function and nothing
  is passed across the boundary) but it is real install weight, and it is the
  reason this is a minor rather than a patch.

  Backed by new runtime evidence rather than a clean compile. research declared
  `openai` and called it in exactly one place — the qwen-\*/OpenRouter branch of
  `synthesisGenerate` — and NO test had ever constructed a client or exercised a
  request, so the whole OpenAI surface was covered only by "it typechecks".

  `test/synthesis-openai-client.test.ts` adds 7 contract tests that stub
  `globalThis.fetch` rather than mocking the `openai` module, so the real SDK
  builds the request and parses the response. They assert what this package
  actually depends on: that the client honours the OpenRouter `baseURL` instead
  of calling api.openai.com, that it sends `model`, `max_tokens` and both message
  roles, that it authenticates with a bearer token, that `choices[]`/`usage` are
  exposed in the shape the code reads, that a missing `usage` block and a null
  content are both tolerated, and that a missing `OPENROUTER_API_KEY` throws
  instead of silently issuing an unauthenticated call.

  7/7 green on openai 6.49.0 first, then 7/7 green on 7.0.0 — the tests predate
  the upgrade, so they are evidence rather than a description of the new
  behaviour. No API key and no network access are required to run them.

## 0.11.2

### Patch Changes

- Fix profile coverage under-counting when the planner (not a pack seed)
  discovers an authority page.

  Discoveries carried `source_pack_ids` only from pack-seeded subqueries;
  planner subqueries carry no pack id, so a page found by the planner was
  invisible to `coverageRequirements` even when its host is one of the pack's
  own `includeDomains`. On 2026-07-27 the web-design-intelligence@2 release
  canary failed `program_incomplete` with `award-source-coverage` at 6 of 8
  required evidence items while the report itself cited healthy award
  evidence: the award pages simply arrived through planner queries.

  `domainMatchedPublicPackIds` (exported from `research-program.ts`) now
  attributes a discovery to every public pack whose `includeDomains` contains
  the discovery's host, unioned with its seed attribution inside
  `validatedPublicEvidenceItems`. Matching is domain-boundary exact
  (`host === domain || host.endsWith('.' + domain)`), so `awwwards.com.evil.tld`
  never attributes. Seeds are already host-restricted by `include_domains`, so
  this only adds planner-found URLs on the same authorities; it changes no
  search, fetch, extraction, or cost behavior.

## 0.11.1

### Patch Changes

- Fix the extraction model: `gemini-2.5-flash-lite` is listed-but-not-callable.

  The 0.9.x cost change (0444eb1) pinned `EXTRACTION_MODEL` to
  `gemini-2.5-flash-lite` for its $0.10/$0.40 rates. The id appears in
  `GET /v1beta/models`, but every `generateContent` call against it returns
  HTTP 404 on both v1beta and v1 (verified 2026-07-27 against the Ora-App GCP
  key; `gemini-2.0-flash-lite` 404s the same way). A listed model id is not a
  callable model id.

  The extractor swallows per-page API errors by design, so from 2026-07-25 to
  this release every deep-research run extracted ZERO quotes from every
  crawled page: searches and fetches succeeded, synthesis produced reports,
  and the reports carried no citations. Cost per run dropped to cents, which
  made the failure invisible to spend monitoring. Profile coverage checks and
  the cortex-worker research canary (`program_incomplete`) caught it.

  `EXTRACTION_MODEL` moves to `gemini-3.1-flash-lite` (GA successor to the
  deprecated preview; the cheapest lite tier answering 200 today).
  `EXTRACTION_INPUT_USD_PER_M` / `EXTRACTION_OUTPUT_USD_PER_M` move to the
  matching observed rates ($0.25/$1.50) in the same commit, per the rule these
  constants carry. `SAFE_USAGE_MODELS` and `MODEL_PRICING` gain the GA id so
  usage attribution and direct `getModelPricing` callers keep working.

- Fix the GitHub lane returning zero results for verbose queries.

  GitHub search ANDs every free-text term against name/description/readme, so
  long natural-language queries (planner subqueries, profile pack hints of 8+
  words) return 200 with `total_count` 0 where Tavily and SearXNG tolerate the
  same text. Verified 2026-07-27 against the live API: the 13-term
  `open-implementation-sources` pack hint returns 0; "design system components"
  returns 8,102. The github provider now walks a query-term ladder — full
  query, first 6 terms, first 3 terms — retrying only when the API itself
  returned zero items (a query that matched but post-filters empty on the date
  window is not relaxed). Repository and issue search both relax.

## 0.11.0

### Minor Changes

- Add YouTube channel ingestion, a unified transcript stack, and a YC
  portfolio provider (7b9f8af). Purely additive: new exports for channel
  listing, video metadata, comments, transcript extraction with tiered
  fallback, and `fetchYcPortfolio`. No existing pipeline surface changed.
  (Changelog entry added retroactively in 0.11.1.)

## 0.10.0

### Minor Changes

- Add `perplexityAnswer()` — the full-answer Perplexity primitive.

  Also adds `PerplexityApiError`, carrying the HTTP `status` and an
  `isQuotaExceeded` getter. Hosts branch on the status — a 429 trips a circuit
  breaker and pages an operator, a 5xx is a transient retry — and without a
  typed status every host would regex its own error string. `perplexityAnswer()`
  throws it on any non-2xx.

  `perplexityProvider.search()` maps a Sonar response into the shared
  `SearchResult[]` contract, which means the synthesized answer survives only as
  `snippet: answer.slice(0, 500)` — truncated to 500 characters and duplicated
  onto every result. That is correct for a search tier feeding the research
  pipeline, and wrong for a caller that wants the answer itself.

  Because the package had no full-answer primitive, every host that needed one
  (Sentigen, Swishh, Cortex) kept its own raw `fetch` against
  `api.perplexity.ai/chat/completions`. That is the direct cause of the
  duplicate provider paths the fleet consolidation is removing — migrating those
  callers onto `search()` would have silently truncated every answer.

  `perplexityAnswer(query, options)` returns the complete `answer`, `citations`,
  structured `searchResults`, plus `usage` and the resolved `model` /
  `searchContextSize` so a host can price the call. It supports `sonar` and
  `sonar-pro`, a system message, recency filtering, and
  `web_search_options.search_context_size`.

  It deliberately does **not** track cost, emit telemetry, or wrap a circuit
  breaker. Those are host concerns; the package stays host-agnostic and the host
  wraps this. Returning `usage` and `model` is what makes that wrapping possible.

  `perplexityProvider.search()` is unchanged.

## 0.9.1

### Patch Changes

- Make three packages publishable again.

  `kimi-router/install.mjs` could not be parsed at all. The launchd plist is built
  from a template literal, and an XML comment inside it quoted `supervisor audit`
  and `ps` in backticks, which closed the string and left the prose to be read as
  code. The publish gate caught it as `SyntaxError: Unexpected identifier
'supervisor'`. The quotes are now single, so the comment survives the template.
  Anyone who ran the installer between that comment landing and now got the same
  parse error, because the file was never valid JavaScript.

  `research` and `onboarding-react` both build content that differs from what is
  already on the registry under their current version numbers, so the publish gate
  refuses them: a version that already exists must be byte-identical or the
  mapping from version to commit is a lie. Neither needs a code change, only a
  number that has not been used yet.

## 0.9.0

### Minor Changes

- Lead with Tavily, retire the Jina fetch layer, and fix two cost-accounting
  defects.

  **`runAnswer` never called Tavily.** `answer.ts` imported `searxngSearch` and
  `serperProvider` directly, bypassing the provider registry, so the
  highest-volume entry point in the package was hardwired to the weakest
  backend — and hard-failed with `no search results (backend: searxng)`
  whenever `SEARXNG_URLS` was unset. It now runs a three-tier cascade: Tavily,
  then SearXNG, then Serper, each tier only firing when the previous came back
  thin.

  Tavily leads because `include_raw_content` returns server-side page
  extraction INLINE with the results. The fetch stage short-circuits on it, so
  a Tavily hit removes a crawl instead of adding one, and that extraction
  survives JS, paywalls, and bot-walls that defeat a headless re-crawl.
  Measured over a 4-query run: 24 sources retrieved through Tavily, 24 served
  from inline raw content, **0 crawls**. Cheaper per search is not cheaper per
  usable source. `SOURCE_TYPE_ROUTING` and the planner's routing rows were
  reordered to match; specialists (reddit, youtube, github, exa, rss, podcasts)
  keep their leads, and searxng/serper remain in every general list as free
  fallbacks.

  **Jina Reader is removed.** Its job was rendering JS/paywalled pages a plain
  crawl fails on, and Tavily now does that earlier, better, and at the search
  step. What was left was a third attempt at pages the first two had already
  failed on, from a hosted reader whose free tier rate-limits, costing a full
  30s-timeout round-trip on the slowest path. The fetch chain is now
  Tavily raw content → Crawl4AI → direct fetch.

  **BREAKING:** the `jinaReaderFetch` export is gone, as is the `'jina'` member
  of `SourceBackendSchema`. No consumer in the fleet imported either.
  `crawlUrl`, `crawlWithCrawl4AI`, and `directFetchAsText` are unchanged.

  Two cost defects fixed in passing:

  - `getModelPricing` missed dated model IDs. `claude-haiku-4-5-20251001` did
    not match the `claude-haiku-4-5` table key, fell through to the
    unknown-model fallback, and billed Haiku at Sonnet rates — 3x on input and
    output. That over-count feeds CostTracker's hard spend cap, so a caller
    pinning a model ID tripped the cap early. Dated suffixes now resolve to
    their undated alias; genuinely unknown models still take the conservative
    fallback.
  - The logger dropped every key not in `SAFE_LOG_KEYS`, which silently
    discarded `sources`, `costUsd`, and `durationMs` from the `runAnswer`
    completion line. Added those plus the new `fromSearchRawContent` and
    `crawled` crawl-avoidance counters.

## 0.8.7

### Patch Changes

- d430d70: Ship a Braintied proprietary LICENSE and correct the license field.

  Sixteen of these packages declared `"license": "MIT"` and the repository
  contained no LICENSE file at all, while the two highest-value packages were the
  only ones marked UNLICENSED. MIT permits sublicensing and redistribution and
  survives termination of any surrounding agreement, so an MIT declaration would
  have given any recipient a perpetual right to the code regardless of contract.

  All eighteen now declare UNLICENSED and ship the same proprietary LICENSE file.
  No runtime behaviour changes.

## Unreleased

### Bright Data primary / Apify opt-in only (2026-08-01)

- **Policy:** Bright Data is the preferred social acquisition plane. Apify runs only when `APIFY_ALLOW_FALLBACK=1|true|yes` **and** `APIFY_API_TOKEN` is set (`isApifyFallbackAllowed`).
- **TikTok:** keyword discovery via Bright Data `discover_new` + `discover_by=keyword` on posts dataset `gd_lu702nij2f790tmv9h` (same as Swishh). URL fetch remains Bright Data scrape first.
- **Facebook groups:** prefer `BRIGHTDATA_FB_GROUPS_DATASET_ID` via `fetchFacebookGroupPostsBrightData`; Apify groups scraper is opt-in fallback.
- **X:** twitterapi.io → official X API; Apify tweet scraper only with the allow flag (Bright Data does not replace global X keyword search).
- **New:** `discoverAndDownload()` on the Bright Data client; `APIFY_ALLOW_FALLBACK` in `RESEARCH_ENV_NAMES`.
