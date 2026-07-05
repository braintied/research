/**
 * Facebook Groups Search Provider
 *
 * Uses Apify actor `apify/facebook-groups-scraper` to scrape posts + comments
 * from public Facebook groups. The provider's search() pivots a query string
 * against a curated allowlist of known AI-curious beginner groups (see SEED_GROUPS
 * below). For v1, group selection is keyword-matched against the query; no
 * SerpAPI side-channel needed.
 *
 * Rate limit: 5-second queue between Apify calls. Cost ~$0.50/run for 50 posts.
 * Env required: APIFY_API_TOKEN (shared with other Apify providers).
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
// Rate limiter — 5-second queue between Apify calls
// =============================================================================

const FB_RATE_LIMIT_MS = 5000;
let lastFbCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastFbCallAt;
  if (elapsed < FB_RATE_LIMIT_MS) {
    await sleep(FB_RATE_LIMIT_MS - elapsed);
  }
  lastFbCallAt = Date.now();
}

// =============================================================================
// Seed group allowlist — public AI-curious beginner groups on Facebook
// Each entry: { slug: Facebook group slug/ID, name: human label, keywords: match terms }
// =============================================================================

interface SeedGroup {
  slug: string;
  name: string;
  keywords: string[];
}

const SEED_GROUPS: SeedGroup[] = [
  // General AI for beginners
  { slug: 'aibeginnersclub', name: 'AI Beginners', keywords: ['ai', 'artificial intelligence', 'beginner', 'learn'] },
  { slug: 'promptengineeringforbeginners', name: 'Prompt Engineering for Beginners', keywords: ['prompt', 'engineering', 'chatgpt', 'beginner'] },
  { slug: 'chatgptusers', name: 'ChatGPT Users & AI Tools', keywords: ['chatgpt', 'gpt', 'openai', 'ai tools'] },
  { slug: 'aitools2024', name: 'AI Tools and ChatGPT for Educators', keywords: ['educator', 'teacher', 'teaching', 'education', 'school', 'classroom'] },
  // Education-focused
  { slug: 'chatgptforteachers', name: 'ChatGPT for Teachers', keywords: ['teacher', 'teaching', 'education', 'school', 'classroom', 'curriculum'] },
  { slug: 'aieducators', name: 'AI for Educators Network', keywords: ['educator', 'teacher', 'learning', 'education', 'training'] },
  // Coaching & professional
  { slug: 'aiforcoaches', name: 'AI for Coaches', keywords: ['coach', 'coaching', 'personal development', 'business coach'] },
  { slug: 'chatgptmarketingmastermind', name: 'ChatGPT Marketing Mastermind', keywords: ['marketing', 'copywriting', 'sales', 'ads', 'social media'] },
  // Real estate
  { slug: 'realestateaimastermind', name: 'Real Estate AI Mastermind', keywords: ['real estate', 'realtor', 'property', 'agent', 'broker'] },
  { slug: 'aiinrealestate', name: 'AI in Real Estate', keywords: ['real estate', 'property', 'realtor', 'listing'] },
  // Diversity-focused
  { slug: 'womeninaicommunity', name: 'Womxn in AI', keywords: ['women', 'womxn', 'diversity', 'female', 'gender'] },
  // Content & creators
  { slug: 'aiforcreators', name: 'AI for Content Creators', keywords: ['content', 'creator', 'youtube', 'instagram', 'tiktok', 'influencer'] },
  { slug: 'aiwritingtools', name: 'AI Writing Tools & ChatGPT', keywords: ['writing', 'copywriting', 'content', 'blog', 'newsletter'] },
  // Business general
  { slug: 'aiforbusiness2024', name: 'AI for Business & Entrepreneurs', keywords: ['business', 'entrepreneur', 'startup', 'productivity', 'workflow'] },
  { slug: 'midjourneycommunity', name: 'Midjourney & AI Art Community', keywords: ['midjourney', 'dalle', 'image', 'art', 'design', 'stable diffusion'] },
];

// =============================================================================
// Group selection — keyword match query against seed group keywords
// Returns up to maxGroups most-relevant groups for the query.
// =============================================================================

function selectGroupsForQuery(query: string, maxGroups: number): SeedGroup[] {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  const scored: Array<{ group: SeedGroup; score: number }> = [];

  for (const group of SEED_GROUPS) {
    let score = 0;
    for (const keyword of group.keywords) {
      if (queryLower.includes(keyword)) {
        score += 2;
      } else {
        for (const word of queryWords) {
          if (keyword.includes(word) || word.includes(keyword)) {
            score += 1;
          }
        }
      }
    }
    scored.push({ group, score });
  }

  // Sort by score desc, take top N; if no matches, return first maxGroups (fallback)
  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.filter(s => s.score > 0).slice(0, maxGroups);
  if (relevant.length > 0) {
    return relevant.map(s => s.group);
  }
  // Fallback: return general AI beginner groups
  return SEED_GROUPS.slice(0, maxGroups);
}

// =============================================================================
// Apify API helpers
// =============================================================================

const APIFY_BASE_URL = 'https://api.apify.com/v2';
const ACTOR_ID = 'apify/facebook-groups-scraper';
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 5 * 60 * 1_000;

function getApifyToken(): string {
  const token = process.env.APIFY_API_TOKEN;
  if (token === undefined || token === '') {
    throw new Error('APIFY_API_TOKEN environment variable is not configured');
  }
  return token;
}

function isEnabled(): boolean {
  const token = process.env.APIFY_API_TOKEN;
  return token !== undefined && token !== '';
}

interface ApifyRunData {
  id: string;
  defaultDatasetId: string;
  status: string;
  usageTotalUsd?: number;
}

async function startApifyRun(
  actorId: string,
  input: Record<string, unknown>,
  token: string,
): Promise<{ runId: string; datasetId: string }> {
  const url = `${APIFY_BASE_URL}/acts/${encodeURIComponent(actorId)}/runs?token=${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Apify start error (${actorId}): HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as { data: ApifyRunData };
  const runId = json.data.id;
  const datasetId = json.data.defaultDatasetId;

  if (runId === '' || runId === undefined) {
    throw new Error(`Apify actor "${actorId}" start response missing run id`);
  }

  return { runId, datasetId };
}

async function pollRunUntilDone(runId: string, token: string): Promise<{ usageUsd: number }> {
  const startTime = Date.now();
  const statusUrl = `${APIFY_BASE_URL}/actor-runs/${runId}?token=${token}`;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Apify poll error: HTTP ${response.status} ${body.slice(0, 100)}`);
    }

    const json = (await response.json()) as { data: ApifyRunData };
    const status = json.data.status;

    if (status === 'SUCCEEDED') {
      const usageUsd = json.data.usageTotalUsd !== undefined ? json.data.usageTotalUsd : 0;
      return { usageUsd };
    }

    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run "${runId}" ended with status "${status}"`);
    }
  }

  throw new Error(`Apify run "${runId}" timed out after ${MAX_WAIT_MS / 1000}s`);
}

async function fetchDatasetItems(datasetId: string, token: string): Promise<unknown[]> {
  const url = `${APIFY_BASE_URL}/datasets/${datasetId}/items?token=${token}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Apify dataset fetch error: HTTP ${response.status} ${body.slice(0, 100)}`);
  }

  return (await response.json()) as unknown[];
}

// =============================================================================
// Apify Facebook Groups post item schema
// =============================================================================

const FbPostItemSchema = z.object({
  id: z.string().optional(),
  permalink: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  author: z.union([
    z.string(),
    z.object({ name: z.string().optional() }),
  ]).optional(),
  timestamp: z.string().optional(),
  reactionsCount: z.number().optional(),
  commentsCount: z.number().optional(),
  comments: z.array(z.unknown()).optional(),
}).passthrough();

// =============================================================================
// Helpers
// =============================================================================

function extractPermalink(item: z.infer<typeof FbPostItemSchema>): string | null {
  if (item.permalink !== undefined && item.permalink.length > 0) {
    return item.permalink.startsWith('http') ? item.permalink : `https://www.facebook.com${item.permalink}`;
  }
  if (item.url !== undefined && item.url.length > 0) {
    return item.url;
  }
  return null;
}

function extractAuthorName(item: z.infer<typeof FbPostItemSchema>): string | undefined {
  if (item.author === undefined || item.author === null) return undefined;
  if (typeof item.author === 'string') {
    return item.author.length > 0 ? item.author : undefined;
  }
  if (typeof item.author === 'object' && item.author.name !== undefined) {
    return item.author.name.length > 0 ? item.author.name : undefined;
  }
  return undefined;
}

function toIsoString(dateStr: string): string | undefined {
  if (dateStr.length === 0) return undefined;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString();
  } catch {
    return undefined;
  }
}

// =============================================================================
// Provider
// =============================================================================

export const facebookGroupsProvider: SearchProvider = {
  name: 'facebook_groups',

  get enabled(): boolean {
    return isEnabled();
  },

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const token = getApifyToken();
    const limit = opts.limit !== undefined ? Math.min(opts.limit, 50) : 25;

    // Select 2 groups per search call to stay within cost budget
    const groups = selectGroupsForQuery(query, 2);
    const results: SearchResult[] = [];

    for (const group of groups) {
      await rateLimit();

      const groupUrl = `https://www.facebook.com/groups/${group.slug}`;
      const input: Record<string, unknown> = {
        startUrls: [{ url: groupUrl }],
        resultsLimit: limit,
      };

      let items: unknown[] = [];

      try {
        const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
        await pollRunUntilDone(runId, token);
        items = await fetchDatasetItems(datasetId, token);
        logger.info(
          { group: group.name, items: items.length, query: query.slice(0, 60) },
          '[FacebookGroups] Scrape complete',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ group: group.name, error: msg }, '[FacebookGroups] Scrape failed, skipping group');
        continue;
      }

      for (const rawItem of items) {
        const parsed = FbPostItemSchema.safeParse(rawItem);
        if (!parsed.success) continue;

        const item = parsed.data;
        const permalink = extractPermalink(item);
        if (permalink === null) continue;

        const snippetSource = item.text !== undefined ? item.text : (item.title !== undefined ? item.title : '');
        const titleSource = item.title !== undefined && item.title.length > 0
          ? item.title
          : snippetSource.slice(0, 80);

        const publishedAt = item.timestamp !== undefined ? toIsoString(item.timestamp) : undefined;
        const author = extractAuthorName(item);

        const candidate = {
          provider: 'facebook_groups' as const,
          url: permalink,
          canonical_id: item.id !== undefined && item.id.length > 0 ? item.id : undefined,
          title: titleSource.slice(0, 200),
          snippet: snippetSource.slice(0, 500),
          author,
          published_at: publishedAt,
          engagement: {
            upvotes: item.reactionsCount,
            comment_count: item.commentsCount,
          },
          raw_metadata: {
            group_slug: group.slug,
            group_name: group.name,
            group_url: groupUrl,
          },
        };

        const validated = SearchResultSchema.safeParse(candidate);
        if (validated.success) {
          results.push(validated.data);
        }
      }
    }

    logger.info(
      { query: query.slice(0, 60), count: results.length, groups: groups.map(g => g.name) },
      '[FacebookGroups] Search complete',
    );

    return results;
  },

  async fetch(url: string, signal?: AbortSignal): Promise<FetchResult> {
    const token = getApifyToken();
    await rateLimit();

    const input: Record<string, unknown> = {
      startUrls: [{ url }],
      resultsLimit: 1,
      commentsLimit: 100,
    };

    let items: unknown[] = [];

    try {
      const { runId, datasetId } = await startApifyRun(ACTOR_ID, input, token);
      await pollRunUntilDone(runId, token);
      items = await fetchDatasetItems(datasetId, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return FetchResultSchema.parse({
        provider: 'facebook_groups',
        url,
        fetch_status: 'failed',
        fetch_error: `Facebook Groups fetch failed: ${msg.slice(0, 200)}`,
      });
    }

    const firstItem = items[0];
    if (firstItem === undefined) {
      return FetchResultSchema.parse({
        provider: 'facebook_groups',
        url,
        fetch_status: 'failed',
        fetch_error: 'No items returned from Apify',
      });
    }

    const parsed = FbPostItemSchema.safeParse(firstItem);
    if (!parsed.success) {
      return FetchResultSchema.parse({
        provider: 'facebook_groups',
        url,
        fetch_status: 'failed',
        fetch_error: `Invalid item shape: ${parsed.error.message.slice(0, 100)}`,
      });
    }

    const item = parsed.data;
    const snippetSource = item.text !== undefined ? item.text : '';
    const titleSource = item.title !== undefined && item.title.length > 0
      ? item.title
      : snippetSource.slice(0, 80);

    // Build markdown with post + comments
    const lines: string[] = [
      `# ${titleSource}`,
      '',
      `**Author:** ${extractAuthorName(item) !== undefined ? extractAuthorName(item) : 'Unknown'} | **Reactions:** ${item.reactionsCount !== undefined ? item.reactionsCount : 0} | **Comments:** ${item.commentsCount !== undefined ? item.commentsCount : 0}`,
      '',
    ];

    if (snippetSource.length > 0) {
      lines.push('## Post', '', snippetSource, '');
    }

    // Include raw comments if Apify returned them inline
    const rawComments = item.comments;
    if (rawComments !== undefined && Array.isArray(rawComments) && rawComments.length > 0) {
      lines.push('## Comments', '');

      const FbCommentSchema = z.object({
        text: z.string().optional(),
        author: z.union([z.string(), z.object({ name: z.string().optional() })]).optional(),
        timestamp: z.string().optional(),
        likesCount: z.number().optional(),
      }).passthrough();

      for (const rawComment of rawComments) {
        const commentParsed = FbCommentSchema.safeParse(rawComment);
        if (!commentParsed.success) continue;
        const c = commentParsed.data;

        let commentAuthor = 'Unknown';
        if (typeof c.author === 'string' && c.author.length > 0) {
          commentAuthor = c.author;
        } else if (typeof c.author === 'object' && c.author !== null && c.author.name !== undefined && c.author.name.length > 0) {
          commentAuthor = c.author.name;
        }

        const commentText = c.text !== undefined ? c.text : '';
        if (commentText.length > 0) {
          lines.push(`**${commentAuthor}** (${c.likesCount !== undefined ? c.likesCount : 0} likes)`);
          lines.push('');
          lines.push(commentText);
          lines.push('');
          lines.push('---');
          lines.push('');
        }
      }
    }

    const markdown = lines.join('\n');
    const publishedAt = item.timestamp !== undefined ? toIsoString(item.timestamp) : undefined;

    const result = FetchResultSchema.parse({
      provider: 'facebook_groups',
      url,
      canonical_id: item.id !== undefined && item.id.length > 0 ? item.id : undefined,
      title: titleSource.slice(0, 200),
      author: extractAuthorName(item),
      published_at: publishedAt,
      raw_content: snippetSource,
      markdown,
      engagement: {
        upvotes: item.reactionsCount,
        comment_count: item.commentsCount,
      },
      fetch_status: 'ok',
      raw_metadata: { url, comments: item.comments },
    });

    logger.info(
      { url: url.slice(0, 60), title: titleSource.slice(0, 40) },
      '[FacebookGroups] Fetch complete',
    );

    return result;
  },

  async extract(raw: FetchResult): Promise<ExtractedQuotes> {
    const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
    return extractQuotesWithGemini({
      provider: 'facebook_groups',
      url: raw.url,
      content,
      mode: 'reddit', // closest equivalent — comment threads with engagement
    });
  },
};
