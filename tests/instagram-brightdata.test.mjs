import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { createInstagramProvider } from '../dist/index.mjs';

const originalFetch = globalThis.fetch;

// Configured explicitly per test: the provider is built from a credential
// record, so "which token is present" is stated rather than inherited.
const brightDataCredentials = { brightdata: { apiToken: 'test-brightdata-token' } };  // git-secret-allow: fake fixture value, never a live credential
const instagramProvider = createInstagramProvider(brightDataCredentials);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Instagram provider is enabled by Bright Data or Apify credentials', () => {
  const apifyOnly = createInstagramProvider({ apifyApiToken: 'test-apify-token' });  // git-secret-allow: fake fixture value, never a live credential
  const neither = createInstagramProvider({});
  assert.equal(apifyOnly.enabled, true);
  assert.equal(neither.enabled, false);
  assert.equal(instagramProvider.enabled, true);
});

test('Bright Data hashtag discovery returns canonical, deduplicated Instagram results with provenance', async () => {
  const calls = [];
  let snapshot = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    assert.equal(new URL(url).hostname, 'api.brightdata.com');
    assert.equal(init.headers.Authorization, 'Bearer test-brightdata-token');

    if (url.includes('/trigger?')) {
      snapshot += 1;
      const payload = JSON.parse(init.body);
      assert.match(payload[0].url, /^https:\/\/www\.instagram\.com\/explore\/tags\//);
      return jsonResponse({ snapshot_id: `snapshot-${snapshot}` });
    }
    if (url.includes('/progress/')) return jsonResponse({ status: 'ready' });
    if (url.includes('/snapshot/')) {
      return jsonResponse([{
        url: 'https://instagram.com/reels/Ab_C-1/?utm_source=test#fragment',
        shortcode: 'Ab_C-1',
        description: 'A useful caption #AITeachers',
        user_posted: 'creator',
        date_posted: '2026-07-14T12:00:00Z',
        likes: '1,234',
        num_comments: 42,
        video_view_count: 9000,
        video_url: 'https://cdn.example/video.mp4',
        content_type: 'reel',
      }]);
    }
    throw new Error(`unexpected test URL: ${url}`);
  };

  const results = await instagramProvider.search('AI for teachers', { limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://www.instagram.com/reel/Ab_C-1/');
  assert.equal(results[0].provider, 'instagram');
  assert.equal(results[0].canonical_id, 'Ab_C-1');
  assert.equal(results[0].author, '@creator');
  assert.equal(results[0].engagement.like_count, 1234);
  assert.equal(results[0].raw_metadata.instagram_provider, 'brightdata');
  assert.equal(results[0].raw_metadata.brightdata_dataset_id, 'gd_lk5ns7kz21pck8jpis');
  assert.deepEqual(results[0].raw_metadata.discovery_hashtags, ['aiforteachers', 'aifor']);
  assert.equal(calls.length, 6);
  assert.equal(calls.some(call => /apify|jina|crawl4ai|playwright|puppeteer/i.test(call.url)), false);
});

test('Instagram search fails immediately when Bright Data is missing or returns an error', async () => {
  const apifyOnly = createInstagramProvider({ apifyApiToken: 'test-apify-token' });  // git-secret-allow: fake fixture value, never a live credential
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({});
  };
  await assert.rejects(
    apifyOnly.search('AI creators', { limit: 5 }),
    /brightdata/,
  );
  assert.equal(calls, 0);

  globalThis.fetch = async (input) => {
    calls += 1;
    assert.equal(new URL(String(input)).hostname, 'api.brightdata.com');
    return jsonResponse({ error: 'provider unavailable' }, 503);
  };
  await assert.rejects(
    instagramProvider.search('AI creators', { limit: 5 }),
    /Bright Data Instagram discovery trigger failed with HTTP 503/,
  );
  assert.equal(calls, 1);

  let terminalCalls = 0;
  globalThis.fetch = async (input) => {
    terminalCalls += 1;
    const url = String(input);
    if (url.includes('/trigger?')) return jsonResponse({ snapshot_id: 'terminal-snapshot' });
    if (url.includes('/progress/')) return jsonResponse({ status: 'failed' });
    throw new Error(`unexpected test URL: ${url}`);
  };
  await assert.rejects(
    instagramProvider.search('AI creators', { limit: 5 }),
    /snapshot ended with status "failed"/,
  );
  assert.equal(terminalCalls, 2);

  let emptyCalls = 0;
  globalThis.fetch = async (input) => {
    emptyCalls += 1;
    const url = String(input);
    if (url.includes('/trigger?')) return jsonResponse({ snapshot_id: 'empty-snapshot' });
    if (url.includes('/progress/')) return jsonResponse({ status: 'ready' });
    if (url.includes('/snapshot/')) {
      return jsonResponse([{
        url: 'https://www.instagram.com/p/Empty_Search/',
        shortcode: 'Empty_Search',
      }]);
    }
    throw new Error(`unexpected test URL: ${url}`);
  };
  await assert.rejects(
    instagramProvider.search('AI creators', { limit: 5 }),
    /discovery returned no usable content/,
  );
  assert.equal(emptyCalls, 3);
});

test('direct Instagram fetch uses Bright Data once and preserves the canonical source URL', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    assert.equal(new URL(url).hostname, 'api.brightdata.com');
    assert.match(url, /\/datasets\/v3\/scrape\?/);
    assert.deepEqual(JSON.parse(init.body), [{ url: 'https://www.instagram.com/p/Post_42/' }]);
    return jsonResponse([{
      post_url: 'https://www.instagram.com/p/Post_42/?igsh=test',
      short_code: 'Post_42',
      caption: 'Evidence from the post',
      owner_username: 'researcher',
      timestamp: '2026-07-14T13:00:00+00:00',
      display_url: 'https://cdn.example/image.jpg',
      likes_count: 88,
    }]);
  };

  const result = await instagramProvider.fetch('https://instagram.com/p/Post_42/?igsh=test');
  assert.equal(result.fetch_status, 'ok');
  assert.equal(result.url, 'https://www.instagram.com/p/Post_42/');
  assert.equal(result.canonical_id, 'Post_42');
  assert.equal(result.author, '@researcher');
  assert.match(result.markdown, /Instagram data provider:\*\* Bright Data/);
  assert.equal(result.engagement.instagram_provider, 'brightdata');
  assert.equal(calls.length, 1);
});

