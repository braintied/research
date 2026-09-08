import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUBLIC_FIGURE_CATEGORIES,
  PUBLIC_FIGURE_TAXONOMY,
  publicFigureTaxonomy,
} from '../src/ingestion/public-figure.js';
import { CONTRACTOR_TAXONOMY } from '../src/ingestion/categorize.js';

// ---------------------------------------------------------------------------
// Why these exist.
//
// Measured 2026-09-08 on the Tucker Hamilton corpus (422 items, 3.28M chars):
// `category` was 'other' on every row, because the harvest script's own flag
// said "--categorize  run the contractor-taxonomy categorizer (off for people)".
// Turning it on would have classified a change-of-command speech as `tip` or
// `competitor`, so it was correctly left off — and the corpus shipped with no
// judgement layer at all for want of a second taxonomy.
//
// Two properties matter here. A taxonomy for a person has to name the person
// (a generic prompt classifies against a generic prior), and it must not
// disturb the contractor default that every existing caller still gets.
// ---------------------------------------------------------------------------

test('every category carries a description and the fallback is one of them', () => {
  const t = publicFigureTaxonomy('Tucker Hamilton', 'a retired Air Force test pilot and podcast host');
  for (const category of t.categories) {
    const description = t.categoryDescriptions[category];
    assert.ok(
      description !== undefined && description.trim().length > 0,
      `category "${category}" has no description`,
    );
  }
  assert.ok(t.categories.includes(t.fallback), 'fallback is not one of the categories');
  // An empty scan would pass the loop above vacuously.
  assert.equal(t.categories.length, PUBLIC_FIGURE_CATEGORIES.length);
  assert.ok(t.categories.length >= 5);
});

test('the subject name reaches every prompt field that should carry it', () => {
  const t = publicFigureTaxonomy('Ada Lovelace', 'a mathematician');
  assert.match(t.audienceBrief, /Ada Lovelace/);
  assert.match(t.categoryDescriptions.thesis ?? '', /Ada Lovelace/);
  assert.match(t.categoryDescriptions.guest_subject ?? '', /Ada Lovelace/);
  assert.match(t.categoryDescriptions.press ?? '', /Ada Lovelace/);
  assert.match(t.quoteVoice, /Ada Lovelace/);
  // The descriptor is what stops `craft` collapsing into `doctrine`.
  assert.match(t.audienceBrief, /a mathematician/);
});

test('a missing name or descriptor throws rather than producing a generic prompt', () => {
  assert.throws(() => publicFigureTaxonomy('', 'a pilot'), /subjectName is required/);
  assert.throws(() => publicFigureTaxonomy('  ', 'a pilot'), /subjectName is required/);
  assert.throws(() => publicFigureTaxonomy('Tucker', ''), /descriptor is required/);
  assert.throws(() => publicFigureTaxonomy('Tucker', '   '), /descriptor is required/);
});

test('the quote instruction refuses to presume the speaker', () => {
  const t = publicFigureTaxonomy('Tucker Hamilton', 'a podcast host');
  // A person corpus built from an interview show is mostly other people
  // talking. A quoteVoice that says "in his voice" gets guests' sentences
  // attributed to the host, which is the failure claims-about-people.md names.
  assert.match(t.quoteVoice, /VERBATIM/);
  assert.match(t.quoteVoice, /do NOT\s+assume the speaker/);
  assert.doesNotMatch(t.quoteVoice, /in (his|her|their) (own )?voice/i);
});

test('guest_subject exists and tells the model to prefer it when unsure', () => {
  const t = publicFigureTaxonomy('Tucker Hamilton', 'a podcast host');
  assert.ok(t.categories.includes('guest_subject'));
  assert.match(t.categoryDescriptions.guest_subject ?? '', /whenever/i);
});

test('the contractor default is untouched', () => {
  assert.equal(CONTRACTOR_TAXONOMY.fallback, 'other');
  assert.deepEqual(
    [...CONTRACTOR_TAXONOMY.categories],
    ['tip', 'tool', 'news', 'win', 'pain_point', 'trend', 'competitor', 'other'],
  );
  assert.match(CONTRACTOR_TAXONOMY.audienceBrief, /FOR CONTRACTORS/);
  // No category name is shared, so a row's category still says which taxonomy
  // classified it.
  const overlap = PUBLIC_FIGURE_CATEGORIES.filter(
    (c) => (CONTRACTOR_TAXONOMY.categories as readonly string[]).includes(c) && c !== 'other',
  );
  assert.deepEqual(overlap, []);
});

test('the no-subject export is valid but generic, so a caller can tell', () => {
  assert.equal(PUBLIC_FIGURE_TAXONOMY.fallback, 'other');
  assert.match(PUBLIC_FIGURE_TAXONOMY.audienceBrief, /the subject/);
});
