/**
 * Podcasts Search Provider (Listen Notes API)
 *
 * Uses the Listen Notes REST API to search podcast episodes by query,
 * then fetches episode detail + transcript when available.
 *
 * API docs: https://www.listennotes.com/api/docs/
 * Auth: Authorization header with raw API key (no "Bearer" prefix).
 * Rate limit: free tier ~10K/mo; treat as 100/min for safety → 600ms min gap.
 *
 * Env required: LISTENNOTES_API_KEY
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { sleep } from '../pipeline-core.js';
import {
  SearchResultSchema,
  FetchResultSchema,
  type SearchProvider,
  type SearchResult,
  type FetchResult,
  type ExtractedQuotes,
  type SearchOpts,
} from '../types.js';
import { extractQuotesWithGemini } from './gemini-extractor.js';

// =============================================================================
// Rate limiter — 100 req/min = 1 req per 620ms
// =============================================================================

const LN_RATE_LIMIT_MS = 620;
let lastLnCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastLnCallAt;
  if (elapsed < LN_RATE_LIMIT_MS) {
    await sleep(LN_RATE_LIMIT_MS - elapsed);
  }
  lastLnCallAt = Date.now();
}

// =============================================================================
// API key
// =============================================================================

const LN_BASE_URL = 'https://listen-api.listennotes.com/api/v2';

function getApiKey(): string {
  const key = process.env.LISTENNOTES_API_KEY;
  if (key === undefined || key === '') {
    throw new Error('LISTENNOTES_API_KEY environment variable is not configured');
  }
  return key;
}

function isEnabled(): boolean {
  const key = process.env.LISTENNOTES_API_KEY;
  return key !== undefined && key !== '';
}

// =============================================================================
// Listen Notes API response schemas
// =============================================================================

const LnPodcastSchema = z.object({
  id: z.string().optional(),
  title_original: z.string().optional(),
  publisher_original: z.string().optional(),
  listennotes_url: z.string().optional(),
  listen_score: z.union([z.number(), z.string()]).optional(),
}).passthrough();

const LnEpisodeResultSchema = z.object({
  id: z.string().default(''),
  title_original: z.string().default(''),
  description_original: z.string().default(''),
  audio: z.string().optional(),
  pub_date_ms: z.number().optional(),
  listennotes_url: z.string().optional(),
  podcast: LnPodcastSchema.optional(),
}).passthrough();

const LnSearchResponseSchema = z.object({
  results: z.array(LnEpisodeResultSchema).default([]),
  total: z.number().optional(),
  count: z.number().optional(),
  next_offset: z.number().optional(),
});

// Episode detail schema (GET /episodes/{id})
const LnEpisodeDetailSchema = z.object({
  id: z.string().default(''),
  title: z.string().default(''),
  description: z.string().default(''),
  audio: z.string().optional(),
  pub_date_ms: z.number().optional(),
  listennotes_url: z.string().optional(),
  transcript: z.string().optional(),
  maybe_audio_invalid: z.boolean().optional(),
  podcast: LnPodcastSchema.optional(),
}).passthrough();

// =============================================================================
// Helpers
// =============================================================================

function pubDateMsToIso(pubDateMs: number): string {
  return new Date(pubDateMs).toISOString();
}

function extractListenScore(podcast: z.infer<typeof LnPodcastSchema> | undefined): number | undefined {
  if (podcast === undefined) return undefined;
  const raw = podcast.listen_score;
  if (raw === undefined) return undefined;
  if (typeof raw === 'number') return raw;
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? undefined : parsed;
}

// =============================================================================
// Provider
// =============================================================================

export const podcastsProvider: SearchProvider = {
  name: 'podcasts',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const apiKey = getApiKey();
    await rateLimit();

    const pageSize = opts.limit !== undefined ? Math.min(opts.limit, 10) : 10;

    const params = new URLSearchParams({
      q: query,
      type: 'episode',
      offset: '0',
      len_min: '10',
      len_max: '120',
      safe_mode: '0',
      unique_podcasts: '0',
      page_size: String(pageSize),
    });

    const response = await fetch(`${LN_BASE_URL}/search?${params.toString()}`, {
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Listen Notes search error: ${response.status} ${body.slice(0, 200)}`);
    }

    const rawJson: unknown = await response.json();
    const parsed = LnSearchResponseSchema.safeParse(rawJson);

    if (!parsed.success) {
      logger.warn({ query: query.slice(0, 60), errors: parsed.error.message }, '[Podcasts] Invalid search response');
      return [];
    }

    const results: SearchResult[] = [];

    for (const episode of parsed.data.results) {
      if (episode.id.length === 0) continue;

      const episodeUrl = episode.audio !== undefined && episode.audio.length > 0
        ? episode.audio
        : (episode.listennotes_url !== undefined ? episode.listennotes_url : `https://www.listennotes.com/e/${episode.id}/`);

      const publishedAt = episode.pub_date_ms !== undefined ? pubDateMsToIso(episode.pub_date_ms) : undefined;
      const publisher = episode.podcast !== undefined && episode.podcast.publisher_original !== undefined
        ? episode.podcast.publisher_original
        : undefined;

      const candidate = {
        provider: 'podcasts' as const,
        url: episodeUrl,
        canonical_id: episode.id.length > 0 ? episode.id : undefined,
        title: episode.title_original,
        snippet: episode.description_original.slice(0, 500),
        author: publisher,
        published_at: publishedAt,
        engagement: {
          score: extractListenScore(episode.podcast),
        },
        raw_metadata: {
          listennotes_url: episode.listennotes_url,
          podcast_title: episode.podcast !== undefined ? episode.podcast.title_original : undefined,
          listen_score: extractListenScore(episode.podcast),
        },
      };

      const validated = SearchResultSchema.safeParse(candidate);
      if (validated.success) {
        results.push(validated.data);
      }
    }

    logger.info(
      { query: query.slice(0, 60), count: results.length },
      '[Podcasts] Search complete',
    );

    return results;
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    const apiKey = getApiKey();
    await rateLimit();

    // Extract episode ID from a listennotes URL or use the url as canonical_id directly
    // Patterns: https://www.listennotes.com/e/<id>/ or bare episode ID
    let episodeId: string | null = null;

    const lnMatch = /listennotes\.com\/e\/([^/?#]+)/.exec(url);
    if (lnMatch !== null) {
      episodeId = lnMatch[1];
    } else if (/^[a-f0-9]{32}$/.test(url)) {
      // Raw Listen Notes episode ID (hex string)
      episodeId = url;
    }

    if (episodeId === null) {
      // No Listen Notes ID — return partial with just the URL
      return FetchResultSchema.parse({
        provider: 'podcasts',
        url,
        fetch_status: 'partial',
        fetch_error: 'Cannot resolve Listen Notes episode ID from URL — no transcript available',
      });
    }

    const detailUrl = `${LN_BASE_URL}/episodes/${encodeURIComponent(episodeId)}?show_transcript=1`;

    const response = await fetch(detailUrl, {
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      signal: signal !== undefined ? signal : AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      return FetchResultSchema.parse({
        provider: 'podcasts',
        url,
        fetch_status: 'failed',
        fetch_error: `Listen Notes episode fetch error: ${response.status} ${body.slice(0, 100)}`,
      });
    }

    const rawJson: unknown = await response.json();
    const parsed = LnEpisodeDetailSchema.safeParse(rawJson);

    if (!parsed.success) {
      return FetchResultSchema.parse({
        provider: 'podcasts',
        url,
        fetch_status: 'failed',
        fetch_error: `Invalid episode response: ${parsed.error.message.slice(0, 100)}`,
      });
    }

    const episode = parsed.data;
    const hasTranscript = episode.transcript !== undefined && episode.transcript.length > 0;
    const publishedAt = episode.pub_date_ms !== undefined ? pubDateMsToIso(episode.pub_date_ms) : undefined;
    const publisher = episode.podcast !== undefined && episode.podcast.publisher_original !== undefined
      ? episode.podcast.publisher_original
      : undefined;

    // Build markdown
    const lines: string[] = [
      `# ${episode.title}`,
      '',
    ];

    if (publisher !== undefined) {
      lines.push(`**Publisher:** ${publisher}`, '');
    }

    if (episode.description.length > 0) {
      lines.push('## Episode Description', '', episode.description, '');
    }

    if (hasTranscript && episode.transcript !== undefined) {
      lines.push('## Transcript', '', episode.transcript, '');
    }

    const markdown = lines.join('\n');

    const result = FetchResultSchema.parse({
      provider: 'podcasts',
      url,
      canonical_id: episode.id.length > 0 ? episode.id : undefined,
      title: episode.title,
      author: publisher,
      published_at: publishedAt,
      raw_content: hasTranscript && episode.transcript !== undefined ? episode.transcript : episode.description,
      markdown,
      engagement: {
        score: extractListenScore(episode.podcast),
      },
      fetch_status: hasTranscript ? 'ok' : 'partial',
      fetch_error: hasTranscript ? undefined : 'No transcript available — description only',
      raw_metadata: {
        listennotes_url: episode.listennotes_url,
        listen_score: extractListenScore(episode.podcast),
        maybe_audio_invalid: episode.maybe_audio_invalid,
      },
    });

    logger.info(
      {
        url: url.slice(0, 60),
        episodeId,
        title: episode.title.slice(0, 40),
        hasTranscript,
      },
      '[Podcasts] Fetch complete',
    );

    return result;
  },

  async extract(raw: FetchResult): Promise<ExtractedQuotes> {
    const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
    return extractQuotesWithGemini({
      provider: 'podcasts',
      url: raw.url,
      content,
      mode: 'longform', // transcript is long-form text
    });
  },
};
