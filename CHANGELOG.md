## 5.1.0

### Minor Changes

- 1de3deb: New `@braintied/artists`: find a specialist artist and their studio near a place, tattoo first. Four injected lanes (Google Maps via pets, OpenStreetMap `shop=tattoo`, Google web search for Instagram artists and studio sites, an Instagram profile reader), each allowed to fail on its own; a studio-site reader for per-artist styles and handles, contacts, house calls, consultations, hygiene copy and printed rates; artist↔studio links by handle, tag, bio link or phone; every claim marked unverified with its source and date; `tattooPreferenceFact` for Cortex `human_facts`.

  `@braintied/serpapi`: the `google` web engine (`googleSearch`, `parseGoogleSearch`), schema read off a live 2026-10-30 response, including `/goto` redirect links and Instagram rows.

  `@braintied/research`: a `./public-http` subpath export of the existing outbound guard (`fetchPublicText`, `isPublicAddress`, `resolvePublicHttpUrl`, `UnsafeOutboundUrlError` and their types), node built-ins only, so a consumer fetches public pages through research's pinned, per-hop address check without importing the rest of research. `@braintied/artists` fetches studio sites through it.

### Patch Changes

- Updated dependencies [bce2fb9]
- Updated dependencies [a9be5bd]
  - @braintied/cost@6.12.3
  - @braintied/models@4.3.0

## 5.0.2

### Patch Changes

- Updated dependencies [2847125]
- Updated dependencies [2847125]
  - @braintied/cost@6.12.2
  - @braintied/models@4.2.0

## 5.0.1

### Patch Changes

- Updated dependencies [8845059]
  - @braintied/cost@6.12.1

## 5.0.0

### Major Changes

- fb643fa: Extraction now adapts to the evidence each section actually gets, instead of a fixed page count.

  Each section receives `firstWavePagesPerSection` pages. After every wave the run counts validated quotes and claims per section, and the distinct source documents behind them (same-page anchors such as `#comment-…` or `#t=…` count as one document). Only sections still below the depth's target (`evidenceTargetUnits` from at least `evidenceTargetSources` documents) get more pages, thinnest first. Later waves size each short section's share so the worker pool stays busy. A page feeds, and is queued under, every section it was retrieved for, so a page one section no longer needs is still read for another, and it is never extracted twice.

  Extraction stops when every section is at target, candidates run out, the page ceiling is reached, the run's hard cap is spent, or extraction spend (the `extract` cost category only) would pass `EXTRACT_SPEND_SHARE` (60%) of the cap. Each page's estimated cost is reserved before dispatch, so parallel calls cannot jointly overshoot. The refinement pass counts evidence earlier passes already hold. The loop is `runAdaptiveExtraction`, a pure driver the pipeline calls with its extractor.

  `maxExtractPages` becomes a safety ceiling (quick 16, blog 32, standard 96, wide 192) rather than the plan. Targets: quick 3 units/1 source, blog 4/2, standard 6/2, wide 8/3. New exports: `runAdaptiveExtraction`, `takeAdaptiveExtractWave`, `sectionEvidenceFrom`, `sectionNeedsEvidence`, `EXTRACT_SPEND_SHARE` and their types. `allocateExtractBudgetFairShare` stays exported for existing callers but the pipeline no longer uses it. The evidence funnel adds `pageBudget`, `extractWaves`, `sourcesNotNeeded`, `sourcesSkippedForCost` and `sectionsBelowTarget`.

  Measured 2026-10-26: a standard run on a five-question brief planned 20 sections, discovered 186 sources across web, Reddit and YouTube, and could read 14 main-pass pages. It cited 8 sources and left 11 of 20 sections as evidence gaps at $0.03 of a $2 cap.

  Major because `DepthTunables` gains required members (`firstWavePagesPerSection`, `evidenceTargetUnits`, `evidenceTargetSources`) and `EvidenceFunnel` gains required counts. No function signature changed.

## 4.1.0

### Minor Changes

- 5d77166: Trip atlas, productized. `@braintied/places` gains the `Atlas` contract (strict Zod schema for meta, spots with media and voices carrying source kind and provenance, timeline, plans, booked; optional `checked_at` and per-spot `sources` for spots pinned from a shared link), `atlasPublicity`, the OSRM distance table with a per-country road-time factor, and Natural Earth country geo prep with a point-of-view option. `@braintied/departure` adds `planToAtlas`, projecting a stored plan into the atlas timeline and bookings. `@braintied/research` SearXNG search takes an `images` category, returns `img_src`, and accepts an injected `fetch`. New `@braintied/atlas` runs the engine: geo, distances, Commons, media gathering (SearXNG, crawl4ai, SerpApi Google Images metered through `@braintied/cost`), the page build and a CLI.

## 4.0.0

### Major Changes

- d203ed8: The zod peer range is now `^4.6.7` (was `^4.4.3`). zod below 4.6.6 is affected by GHSA-mrhx-c7xc-m3w5 (high: memory exhaustion when validating oversized constrained collections). Major because a narrowed peer range is a breaking change to the install contract: a consumer on zod 4.4.x or 4.5.x must move to zod 4.6.7 or later. No API changed.

## 3.1.3

### Patch Changes

- 00d35fb: run-internal-research: treat a terminal durable status as terminal. A `failed` run (HTTP 500 with the run's `error_code`) or an expired one (410 `RUN_EXPIRED`) now exits non-zero with the code and a one-line reason, and rewrites the metadata checkpoint to `checkpoint_status: terminal_failure` with `error_code` and `error_reason`. The checkpoint used to stay at `awaiting_terminal_result`, so `bt-research` resumed a run the worker had already rejected (`RESEARCH_INPUT_REJECTED`, a `--max-cost-usd` above the worker's $5 `INTERNAL_RESEARCH_MAX_COST_USD`) for 3 hours. Queued and running runs still poll and resume as before.

## 3.1.2

### Patch Changes

