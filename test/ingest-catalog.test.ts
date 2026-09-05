/**
 * Catalog mode — the person-corpus door. Every transport is faked: Bright
 * Data, the YouTube Data API, Groq and Deepgram through globalThis.fetch;
 * the node:http-based feed and sitemap fetchers through CatalogDependencies.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { ingestSource } from '../src/ingestion/ingest-source.js';
import { ingestCatalog, listSitemapPages, parseCatalogConfig } from '../src/ingestion/catalog.js';
import { transcribeAudioUrl, TranscriptUnavailableError } from '../src/transcript/index.js';
import { resolveChannelId } from '../src/youtube/channel.js';
import { resolveResearchCredentials } from '../src/credentials.js';
import type { ResearchCredentials } from '../src/credentials.js';
import type { KnowledgeSource } from '../src/ingestion/types.js';
import type { FeedResult } from '../src/advice-rss.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type FetchInput = string | URL | Request;
function hrefOf(input: FetchInput): string {
  return typeof input === 'string' || input instanceof URL ? String(input) : input.url;
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function source(overrides: Partial<KnowledgeSource>): KnowledgeSource {
  return {
    id: 'src-1',
    workspaceId: 'ws-1',
    sourceType: 'blog',
    identifier: 'https://example.test',
    label: null,
    topics: [],
    isActive: true,
    pollIntervalHours: 24,
    lastPolledAt: null,
    config: { mode: 'catalog' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('parseCatalogConfig: sweep sources are null, catalog parses, malformed throws', () => {
  assert.equal(parseCatalogConfig({}), null);
  assert.equal(parseCatalogConfig({ mode: 'sweep' }), null);
  assert.deepEqual(parseCatalogConfig({ mode: 'catalog' }), { mode: 'catalog', transcribe: false });
  assert.deepEqual(
    parseCatalogConfig({ mode: 'catalog', transcribe: true, maxTranscripts: 5 }),
    { mode: 'catalog', transcribe: true, maxTranscripts: 5 },
  );
  assert.throws(() => parseCatalogConfig({ mode: 'catalog', transcribe: 'yes' }));
});

test('credentials: GROQ_API_KEY and DEEPGRAM_API_KEY resolve into the record', () => {
  const creds = resolveResearchCredentials({
    GROQ_API_KEY: 'groq-test-key',  // git-secret-allow: fake fixture value, never a live credential
    DEEPGRAM_API_KEY: 'deepgram-test-key',  // git-secret-allow: fake fixture value, never a live credential
  });
  assert.equal(creds.groqApiKey, 'groq-test-key');
  assert.equal(creds.deepgramApiKey, 'deepgram-test-key');
  assert.equal('groqApiKey' in resolveResearchCredentials({}), false);
});

// ---------------------------------------------------------------------------
// Instagram — profile posts through Bright Data discover_by=url
// ---------------------------------------------------------------------------

test('instagram catalog enumerates a profile, not a hashtag, and bills per record', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = hrefOf(input);
    assert.equal(new URL(url).hostname, 'api.brightdata.com');
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (url.includes('/trigger')) return json({ snapshot_id: 'snap-1' });
    if (url.includes('/progress/')) return json({ status: 'ready' });
    if (url.includes('/snapshot/')) {
      return json([
        { url: 'https://www.instagram.com/p/ABC123/', description: 'Flying the F-35 #testpilot', user_posted: 'cincohamilton', date_posted: '2026-08-20T10:00:00.000Z', likes: 1200, num_comments: 40, photos: ['https://cdn.example/1.jpg'] },
        { url: 'https://www.instagram.com/reel/DEF456/', description: 'Wingman AI', user_posted: 'cincohamilton', date_posted: '2026-08-01T10:00:00.000Z', likes: 800, num_comments: 12, video_url: 'https://cdn.example/2.mp4', content_type: 'reel' },
        { url: 'https://www.instagram.com/p/ABC123/', description: 'duplicate record', user_posted: 'cincohamilton' },
      ]);
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const credentials: ResearchCredentials = { brightdata: { apiToken: 'bd-fixture' } }; // git-secret-allow: fake fixture value
  const result = await ingestSource(credentials, source({
    sourceType: 'instagram',
    identifier: '@CincoHamilton',
  }), { maxItems: 300, recencyDays: 30 });

  assert.equal(result.error, null);
  const trigger = calls.find((c) => c.url.includes('/trigger'));
  assert.ok(trigger !== undefined, 'a discovery trigger must fire');
  assert.match(trigger.url, /type=discover_new&discover_by=url/);
  const body = trigger.body as Array<Record<string, unknown>>;
  assert.equal(body[0]?.url, 'https://www.instagram.com/cincohamilton/');
  assert.equal(body[0]?.num_of_posts, 300);
  assert.match(String(body[0]?.start_date), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result.items.length, 2, 'duplicate shortcode collapses to one item');
  assert.equal(result.items[0]?.url, 'https://www.instagram.com/p/ABC123/');
  assert.equal(result.items[0]?.engagement.likes, 1200);
  assert.match(result.items[0]?.contentMd ?? '', /## Media/);
  // Bright Data bills every record it returned, the duplicate included; the
  // dedupe happens on our side after the meter has run.
  assert.ok(Math.abs(result.costUsd - 3 * 0.0015) < 1e-9, `expected 3 billed records, got ${result.costUsd}`);
});

test('instagram catalog refuses a bad identifier before spending', async () => {
  let triggered = 0;
  globalThis.fetch = (async () => { triggered += 1; return json({ snapshot_id: 'x' }); }) as typeof fetch;
  const result = await ingestSource({ brightdata: { apiToken: 'bd-fixture' } }, source({ // git-secret-allow: fake fixture value
    sourceType: 'instagram',
    identifier: 'not a handle!',
  }), { maxItems: 10, recencyDays: 0 });
  assert.equal(triggered, 0);
  assert.match(result.error ?? '', /not a username or profile URL/);
});

// ---------------------------------------------------------------------------
// YouTube — channel uploads through the Data API
// ---------------------------------------------------------------------------

test('youtube catalog resolves an @handle, walks the uploads playlist, and keeps metadata items', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: FetchInput) => {
    const url = new URL(hrefOf(input));
    seen.push(url.pathname + '?' + url.searchParams.get('part'));
    assert.equal(url.hostname, 'www.googleapis.com');
    if (url.pathname.endsWith('/channels') && url.searchParams.get('forHandle') === 'fighterpilotpodcast') {
      return json({ items: [{ id: 'UCI_mZTC4UmH2ICN5MBbrDrQ' }] });
    }
    if (url.pathname.endsWith('/channels')) {
      return json({ items: [{ id: 'UCI_mZTC4UmH2ICN5MBbrDrQ', contentDetails: { relatedPlaylists: { uploads: 'UUI_mZTC4UmH2ICN5MBbrDrQ' } } }] });
    }
    if (url.pathname.endsWith('/playlistItems')) {
      return json({ items: [
        { snippet: { title: 'FPP222', publishedAt: '2026-08-31T00:00:00Z', position: 0 }, contentDetails: { videoId: 'vid00000001', videoPublishedAt: '2026-08-31T00:00:00Z' } },
        { snippet: { title: 'FPP001', publishedAt: '2018-01-01T00:00:00Z', position: 1 }, contentDetails: { videoId: 'vid00000002', videoPublishedAt: '2018-01-01T00:00:00Z' } },
      ] });
    }
    if (url.pathname.endsWith('/videos')) {
      return json({ items: [{
        id: 'vid00000001',
        snippet: { publishedAt: '2026-08-31T00:00:00Z', channelId: 'UCI_mZTC4UmH2ICN5MBbrDrQ', channelTitle: 'Fighter Pilot Podcast', title: 'FPP222 - Afghanistan', description: 'Show notes here', tags: [], categoryId: '22', thumbnails: {} },
        contentDetails: { duration: 'PT47M' },
        statistics: { viewCount: '15000', likeCount: '400', commentCount: '35' },
      }] });
    }
    throw new Error(`unexpected ${url.href}`);
  }) as typeof fetch;

  const credentials: ResearchCredentials = { youtubeApiKey: 'yt-fixture' }; // git-secret-allow: fake fixture value
  const result = await ingestCatalog(credentials, source({
    sourceType: 'youtube',
    identifier: 'https://www.youtube.com/@fighterpilotpodcast',
  }), { mode: 'catalog', transcribe: false }, { maxItems: 50, recencyDays: 365 }, new Date('2026-09-02T00:00:00Z'));

  assert.equal(result.items.length, 1, 'the 2018 upload is outside the recency window');
  assert.equal(result.skipped.older_than_recency, 1);
  assert.equal(result.items[0]?.url, 'https://www.youtube.com/watch?v=vid00000001');
  assert.equal(result.items[0]?.title, 'FPP222 - Afghanistan');
  assert.equal(result.items[0]?.author, 'Fighter Pilot Podcast');
  assert.equal(result.items[0]?.engagement.views, 15000);
  assert.equal(result.costUsd, 0);
  assert.deepEqual(result.transcripts, { attempted: 0, succeeded: 0 });
  assert.ok(seen.some((s) => s.endsWith('/videos?snippet,contentDetails,statistics')), 'metadata batch must run');
});

test('resolveChannelId accepts a bare id and a /channel/ URL without an API key', async () => {
  globalThis.fetch = (async () => { throw new Error('no network expected'); }) as typeof fetch;
  assert.equal(await resolveChannelId({ identifier: 'UCI_mZTC4UmH2ICN5MBbrDrQ' }), 'UCI_mZTC4UmH2ICN5MBbrDrQ');
  assert.equal(
    await resolveChannelId({ identifier: 'https://www.youtube.com/channel/UCI_mZTC4UmH2ICN5MBbrDrQ/videos' }),
    'UCI_mZTC4UmH2ICN5MBbrDrQ',
  );
  await assert.rejects(resolveChannelId({ identifier: '@somebody' }), /needs youtubeApiKey/);
  await assert.rejects(resolveChannelId({ identifier: 'fighter pilot podcast' }), /not a channel id/);
});

// ---------------------------------------------------------------------------
// Podcast — every episode in the feed, transcript optional
// ---------------------------------------------------------------------------

function feed(items: FeedResult['items']): FeedResult {
  return { success: true, feedTitle: 'Fighter Pilot Podcast', feedUrl: 'https://feeds.example/fpp', items, totalItemsParsed: items.length, error: null };
}
const episode = (n: number, audio: string | null): FeedResult['items'][number] => ({
  title: `FPP${n}`,
  url: `https://feeds.example/fpp/${n}`,
  description: `Show notes ${n}`,
  publishedAt: `2026-0${n}-01T00:00:00.000Z`,
  publishedDate: new Date(`2026-0${n}-01T00:00:00.000Z`),
  audioUrl: audio,
  duration: null,
  durationSeconds: null,
  guid: `guid-${n}`,
  youtubeUrl: null,
  transcriptUrl: null,
  guestNames: [],
});

test('podcast catalog asks the feed for the whole history and transcribes enclosures through Groq', async () => {
  const feedCalls: Array<[string, number, number]> = [];
  let groqCalls = 0;
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = hrefOf(input);
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '1000', 'content-type': 'audio/mpeg' } });
    }
    if (url.startsWith('https://cdn.example/')) return new Response(new Uint8Array(1000), { status: 200 });
    if (url.startsWith('https://api.groq.com/')) {
      groqCalls += 1;
      return json({ text: 'Welcome to the show', language: 'en', duration: 3600, segments: [{ start: 0, end: 5, text: 'Welcome to the show' }] });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const credentials: ResearchCredentials = { groqApiKey: 'groq-fixture' }; // git-secret-allow: fake fixture value
  const result = await ingestCatalog(credentials, source({
    sourceType: 'podcast',
    identifier: 'https://feeds.example/fpp',
  }), { mode: 'catalog', transcribe: true, maxTranscripts: 1 }, { maxItems: 400, recencyDays: 0 }, new Date(), {
    fetchFeed: async (feedUrl, maxItems, maxAgeDays) => {
      feedCalls.push([feedUrl, maxItems, maxAgeDays]);
      return feed([episode(2, 'https://cdn.example/2.mp3'), episode(1, null)]);
    },
  });

  assert.deepEqual(feedCalls, [['https://feeds.example/fpp', 400, 36_500]]);
  assert.equal(result.items.length, 2);
  assert.equal(groqCalls, 1, 'maxTranscripts caps paid calls');
  assert.deepEqual(result.transcripts, { attempted: 1, succeeded: 1 });
  assert.match(result.items[0]?.contentMd ?? '', /## Transcript \(groq-whisper\)\n\nWelcome to the show/);
  assert.equal(result.items[1]?.contentMd, 'Show notes 1');
  assert.equal(result.items[0]?.author, 'Fighter Pilot Podcast');
  assert.ok(Math.abs(result.costUsd - 0.04) < 1e-9, `one hour of Groq is $0.04, got ${result.costUsd}`);
});

test('podcast catalog keeps the show-notes item when every transcript tier fails', async () => {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '10' } });
    if (hrefOf(input).startsWith('https://cdn.example/')) return new Response(new Uint8Array(10), { status: 200 });
    return new Response('nope', { status: 500 });
  }) as typeof fetch;
  const result = await ingestCatalog({ groqApiKey: 'groq-fixture' }, source({ sourceType: 'podcast', identifier: 'https://feeds.example/fpp' }), // git-secret-allow: fake fixture value
    { mode: 'catalog', transcribe: true }, { maxItems: 5, recencyDays: 0 }, new Date(),
    { fetchFeed: async () => feed([episode(3, 'https://cdn.example/3.mp3')]) });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.transcripts, { attempted: 1, succeeded: 0 });
  assert.equal(result.skipped.transcript_unavailable, 1);
});

// ---------------------------------------------------------------------------
// transcribeAudioUrl — tier selection by size
// ---------------------------------------------------------------------------

test('transcribeAudioUrl skips Groq for a file over 25 MB and lands on Deepgram', async () => {
  const hits: string[] = [];
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = hrefOf(input);
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(48 * 1024 * 1024), 'content-type': 'audio/mpeg' } });
    if (url.startsWith('https://cdn.example/')) return new Response(new Uint8Array(64), { status: 200 });
    hits.push(new URL(url).hostname);
    if (url.startsWith('https://api.deepgram.com/')) {
      return json({ metadata: { duration: 2868 }, results: { channels: [{ detected_language: 'en', alternatives: [{ transcript: 'Afghanistan' }] }], utterances: [{ start: 0, end: 2, transcript: 'Afghanistan' }] } });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const result = await transcribeAudioUrl({ audioUrl: 'https://cdn.example/big.mp3', groqApiKey: 'groq-fixture', deepgramApiKey: 'dg-fixture' }); // git-secret-allow: fake fixture values
  assert.deepEqual(hits, ['api.deepgram.com']);
  assert.equal(result.tier, 'deepgram');
  assert.equal(result.usage?.audioDurationSeconds, 2868);
});

test('transcribeAudioUrl has no free tier', async () => {
  globalThis.fetch = (async () => { throw new Error('no network expected'); }) as typeof fetch;
  await assert.rejects(transcribeAudioUrl({ audioUrl: 'https://cdn.example/x.mp3' }), TranscriptUnavailableError);
});

// ---------------------------------------------------------------------------
// Site — sitemap pages through crawlUrl
// ---------------------------------------------------------------------------

test('site catalog takes same-host sitemap pages, follows a sitemap index, and crawls each once', async () => {
  const sitemaps: Record<string, string> = {
    'https://www.example.test/sitemap.xml': '<sitemapindex><sitemap><loc>https://www.example.test/sitemap-pages.xml</loc></sitemap></sitemapindex>',
    'https://www.example.test/sitemap-pages.xml': `<urlset>
      <url><loc>https://www.example.test/</loc></url>
      <url><loc>https://www.example.test/about</loc></url>
      <url><loc>https://www.example.test/about/</loc></url>
      <url><loc>https://www.example.test/book.pdf</loc></url>
      <url><loc>https://elsewhere.test/page</loc></url>
      <url><loc>https://www.example.test/podcast</loc></url>
    </urlset>`,
  };
  const crawled: string[] = [];
  const result = await ingestCatalog({}, source({ sourceType: 'blog', identifier: 'https://www.example.test' }),
    { mode: 'catalog', transcribe: false }, { maxItems: 10, recencyDays: 0 }, new Date(), {
      fetchText: async (url) => ({ finalUrl: url, headers: {}, ok: url in sitemaps, status: url in sitemaps ? 200 : 404, text: sitemaps[url] ?? '' }),
      crawl: async (_credentials, url) => { crawled.push(url); return url.endsWith('/podcast') ? '' : `## Page ${url}\n\nbody`; },
    });
  assert.deepEqual(crawled, ['https://www.example.test', 'https://www.example.test/about', 'https://www.example.test/podcast']);
  assert.equal(result.items.length, 2);
  assert.equal(result.skipped.empty_page, 1);
  assert.equal(result.items[1]?.title, 'Page https://www.example.test/about');
  assert.equal(result.costUsd, 0);
});

test('listSitemapPages returns only the seed page when the site has no sitemap', async () => {
  const pages = await listSitemapPages('https://nositemap.test/home', 10,
    async (url) => ({ finalUrl: url, headers: {}, ok: false, status: 404, text: '' }));
  assert.deepEqual(pages, ['https://nositemap.test/home']);
});
