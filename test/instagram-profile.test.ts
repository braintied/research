/**
 * One-call Instagram profile read (fetchInstagramProfile).
 *
 * The fixture is a real Bright Data profiles-dataset record collected for a
 * public account on 2026-10-18, redacted: the account, names, ids, captions
 * and CDN signatures are replaced, and only three of its twelve posts are
 * kept. Every field name, nesting and value type is as Bright Data sent it.
 * `globalThis.fetch` is replaced in every transport test, so nothing reaches
 * Bright Data and no test needs a credential.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach } from 'node:test';

import {
  BRIGHTDATA_INSTAGRAM_PROFILES_DATASET_ID,
  createInstagramProvider,
  fetchInstagramProfile,
  normalizeInstagramProfileSnapshot,
} from '../src/providers/instagram.js';
import { MissingCredentialError, type ResearchCredentials } from '../src/credentials.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Fake token: the transport is stubbed in every test, so nothing is sent.
const credentials: ResearchCredentials = {
  brightdata: { apiToken: 'test-brightdata-token' },  // git-secret-allow: fake fixture value, never a live credential
};

const fixtureRecords: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/instagram/brightdata-profile-record.json', import.meta.url), 'utf8'),
);

function fixtureRecord(): Record<string, unknown> {
  if (!Array.isArray(fixtureRecords)) throw new Error('fixture is not an array');
  const first: unknown = fixtureRecords[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    throw new Error('fixture record is not an object');
  }
  return { ...first };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Call { url: string; method: string; body: string | undefined }

function stubBrightData(progressStatus: string, records: unknown[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.includes('/trigger?')) return jsonResponse({ snapshot_id: 'sd_fixture' });
    if (url.includes('/progress/')) return jsonResponse({ status: progressStatus });
    if (url.includes('/snapshot/')) return jsonResponse(records);
    throw new Error(`unexpected test URL: ${url}`);
  };
  return calls;
}

test('the recorded profiles-dataset record maps to every field the tool returns', () => {
  const profile = normalizeInstagramProfileSnapshot(
    fixtureRecord(),
    'https://www.instagram.com/example.dj/',
    'sd_fixture',
  );
  assert.ok(profile !== null);
  assert.equal(profile.username, 'example.dj');
  assert.equal(profile.displayName, 'Example DJ');
  assert.equal(profile.biography, 'DNB - JUNGLE - HIP HOP \nHOUSE - TECHNO - DISCO');
  assert.equal(profile.followersCount, 1645);
  assert.equal(profile.followingCount, 8078);
  assert.equal(profile.postsCount, 164);
  assert.equal(profile.highlightsCount, 8);
  assert.equal(profile.verified, false);
  assert.equal(profile.private, false);
  assert.match(profile.profileImageUrl ?? '', /^https:\/\/scontent\.cdninstagram\.com\//);
  assert.equal(profile.collectedAt, '2026-10-17T23:56:44.362Z');
  assert.equal(profile.snapshotId, 'sd_fixture');

  // The same link arrives in three shapes; it is one bio link, with its title.
  assert.deepEqual(profile.bioLinks, [{
    url: 'https://soundcloud.com/example-radio/example-mix-02-07-25',
    title: 'Example Mix on Example Radio',
  }]);
  assert.equal(profile.externalUrl, 'https://soundcloud.com/example-radio/example-mix-02-07-25');

  assert.equal(profile.recentPostsIncluded, true);
  assert.equal(profile.recentPosts.length, 3);
  const [first, second, third] = profile.recentPosts;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  assert.equal(first.url, 'https://www.instagram.com/p/ExAmPlE0/');
  assert.equal(first.shortcode, 'ExAmPlE0');
  assert.equal(first.id, '400000000000000000');
  assert.equal(first.mediaType, 'Video');
  assert.equal(first.publishedAt, '2026-10-05T00:00:00.000Z');
  assert.equal(first.mediaUrls.length, 1);
  assert.match(first.caption, /^Start your morning/);
  assert.deepEqual(second.hashtags, ['riverside', 'yogaandmusic']);
  assert.equal(third.caption, '');
});

test('a record for another account is refused, not returned', () => {
  const profile = normalizeInstagramProfileSnapshot(
    fixtureRecord(),
    'https://www.instagram.com/someone.else/',
    'sd_fixture',
  );
  assert.equal(profile, null);
});

test('a record without a posts array says so instead of reading as zero posts', () => {
  const record = fixtureRecord();
  delete record.posts;
  const profile = normalizeInstagramProfileSnapshot(record, 'https://www.instagram.com/example.dj/', 'sd_fixture');
  assert.ok(profile !== null);
  assert.equal(profile.recentPostsIncluded, false);
  assert.deepEqual(profile.recentPosts, []);
});

test('fetchInstagramProfile triggers the profiles dataset once and returns the profile', async () => {
  const calls = stubBrightData('ready', [fixtureRecord()]);
  const result = await fetchInstagramProfile(credentials, '@Example.DJ');
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.profile.username, 'example.dj');
  assert.equal(result.profile.recentPosts.length, 3);

  const trigger = calls.filter(call => call.url.includes('/trigger?'));
  assert.equal(trigger.length, 1);
  assert.ok(trigger[0] !== undefined);
  assert.match(trigger[0].url, new RegExp(`dataset_id=${BRIGHTDATA_INSTAGRAM_PROFILES_DATASET_ID}`));
  assert.deepEqual(JSON.parse(trigger[0].body ?? 'null'), [{ url: 'https://www.instagram.com/example.dj/' }]);
  // Never the sync /scrape endpoint (60 s hold then 202) and never a posts discovery crawl.
  assert.equal(calls.some(call => call.url.includes('/scrape?') || call.url.includes('discover_new')), false);
  assert.equal(calls.every(call => new URL(call.url).hostname === 'api.brightdata.com'), true);
});

test('a snapshot still running at the budget answers pending with its id, never an empty success', async () => {
  stubBrightData('running', []);
  const result = await fetchInstagramProfile(credentials, 'https://www.instagram.com/example.dj/', { maxWaitMs: 30 });
  assert.equal(result.status, 'pending');
  if (result.status !== 'pending') return;
  assert.equal(result.snapshotId, 'sd_fixture');
  assert.equal(result.username, 'example.dj');
  assert.equal(result.url, 'https://www.instagram.com/example.dj/');
});

test('resumeSnapshotId collects the earlier snapshot without a second trigger', async () => {
  const calls = stubBrightData('ready', [fixtureRecord()]);
  const result = await fetchInstagramProfile(credentials, 'example.dj', { resumeSnapshotId: 'sd_earlier' });
  assert.equal(result.status, 'ok');
  assert.equal(calls.some(call => call.url.includes('/trigger?')), false);
  assert.equal(calls.some(call => call.url.includes('/snapshot/sd_earlier')), true);
});

test('a ready snapshot with no matching record throws', async () => {
  stubBrightData('ready', [fixtureRecord()]);
  await assert.rejects(
    fetchInstagramProfile(credentials, 'someone.else'),
    /returned no usable record for @someone\.else/,
  );
});

test('bad identifiers and a missing credential fail before any request', async () => {
  const calls = stubBrightData('ready', []);
  await assert.rejects(fetchInstagramProfile(credentials, 'https://www.instagram.com/p/ABC/'), /not a username or profile URL/);
  await assert.rejects(fetchInstagramProfile({}, 'example.dj'), MissingCredentialError);
  assert.equal(calls.length, 0);
});

test('the provider fetch path reads the website from the array-shaped external_url', async () => {
  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes('/scrape?')) return jsonResponse([fixtureRecord()]);
    throw new Error(`unexpected test URL: ${url}`);
  };
  const provider = createInstagramProvider(credentials);
  assert.ok(provider.fetch !== undefined);
  const fetched = await provider.fetch('https://www.instagram.com/example.dj/');
  assert.equal(fetched.engagement?.external_url, 'https://soundcloud.com/example-radio/example-mix-02-07-25');
});