- Updated dependencies [fea3dbe]
- Updated dependencies [6c5e59c]
  - @braintied/cost@6.12.0
  - @braintied/models@4.1.1

## 3.1.1

### Patch Changes

- Updated dependencies [c3b03f5]
  - @braintied/cost@6.11.0

## 3.1.0

### Minor Changes

- d5ed410: New `fetchInstagramProfile(credentials, handleOrUrl, { signal, maxWaitMs, resumeSnapshotId })`: one public Instagram profile in one Bright Data call, with display name, bio, every bio link, counts, profile image and the recent posts (caption, media URLs, permalink, timestamp) the profiles dataset carries on the same record. A collection still running at the wait budget answers `{ status: 'pending', snapshotId }`; pass the id back as `resumeSnapshotId` to collect it without a second bill. The profile fetch path now also reads the website when Bright Data sends `external_url` as an array (it was dropped before).

## 3.0.6

### Patch Changes

- Updated dependencies [72fc9c7]
  - @braintied/cost@6.10.0

## 3.0.5

### Patch Changes

- Updated dependencies [1b8bf40]
  - @braintied/models@4.1.0

## 3.0.4

### Patch Changes

- Updated dependencies [9cd4748]
  - @braintied/cost@6.9.0

## 3.0.3

### Patch Changes

- Updated dependencies [4079ed0]
  - @braintied/models@4.0.0

## 3.0.2

### Patch Changes

- Updated dependencies [f1184ce]
  - @braintied/models@3.0.0

## 3.0.1

### Patch Changes

- Updated dependencies [01bf4fa]
  - @braintied/models@2.0.0

## 3.0.0

### Major Changes

- f613878: Reddit corpus: `collectRedditCorpus` (subreddits x queries to one file per thread with full comment trees via `/api/morechildren` and continue-thread expansion, resumable store, per-request error list, no usernames by default), `discoverSubreddits`, client `moreChildren` and `searchSubreddits`, and the `reddit-corpus.mjs` runner (`check`, `discover`, `collect`) that exits 2 without OAuth credentials.

### Patch Changes

- Updated dependencies [b10e2dd]
  - @braintied/cost@6.8.0

## 2.9.2

### Patch Changes

- Updated dependencies [7ef64f8]
  - @braintied/models@1.25.0

## 2.9.1

### Patch Changes

- Updated dependencies [eea26d3]
  - @braintied/cost@6.7.0

## 2.9.0

### Minor Changes

- 326270c: Answer quality: reports now answer the brief, and say when they do not.

  - Brief analysis (one cheap call) lists the brief's explicit questions, the facts each asks for (version, date, price, name...), and the primary source it names or implies.
  - Primary sources are searched with `site:`/`include_domains` and their canonical pages are fetched directly, ahead of search results and the extract budget.
  - Fetch quality: short error, bot-wall and script-failure pages and navigation shells are rejected before extraction; verbatim site chrome ("A required part of this site couldn't load", cookie and browser notices) is dropped as evidence.
  - Extraction reads a question-focused window of long pages and is told the questions (the extract cache key carries both).
  - Relevance gate: every evidence unit is judged against the questions before synthesis; off-topic units never reach a section.
  - The executive summary answers each question fact by fact with exact evidence sentences, or says which fact is missing, and ends with the answer check line.
  - New `answer_quality` on `FinalReport` (and `answerQuality` on pipeline results): answered facets, primary-source citation, gate and fetch counts, `summary_line`, `passed`. The skill runners write it to metadata (`answer_quality`, `answer_quality_status`, `answer_quality_passed`, `answer_check`).
  - Grounding accepts a short citation (two or three tokens, such as "Bot API 10.3") only as an exact match of a validated verbatim quote.
  - New eval: `evals/run-answer-quality.ts` with ten briefs and expected answer facts.

## 2.8.2

### Patch Changes

- ff4e078: Bright Data snapshot polling no longer abandons a triggered, billed snapshot on one bad poll. Instagram `waitForSnapshot` and the tolerant `pollSnapshot` now share `waitForBrightDataSnapshot`: inside the overall wait ceiling, a progress poll that times out, hits a network error, or gets HTTP 5xx/429 is counted and retried. Terminal snapshot statuses, caller aborts, and other 4xx responses still fail at once. At the ceiling, Instagram throws `InstagramSnapshotPendingError` and `pollSnapshot` throws the new `BrightDataSnapshotPendingError`, both carrying `snapshotId` and the last transient failure. `pollSnapshot` now honors `signal`, so `scrapeDataset`'s caller abort reaches the poll loop.

## 2.8.1

### Patch Changes

- Updated dependencies [fec5fc4]
- Updated dependencies [fec5fc4]
- Updated dependencies [05de09c]
  - @braintied/cost@6.6.0
  - @braintied/models@1.24.0

## 2.8.0

### Minor Changes

