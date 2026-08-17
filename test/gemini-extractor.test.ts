import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeGeminiExtractionPayload } from '../src/providers/gemini-extractor.js';
import { buildGroundingEvidenceChunks, validateGrounding } from '../src/grounding.js';
import type { GeminiExtractInput } from '../src/providers/gemini-extractor.js';

const DEFAULT_SOURCE_CONTENT = [
  'The source documents the behavior.',
  'Unknown labels do not destroy this quote.',
  'Mixed-case labels normalize safely.',
  'A valid claim survives.',
  'A second valid claim survives.',
  'A valid sibling survives.',
  'Malformed optional metadata is omitted, not fatal.',
  'A model-selected anchor cannot replace the long-form parent.',
  'A safe timestamp anchor is preserved.',
  'A safe relative timestamp anchor is preserved.',
  'A cross-origin URL is rejected.',
  'A different same-origin video is rejected.',
].join('\n');

function extractFixture(
  payload: Record<string, unknown>,
  input: Partial<GeminiExtractInput> = {},
) {
  return normalizeGeminiExtractionPayload(
    payload,
    {
      provider: 'tavily',
      url: 'https://docs.example/article',
      content: DEFAULT_SOURCE_CONTENT,
      mode: 'longform',
      ...input,
    },
    { promptTokenCount: 100, candidatesTokenCount: 50 },
  );
}

