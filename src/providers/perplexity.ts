/**
 * Perplexity Search Provider
 *
 * Wraps Perplexity's Sonar API (https://api.perplexity.ai/chat/completions).
 * `search()` runs a `sonar` query and maps the returned search_results /
 * citations into the shared SearchResult contract — useful when a subquery
 * benefits from an answer-engine pass alongside raw SERP results.
 *
 * The heavier managed end-to-end pipeline (`sonar-deep-research`) lives in
 * `src/managed-research.ts`, not here.
 *
 * Raw fetch, no SDK. Enabled when PERPLEXITY_API_KEY is set.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { MissingCredentialError, type ResearchCredentials } from '../credentials.js';
import {
  SearchResultSchema,
  type SearchProvider,
  type SearchResult,
  type SearchOpts,
} from '../types.js';

// =============================================================================
// Perplexity API response schema (subset we consume)
// =============================================================================

const PerplexitySearchResultItemSchema = z.object({
  title: z.string().default(''),
  url: z.string(),
  date: z.string().nullable().optional(),
});

const PerplexityUsageSchema = z.object({
  prompt_tokens: z.number().default(0),
  completion_tokens: z.number().default(0),
});

const PerplexityResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().default(''),
      }),
    }),
  ).default([]),
  search_results: z.array(PerplexitySearchResultItemSchema).default([]),
  citations: z.array(z.string()).default([]),
  // Consumed by perplexityAnswer() so a host can price the call. `search()`
  // ignores it.
  usage: PerplexityUsageSchema.optional(),
});

// =============================================================================
// Provider
// =============================================================================

export const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

export function requirePerplexityApiKey(credentials: ResearchCredentials): string {
  if (credentials.perplexityApiKey === undefined) {
    throw new MissingCredentialError('perplexityApiKey', 'required for the Perplexity managed-answer lane');
  }
  return credentials.perplexityApiKey;
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
// Answer primitive
// =============================================================================

/**
 * Non-2xx from Perplexity, carrying the HTTP status.
 *
 * The status is exposed as a field rather than only in the message because
 * hosts branch on it: a 429 means quota exhausted and typically trips a
 * circuit breaker and pages an operator, while a 5xx is a transient retry.
 * Without a typed status every host would have to regex its own error string.
 */
export class PerplexityApiError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string) {
    super(`Perplexity API error: ${status} ${body.slice(0, 200)}`);
    this.name = 'PerplexityApiError';
    this.status = status;
    this.body = body;
  }

  /** Quota or rate limit exhausted. */
  get isQuotaExceeded(): boolean {
    return this.status === 429;
  }
}

/** Sonar tiers. `sonar-pro` searches deeper and costs more per request. */
export type PerplexityAnswerModel = 'sonar' | 'sonar-pro';

export interface PerplexityAnswerOptions {
  /** Prepended as a system message when set. */
  systemMessage?: string;
  /** Default 'sonar'. */
  model?: PerplexityAnswerModel;
  /** Maps to Perplexity's `search_recency_filter`. */
  searchRecencyFilter?: 'hour' | 'day' | 'week' | 'month' | 'year';
  /**
   * Maps to `web_search_options.search_context_size`. Drives the per-request
   * surcharge, so a host that prices calls must be able to set it.
   */
  searchContextSize?: 'low' | 'medium' | 'high';
  /** Default 1024. `search()` uses 512; answers usually need more. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface PerplexityAnswerResult {
  /** The FULL synthesized answer. Never truncated. */
  answer: string;
  citations: string[];
  searchResults: SearchResult[];
  /** Returned so the caller can price the call. */
  usage: { promptTokens: number; completionTokens: number };
  /** Echoed back because pricing is per-model. */
  model: PerplexityAnswerModel;
  searchContextSize: 'low' | 'medium' | 'high';
}

/**
 * Run a Perplexity Sonar query and return the COMPLETE answer.
 *
 * Why this exists alongside `perplexityProvider.search()`: `search()` maps the
 * response into the shared `SearchResult[]` contract, which means the
 * synthesized answer survives only as `snippet: answer.slice(0, 500)` —
 * truncated to 500 characters and duplicated onto every result. That is the
 * right shape for a search tier feeding a research pipeline, and the wrong
 * shape for a caller that wants the answer itself.
 *
 * Added 2026-07-26 for the fleet consolidation: hosts (Sentigen, Swishh,
 * Cortex) each had their own raw `fetch` against
 * `api.perplexity.ai/chat/completions` precisely because this primitive was
 * missing, and swapping them onto `search()` would have silently truncated
 * every answer.
 *
 * This deliberately does NOT track cost, emit telemetry, or wrap a circuit
 * breaker. Those are host concerns — the package stays host-agnostic, and the
 * host wraps this. `usage` and `model` are returned so it can.
 */