test('direct Instagram fetch follows an asynchronous Bright Data scrape snapshot', async () => {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/scrape?')) {
      return jsonResponse({ snapshot_id: 'instagram-async-1' }, 202);
    }
    if (url.includes('/progress/')) return jsonResponse({ status: 'ready' });
    if (url.includes('/snapshot/')) {
      return jsonResponse([{
        post_url: 'https://www.instagram.com/p/Async_42/',
        short_code: 'Async_42',
        caption: 'Asynchronous evidence from Bright Data',
        owner_username: 'async-researcher',
        timestamp: '2026-07-21T13:00:00+00:00',
      }]);
    }
    throw new Error(`unexpected test URL: ${url}`);
  };

  const result = await instagramProvider.fetch('https://www.instagram.com/p/Async_42/');
  assert.equal(result.fetch_status, 'ok');
  assert.equal(result.engagement.brightdata_dataset_id, 'gd_lk5ns7kz21pck8jpis');
  assert.match(result.markdown, /Asynchronous evidence from Bright Data/);
  assert.deepEqual(calls.map(url => new URL(url).pathname), [
    '/datasets/v3/scrape',
    '/datasets/v3/progress/instagram-async-1',
    '/datasets/v3/snapshot/instagram-async-1',
  ]);
});

test('one-segment Instagram profiles use the Bright Data profiles dataset and require useful profile data', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    assert.match(url, /dataset_id=gd_l1vikfch901nx3by4/);
    assert.deepEqual(JSON.parse(init.body), [{ url: 'https://www.instagram.com/research.creator/' }]);
    return jsonResponse([{
      account: 'Research.Creator',
      full_name: 'Research Creator',
      biography: 'Evidence-driven creator research.',
      external_url: 'https://example.com/',
      followers: '12,345',
      following: 321,
      posts_count: 87,
      is_verified: true,
      is_private: false,
      profile_image_link: 'https://cdn.example/profile.jpg',
      business_category_name: 'Research',
    }]);
  };

  const result = await instagramProvider.fetch(
    'https://instagram.com/Research.Creator/?utm_source=test',
  );
  assert.equal(result.fetch_status, 'ok');
  assert.equal(result.url, 'https://www.instagram.com/research.creator/');
  assert.equal(result.canonical_id, 'research.creator');
  assert.equal(result.author, '@research.creator');
  assert.match(result.markdown, /Evidence-driven creator research\./);
  assert.equal(result.engagement.followers_count, 12345);
  assert.equal(result.engagement.instagram_provider, 'brightdata');
  assert.equal(result.engagement.brightdata_dataset_id, 'gd_l1vikfch901nx3by4');
  assert.equal(calls.length, 1);

  globalThis.fetch = async () => jsonResponse([{ account: 'research.creator' }]);
  const empty = await instagramProvider.fetch('https://www.instagram.com/research.creator/');
  assert.equal(empty.fetch_status, 'failed');
  assert.match(empty.fetch_error, /no usable matching content/);
});

