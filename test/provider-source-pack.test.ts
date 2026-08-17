import assert from 'node:assert/strict';
import test from 'node:test';

import { compileProfileExecution } from '../src/profiles/registry.js';
import { SourcePackSchema } from '../src/profiles/types.js';
import { createHnProvider, searchResultFromHnHit } from '../src/providers/hn.js';

const hnProvider = createHnProvider({});
import {
  rssFeedUrlsFromSearchOptions,
  rssItemMatchesQuery,
  rssProvider,
} from '../src/providers/rss.js';
import { FeedUrlSchema } from '../src/types.js';

const availableProviders = [
  'tavily', 'searxng', 'github', 'x', 'reddit', 'youtube', 'hn', 'rss', 'podcasts',
] as const;

test('RSS consumes explicit feed URLs and never reinterprets domain filters', async () => {
  const first = 'https://publisher.example/feed.xml';
  const second = 'https://publisher.example/atom.xml';

  assert.deepEqual(
    rssFeedUrlsFromSearchOptions({
      include_domains: ['publisher.example'],
      feed_urls: [first, first, second],
    }),
    [first, second],
  );
  assert.deepEqual(
    rssFeedUrlsFromSearchOptions({ include_domains: ['publisher.example'] }),
    [],
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('RSS must not fetch an include_domains value as a feed URL.');
  }) as typeof fetch;
  try {
    assert.deepEqual(
      await rssProvider.search('design systems', { include_domains: ['publisher.example'] }),
      [],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RSS long-form planner queries admit relevant items without matching half the prompt', () => {
  const query =
    'AI generated website design taste failure generic aesthetics design systems practitioner';
  assert.equal(
    rssItemMatchesQuery(
      query,
      'Good designers, bad websites: a proposal',
      'A practical design method for teams.',
    ),
    true,
  );
  assert.equal(
    rssItemMatchesQuery(query, 'Unrelated engineering article', 'A database release note.'),
    false,
  );
});

test('RSS-enabled source packs fail closed without valid explicit feed URLs', () => {
  const basePack = {
    id: 'rss-test-pack',
    label: 'RSS test pack',
    purpose: 'Verify that RSS source packs declare concrete feed endpoints.',
    lane: 'community' as const,
    visibility: 'public' as const,
    transport: 'external_search' as const,
    executionMode: 'community' as const,
    providers: ['rss'] as const,
  };

  const missing = SourcePackSchema.safeParse(basePack);
  assert.equal(missing.success, false);
  if (!missing.success) {
    assert.ok(missing.error.issues.some((issue) => issue.path.join('.') === 'feedUrls'));
  }

  assert.equal(SourcePackSchema.safeParse({
    ...basePack,
    feedUrls: ['file:///private/feed.xml'],
  }).success, false);
  assert.equal(FeedUrlSchema.safeParse('not-a-url').success, false);
  assert.equal(SourcePackSchema.safeParse({
    ...basePack,
    feedUrls: ['not-a-url'],
  }).success, false);
  assert.equal(SourcePackSchema.safeParse({
    ...basePack,
    feedUrls: ['https://publisher.example/feed.xml'],
  }).success, true);
});

test('profiles compile verified feed endpoints into every RSS-backed seeded search', () => {
  const webDesignV1 = compileProfileExecution(
    'web-design-intelligence@1',
    {
      question: 'Which resources help agents build exceptional websites?',
      asOf: '2026-07-22',
    },
    [...availableProviders],
  );
  const v1Seeds = webDesignV1.seedSubqueries.filter((subquery) =>
    subquery.source_pack_id === 'design-practitioner-signal');
  assert.equal(v1Seeds.length, 2);
  // v1 is frozen: feed-only community pack, no include_domains.
  assert.ok(v1Seeds.every((subquery) =>
    subquery.search_options.include_domains === undefined));
  assert.ok(v1Seeds.every((subquery) =>
    subquery.search_options.feed_urls?.includes('https://www.smashingmagazine.com/feed/')));
  assert.ok(v1Seeds.every((subquery) =>
    subquery.search_options.feed_urls?.includes('https://web.dev/static/blog/feed.xml')));
  assert.ok(v1Seeds.every((subquery) =>
    subquery.search_options.feed_urls?.includes('https://alistapart.com/main/feed/')));

  const webDesignV2 = compileProfileExecution(
    'web-design-intelligence@2',
    {
      question: 'Which resources help agents build exceptional websites?',
      asOf: '2026-08-04',
    },
    [...availableProviders],
  );
  const practitionerSeeds = webDesignV2.seedSubqueries.filter((subquery) =>
    subquery.source_pack_id === 'design-practitioner-signal');
  // 1.2.3: compileProfileExecution fans out up to 4 pack query hints.
  assert.equal(practitionerSeeds.length, 4);
  // v2: publisher domains for tavily/searxng recovery; feeds remain RSS surface.
  assert.ok(practitionerSeeds.every((subquery) =>
    (subquery.search_options.include_domains ?? []).includes('smashingmagazine.com')));
  assert.ok(practitionerSeeds.every((subquery) =>
    subquery.search_options.feed_urls?.includes('https://www.smashingmagazine.com/feed/')));

  const ora = compileProfileExecution(
    'ora-agent-runtime@1',
    {
      question: 'How should durable agent work graphs be designed?',
      asOf: '2026-07-22',
    },
    [...availableProviders],
  );
  const rssSeeds = ora.seedSubqueries.filter((subquery) => subquery.providers.includes('rss'));
  assert.ok(rssSeeds.length > 0);
  assert.ok(rssSeeds.every((subquery) => (subquery.search_options.feed_urls?.length ?? 0) > 0));
});

test('HN search identity is the fetchable discussion URL and preserves the outbound article', async () => {
  const result = searchResultFromHnHit({
    objectID: '42424242',
    url: 'https://publisher.example/agent-design',
    title: 'Agent design discussion',
    story_text: 'A practitioner discussion about agent design.',
    author: 'builder',
    created_at: '2026-07-20T12:00:00.000Z',
    points: 88,
    num_comments: 21,
    _tags: ['story'],
  });
  assert.ok(result !== null);
  assert.equal(result.url, 'https://news.ycombinator.com/item?id=42424242');
  assert.equal(result.raw_metadata['outbound_url'], 'https://publisher.example/agent-design');
  assert.equal(result.raw_metadata['hn_url'], result.url);

  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input instanceof Request ? input.url : input);
    return Response.json({
      id: 42424242,
      type: 'story',
      author: 'builder',
      text: 'Story text',
      points: 88,
      created_at: '2026-07-20T12:00:00.000Z',
      children: [],
    });
  }) as typeof fetch;
  try {
    assert.ok(hnProvider.fetch !== undefined);
    const fetched = await hnProvider.fetch(result.url);
    assert.equal(fetched.fetch_status, 'ok');
    assert.match(requestedUrl, /hn\.algolia\.com\/api\/v1\/items\/42424242$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
