#!/usr/bin/env tsx
/**
 * Crawl4AI live smoke test
 *
 * Crawls a stable public URL through the real ora-scraper service and reports
 * which lane served. The unit suite mocks the wire entirely; this is the only
 * check that catches request-shape drift between the package client and the
 * deployed Crawl4AI server (the typed-config bug class: flat `crawler_params`
 * is silently IGNORED by 0.8.x — measured 1 char vs 5,898 chars on the same
 * URL, Sentigen 2026-06-20).
 *
 * Never runs in CI: it is a script, not a `test/` file, and it exits 0 with a
 * SKIP line unless both gates are present.
 *
 * Usage:
 *   CRAWL4AI_URL=https://ora-scraper.fly.dev \
 *   BRAINTIED_CRAWL4AI_NETWORK_GUARD=enforced-v1 \
 *   BRAINTIED_CRAWL4AI_ALLOWED_DOMAINS='*' \
 *   RESEARCH_LIVE_TEST=1 \
 *   tsx --env-file=.env.local scripts/smoke-test-crawl4ai.ts [url]
 *
 * Default target: https://www.iana.org/domains/example (stable, IANA-operated,
 * and content-rich enough to clear the 200-char evidence floor that
 * crawlUrlDetailed enforces; example.com's ~133 chars cannot).
 * Exit 0 = crawl4ai lane served. Exit 1 = it declined or errored (the reason
 * is printed; `direct_fetch` serving is still a FAIL — that is the fallback
 * doing the primary lane's job, which is the drift this exists to catch).
 */

import { crawlUrlDetailed } from '../src/pipeline-core.js';
import { resolveResearchCredentials } from '../src/credentials.js';

const target = process.argv[2] ?? 'https://www.iana.org/domains/example';

if (process.env.RESEARCH_LIVE_TEST !== '1' || process.env.CRAWL4AI_URL === undefined) {
  console.log('SKIP: set RESEARCH_LIVE_TEST=1 and CRAWL4AI_URL to run the live crawl smoke');
  process.exit(0);
}

async function main(): Promise<number> {
  const credentials = resolveResearchCredentials(process.env);
  if (credentials.crawl4ai === undefined) {
    console.error('FAIL: CRAWL4AI_URL is set but resolveResearchCredentials produced no crawl4ai config');
    return 1;
  }

  const started = performance.now();
  const result = await crawlUrlDetailed(credentials, target);
  const latencyMs = Math.round(performance.now() - started);

  console.log(`target:   ${target}`);
  console.log(`method:   ${result.method ?? 'none'}`);
  console.log(`declined: ${result.declinedReason ?? 'n/a'}`);
  console.log(`chars:    ${result.text === null ? 0 : result.text.length}`);
  console.log(`latency:  ${latencyMs}ms`);

  if (result.method !== 'crawl4ai' || result.text === null || result.text.length < 200) {
    console.error('FAIL: the crawl4ai lane did not serve a usable crawl');
    return 1;
  }

  console.log('OK: crawl4ai lane served a usable crawl end-to-end');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('FAIL: smoke test threw', error);
    process.exit(1);
  });
