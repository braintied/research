import assert from 'node:assert/strict';
import test from 'node:test';

import { filterRedditByTopic } from '../src/providers/reddit.js';
import { SearchResultSchema } from '../src/types.js';

const QUERY = 'large checked suitcase durability wheels Monos Away Samsonite';

function post(title: string, snippet = ''): ReturnType<typeof SearchResultSchema.parse> {
  return SearchResultSchema.parse({
    provider: 'reddit',
    url: `https://www.reddit.com/r/x/comments/${encodeURIComponent(title).slice(0, 12)}/t/`,
    title,
    snippet,
  });
}

test('a thread that shares one incidental word is dropped', () => {
  const kept = filterRedditByTopic(QUERY, [
    post('Opportunity gazes back at its own tracks on Mars, battling dust storms and worn wheels'),
    post('Chinese company DEEP Robotics announced a quadruped model with wheels'),
  ]);
  assert.deepEqual(kept, []);
});

test('on-topic threads survive, matched on title or selftext', () => {
  const a = post('Monos vs Away checked luggage wheels');
  const b = post('My honest take after two years', 'The Samsonite suitcase wheels lasted, durability was fine');
  const kept = filterRedditByTopic(QUERY, [
    post('He is going off on a 10 day vacation with his ex-fiancee'),
    a,
    b,
  ]);
  assert.deepEqual(kept.map((r) => r.url), [a.url, b.url]);
});

test('a short query is not judged', () => {
  const results = [post('Anything at all')];
  assert.equal(filterRedditByTopic('luggage wheels', results).length, 1);
});