- 1c7f35b: `@braintied/research`: the Reddit client carries what the hosts moving onto it read today. `RedditPost` gains `isSelf`, `score` (Reddit's net score; `ups` when Reddit omits it), `linkFlairText`, `over18` and `quarantine`; `RedditComment` gains `score`. `listSubreddit` accepts the `controversial` sort, and `fetchThread` takes a comment `sort` (`RedditCommentSort`: `confidence`, `top`, `new`, `controversial`, `old`, `qa`). `fetchThread` resolves `https://redd.it/<id>` short links to the post and refuses one that names no post, before any token is requested. Answers of 500, 502, 503 or 504 and network failures are retried with 1s then 2s backoff, three attempts in all, before `RedditApiError` carries the last status; a caller's abort is never retried.

## 2.7.0

### Minor Changes

- 4d0fb62: Report bibliographies now carry each source's author and published date
  (`[^n]: url — author, YYYY-MM-DD`) instead of a bare URL, via the exported
  `formatBibliographyLine`. `parseMarkdownReport` reads the date from any
  trailer position, so a dated source with no author round-trips. Readers of the
  corpus can now tell how old the evidence behind a report is.

  Bibliography entries also carry `scraped_at` (when the run obtained the
  source's content), so the stored report says when its evidence was scraped.
  The internal runner prints a `braintied_internal_research_progress` line every
  minute while polling, with the server run's heartbeat age and a `stalled` flag
  after ten silent minutes, so a hung durable run is visible long before the
  client deadline.

- 6244719: `@braintied/research`: `createRedditClient(credentials, { fetchImpl?, now?, sleep? })` is the one fleet Reddit client. It owns the OAuth client_credentials token (cached per client id, refreshed 60s before expiry, dropped and retried once on a 401), paces requests at 650ms per client id, waits for `x-ratelimit-reset` when `x-ratelimit-remaining` reaches 0, and backs off on 429 for `Retry-After` or the reset header up to 3 attempts before throwing `RedditApiError` (`status`, `reason`, `stage`). Reads only go to `oauth.reddit.com` with `redirect: 'error'`: `search`, `listSubreddit` (`hot` / `new` / `top` / `rising`) and `fetchThread`, which returns the full nested comment tree and the count of unexpanded `more` children. `probe()` and `probeReddit(researchCredentials)` return `{ ok, latencyMs, rateLimitRemaining }` or `{ ok: false, stage, status?, reason }` without throwing or exposing a secret. `REDDIT_VAULT_KEYS` and `redditCredentialsFromResolver(resolve)` name the platform vault rows `reddit/client_id`, `reddit/client_secret`, `reddit/user_agent`.

  The `reddit` provider now runs on this client; its search results, filters, markdown and `reddit_oauth_api` backend are unchanged, and thread fetches now request `raw_json=1`, so comment text arrives without HTML entities. Unauthenticated `www.reddit.com` / `old.reddit.com` JSON answers HTTP 403 (verified 2026-10-11), and hosts that hand-rolled their own Reddit OAuth should move onto this client.

### Patch Changes

- 74036d0: Optional peers stay optional when they are installed anyway.

  GitHub Packages serves no `peerDependenciesMeta`, so a strict install now puts every optional peer of every package in `node_modules`. A string-literal `import('playwright')` is then followed by the consumer's bundler and file tracer, `webpackIgnore` or not (esbuild ignores the comment, and OpenNext builds Workers with esbuild). Runtime-only peers now load through each package's own `importOptionalPeer(specifier)`: a non-literal specifier with `webpackIgnore` and `@vite-ignore`, which no bundler or tracer follows and Node still resolves from the package.

  - seo: `playwright` and `@braintied/agentic-browser` (the root entry no longer drags a browser driver into a Next or Worker build).
  - agentic-browser: `@browserbasehq/sdk`, `@browserbasehq/stagehand`, `@1password/sdk`.
  - agent-audit: `playwright`, `@braintied/cost`. marketplace: `playwright`. media (`/site`), vectorize: `sharp`; vectorize: `@neplex/vectorizer`. draft: `@resvg/resvg-js`. vault-client: `@1password/sdk`.
  - investor: `puppeteer`, `@sparticuz/chromium`, `pdf-lib`, `pdfjs-dist`, `@napi-rs/canvas`. A host that runs the PDF export inside a bundled serverless function names them in its own trace (`serverExternalPackages` or `outputFileTracingIncludes`).
  - investor booking slide: the `@braintied/bookings-react` import carried `webpackIgnore`, which left a bare specifier in the browser bundle that no browser resolves, so the slide always showed the missing-package note. It is now a literal the bundler splits into its own chunk, with `turbopackOptional` so a Turbopack build without the peer still compiles.
  - press, meeting-ship: their non-literal imports gain `webpackIgnore`, so webpack no longer compiles them into a context module that throws.
  - kit, stage-terminal, investor (booking), meeting-intelligence, meeting-ship, research, video-review declare the peers they import by literal on purpose in `braintied.literalOptionalPeers`, each with the reason a consumer's bundler or tracer must see it.
  - blog (`harness`) and agent-surface import `@braintied/seo/site` instead of the package root. Every symbol they use is there, and the root entry carries the distribution harness (`child_process`, the browser loaders) into the consumer's bundle; Parlor's herochurch moved to `/site` for the same reason (ga1ien/parlor#592).

- Updated dependencies [d4e68e8]
- Updated dependencies [1add23c]
- Updated dependencies [b4892f7]
  - @braintied/cost@6.5.0
  - @braintied/models@1.23.0

## 2.6.1

### Patch Changes

- Updated dependencies [72dfb7a]
- Updated dependencies [e487b68]
  - @braintied/cost@6.4.1

## 2.6.0

### Minor Changes

- b8f9256: `@braintied/models`: `failoverLadderForResolution(resolution, { residency?, providers? })` returns the failover ladder for a resolution a caller already holds. Candidate 0 is that resolution unchanged, and the use-case's provider binding and the process residency apply as in `resolveFailoverLadder`.

  `@braintied/research`: `callModel` fails over to the same model on another host. A DeepSeek 402 (empty prepaid balance), 429, 5xx or no response moves the call to Fireworks when `FIREWORKS_API_KEY` is configured. When every host fails it throws `FailoverExhaustedError`, and the extractor and the categoriser rethrow it (new export `isProviderAccountFailure`, also true for 401/403) instead of returning an empty result. Measured 2026-10-07 (PT): with the fleet DeepSeek balance at $0.00, every page extraction failed with HTTP 402 and was logged as a bad page, so paid runs finished `partial` / `ungrounded` with zero citations for about $0.002 and no stated cause. Such a run now fails and names the cause, or is served by Fireworks.

### Patch Changes

- Updated dependencies [b8f9256]
  - @braintied/models@1.22.0

## 2.5.1

### Patch Changes

- 1b72dfb: `SearchOpts.search_locale` sets SerpApi `hl`/`gl` (default en/us, unchanged).
- 1b72dfb: `inferredTravelCommunities` takes an optional destination-to-subreddit table (`DestinationCommunities`); the shipped `DESTINATION_COMMUNITIES` stays the default.

## 2.5.0

### Minor Changes

- f9eb4d1: The RSS, sitemap and Hacker News lanes no longer send `contact: team@braintied.com`. `setResearchUserAgentContact(contact)` (exported) lets the host name its own operator contact once at its process boundary; unset, the User-Agent names the library and lane only. To keep the old header call `setResearchUserAgentContact('team@braintied.com')`.

### Patch Changes

- Updated dependencies [f9eb4d1]
  - @braintied/cost@6.4.0

## 2.4.9

### Patch Changes

- d16c132: The default logger now writes every level to stderr. `info` and `debug` used `console.info` / `console.debug`, which write to stdout, so any CLI importing the package (for example the Reddit provider's `[Reddit] event` lines on every search and fetch) had library diagnostics mixed into its stdout and could not emit clean JSON. Sanitization is unchanged.
- Updated dependencies [fcd523f]
- Updated dependencies [57751f5]
- Updated dependencies [d2098bb]
  - @braintied/cost@6.3.0
  - @braintied/models@1.21.0

## 2.4.8

### Patch Changes

- Updated dependencies [eafd4f3]
  - @braintied/models@1.20.1

## 2.4.7

### Patch Changes

- Updated dependencies [4a4f670]
  - @braintied/cost@6.2.0

## 2.4.6

### Patch Changes

- Updated dependencies [bcc4032]
- Updated dependencies [db08949]
  - @braintied/cost@6.1.0
  - @braintied/models@1.20.0

## 2.4.5

### Patch Changes

- Updated dependencies [03fbeef]
- Updated dependencies [03fbeef]
- Updated dependencies [03fbeef]
- Updated dependencies [03fbeef]
- Updated dependencies [03fbeef]
- Updated dependencies [03fbeef]
- Updated dependencies [03fbeef]
- Updated dependencies [00b31e6]
- Updated dependencies [03fbeef]
  - @braintied/cost@6.0.0
  - @braintied/models@1.19.0

## 2.4.4

### Patch Changes

- 55eee22: The internal research runner accepts `sourceKeySha256` on private-manifest evidence. research.run's `privateManifest()` has emitted this one-way digest of the canonical source URL since 2026-07-24 (ora-ai 4c6580d78), but the runner's allow-list never included it, so every live profile run that returned private Cortex evidence failed validation after Cortex had done (and billed) the work. Measured 2026-09-25 on travel-intelligence@1. The value, when present, must be a 64-character lowercase hex digest. This fix sat uncommitted in the `research-main` install worktree since 2026-09-25 and is moved here so the worktree can be refreshed.

## 2.4.3

### Patch Changes

- 1308086: Paid runs stopped dropping almost every quote before synthesis. Four causes, each measured on a real luggage brief (2026-09-30): the fetch window was the first `subqueries x urlsPerSubquery` entries of the merged result list, so later sections' pages were never fetched and read "no source-validated evidence" (now each subquery's own top results are fetched); the direct-fetch lane flattened a page to one line, fusing headings to sentences and joining `</p><p>` with no space (now block tags become line breaks and entities decode once), which had rejected 21 of 25 quotes copied exactly; the extractor prompt asked for "paragraphs" while validation accepts one to four sentences (the prompt now states the contract); and caption lines of a video transcript are rejoined before validation. Pages with no complete sentence are no longer extracted, so they stop spending the run's page budget (`EvidenceFunnel.sourcesWithoutVerifiableText`). Section synthesis is asked to draw on every distinct source before repeating one.
- 0de46f6: Reddit search drops brand review-spam subreddits: a query word plus an optional short qualifier plus `review(s)` (`monos_reviews`, `Monosluggagereviews`), and any review-named subreddit whose threads in a batch all come from one author. New exports `isBrandReviewSpamSubreddit` and `dropBrandReviewSpam`. The `brightdata-async` test no longer flakes under load: its wall-clock poll budget was 100 ms.

## 2.4.2

### Patch Changes

- d4af2f1: Reddit search drops threads that share only one incidental query word (a luggage brief returned Mars-rover and robot posts into the bibliography). The community coverage entry for a non-software job with no HN/RSS/podcast results now reports `required: false` with a reason instead of `required: true, passed: true` over zero discoveries.

## 2.4.1

### Patch Changes

- Updated dependencies [9503674]
  - @braintied/models@1.18.1

## 2.4.0

### Minor Changes

- 9c924ba: Neutral env names, read first, with the old names kept as fallbacks: `RESEARCH_GEMINI_KEY_NAME`, `RESEARCH_CRAWL4AI_ALLOWED_DOMAINS`, `RESEARCH_CRAWL4AI_NETWORK_GUARD`, `RESEARCH_GITHUB_PUBLIC_TOKEN` and `RESEARCH_GITHUB_REQUIRE_AUTH` (were `BRAINTIED_*`). `RESEARCH_ENV_NAMES` lists both; the runner script imports and honours both. New exports `NEUTRAL_GEMINI_KEY_NAME_ENV`, `NEUTRAL_CRAWL4AI_ALLOWED_DOMAINS_ENV`, `NEUTRAL_CRAWL4AI_NETWORK_GUARD_ENV`. A deployment that changes nothing keeps working.

### Patch Changes

- Updated dependencies [6a9d932]
- Updated dependencies [6a9d932]
  - @braintied/cost@5.0.1
  - @braintied/models@1.18.0

## 2.3.0

### Minor Changes

- 2aeb411: Research model stages move to `deepseek-flash` under the fleet default. Planning, per-page extraction, categorisation, synthesis, critique and assembly now all go through one transport, `callModel`, which routes by the `@braintied/models` resolution's provider instead of by model-name prefix: google on its native generateContent, OpenRouter for `qwen*` overrides, and every other provider (DeepSeek, Fireworks, Anthropic, Z.ai) on its Anthropic-compatible Messages endpoint from `providerWires`. Under the `deepseek_flash` default every stage resolves DeepSeek V4.1 Flash and needs `DEEPSEEK_API_KEY`; under `BRAINTIED_DATA_RESIDENCY=us` it resolves the same weights on Fireworks and needs the new `ResearchCredentials.fireworksApiKey` (`FIREWORKS_API_KEY`). A host that does not supply the resolved provider's key gets `MissingCredentialError` naming that field, as it did for Gemini.

  Cost attribution follows the model that ran: extraction and planner rows carry the resolved provider (they were hard-coded `google`), `getModelPricing` / `tryGetModelPricing` price any catalog id from `@braintied/models` (so `deepseek-flash` is no longer booked at the Sonnet fallback under `anthropic`), `ModelPricing.provider` widens to `string`, and usage telemetry keeps every catalog model id (the hand-kept allowlist dropped `deepseek-flash`). The extract stage runs with thinking off (its `effort: 'minimum'`); critique keeps the provider's default thinking and gets a 16k output ceiling so the thinking cannot truncate its JSON. New exports: `callModel`, `providerForModelId`, `UnroutableModelError`, `researchStageResolution`, and the `ModelCallInput` / `ModelCallResult` / `ModelCallTarget` types. `synthesisGenerate` remains as the same function.

### Patch Changes

- Updated dependencies [991cc18]
- Updated dependencies [2aeb411]
- Updated dependencies [761fd01]
  - @braintied/models@1.17.0

## 2.2.1

### Patch Changes

- a6dd6ec: Republish against `@braintied/cost@5.0.0`. Research's `@braintied/cost` dependency is `workspace:*`, resolved to whatever cost version sits in this workspace at publish time; the last research release (2.2.0) predated cost's 5.0.0 (pets' `estimateVendorCost` use forced that bump), so the published 2.2.0 packument still declares cost `4.2.0` exactly. Downstream, ora-ai's cortex-worker pins one exact cost version fleet-wide and could not raise it past `4.2.0` without research following. Patch because 5.0.0 only adds `trackSandbox`/`estimateSandboxCost`, which research does not call — no API surface of research changes.

## 2.2.0

### Minor Changes

- 9734a3c: Source validation no longer throws away real evidence from web pages. Fetched pages arrive as crawler Markdown (`**bold**`, `[anchor](url)`, bullets, headings), and the validator compared an extractor's plain-text quote against that raw Markdown. Measured 2026-09-26 on five real pages: 54 of 68 genuine prose lines were rejected. Since 2026-09-23, 13 of 17 paid runs in the on-demand ledger failed or came back thin; one run discovered 55 sources and kept none.

  - Markdown presentation syntax is removed from both the quote and the source before comparison. Words are never changed, so a paraphrase, a changed word or a sentence fragment is still rejected.
  - A quote may now be a run of up to four adjacent complete sentences inside one line. The contract always said "sentence or line", but a multi-sentence line could never match, even whole.
  - New `evidenceFunnel` on `RunDeepResearchResult` and `KindResearchResult`: sources with content, extracted, skipped for budget, quotes and claims extracted versus validated, and sources that kept nothing. The internal runner writes it to metadata as `evidence_funnel` and includes it in the thin-report event, so a thin run names the stage that lost its evidence.

  The same quick-tier query went from 0 cited sources (ungrounded, 7 of 7 sections empty) to 5 cited sources with grounding 0.8 at the same cost ($0.026).

### Patch Changes

- 7bac958: SearXNG's round-robin fallback now remembers a transport failure (timeout, HTTP error, bad response shape) for 5 minutes and skips that instance on later queries in the same process, instead of paying its full per-instance timeout again on every query. An empty-but-200 response never marks an instance dead — that stays a per-query content signal.

  Measured 2026-09-24: `ora-cortex-worker` v704's research canary quarantined admission with `canary_transport_timeout`. `cortex-searxng-b`/`-c` have zero Fly machines (fully removed, not autostopped), so every fallback request to either blocked at Fly's edge for the full 12s default timeout instead of failing fast. `cortex-searxng-a`, the one live instance, also returns HTTP 200 with 0 results on many production query shapes, which forced the fallback loop through both dead instances on nearly every query. A full profile-driven research run issues dozens of queries; multiplied by up to 24s of dead-instance timeout per query, that exceeded the deploy canary's own timeout outright.

## 2.1.0

### Minor Changes

- 9a1a914: New `travel-intelligence@1` research profile, and destination-aware Reddit scoping for travel questions.

  The profile sends one trip question to every place the answer lives, and ranks official rules above everything else:

  - **Official rules:** government visa, entry-rule and passenger-rights pages.
  - **Expert blogs:** OMAAT, TPG, Frequent Miler, View from the Wing and others.
  - **Reddit:** travel and destination subreddits.
  - **Social and video:** X, YouTube walkthroughs, and TikTok/Instagram.
  - **Local groups:** Facebook groups, where long-stay rental markets trade.

  Official rules, expert tactics and first-hand traveller experience are required coverage. Social, video and local-group evidence is optional and labelled as leads.

  `inferredRedditCommunities` now scopes travel questions to r/travel, r/solotravel, r/TravelHacks and r/digitalnomad, plus the destination's own subreddits (Goa, Mumbai, India, Bali, Indonesia, Japan, Thailand, Mexico, Portugal). It adds r/Flights and r/awardtravel when the question calls for them. Measured 2026-09-24: an unscoped search for "Mopa taxi to Mandrem" returned laser-engraver pages.

  Bare "trip", "points" and "miles" do not trigger travel scoping, so a psychedelic "trip" or customer "pain points" stay unscoped. Burning Man keeps r/BurningMan.

### Patch Changes

- d9e4be2: `scripts/install-skill.sh` installs with the pnpm version the repo pins in `packageManager`, not whatever `pnpm` is on PATH. When the two differ it runs `npx pnpm@<pinned>`. If install or build fails, it prints the last 30 lines of output and the path to the full log. Before this, pnpm 8.15.6 on the agent laptop refused the lockfile and the script failed without saying why.
- d8158ac: The internal research runner's `ADMISSION_LIMIT_REACHED` error now leads with concurrency, which is the usual cause and clears in seconds. The old text blamed the daily reserved-cost window, so operators read a refusal as "out of budget" and stopped. The worker folds six policy checks into that one code, so the message names all of them and gives the query that shows which one fired. `ADMISSION_PAUSED` gets its own text: admission is paused, not over a limit.
- b3caab8: The internal research runner now finds the `@braintied/research` package root from a skill install. A copy under `~/.claude/skills/run-braintied-research/scripts` resolved `../../../` to `~/.claude` and read `~/.claude/package.json`. It now checks `$BRAINTIED_RESEARCH_PACKAGE_ROOT`, then the package it ships in, then `~/Development/stack/packages/research`, takes the first whose `package.json` is named `@braintied/research`, and fails naming every path it tried when none is. `scripts/install-skill.sh` installs the skill as a symlink into a worktree pinned to `origin/main`, replacing the hand copy under `~/.claude/skills`.

## 2.0.0

### Major Changes

- Published as 2.0.0, not 1.11.0. The registry was at 1.9.2, and 1.10.0 (never published) added `"linkedin"` to the evidence `provider` union. That widens `EvidenceItemSchema`, `RESEARCH_PROFILES` and every profile's `requiredProviders` / `sourcePacks` types, so a consumer switching exhaustively over providers must handle `linkedin`. `stack.mjs publish` measured this against 1.9.2 and required a major. No runtime behaviour differs from the 1.11.0 entry below; 1.11.0 was never published.

### Minor Changes (carried from 1.11.0)

- da23cc9: Standard and blog research refine their gaps again, the internal runner takes `--sources`, and run metadata reports evidence coverage.

  - `critiqueMaxPasses` counts critique calls, and the loop's last pass never refines. The 2026-08-01 cost program set standard and blog to 1, meaning to keep one refinement round; 1 is zero rounds. Measured on the two standard runs of 2026-09-24: 13 of 20 sections came back as evidence gaps labelled "after refinement" while no refinement search ran. Standard and blog are now 2 (one round). `refinementRounds()` states the semantics; the Cortex Worker prompt runner shares them.
  - Part of the extract budget (30%, never more than half) is held for the refinement round. The main pass used 20 of 20 standard pages before the first critique, so a refinement could search but never extract. `refinementExtractReserve()`; the total page budget is unchanged.
  - `run-internal-research.mjs --sources web,github --as-of <date>` forwards `sourceModes` to `research.run`, which the worker already accepted. The fleet CLI advertised `--sources` and the internal path could not send it.
  - Final metadata carries `evidence_coverage` (`complete`/`partial`/`thin`/`empty`), computed from the returned sections by `evidence-coverage.mjs`, and the runner prints a `thin_report` event when under half the sections carry evidence. Grounding stays as it was: it grades the citations present, and coverage says how many sections have any.

## 1.10.1

### Patch Changes

- Updated dependencies [3f1319e]
- Updated dependencies [3f1319e]
  - @braintied/cost@4.2.0
  - @braintied/models@1.16.0

## 1.10.0

### Minor Changes

- efce796: A strict LinkedIn public-profile provider and `consented-person@1`, the research
  program for looking up one person who asked to be looked up.

  `fetchLinkedInPublicProfile` takes one `/in/<id>` URL the subject supplied and
  returns their own published profile — headline, about, positions, education,
  skills, location, and the sites the profile itself lists — as one
  `EvidenceItem` per field, each tagged `first_party_statement` with its source
  URL and retrieval time. It is modelled on `providers/instagram.ts`, not on the
  tolerant LinkedIn _posts_ wrapper: that wrapper logs a warning and returns `[]`
  when its dataset id is unset, and a tolerated empty result is the wrong
  contract for a person's name twice over — it reads as "this person has no
  profile" to an interview about to open with what it just learned, and it hides
  a misconfiguration behind someone's identity.

  Two guards decide who this is, and both refuse rather than degrade. A URL that
  is not one member's profile is refused (`/company/`, `/school/`, `/feed/`,
  `/posts/`, a search URL, and `/in/<id>/recent-activity/` — a sub-page is not
  the profile, and some of those sub-pages are other people). A record whose
  `/in/<id>` is not the one asked for raises
  `LinkedInProfileIdentityMismatchError`, as does a declared subject that
  disagrees with the URL — checked BEFORE the fetch, because refusing after the
  records are billed still bills them. Connections, followers, recommendations
  and "people also viewed" are not in the normalizer at all, so their absence is
  structural rather than a policy comment.

  `consented-person@1` is registered under the fleet's `slug@version`
  convention. Its inputs are the subject's own anchors — their name plus a link,
  handle, city, or affiliation THEY gave — and a name with nothing to anchor it
  to is refused, because a name alone matches every namesake. What it
  deliberately does not do: no people-search or background-check sites (a
  41-entry denylist applied twice, as `excludeDomains` on every pack and again
  by `isDeniedSource` after results come back, because a provider that ignores
  an exclude parameter fails silently); no inference of a personal fact, with
  health, finances, family, legal, sexuality, politics, immigration and religion
  named in the preamble and the output contract requiring a source URL and an
  exact quote per item; nobody but the subject; no Cortex ingest, and no index
  sink on the run; and `snapshot` mode only, since a standing watch on a named
  human is a different product needing its own consent.

  Both refuse without a consent row. `requireSourceConsent` takes the
  `ConsentRow` a caller got from `@braintied/consent`'s `requireConsent` — the
  row, not a boolean, because a boolean is the caller's assertion that it
  checked, carries no notice hash and no proof, and is satisfied by `true`. Four
  refusals are named separately: missing, wrong purpose, not granted (with the
  state, so `withdrawn` and `stale` say why), and a grant with no `recordUri`.
  "Wrong purpose" is the quiet one: a route holding `source:interview` that
  reaches a web-research fetch has a real grant in hand and is still reading
  something the person did not agree to.

  The per-subject cost ceiling is the approved budget, structurally
  `@braintied/on-demand`'s `OnDemandApproval`, passed through to the pipeline's
  existing `maxCostUsd`. No new cap field: a number the runner reads and the
  pipeline does not is a lie told to whoever reads the config. An optional
  `spendGate` accepts `@braintied/pricing/gate`'s decision, and the TIGHTER of
  the two ceilings binds — taking the looser is how Sentigen ended up with two
  limits and no bound. There is deliberately no `ON_DEMAND_REQUIRE_APPROVAL=0`
  bypass; this package reads no environment, and an env var that turns off budget
  approval for a run against a named human is the wrong thing to have available.

  Also: `linkedin` joins the closed provider set as a FETCH-ONLY provider
  (`capabilities.search === false`) and is absent from `SOURCE_TYPE_ROUTING`, so
  no planner fan-out can route to it and no pipeline run can write a discovery
  carrying the name — a consumer with a provider CHECK constraint needs no
  migration until it deliberately persists LinkedIn profile evidence. The
  `./evidence` subpath now also carries the `EvidenceItem` type (type-only, so
  nothing joins that subpath's runtime bundle), so `@braintied/onboarding-core`
  can hold the evidence contract without importing the engine. Namesake
  resolution is injected rather than imported: `@braintied/entity-resolution`
  depends on `@supabase/supabase-js`, and a database client inside a
  third-party-safe engine is the wrong trade, so the default `anchorMatch` is
  exact-anchor matching that fails closed and a host wanting fuzzier scoring
  passes its own matcher in.

  `test:instagram` became `test:dist` over `tests/*.test.mjs`, so a new
  build-level test file is discovered rather than sitting there uninvoked. It
  earned its place immediately: the root index re-exports providers by an
  explicit allow-list, not `export *`, so the whole new surface was missing from
  the built package while every source-level test passed.

### Patch Changes

- Updated dependencies [4e2d462]
  - @braintied/cost@4.1.0

## 1.9.6

### Patch Changes

- Updated dependencies [d9468ef]
  - @braintied/models@1.15.0

## 1.9.5

### Patch Changes

- Updated dependencies [0ee8e20]
  - @braintied/models@1.14.0

## 1.9.4

### Patch Changes

- Updated dependencies [0c2eed7]
  - @braintied/models@1.13.0

## 1.9.3

### Patch Changes

- Updated dependencies [b27d34f]
  - @braintied/models@1.12.0

## 1.9.2

### Minor Changes

- Expose `fetchTweetWithBackends(credentials, tweetId, opts?)` (plus the
  `XBackend`, `XBackendAttempt`, `XTweetChainResult`, `XTweetChainOptions` types)
  from `providers/x.ts`, re-exported through `providers/index` and the package
  barrel. It runs the declared X transport chain (`twitterapi_io` -> `x_api_v2`
  -> `apify`) and returns the RAW winning-backend tweet payload plus the backend
  that served it and the fallback trail, so a consumer with its own rich X
  assembler survives one vendor going down. `createXProvider` and the
  `SearchProvider` contract are unchanged.

  Republished as 1.9.2 (not 1.9.0/1.9.1) to rebuild against the current base:
  1.9.0/1.9.1 were cut from a stale checkout and pinned unpublished
  `@braintied/cost@3.3.1`; 1.9.2 pins the published `@braintied/cost@3.4.0` and
  `@braintied/models@1.10.0`.

## 1.9.0

### Minor Changes

- 6f19cc8: New `./evidence` subpath export: `isVerbatimQuoteSupportedBySource` and
  `isKeyClaimSupportedBySource` from `src/evidence-validation.ts`.

  They were reachable from nowhere. Both are used inside `src/index.ts` and
  neither was ever re-exported from it, so a second consumer needing the
  fail-closed contract — a quote must equal one complete fetched sentence or
  line, a key claim must too and carry at least four tokens — had no import path
  and had to copy them. `@braintied/intros` is that second consumer, checking a
  model's cited evidence against an approved profile field, and its first draft
  did exactly that: a private `approved.includes(evidence_text)`, which accepts
  any fragment. A complete-sentence check decays into a substring check the
  moment it is copied.

  The module is pure string matching with no imports, so it is its own tsup entry
  and the subpath pulls in none of the engine — no Anthropic or OpenAI SDK, no
  YouTube libraries, no `@braintied/cost`. The `@internal` tags on the two
  functions are now public documentation; nothing else changed and no existing
  export moved.

### Patch Changes

- Updated dependencies [3c2a1a4]
- Updated dependencies [a68c042]
- Updated dependencies [4e97d79]
- Updated dependencies [4e97d79]
- Updated dependencies [63d6c57]
- Updated dependencies [63d6c57]
- Updated dependencies [9896efe]
  - @braintied/cost@3.4.0
  - @braintied/models@1.10.0

## 1.8.0

### Minor Changes

- Add `publicFigureTaxonomy(subjectName, descriptor)` and `PUBLIC_FIGURE_TAXONOMY`: a
  categorizer taxonomy for a corpus that is ONE PERSON'S published output, classified by
  the job an item can do for a repurposing team rather than by subject matter. Categories
  are thesis / origin_story / doctrine / craft / promotion / tribute / guest_subject /
  press / other.

  `guest_subject` is the category that earns its place: a person corpus built from an
  interview show is mostly other people talking, and an engine that cannot separate the
  host's material from a guest's publishes a guest's sentence under the host's name. It
  is a weak signal read from an 800-character head — it narrows what a human or an
  utterance-level speaker check has to look at, and never establishes who spoke.

  `quoteVoice` deliberately refuses to presume the speaker, and both arguments to
  `publicFigureTaxonomy` throw when blank: the name reaches five prompt fields and a
  partial substitution is invisible in the output.

  Measured 2026-09-08 on a 422-item person corpus: `category` was `'other'`, `quotes`
  was `[]` and `why_it_matters` was `NULL` on every row, because the only taxonomy that
  existed classified for contractors. `CONTRACTOR_TAXONOMY` is unchanged and shares no
  category name except `other`.

## 1.7.2

### Patch Changes

- 7cae633: Instagram profile discovery waits up to 20 minutes (was 180 s, which gave up on a 247-post crawl Bright Data finished a minute later, records already billed), and a wait that still runs out throws `InstagramSnapshotPendingError` carrying the snapshot id. `discoverInstagramProfilePosts({ resumeSnapshotId })`, `CatalogIngestOptions.resumeInstagramSnapshotId` and `IngestSourceOptions.resumeInstagramSnapshotId` collect that snapshot without a second crawl.

## 1.7.1

### Patch Changes

- 30d7e1c: Catalog mode, two defects the first real harvest exposed (Tucker Hamilton, 2026-09-04):

  - Podcast episodes are keyed by their enclosure, not the feed's `<link>`. The Fighter Pilot Podcast feed carries 345 episodes and 13 distinct links (the show homepage on most of them), so the catalog stored 18. Generic RSS still keys on the article link.
  - Sitemap requests now carry a User-Agent (`fetchPublicText` sets none, and Duda answers a bare request with 403), and a refused sitemap is logged with its status instead of silently harvesting the seed page alone.

## 1.7.0

### Minor Changes

- d0a0ed7: Catalog mode for knowledge ingestion, the person-corpus door. A source with
  `config.mode = 'catalog'` enumerates ONE account's own output instead of
  searching a topic: a YouTube channel's uploads (`resolveChannelId` accepts a
  `UC…` id, a `/channel/` URL or an `@handle`), an Instagram profile's posts
  (`discoverInstagramProfilePosts`, Bright Data `discover_by=url`, the path Swishh
  creator enrichment already proved), every episode in a podcast or RSS feed, and
  a site's sitemap pages through `crawlUrl`. `config.transcribe = true` adds
  transcripts: YouTube through the existing captions → Groq → Deepgram stack, and
  podcast enclosures through the new `transcribeAudioUrl`, which HEAD-probes the
  file and skips Groq's 25 MB cap straight to Deepgram instead of downloading
  twice. `ResearchCredentials` gains `groqApiKey` / `deepgramApiKey`
  (`GROQ_API_KEY`, `DEEPGRAM_API_KEY`) so the ingestion core can reach the paid
  tiers without a host passing keys per call. Cost is metered per lane from what
  the providers bill (Bright Data per record, Groq/Deepgram per audio hour); the
  sweep lanes are unchanged.

  Built for the Tucker Hamilton corpus (Coxie 360, 2026-09-02): 282 channel
  uploads, 248 Instagram posts, 345 podcast episodes and a 10-page site, none of
  which the topic sweep (15 items, 30 days) could reach.

## 1.6.0

### Minor Changes

- 5df3c0d: SearXNG accepts an `engines` list (`youtube`, `reddit`, `bing`) so discovery can target those indexes without Tavily. `ingestSource` `web_search` uses SearXNG + Crawl4AI when SearXNG URLs are configured; Tavily is the fallback only when SearXNG is off. `recencyDays: 0` means no time filter (Reddit `t=all`).

### Patch Changes

- 45b852e: Coverage counts reddit.com / youtube.com hosts and native providers, not only `source_modes` tags. Web discovery prefers SearXNG (Tavily last). Burning Man briefs restrict Reddit to r/BurningMan. Non-software community seeds prefer RSS; empty HN does not fail coverage. `--kind deep` with reddit/youtube inherits recency 0.
- 43ca7c5: Source-mode seeds use the first heading of a brief, not the whole markdown, and only append software suffixes on software jobs. `--recency-days 0` is all-time (Reddit `t=all`). Measured 2026-08-26: a Burning Man culture deep run spent $0.47, required reddit+youtube ran, and the bibliography was soccer transfers, baby CPR, and a reggae video named Spark Up because the seed was the entire brief plus `engineering talk demo interview`.

- Coverage counts provider and URL host, not only `source_modes`. Web discovery prefers SearXNG. Burning Man briefs pin Reddit to r/BurningMan. Deep + reddit/youtube inherits recency 0. Empty HN is not a failed culture lane.
- Source-mode seeds compact to the first heading and skip software suffixes on non-software jobs. `--recency-days 0` is all-time. Measured 2026-08-26 on a Burning Man culture deep run ($0.47, required reddit+youtube ran, bibliography was off-topic).

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

### Bright Data primary / Apify opt-in only (2026-08-01)

- **Policy:** Bright Data is the preferred social acquisition plane. Apify runs only when `APIFY_ALLOW_FALLBACK=1|true|yes` **and** `APIFY_API_TOKEN` is set (`isApifyFallbackAllowed`).
- **TikTok:** keyword discovery via Bright Data `discover_new` + `discover_by=keyword` on posts dataset `gd_lu702nij2f790tmv9h` (same as Swishh). URL fetch remains Bright Data scrape first.
- **Facebook groups:** prefer `BRIGHTDATA_FB_GROUPS_DATASET_ID` via `fetchFacebookGroupPostsBrightData`; Apify groups scraper is opt-in fallback.
- **X:** twitterapi.io → official X API; Apify tweet scraper only with the allow flag (Bright Data does not replace global X keyword search).
- **New:** `discoverAndDownload()` on the Bright Data client; `APIFY_ALLOW_FALLBACK` in `RESEARCH_ENV_NAMES`.
