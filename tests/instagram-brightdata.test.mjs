import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { instagramProvider } from '../dist/index.mjs';

const originalFetch = globalThis.fetch;
const originalBrightDataToken = process.env.BRIGHTDATA_API_TOKEN;
const originalApifyToken = process.env.APIFY_API_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBrightDataToken === undefined) delete process.env.BRIGHTDATA_API_TOKEN;
  else process.env.BRIGHTDATA_API_TOKEN = originalBrightDataToken;
  if (originalApifyToken === undefined) delete process.env.APIFY_API_TOKEN;
  else process.env.APIFY_API_TOKEN = originalApifyToken;
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Instagram provider is enabled only by BRIGHTDATA_API_TOKEN', () => {
  delete process.env.BRIGHTDATA_API_TOKEN;
  process.env.APIFY_API_TOKEN = 'test-apify-token';
  assert.equal(instagramProvider.enabled, false);

  process.env.BRIGHTDATA_API_TOKEN = 'test-brightdata-token';
  assert.equal(instagramProvider.enabled, true);
});

test('Bright Data hashtag discovery returns canonical, deduplicated Instagram results with provenance', async () => {
  process.env.BRIGHTDATA_API_TOKEN = 'test-brightdata-token';
  delete process.env.APIFY_API_TOKEN;
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
  delete process.env.BRIGHTDATA_API_TOKEN;
  process.env.APIFY_API_TOKEN = 'test-apify-token';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({});
  };
  await assert.rejects(
    instagramProvider.search('AI creators', { limit: 5 }),
    /BRIGHTDATA_API_TOKEN/,
  );
  assert.equal(calls, 0);

  process.env.BRIGHTDATA_API_TOKEN = 'test-brightdata-token';
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
  process.env.BRIGHTDATA_API_TOKEN = 'test-brightdata-token';
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

test('one-segment Instagram profiles use the Bright Data profiles dataset and require useful profile data', async () => {
  process.env.BRIGHTDATA_API_TOKEN = 'test-brightdata-token';
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
  process.env.BRIGHTDATA_API_TOKEN = 'test-brightdata-token';
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
    /failed or empty Bright Data fetch/,
  );
  assert.equal(calls, 2);
});

test('Instagram provider source enforces the Bright Data-only boundary', async () => {
  const source = await readFile(new URL('../src/providers/instagram.ts', import.meta.url), 'utf8');
  assert.match(source, /gd_lk5ns7kz21pck8jpis/);
  assert.match(source, /gd_l1vikfch901nx3by4/);
  assert.match(source, /BRIGHTDATA_API_TOKEN/);
  assert.doesNotMatch(source, /APIFY|api\.apify|Crawl4AI|Jina|Playwright|Puppeteer/i);
});
