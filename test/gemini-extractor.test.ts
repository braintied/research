import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeGeminiExtractionPayload } from '../src/providers/gemini-extractor.js';
import type { GeminiExtractInput } from '../src/providers/gemini-extractor.js';

function extractFixture(
  payload: Record<string, unknown>,
  input: Partial<GeminiExtractInput> = {},
) {
  return normalizeGeminiExtractionPayload(
    payload,
    {
      provider: 'tavily',
      url: 'https://docs.example/article',
      content: 'Offline fixture content.',
      mode: 'longform',
      ...input,
    },
    { promptTokenCount: 100, candidatesTokenCount: 50 },
  );
}

test('unknown sentiment is omitted and valid sentiment is normalized case-insensitively', () => {
  const result = extractFixture({
    key_claims: ['The source documents the behavior.'],
    verbatim_quotes: [
      {
        quote: 'Unknown labels do not destroy this quote.',
        source_url: 'https://docs.example/article',
        sentiment: 'informational',
      },
      {
        quote: 'Mixed-case labels normalize safely.',
        source_url: 'https://docs.example/article',
        sentiment: '  PoSiTiVe  ',
      },
    ],
  });

  assert.equal(result.verbatim_quotes.length, 2);
  assert.equal(result.verbatim_quotes[0]?.sentiment, undefined);
  assert.equal(result.verbatim_quotes[1]?.sentiment, 'positive');
});

test('one malformed quote or optional field cannot erase valid siblings and key claims', () => {
  const result = extractFixture({
    key_claims: ['A valid claim survives.', 123, 'A second valid claim survives.'],
    verbatim_quotes: [
      {
        quote: 'A valid sibling survives.',
        sentiment: 'neutral',
      },
      {
        quote: 123,
        sentiment: 'positive',
      },
      {
        quote: 'Malformed optional metadata is omitted, not fatal.',
        author: 42,
        published_at: 'not-a-date',
        engagement: 'not-an-object',
        sentiment: { unexpected: true },
        category: false,
      },
    ],
  });

  assert.deepEqual(result.key_claims, [
    'A valid claim survives.',
    'A second valid claim survives.',
  ]);
  assert.deepEqual(
    result.verbatim_quotes.map((quote) => quote.quote),
    [
      'A valid sibling survives.',
      'Malformed optional metadata is omitted, not fatal.',
    ],
  );
  assert.deepEqual(result.verbatim_quotes[1]?.engagement, {});
  assert.equal(result.verbatim_quotes[1]?.author, undefined);
  assert.equal(result.verbatim_quotes[1]?.published_at, undefined);
  assert.equal(result.verbatim_quotes[1]?.sentiment, undefined);
  assert.equal(result.verbatim_quotes[1]?.category, undefined);
});

test('long-form citations are always bound to the fetched parent URL', () => {
  const parentUrl = 'https://docs.example/article';
  const result = extractFixture({
    verbatim_quotes: [{
      quote: 'A model-selected anchor cannot replace the long-form parent.',
      source_url: `${parentUrl}#details`,
    }],
  }, { url: parentUrl, mode: 'longform' });

  assert.equal(result.verbatim_quotes[0]?.source_url, parentUrl);
});

test('social and video anchors require the same origin and canonical source', () => {
  const parentUrl = 'https://www.youtube.com/watch?v=abc123&utm_source=test';
  const result = extractFixture({
    verbatim_quotes: [
      {
        quote: 'A safe timestamp anchor is preserved.',
        source_url: 'https://www.youtube.com/watch?v=abc123#t=42',
      },
      {
        quote: 'A safe relative timestamp anchor is preserved.',
        source_url: '#t=84',
      },
      {
        quote: 'A cross-origin URL is rejected.',
        source_url: 'https://attacker.example/watch?v=abc123#t=42',
      },
      {
        quote: 'A different same-origin video is rejected.',
        source_url: 'https://www.youtube.com/watch?v=other#t=42',
      },
    ],
  }, { provider: 'youtube', url: parentUrl, mode: 'youtube' });

  assert.equal(
    result.verbatim_quotes[0]?.source_url,
    'https://www.youtube.com/watch?v=abc123#t=42',
  );
  assert.equal(
    result.verbatim_quotes[1]?.source_url,
    'https://www.youtube.com/watch?v=abc123&utm_source=test#t=84',
  );
  assert.equal(result.verbatim_quotes[2]?.source_url, parentUrl);
  assert.equal(result.verbatim_quotes[3]?.source_url, parentUrl);
});