export async function perplexityAnswer(
  credentials: ResearchCredentials,
  query: string,
  options: PerplexityAnswerOptions = {},
): Promise<PerplexityAnswerResult> {
  const apiKey = requirePerplexityApiKey(credentials);
  const model: PerplexityAnswerModel = options.model !== undefined ? options.model : 'sonar';
  const maxTokens = options.maxTokens !== undefined ? options.maxTokens : 1024;
  const searchContextSize =
    options.searchContextSize !== undefined ? options.searchContextSize : 'medium';

  const messages: { role: string; content: string }[] = [];
  if (options.systemMessage !== undefined && options.systemMessage.length > 0) {
    messages.push({ role: 'system', content: options.systemMessage });
  }
  messages.push({ role: 'user', content: query });

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    web_search_options: { search_context_size: searchContextSize },
  };

  if (options.searchRecencyFilter !== undefined) {
    body['search_recency_filter'] = options.searchRecencyFilter;
  }

  const response = await fetch(PERPLEXITY_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: options.signal !== undefined ? options.signal : AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new PerplexityApiError(response.status, errorBody);
  }

  const rawJson: unknown = await response.json();
  const parsed = PerplexityResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(`Perplexity returned an unexpected response shape: ${parsed.error.message}`);
  }

  const firstChoice = parsed.data.choices[0];
  const answer = firstChoice !== undefined ? firstChoice.message.content : '';

  const searchResults: SearchResult[] = [];
  for (const item of parsed.data.search_results) {
    const candidate = {
      provider: 'perplexity' as const,
      url: item.url,
      title: item.title,
      snippet: '',
      published_at:
        item.date !== null && item.date !== undefined ? toIsoString(item.date) : undefined,
      engagement: {},
      raw_metadata: {},
    };
    const validated = SearchResultSchema.safeParse(candidate);
    if (validated.success) {
      searchResults.push(validated.data);
    }
  }

  // Prefer explicit citations; fall back to the structured result urls so a
  // caller always gets something to attribute against.
  const citations =
    parsed.data.citations.length > 0
      ? parsed.data.citations
      : searchResults.map((r) => r.url);

  return {
    answer,
    citations,
    searchResults,
    usage: {
      promptTokens: parsed.data.usage !== undefined ? parsed.data.usage.prompt_tokens : 0,
      completionTokens: parsed.data.usage !== undefined ? parsed.data.usage.completion_tokens : 0,
    },
    model,
    searchContextSize,
  };
}

export function createPerplexityProvider(credentials: ResearchCredentials): SearchProvider {
  return {
    name: 'perplexity',

    enabled: credentials.perplexityApiKey !== undefined,

    async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
      const apiKey = requirePerplexityApiKey(credentials);

      const body: Record<string, unknown> = {
        model: 'sonar',
        messages: [
          {
            role: 'user',
            content: query,
          },
        ],
        max_tokens: 512,
      };

      if (opts.recency_days !== undefined && opts.recency_days > 0) {
        if (opts.recency_days <= 1) {
          body['search_recency_filter'] = 'day';
        } else if (opts.recency_days <= 7) {
          body['search_recency_filter'] = 'week';
        } else if (opts.recency_days <= 31) {
          body['search_recency_filter'] = 'month';
        } else {
          body['search_recency_filter'] = 'year';
        }
      }

      const response = await fetch(PERPLEXITY_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: opts.signal !== undefined ? opts.signal : AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Perplexity API error: ${response.status} ${errorBody.slice(0, 200)}`);
      }

      const rawJson: unknown = await response.json();
      const parsed = PerplexityResponseSchema.safeParse(rawJson);

      if (!parsed.success) {
        logger.warn({ query: query.slice(0, 60), errors: parsed.error.message }, '[Perplexity] Invalid response shape');
        return [];
      }

      const firstChoice = parsed.data.choices[0];
      const answer = firstChoice !== undefined ? firstChoice.message.content : '';
      const limit = opts.limit !== undefined ? opts.limit : 10;

      const results: SearchResult[] = [];

      // Prefer structured search_results; fall back to bare citation URLs.
      if (parsed.data.search_results.length > 0) {
        for (const item of parsed.data.search_results.slice(0, limit)) {
          const publishedAt =
            item.date !== null && item.date !== undefined ? toIsoString(item.date) : undefined;
          const candidate = {
            provider: 'perplexity' as const,
            url: item.url,
            title: item.title,
            snippet: answer.slice(0, 500),
            published_at: publishedAt,
            engagement: {},
            raw_metadata: {},
          };
          const validated = SearchResultSchema.safeParse(candidate);
          if (validated.success) {
            results.push(validated.data);
          }
        }
      } else {
        for (const url of parsed.data.citations.slice(0, limit)) {
          const candidate = {
            provider: 'perplexity' as const,
            url,
            title: '',
            snippet: answer.slice(0, 500),
            engagement: {},
            raw_metadata: {},
          };
          const validated = SearchResultSchema.safeParse(candidate);
          if (validated.success) {
            results.push(validated.data);
          }
        }
      }

      logger.info(
        { query: query.slice(0, 60), count: results.length },
        '[Perplexity] Search complete',
      );

      return results;
    },
  };
}