test('direct Instagram fetch fails closed for provider errors and unusable records', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse([{ error: 'record unavailable' }]);
  };
  const providerError = await instagramProvider.fetch('https://www.instagram.com/reel/Error_1/');
  assert.equal(providerError.fetch_status, 'failed');
  assert.match(providerError.fetch_error, /provider error/);
  assert.equal(calls, 1);

  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse([{
      url: 'https://www.instagram.com/reel/Empty_2/',
      shortcode: 'Empty_2',
    }]);
  };
  const empty = await instagramProvider.fetch('https://www.instagram.com/reel/Empty_2/');
  assert.equal(empty.fetch_status, 'failed');
  assert.match(empty.fetch_error, /no usable matching content/);
  await assert.rejects(
    instagramProvider.extract(empty),
    /failed or empty Instagram fetch/,
  );
  assert.equal(calls, 2);
});

test('Instagram provider source keeps posts on Bright Data and stories on Apify only', async () => {
  const source = await readFile(new URL('../src/providers/instagram.ts', import.meta.url), 'utf8');
  assert.match(source, /gd_lk5ns7kz21pck8jpis/);
  assert.match(source, /gd_l1vikfch901nx3by4/);
  assert.match(source, /credentials\.brightdata/);
  assert.match(source, /datavoyantlab\/advanced-instagram-stories-scraper/);
  assert.match(source, /api\.apify\.com/);
  // Posts/profiles must not be recovered through generic crawl/browser stacks
  // (allow the words only in ban-list comments if present).
  const codeWithoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codeWithoutComments, /Crawl4AI|Jina|Playwright|Puppeteer/i);
  // Stories are the only Apify lane; post scrape must stay on Bright Data datasets.
  assert.match(source, /scrapePost[\s\S]*?BRIGHTDATA_INSTAGRAM_POSTS_DATASET_ID/);
  assert.match(source, /scrapeProfile[\s\S]*?BRIGHTDATA_INSTAGRAM_PROFILES_DATASET_ID/);
  assert.match(source, /scrapeStories[\s\S]*?APIFY_INSTAGRAM_STORIES_ACTOR_ID|startApifyStoriesRun/);
});