test('model-inferred quote metadata is discarded even when it looks well formed', () => {
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
  assert.equal(result.verbatim_quotes[1]?.sentiment, undefined);
  assert.equal(result.verbatim_quotes[1]?.category, undefined);
  assert.deepEqual(result.verbatim_quotes[1]?.engagement, {});
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

test('a fabricated quote and claim from an unrelated source cannot circularly pass grounding', () => {
  const sourceUrl = 'https://docs.example/article';
  const fabricatedClaim = 'The platform guarantees a 91% reduction in checkout failures.';
  const extracted = extractFixture({
    key_claims: [fabricatedClaim],
    verbatim_quotes: [{
      quote: fabricatedClaim,
      source_url: sourceUrl,
      sentiment: 'positive',
    }],
  }, {
    url: sourceUrl,
    content: 'This source discusses orchard irrigation schedules and soil moisture.',
  });

  assert.deepEqual(extracted.key_claims, []);
  assert.deepEqual(extracted.verbatim_quotes, []);

  const chunks = buildGroundingEvidenceChunks({
    sourceQuotesByUrl: { [sourceUrl]: extracted.verbatim_quotes },
    claimsBySection: {
      'A.1': extracted.key_claims.map((claim) => ({
        claim,
        source_url: sourceUrl,
        provider: 'tavily',
      })),
    },
  });
  const grounding = validateGrounding({
    fullMarkdown: `${fabricatedClaim} [^1].`,
    bibliography: [{
      citation_anchor: '[^1]',
      source_url: sourceUrl,
      title: 'Unrelated source',
      author: '',
      provider: 'tavily',
    }],
    chunks,
  });

  assert.equal(chunks.length, 0);
  assert.notEqual(grounding.quality, 'strong');
  assert.equal(grounding.passed, false);
});

test('a model quote cannot splice sentences or omit a source qualifier', () => {
  const result = extractFixture({
    verbatim_quotes: [
      { quote: 'The product is safe Children died during independent clinical testing.' },
      { quote: 'Evidence shows the product is safe for unsupervised use.' },
    ],
  }, {
    content: [
      'The product is safe. Children died during independent clinical testing.',
      'Preliminary evidence shows the product is safe for unsupervised use.',
    ].join('\n'),
  });

  assert.deepEqual(result.verbatim_quotes, []);
});

test('verbatim validation preserves punctuation that changes meaning', () => {
  const result = extractFixture({
    verbatim_quotes: [
      { quote: "Let's eat Grandma." },
      { quote: 'No refunds are allowed.' },
    ],
  }, {
    content: "Let's eat, Grandma. No, refunds are allowed.",
  });

  assert.deepEqual(result.verbatim_quotes, []);
});

test('valid verbatim quotes survive Unicode punctuation and whitespace normalization', () => {
  const quote = `The caf\u00e9's "night ritual" uses hand-forged silver.`;
  const result = extractFixture({
    verbatim_quotes: [{ quote }],
  }, {
    content: 'The cafe\u0301\u2019s \u201cnight ritual\u201d\u00a0uses hand\u2011forged silver.',
  });

  assert.deepEqual(result.verbatim_quotes.map((entry) => entry.quote), [quote]);
});

test('complete source sentences survive fail-closed fetched-content validation', () => {
  const result = extractFixture({
    key_claims: [
      'The city council unanimously approved the accessibility rules as an international standard.',
    ],
  }, {
    content: 'The city council unanimously approved the accessibility rules as an international standard.',
  });

  assert.deepEqual(result.key_claims, [
    'The city council unanimously approved the accessibility rules as an international standard.',
  ]);
});

test('source validation preserves numeric units instead of treating punctuation as decoration', () => {
  const result = extractFixture({
    key_claims: ['Checkout failures fell by 91%.'],
    verbatim_quotes: [{ quote: 'Checkout failures fell by 91%.' }],
  }, {
    content: 'Checkout failures fell by 91 incidents during the pilot.',
  });

  assert.deepEqual(result.key_claims, []);
  assert.deepEqual(result.verbatim_quotes, []);
});

test('source-near overlap cannot hide a reversed predicate or negation', () => {
  const result = extractFixture({
    key_claims: [
      'The council rejected the accessibility rules as an international standard.',
      'The council did not approve the accessibility rules as an international standard.',
    ],
  }, {
    content: 'The council approved the accessibility rules as an international standard.',
  });

  assert.deepEqual(result.key_claims, []);
});

test('long overlap cannot hide swapped entity roles or one changed predicate', () => {
  const result = extractFixture({
    key_claims: [
      'Bob sold the rare ceremonial artifact to Alice in London yesterday after a private appraisal.',
      'The council rejected the comprehensive accessibility standard after extensive independent review by five experts.',
      'Treatment B outperformed Treatment A in every measured cohort during the controlled clinical evaluation.',
    ],
  }, {
    content: [
      'Alice sold the rare ceremonial artifact to Bob in London yesterday after a private appraisal.',
      'The council approved the comprehensive accessibility standard after extensive independent review by five experts.',
      'Treatment A outperformed Treatment B in every measured cohort during the controlled clinical evaluation.',
    ].join('\n'),
  });

  assert.deepEqual(result.key_claims, []);
});

test('source overlap cannot erase modality or quantifier differences', () => {
  const result = extractFixture({
    key_claims: [
      'The treatment will reduce severe symptoms during monitored recovery.',
      'All patients experienced durable remission during the extended clinical follow-up.',
      'The product is safe for unsupervised daily use by adolescents.',
      'The policy applies to all international contractors in regulated markets.',
    ],
  }, {
    content: [
      'The treatment may reduce severe symptoms during monitored recovery.',
      'Some patients experienced durable remission during the extended clinical follow-up.',
      'The product may be safe for unsupervised daily use by adolescents.',
      'The policy applies only to some international contractors in regulated markets.',
    ].join('\n'),
  });

  assert.deepEqual(result.key_claims, []);
});

test('omitted qualifiers cannot turn a source fragment into a verified key claim', () => {
  const result = extractFixture({
    key_claims: [
      'Evidence shows the product is safe for unsupervised daily use.',
      'The report confirms the product is safe for unsupervised daily use.',
      'The system prevents leakage during ordinary operation.',
    ],
  }, {
    content: [
      'Preliminary evidence shows the product is safe for unsupervised daily use.',
      'The unverified report confirms the product is safe for unsupervised daily use.',
      'The system reportedly prevents leakage during ordinary operation.',
    ].join('\n'),
  });

  assert.deepEqual(result.key_claims, []);
});

test('model-selected citation anchors are always bound to the fetched parent URL', () => {
  const parentUrl = 'https://docs.example/article';
  const result = extractFixture({
    verbatim_quotes: [{
      quote: 'A model-selected anchor cannot replace the long-form parent.',
      source_url: `${parentUrl}#details`,
    }],
  }, { url: parentUrl, mode: 'longform' });

  assert.equal(result.verbatim_quotes[0]?.source_url, parentUrl);
});

test('social and video model-selected anchors cannot override the fetched parent', () => {
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
    parentUrl,
  );
  assert.equal(
    result.verbatim_quotes[1]?.source_url,
    parentUrl,
  );
  assert.equal(result.verbatim_quotes[2]?.source_url, parentUrl);
  assert.equal(result.verbatim_quotes[3]?.source_url, parentUrl);
});

test('thinking tokens are billed as output and counted with candidates', () => {
  // Google bills thoughtsTokenCount as output and reports it DISJOINT from
  // candidatesTokenCount. Counting candidates alone under-books every
  // thinking-enabled call — measured at ~50% metered coverage on the research
  // key's GCP project before this was fixed.
  const withThinking = normalizeGeminiExtractionPayload(
    { key_claims: ['A valid claim survives.'], verbatim_quotes: [] },
    {
      provider: 'tavily',
      url: 'https://docs.example/article',
      content: DEFAULT_SOURCE_CONTENT,
      mode: 'longform',
    },
    { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 400 },
  );
  assert.equal(withThinking?.usage?.candidate_tokens, 450);

  // A non-thinking model omits the field entirely. It must read as 0 — NaN
  // fails the payload schema and nulls the whole extraction, not just usage.
  const withoutThinking = normalizeGeminiExtractionPayload(
    { key_claims: ['A valid claim survives.'], verbatim_quotes: [] },
    {
      provider: 'tavily',
      url: 'https://docs.example/article',
      content: DEFAULT_SOURCE_CONTENT,
      mode: 'longform',
    },
    { promptTokenCount: 100, candidatesTokenCount: 50 },
  );
  assert.equal(withoutThinking?.usage?.candidate_tokens, 50);
  assert.equal(withoutThinking?.source_url, 'https://docs.example/article');
});
