import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasVerifiableSentence,
  isVerbatimQuoteSupportedBySource,
} from '../src/evidence-validation.js';
import { selectUrlsToFetch } from '../src/fetch-selection.js';
import { htmlToStructuredText } from '../src/pipeline-core.js';
import { SearchResultSchema, SubquerySchema } from '../src/types.js';

test('htmlToStructuredText keeps block structure so a heading never fuses with the next sentence', () => {
  const html = [
    '<html><head><title>T</title><style>p{}</style></head><body>',
    '<nav>Menu Home About</nav>',
    '<h2>Why Is My Tent Stove Smoking?</h2>',
    '<p>A wood stove can turn a cold night into a warm camp.</p><p>Wet wood produces more smoke.</p>',
    '<ul><li>Dry the firewood</li><li>Clean the chimney</li></ul>',
    '<p>It&rsquo;s simple&nbsp;&amp; cheap &#8212; really.</p>',
    '</body></html>',
  ].join('');
  const text = htmlToStructuredText(html);
  assert.equal(text.includes('Menu Home'), false);
  assert.deepEqual(text.split('\n\n'), [
    'Why Is My Tent Stove Smoking?',
    'A wood stove can turn a cold night into a warm camp.',
    'Wet wood produces more smoke.',
    'Dry the firewood',
    'Clean the chimney',
    'It’s simple & cheap — really.',
  ]);
  // The quotes an extractor copies from that page are now complete lines.
  assert.equal(isVerbatimQuoteSupportedBySource('Wet wood produces more smoke.', text), true);
  assert.equal(
    isVerbatimQuoteSupportedBySource('A wood stove can turn a cold night into a warm camp.', text),
    true,
  );
});

test('htmlToStructuredText decodes an entity once', () => {
  assert.equal(htmlToStructuredText(`<p>${'x'.repeat(10)} &amp;lt;b&amp;gt;</p>`), `${'x'.repeat(10)} &lt;b&gt;`);
});

const transcript = [
  '# A review',
  '[t=1] today we are reviewing the away',
  '[t=3] large suitcase. The wheels are quiet',
  '[t=6] and the handle feels solid.',
  '[t=9] Next we test the zipper.',
].join('\n');

test('caption lines are rejoined so a spoken sentence can be quoted', () => {
  assert.equal(
    isVerbatimQuoteSupportedBySource('The wheels are quiet and the handle feels solid.', transcript),
    true,
  );
  assert.equal(isVerbatimQuoteSupportedBySource('Next we test the zipper.', transcript), true);
});

test('caption rejoining stays fail-closed: changed words and fragments still fail', () => {
  assert.equal(
    isVerbatimQuoteSupportedBySource('The wheels are loud and the handle feels solid.', transcript),
    false,
  );
  assert.equal(isVerbatimQuoteSupportedBySource('and the handle feels solid.', transcript), false);
});

test('a page with no complete sentence cannot yield evidence', () => {
  assert.equal(hasVerifiableSentence('# Video title - YouTube About Press Copyright Contact us'), false);
  assert.equal(hasVerifiableSentence('[t=1] right in\n[t=2] i got the set of three'), false);
  assert.equal(hasVerifiableSentence('[t=1] right in.\n[t=2] next'), true);
  assert.equal(hasVerifiableSentence('He said "stop." Then left'), true);
});

function result(url: string, sections: string[]): ReturnType<typeof SearchResultSchema.parse> {
  return SearchResultSchema.parse({
    provider: 'searxng',
    url,
    title: url,
    snippet: '',
    retrieved_for: sections,
  });
}

test('the fetch window is per subquery, so a later section is never starved by an earlier one', () => {
  const subqueries = ['A.1', 'B.1', 'C.1'].map((section_path) => SubquerySchema.parse({
    section_path,
    query: `q ${section_path}`,
    providers: ['searxng'],
  }));
  // Section A's eight hits come first in the merged list, as they do in a run.
  const results = [
    ...Array.from({ length: 8 }, (_, i) => result(`https://a.example/${i}`, ['A.1'])),
    ...Array.from({ length: 8 }, (_, i) => result(`https://b.example/${i}`, ['B.1'])),
    ...Array.from({ length: 8 }, (_, i) => result(`https://c.example/${i}`, ['C.1'])),
  ];
  const selected = selectUrlsToFetch(subqueries, results, 3, 400).map((r) => r.url);
  assert.equal(selected.length, 9);
  assert.equal(selected.filter((u) => u.startsWith('https://b.example')).length, 3);
  assert.equal(selected.filter((u) => u.startsWith('https://c.example')).length, 3);
  // The old window, `results.slice(0, 3 * 3)`, reached none of section C and one page of B.
  assert.equal(results.slice(0, 9).filter((r) => r.url.startsWith('https://c.example')).length, 0);
});

test('a URL shared by two sections is fetched once, and the ceiling holds', () => {
  const subqueries = ['A.1', 'B.1'].map((section_path) => SubquerySchema.parse({
    section_path,
    query: `q ${section_path}`,
    providers: ['searxng'],
  }));
  const shared = result('https://shared.example/', ['A.1', 'B.1']);
  const results = [shared, result('https://a.example/', ['A.1']), result('https://b.example/', ['B.1'])];
  assert.equal(selectUrlsToFetch(subqueries, results, 3, 400).length, 3);
  assert.equal(selectUrlsToFetch(subqueries, results, 3, 2).length, 2);
});
