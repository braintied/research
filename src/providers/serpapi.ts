/**
 * SerpAPI Google Search Provider
 *
 * Wraps SerpAPI (https://serpapi.com/search).
 * Parses organic results, ads, people-also-ask, answer_box, knowledge panel.
 * Rate limit: 1 req/sec (default tier).
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { MissingCredentialError, type ResearchCredentials } from '../credentials.js';
import { sleep } from '../pipeline-core.js';
import {
  SearchResultSchema,
  type SearchProvider,
  type SearchResult,
  type FetchResult,
  type ExtractedQuotes,
  type SearchOpts,
} from '../types.js';
import { extractQuotesWithGemini } from './gemini-extractor.js';

// =============================================================================
// Rate limiter — 1 req/sec
// =============================================================================

const SERPAPI_RATE_LIMIT_MS = 1100;
let lastSerpCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastSerpCallAt;
  if (elapsed < SERPAPI_RATE_LIMIT_MS) {
    await sleep(SERPAPI_RATE_LIMIT_MS - elapsed);
  }
  lastSerpCallAt = Date.now();
}

// =============================================================================
// SerpAPI response schemas
// =============================================================================

const OrganicResultSchema = z.object({
  position: z.number().optional(),
  title: z.string().default(''),
  link: z.string().default(''),
  snippet: z.string().default(''),
  date: z.string().optional(),
  displayed_link: z.string().optional(),
}).passthrough();

const AdResultSchema = z.object({
  position: z.number().optional(),
  title: z.string().default(''),
  link: z.string().default(''),
  snippet: z.string().optional(),
  displayed_link: z.string().optional(),
}).passthrough();

const PaaItemSchema = z.object({
  question: z.string().default(''),
  snippet: z.string().optional(),
  link: z.string().optional(),
  title: z.string().optional(),
}).passthrough();

const AnswerBoxSchema = z.object({
  type: z.string().optional(),
  answer: z.string().optional(),
  snippet: z.string().optional(),
  title: z.string().optional(),
  link: z.string().optional(),
}).passthrough();

const KnowledgePanelSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  website: z.string().optional(),
}).passthrough();

const SerpApiResponseSchema = z.object({
  organic_results: z.array(OrganicResultSchema).default([]),
  ads: z.array(AdResultSchema).default([]),
  related_questions: z.array(PaaItemSchema).default([]),
  answer_box: AnswerBoxSchema.optional(),
  knowledge_graph: KnowledgePanelSchema.optional(),
}).passthrough();

// =============================================================================
// Provider
// =============================================================================

const SERPAPI_URL = 'https://serpapi.com/search';

function requireApiKey(credentials: ResearchCredentials): string {
  if (credentials.serpapiKey === undefined) {
    throw new MissingCredentialError('serpapiKey', 'required for the SerpAPI search lane');
  }
  return credentials.serpapiKey;
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

export function createSerpapiProvider(credentials: ResearchCredentials): SearchProvider {
  return {
    name: 'serpapi',

    enabled: credentials.serpapiKey !== undefined,

    async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
      const apiKey = requireApiKey(credentials);
      await rateLimit();

      const params = new URLSearchParams({
        q: query,
        engine: 'google',
        api_key: apiKey,
        num: String(opts.limit !== undefined ? opts.limit : 10),
        hl: 'en',
        gl: 'us',
      });

      const response = await fetch(`${SERPAPI_URL}?${params.toString()}`, {
        method: 'GET',
        signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`SerpAPI error: ${response.status} ${errorBody.slice(0, 200)}`);
      }

      const rawJson: unknown = await response.json();
      const parsed = SerpApiResponseSchema.safeParse(rawJson);

      if (!parsed.success) {
        logger.warn({ query: query.slice(0, 60), errors: parsed.error.message }, '[SerpAPI] Invalid response shape');
        return [];
      }

      const data = parsed.data;
      const results: SearchResult[] = [];

      // Organic results
      for (const item of data.organic_results) {
        if (item.link.length === 0) continue;
        const publishedAt = item.date !== undefined ? toIsoString(item.date) : undefined;

        const candidate = {
          provider: 'serpapi' as const,
          url: item.link,
          title: item.title,
          snippet: item.snippet,
          published_at: publishedAt,
          engagement: {},
          raw_metadata: {
            serp_kind: 'organic',
            position: item.position,
            displayed_link: item.displayed_link,
          },
        };

        const validated = SearchResultSchema.safeParse(candidate);
        if (validated.success) {
          results.push(validated.data);
        }
      }

      // Ads
      for (const item of data.ads) {
        if (item.link.length === 0) continue;

        const candidate = {
          provider: 'serpapi' as const,
          url: item.link,
          title: item.title,
          snippet: item.snippet !== undefined ? item.snippet : '',
          engagement: {},
          raw_metadata: {
            serp_kind: 'ads',
            position: item.position,
            displayed_link: item.displayed_link,
          },
        };

        const validated = SearchResultSchema.safeParse(candidate);
        if (validated.success) {
          results.push(validated.data);
        }
      }

      // People Also Ask
      for (const item of data.related_questions) {
        const url = item.link !== undefined ? item.link : `https://www.google.com/search?q=${encodeURIComponent(item.question)}`;
        const snippet = item.snippet !== undefined ? item.snippet : '';

        const candidate = {
          provider: 'serpapi' as const,
          url,
          title: item.question,
          snippet,
          engagement: {},
          raw_metadata: {
            serp_kind: 'paa',
            source_title: item.title,
          },
        };

        const validated = SearchResultSchema.safeParse(candidate);
        if (validated.success) {
          results.push(validated.data);
        }
      }

      // Answer box
      if (data.answer_box !== undefined) {
        const ab = data.answer_box;
        const abUrl = ab.link !== undefined ? ab.link : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const abTitle = ab.title !== undefined ? ab.title : query;
        const abSnippet = ab.answer !== undefined ? ab.answer : (ab.snippet !== undefined ? ab.snippet : '');

        if (abSnippet.length > 0) {
          const candidate = {
            provider: 'serpapi' as const,
            url: abUrl,
            title: abTitle,
            snippet: abSnippet,
            engagement: {},
            raw_metadata: {
              serp_kind: 'answer_box',
              box_type: ab.type,
            },
          };

          const validated = SearchResultSchema.safeParse(candidate);
          if (validated.success) {
            results.push(validated.data);
          }
        }
      }

      // Knowledge panel
      if (data.knowledge_graph !== undefined) {
        const kg = data.knowledge_graph;
        if (kg.description !== undefined && kg.description.length > 0) {
          const kgUrl = kg.website !== undefined ? kg.website : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          const kgTitle = kg.title !== undefined ? kg.title : query;

          const candidate = {
            provider: 'serpapi' as const,
            url: kgUrl,
            title: kgTitle,
            snippet: kg.description,
            engagement: {},
            raw_metadata: {
              serp_kind: 'knowledge_panel',
            },
          };

          const validated = SearchResultSchema.safeParse(candidate);
          if (validated.success) {
            results.push(validated.data);
          }
        }
      }

      logger.info(
        { query: query.slice(0, 60), count: results.length },
        '[SerpAPI] Search complete',
      );

      return results;
    },

    async extract(raw: FetchResult): Promise<ExtractedQuotes> {
      const content = raw.markdown.length > 0 ? raw.markdown : raw.raw_content;
      return extractQuotesWithGemini({
        credentials,
        provider: 'serpapi',
        url: raw.url,
        content,
        mode: 'serp',
      });
    },
  };
}
