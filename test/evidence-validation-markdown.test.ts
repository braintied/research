import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isKeyClaimSupportedBySource,
  isVerbatimQuoteSupportedBySource,
} from '../src/evidence-validation.js';

// Shape of real crawl4ai output: links, emphasis, bullets, headings, and
// several sentences on one line.
const crawledPage = [
  '# Smooth scroll, settled',
  'Lenis is a free, [open-source library](https://github.com/darkroomengineering/lenis) that turns native scroll into a silky experience. One call to `new Lenis()` and you are done. It powers **hundreds** of award-winning sites.',
  '  * [Locomotive Scroll](https://locomotivemtl.github.io/) now runs on _Lenis_ under the hood.',
  '> Scroll-linked effects lag because browsers run them asynchronously.',
  '1. Install the package with pnpm.',
].join('\n');

test('a plain-text quote of a sentence that carries a Markdown link is accepted', () => {
  assert.equal(
    isVerbatimQuoteSupportedBySource(
      'Lenis is a free, open-source library that turns native scroll into a silky experience.',
      crawledPage,
    ),
    true,
  );
});

test('emphasis, inline code, bullets, blockquotes and numbered items are presentation only', () => {
  assert.equal(isVerbatimQuoteSupportedBySource('It powers hundreds of award-winning sites.', crawledPage), true);
  assert.equal(isVerbatimQuoteSupportedBySource('One call to new Lenis() and you are done.', crawledPage), true);
  assert.equal(isVerbatimQuoteSupportedBySource('Locomotive Scroll now runs on Lenis under the hood.', crawledPage), true);
  assert.equal(
    isVerbatimQuoteSupportedBySource('Scroll-linked effects lag because browsers run them asynchronously.', crawledPage),
    true,
  );
  assert.equal(isKeyClaimSupportedBySource('Install the package with pnpm.', crawledPage), true);
});

test('the quote may keep the Markdown the source had', () => {
  assert.equal(isVerbatimQuoteSupportedBySource('It powers **hundreds** of award-winning sites.', crawledPage), true);
});

test('adjacent complete sentences inside one line are accepted, up to a whole line', () => {
  assert.equal(
    isVerbatimQuoteSupportedBySource(
      'One call to new Lenis() and you are done. It powers hundreds of award-winning sites.',
      crawledPage,
    ),
    true,
  );
  assert.equal(
    isVerbatimQuoteSupportedBySource(
      'Lenis is a free, open-source library that turns native scroll into a silky experience. One call to new Lenis() and you are done. It powers hundreds of award-winning sites.',
      crawledPage,
    ),
    true,
  );
});

test('still fail-closed: paraphrase, changed words, fragments and cross-line spans are rejected', () => {
  // paraphrase
  assert.equal(isVerbatimQuoteSupportedBySource('Lenis is an open-source smooth scroll library.', crawledPage), false);
  // one word changed
  assert.equal(isVerbatimQuoteSupportedBySource('It powers thousands of award-winning sites.', crawledPage), false);
  // a fragment of a sentence
  assert.equal(isVerbatimQuoteSupportedBySource('turns native scroll into a silky experience', crawledPage), false);
  // non-adjacent sentences stitched together
  assert.equal(
    isVerbatimQuoteSupportedBySource(
      'Lenis is a free, open-source library that turns native scroll into a silky experience. It powers hundreds of award-winning sites.',
      crawledPage,
    ),
    false,
  );
  // a span that crosses a line break
  assert.equal(
    isVerbatimQuoteSupportedBySource(
      'It powers hundreds of award-winning sites. Locomotive Scroll now runs on Lenis under the hood.',
      crawledPage,
    ),
    false,
  );
  // the link URL is not readable text and cannot be quoted as if it were
  assert.equal(isVerbatimQuoteSupportedBySource('https://github.com/darkroomengineering/lenis', crawledPage), false);
  // key claims keep their four-token floor
  assert.equal(isKeyClaimSupportedBySource('Smooth scroll, settled', crawledPage), false);
});

test('snake_case identifiers and lone asterisks are not treated as emphasis', () => {
  const source = 'Set user_id and workspace_id on every row. Prices start at 5 * 2 credits.';
  assert.equal(isVerbatimQuoteSupportedBySource('Set user_id and workspace_id on every row.', source), true);
  assert.equal(isVerbatimQuoteSupportedBySource('Set userid and workspaceid on every row.', source), false);
  assert.equal(isVerbatimQuoteSupportedBySource('Prices start at 5 * 2 credits.', source), true);
});
