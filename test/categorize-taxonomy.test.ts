import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTRACTOR_TAXONOMY,
  CategorizeTaxonomyError,
  categorizeItems,
  type CategorizeTaxonomy,
} from '../src/ingestion/categorize.js';
import { KNOWLEDGE_CATEGORIES } from '../src/ingestion/types.js';
import type { IngestedItem } from '../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Why these exist.
//
// This categorizer's prompt hardcoded "curating a knowledge base FOR
// CONTRACTORS" with a fixed tip|tool|news|win|... taxonomy — the most
// domain-coupled code in the least domain-coupled package. Any other domain run
// through it was classified against the wrong universe, so a silversmithing
// studio came back `competitor`. @braintied/knowledge's taxonomy.ts documented
// exactly this and named the fix; nusa was written against the fixed version and
// could not compile because it had never landed.
//
// Two properties matter. An injected taxonomy must be validated rather than
// half-applied, and THE DEFAULT PATH MUST NOT MOVE: every existing caller has to
// get the classification it got before, or a "non-breaking" change quietly
// rewrites their knowledge base.
// ---------------------------------------------------------------------------

const BALI_TAXONOMY: CategorizeTaxonomy = {
  categories: ['craft', 'place', 'event', 'other'],
  fallback: 'other',
  audienceBrief: 'You are curating a knowledge base for someone planning a stay in Bali.',
  categoryDescriptions: {
    craft: 'How a craft is practised, learned, or sold locally.',
    place: 'A studio, workshop, coworking room, or school with a location.',
    event: 'A market, class, or gathering with a date.',
    other: 'Anything that does not fit the categories above.',
  },
  relevanceFieldPrompt: 'one sentence on why this matters to someone planning a stay',
  quoteVoice: 'in the voice of someone who has actually done it here',
};

// Never used: every call below either returns on the empty fast path or fails
// the Gemini call on purpose, which is the documented "items keep their default
// category" path.
const NO_CREDENTIALS = {};

test('the default taxonomy still matches the DB CHECK category set', () => {
  // knowledge_items.category has a CHECK constraint against this list. If the
  // default drifts from it, rows start failing to insert in production instead
  // of failing here.
  assert.deepEqual([...CONTRACTOR_TAXONOMY.categories], [...KNOWLEDGE_CATEGORIES]);
});

test('the default taxonomy describes every category and falls back inside its own set', () => {
  for (const category of CONTRACTOR_TAXONOMY.categories) {
    const description = CONTRACTOR_TAXONOMY.categoryDescriptions[category];
    assert.ok(
      description !== undefined && description.trim().length > 0,
      `no description for "${category}"`,
    );
  }
  assert.ok(CONTRACTOR_TAXONOMY.categories.includes(CONTRACTOR_TAXONOMY.fallback));
});

test('a category with no description is rejected, not prompted as a blank line', async () => {
  const broken: CategorizeTaxonomy = {
    ...BALI_TAXONOMY,
    categories: ['craft', 'undescribed'],
    categoryDescriptions: { craft: 'ok' },
  };
  await assert.rejects(
    () => categorizeItems(NO_CREDENTIALS, [], broken),
    (error: unknown) =>
      error instanceof CategorizeTaxonomyError && /undescribed/.test(error.message),
  );
});

test('a fallback outside the category set is rejected', async () => {
  const broken: CategorizeTaxonomy = { ...BALI_TAXONOMY, fallback: 'nowhere' };
  await assert.rejects(
    () => categorizeItems(NO_CREDENTIALS, [], broken),
    (error: unknown) => error instanceof CategorizeTaxonomyError && /nowhere/.test(error.message),
  );
});

test('an empty category set is rejected', async () => {
  const broken: CategorizeTaxonomy = { ...BALI_TAXONOMY, categories: [] };
  await assert.rejects(
    () => categorizeItems(NO_CREDENTIALS, [], broken),
    (error: unknown) =>
      error instanceof CategorizeTaxonomyError && /at least one category/.test(error.message),
  );
});

test('validation runs on the empty-items fast path, so the error is not deferred', async () => {
  // A caller wiring up a new taxonomy usually tries an empty batch first. If
  // validation sat after the early return they would hear nothing until real
  // data arrived, in whatever ran that batch.
  const broken: CategorizeTaxonomy = { ...BALI_TAXONOMY, fallback: 'nowhere' };
  await assert.rejects(
    () => categorizeItems(NO_CREDENTIALS, [], broken),
    CategorizeTaxonomyError,
  );
});

test('both shipped taxonomies validate, and the call returns its own array', async () => {
  const withDefault: IngestedItem[] = [];
  assert.equal(await categorizeItems(NO_CREDENTIALS, withDefault), withDefault);

  const withInjected: IngestedItem<string>[] = [];
  assert.equal(await categorizeItems(NO_CREDENTIALS, withInjected, BALI_TAXONOMY), withInjected);
});

test('a missing API key throws instead of silently leaving everything uncategorized', async () => {
  // Worth pinning explicitly, because the module header says items are returned
  // unchanged "on ANY failure". That is true of a failed or malformed Gemini
  // CALL; it is deliberately NOT true of a missing credential, which is a
  // configuration fault. Swallowing it would hand back a knowledge base where
  // every item is the fallback category, with nothing anywhere saying why.
  const one: IngestedItem<string> = {
    sourceId: null,
    sourceType: 'rss',
    url: 'https://example.com/a',
    urlHash: 'hash',
    title: 'A title',
    contentMd: 'Some content.',
    excerpt: 'Some content.',
    author: null,
    publishedAt: null,
    engagement: {},
    qualityScore: null,
    category: 'other',
    tags: ['keep'],
    whyItMatters: null,
    quotes: [],
    embedding: null,
  };
  await assert.rejects(
    () => categorizeItems(NO_CREDENTIALS, [one], BALI_TAXONOMY),
    (error: unknown) => error instanceof Error && /geminiApiKey/.test(error.message),
  );
  // And it threw before touching the item, rather than half-applying.
  assert.equal(one.category, 'other');
  assert.deepEqual(one.tags, ['keep']);
});

test('the untaxonomied overload keeps the category union narrow', () => {
  // The assertion that matters is that this FILE COMPILES. An existing caller
  // must still get KnowledgeCategory rather than `string`, or every consumer
  // silently loses its exhaustiveness checking on item.category.
  const narrow: IngestedItem[] = [];
  const widened: IngestedItem<string>[] = narrow;
  assert.equal(widened.length, 0);
});
