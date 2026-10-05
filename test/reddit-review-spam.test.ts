import assert from 'node:assert/strict';
import test from 'node:test';

import { dropBrandReviewSpam, isBrandReviewSpamSubreddit } from '../src/providers/reddit.js';
import { SearchResultSchema } from '../src/types.js';

const QUERY = 'Monos vs Away checked luggage wheels durability';

function post(subreddit: string, author: string, id: string): ReturnType<typeof SearchResultSchema.parse> {
  return SearchResultSchema.parse({
    provider: 'reddit',
    url: `https://www.reddit.com/r/${subreddit}/comments/${id}/t/`,
    title: `post ${id}`,
    snippet: '',
    author: `u/${author}`,
    raw_metadata: { subreddit },
  });
}

test('brand review feeds named for a query word are spam', () => {
  for (const name of ['monos_reviews', 'Monosreviews', 'Monosluggagereviews', 'AwayReviews', 'away_luggage_review']) {
    assert.equal(isBrandReviewSpamSubreddit(name, QUERY), true, name);
  }
});

test('real communities and review subs unrelated to the query are kept', () => {
  for (const name of ['onebag', 'travel', 'BuyItForLife', 'malefashionadvice', 'reviews', 'headphonereviews', 'Samsonite']) {
    assert.equal(isBrandReviewSpamSubreddit(name, QUERY), false, name);
  }
});

test('a review-named subreddit with a single author across the batch is dropped even when its name is not in the query', () => {
  const kept = dropBrandReviewSpam(QUERY, [
    post('zululuggagereviews', 'shill1', 'a'),
    post('zululuggagereviews', 'shill1', 'b'),
    post('onebag', 'alice', 'c'),
    post('travel', 'bob', 'd'),
  ]);
  assert.deepEqual(kept.map((r) => r.raw_metadata['subreddit']), ['onebag', 'travel']);
});

test('several authors in a review-named subreddit is a community, not a feed', () => {
  const kept = dropBrandReviewSpam(QUERY, [
    post('zululuggagereviews', 'a1', 'a'),
    post('zululuggagereviews', 'a2', 'b'),
  ]);
  assert.equal(kept.length, 2);
});

test('the Monos luggage batch keeps only the audience threads', () => {
  const kept = dropBrandReviewSpam(QUERY, [
    post('monos_reviews', 'u1', '1'),
    post('Monosreviews', 'u1', '2'),
    post('Monosluggagereviews', 'u2', '3'),
    post('onebag', 'alice', '4'),
  ]);
  assert.deepEqual(kept.map((r) => r.raw_metadata['subreddit']), ['onebag']);
});
