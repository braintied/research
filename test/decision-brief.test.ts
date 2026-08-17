import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SHARED_CONTEXT_MAX_CHARS,
  questionHeadingFor,
  splitDecisionBriefQuestions,
} from '../src/decision-brief.js';
import { allocateExtractBudgetFairShare } from '../src/extract-budget.js';

const EIGHT_QUESTION_BRIEF = `# Lane brief

## Research stance
You are a database architect. Be strict.

## What we already have (do not re-survey)
- Postgres 17, pgvector, 84,667 triples.

## Decision-grade questions
1. Which graph extensions does hosted Supabase allow?
2. What is measured latency of recursive CTEs at 10^6 edges?
3. Can each option compose vector-kNN seeding + graph traversal
   in ONE query?
4. What do production GraphRAG-class systems run on Postgres?
5. What sync patterns exist for sidecar graph stores?
6. Does SQL/PGQ change the calculus in 12 months?
7. What physical schema is recommended for traversal speed?
8. What result-shaping keeps neighborhood queries under 500ms?

## Required output sections
1. Verified constraints.
2. Option matrix.
`;

test('splitDecisionBriefQuestions: 8 numbered questions with shared header', () => {
  const split = splitDecisionBriefQuestions(EIGHT_QUESTION_BRIEF);
  assert.notEqual(split, null);
  if (split === null) return;
  assert.equal(split.questions.length, 8);
  assert.equal(split.questions[0], 'Which graph extensions does hosted Supabase allow?');
  // Continuation lines join into one question.
  assert.equal(
    split.questions[2],
    'Can each option compose vector-kNN seeding + graph traversal in ONE query?',
  );
  // Shared context is everything before the questions heading.
  assert.ok(split.sharedContext.includes('Research stance'));
  assert.ok(split.sharedContext.includes('84,667 triples'));
  assert.ok(!split.sharedContext.includes('Decision-grade questions'));
  assert.ok(split.sharedContext.length <= SHARED_CONTEXT_MAX_CHARS);
  // Items under LATER headings ("Required output sections") are not questions.
  assert.ok(!split.questions.some((q) => q.includes('Option matrix')));
});

test('splitDecisionBriefQuestions: brief without a questions section yields null', () => {
  const split = splitDecisionBriefQuestions('# Plain brief\n\nJust one paragraph, no questions.');
  assert.equal(split, null);
});

test('splitDecisionBriefQuestions: fewer than two numbered items yields null', () => {
  const split = splitDecisionBriefQuestions('## Questions\n1. Only one question here?\n');
  assert.equal(split, null);
});

test('allocateExtractBudgetFairShare: 3 sections x 10 candidates, budget 6 -> 2 each, order kept', () => {
  interface Candidate { url: string; section: string; }
  const candidates: Candidate[] = [];
  for (const section of ['a', 'b', 'c']) {
    for (let i = 0; i < 10; i += 1) {
      candidates.push({ url: `${section}-${i}`, section });
    }
  }
  const allowed = allocateExtractBudgetFairShare(candidates, (c) => c.section, 6);
  assert.equal(allowed.length, 6);
  const bySection = new Map<string, string[]>();
  for (const c of allowed) {
    const list = bySection.get(c.section);
    if (list === undefined) {
      bySection.set(c.section, [c.url]);
    } else {
      list.push(c.url);
    }
  }
  assert.deepEqual(bySection.get('a'), ['a-0', 'a-1']);
  assert.deepEqual(bySection.get('b'), ['b-0', 'b-1']);
  assert.deepEqual(bySection.get('c'), ['c-0', 'c-1']);
  // Returned list preserves original candidate order.
  const indices = allowed.map((c) => candidates.indexOf(c));
  assert.deepEqual(indices, [...indices].sort((x, y) => x - y));
});

test('allocateExtractBudgetFairShare: budget exceeding candidates returns all', () => {
  const candidates = [{ s: 'a' }, { s: 'b' }];
  const allowed = allocateExtractBudgetFairShare(candidates, (c) => c.s, 10);
  assert.deepEqual(allowed, candidates);
});

test('allocateExtractBudgetFairShare: uneven sections still spend the whole budget', () => {
  // Section a has 1 candidate, section b has 5, budget 4: a gets 1, b gets 3.
  const candidates = [
    { url: 'a-0', s: 'a' },
    { url: 'b-0', s: 'b' },
    { url: 'b-1', s: 'b' },
    { url: 'b-2', s: 'b' },
    { url: 'b-3', s: 'b' },
    { url: 'b-4', s: 'b' },
  ];
  const allowed = allocateExtractBudgetFairShare(candidates, (c) => c.s, 4);
  assert.equal(allowed.length, 4);
  assert.deepEqual(allowed.map((c) => c.url), ['a-0', 'b-0', 'b-1', 'b-2']);
});

test('questionHeadingFor: q-prefixed path renders question heading, clipped to 12 words', () => {
  const titles = {
    q3: 'Can each option compose vector-kNN seeding plus graph traversal plus RLS predicates in one single transaction today?',
  };
  const heading = questionHeadingFor('q3.extensions', titles);
  assert.equal(
    heading,
    'Q3: Can each option compose vector-kNN seeding plus graph traversal plus RLS predicates…',
  );
});

test('questionHeadingFor: non-question paths and missing titles fall through', () => {
  assert.equal(questionHeadingFor('A.1', { q1: 'x' }), undefined);
  assert.equal(questionHeadingFor('q2.foo', { q1: 'x' }), undefined);
  assert.equal(questionHeadingFor('q1.foo', undefined), undefined);
});