test('Instagram stories fetch requires Apify and returns normalized active stories', async () => {
  const provider = createInstagramProvider({
    brightdata: { apiToken: 'test-brightdata-token' },  // git-secret-allow: fake fixture value, never a live credential
    apifyApiToken: 'test-apify-token',  // git-secret-allow: fake fixture value, never a live credential
  });
  const calls = [];
  let pollCount = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', body: init.body });

    if (url.includes('api.apify.com') && url.includes('/acts/') && url.includes('/runs')) {
      assert.equal(init.method, 'POST');
      const payload = JSON.parse(init.body);
      assert.deepEqual(payload.usernames, ['natgeo']);
      return jsonResponse({
        data: { id: 'run-stories-1', defaultDatasetId: 'dataset-stories-1', status: 'RUNNING' },
      });
    }
    if (url.includes('api.apify.com') && url.includes('/actor-runs/run-stories-1')) {
      pollCount += 1;
      return jsonResponse({ data: { id: 'run-stories-1', status: 'SUCCEEDED' } });
    }
    if (url.includes('api.apify.com') && url.includes('/datasets/dataset-stories-1/items')) {
      return jsonResponse([{
        pk: 3586220921557665410,
        id: '3586220921557665410_787132',
        media_type: 1,
        product_type: 'story',
        taken_at: 1741730864,
        expiring_at: 1741817264,
        caption: null,
        user: { username: 'natgeo', full_name: 'National Geographic' },
        image_versions2: {
          candidates: [{ width: 750, height: 1334, url: 'https://cdn.example.com/story-photo.jpg' }],
        },
        story_link_stickers: [{
          story_link: {
            url: 'https://l.instagram.com/?u=https%3A%2F%2Fwww.nationalgeographic.com%2Farticle',
            display_url: 'nationalgeographic.com/article',
          },
        }],
        story_hashtags: [{ hashtag: { name: 'wildlife' } }],
      }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  // Short-circuit poll sleep by making poll return SUCCEEDED on first check:
  // pollApifyRunUntilDone sleeps first, then checks — still fine offline.
  const result = await provider.fetch('https://instagram.com/stories/NatGeo/?utm=1');
  assert.equal(result.fetch_status, 'ok');
  assert.equal(result.url, 'https://www.instagram.com/stories/natgeo/');
  assert.equal(result.author, '@natgeo');
  assert.equal(result.engagement.instagram_provider, 'apify');
  assert.equal(result.engagement.source_kind, 'stories');
  assert.equal(result.engagement.story_count, 1);
  assert.equal(result.engagement.apify_actor_id, 'datavoyantlab/advanced-instagram-stories-scraper');
  assert.match(result.markdown, /Story 1/);
  assert.match(result.markdown, /cdn\.example\.com\/story-photo\.jpg/);
  assert.match(result.markdown, /wildlife/);
  assert.equal(result.engagement.stories[0].story_id, '3586220921557665410');
  assert.equal(result.engagement.stories[0].link_url, 'https://nationalgeographic.com/article');
  assert.ok(calls.some(call => call.url.includes('api.apify.com')));
  assert.ok(!calls.some(call => call.url.includes('api.brightdata.com')));
  assert.ok(pollCount >= 1);
});

test('Instagram stories fetch fails closed without Apify and on empty rings', async () => {
  const noApify = createInstagramProvider({
    brightdata: { apiToken: 'test-brightdata-token' },  // git-secret-allow: fake fixture value, never a live credential
  });
  const missing = await noApify.fetch('https://www.instagram.com/stories/natgeo/');
  assert.equal(missing.fetch_status, 'failed');
  assert.match(missing.fetch_error, /apifyApiToken|required for Instagram stories/i);

  const provider = createInstagramProvider({
    apifyApiToken: 'test-apify-token',  // git-secret-allow: fake fixture value, never a live credential
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/acts/') && url.includes('/runs')) {
      return jsonResponse({
        data: { id: 'run-empty', defaultDatasetId: 'dataset-empty', status: 'RUNNING' },
      });
    }
    if (url.includes('/actor-runs/run-empty')) {
      return jsonResponse({ data: { id: 'run-empty', status: 'SUCCEEDED' } });
    }
    if (url.includes('/datasets/dataset-empty/items')) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const empty = await provider.fetch('https://www.instagram.com/stories/natgeo/');
  assert.equal(empty.fetch_status, 'failed');
  assert.match(empty.fetch_error, /no active stories/);
});

test('Instagram stories URL parser accepts watch and story permalinks', async () => {
  const { parseInstagramStoriesUrl, canonicalizeInstagramStoriesUrl } = await import('../dist/index.mjs');
  const watch = parseInstagramStoriesUrl('https://www.instagram.com/stories/NASA/');
  assert.equal(watch.username, 'nasa');
  assert.equal(watch.storyId, undefined);
  assert.equal(watch.watchUrl, 'https://www.instagram.com/stories/nasa/');
  assert.equal(
    canonicalizeInstagramStoriesUrl('https://instagram.com/stories/nasa/12345/?igsh=1'),
    'https://www.instagram.com/stories/nasa/12345/',
  );
  assert.equal(parseInstagramStoriesUrl('https://www.instagram.com/p/abc/'), null);
  assert.equal(parseInstagramStoriesUrl('https://www.instagram.com/stories/'), null);
});
