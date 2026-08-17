/**
 * Minimal structured logger for @swishh/research.
 *
 * Decoupled replacement for cortex-worker's pino logger. Every harvested
 * module imports `{ logger }` and calls it with either a single message
 * string `logger.info('msg')` or a structured-object + message pair
 * `logger.info({ key: value }, 'msg')` — matching pino's call signature.
 *
 * The default implementation is console-backed. Consumers that want their
 * own logging can pass a `Logger` into `runDeepResearch({ logger })`.
 */

export interface Logger {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  debug(obj: Record<string, unknown> | string, msg?: string): void;
}

type ConsoleMethod = (...args: unknown[]) => void;

const SAFE_STRING_FIELDS = new Set([
  'backend',
  'category',
  'depth',
  'errorClass',
  'kind',
  'method',
  'mode',
  'model',
  'operation',
  'phase',
  'provider',
  'providerName',
  'sort',
  'source_mode',
  'status',
  'target',
]);

const SAFE_STRING_VALUES = new Set([
  'GET', 'POST',
  'acceptable', 'anthropic', 'apify', 'brightdata', 'completed', 'crawl4ai',
  'critique', 'deep', 'embed', 'error', 'exa', 'extract', 'failed',
  'facebook_groups', 'fetch', 'gemini', 'github', 'google', 'hn', 'instagram',
  'longform', 'mixed', 'negative', 'neutral', 'openai', 'pending',
  'perplexity', 'plan', 'podcasts', 'positive', 'processing', 'quick', 'reddit',
  'relevance', 'rss', 'search', 'searxng', 'serp', 'serpapi', 'serper',
  'standard', 'strong', 'success', 'synth', 'tavily', 'tiktok', 'top',
  'transcribe', 'ungrounded', 'unknown', 'video', 'voyage', 'weak', 'web', 'x',
  'youtube',
]);

const SAFE_NUMERIC_FIELDS = new Set([
  'actual_tokens',
  'attempt',
  'attempts',
  'candidate_tokens',
  'chars',
  'citations',
  'claims',
  'costUsd',
  'count',
  'crawled',
  'sources',
  'dropped_claims',
  'dropped_quotes',
  'durationMs',
  'estimated_sections',
  'fromSearchRawContent',
  'gaps',
  'input_tokens',
  'output_tokens',
  'parsed',
  'pass',
  'prompt_tokens',
  'quotes',
  'recency_days',
  'replies',
  'results',
  'returned',
  'sections',
  'status',
  'total',
  'upvotes',
  'views',
  'waitMs',
]);

const SAFE_BOOLEAN_FIELDS = new Set([
  'cached',
  'enabled',
  'passed',
  'retryable',
  'success',
]);

const SAFE_LOG_KEYS = new Set([
  'actual_tokens', 'attempt', 'attempts', 'backend', 'bytes', 'cached',
  'candidate_tokens', 'category', 'chars', 'citations', 'claims', 'costUsd',
  'count', 'crawled', 'delayMs', 'depth', 'dropped_claims', 'dropped_quotes',
  'durationMs', 'enabled', 'error', 'errorClass', 'errors',
  'estimated_sections', 'eventType', 'feedTitle', 'feedUrl',
  'fromSearchRawContent', 'gaps', 'group', 'hashtagCount', 'input_tokens',
  'kind', 'method', 'mode', 'model', 'operation', 'output_tokens', 'parentId',
  'parsed', 'pass', 'passed', 'phase', 'prompt_tokens', 'provider',
  'providerName', 'query', 'quotes', 'rawText', 'reason', 'recency_days',
  'redacted', 'replies', 'resultCount', 'results', 'retryable', 'returned',
  'sections', 'sort', 'sorts', 'source_mode', 'sources', 'status', 'success',
  'target', 'taskId', 'timeFilter', 'total', 'upvotes', 'url', 'videoId',
  'views', 'waitMs',
]);

const SAFE_MESSAGE_TAGS = new Set([
  'BrightData',
  'Crawl4AI',
  'DirectFetch',
  'Exa',
  'FacebookGroups',
  'GeminiExtractor',
  'GitHub',
  'HN',
  'Instagram',
  'JinaReader',
  'Perplexity',
  'Podcasts',
  'RSS',
  'Reddit',
  'SearXNG',
  'SerpAPI',
  'Serper',
  'Tavily',
  'TikTok',
  'X',
  'YouTube',
  'YouTubeTranscript',
  'cache',
  'categorizeItems',
  'critique',
  'deep-research/rerank',
  'embedItems',
  'embedder',
  'fetchWithRetry',
  'generateDocument',
  'ingestSource',
  'planner',
  'research',
  'runAnswer',
  'runDeepResearch',
  'runManagedResearch',
  'synthesis',
]);

function redactedString(value: string): { bytes: number; redacted: true } {
  return {
    bytes: Buffer.byteLength(value, 'utf8'),
    redacted: true,
  };
}

function safeStringField(key: string, value: string): string | ReturnType<typeof redactedString> {
  if (key === 'target' && /^[a-f0-9]{16}$/.test(value)) return value;
  if (SAFE_STRING_FIELDS.has(key)
      && SAFE_STRING_VALUES.has(value)) {
    return value;
  }
  return redactedString(value);
}

function sanitizeValue(key: string, value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === 'number') {
    return SAFE_NUMERIC_FIELDS.has(key) && Number.isFinite(value)
      ? value
      : { redacted: true };
  }
  if (typeof value === 'boolean') {
    return SAFE_BOOLEAN_FIELDS.has(key) ? value : { redacted: true };
  }
  if (typeof value === 'string') return safeStringField(key, value);
  if (value instanceof Error) return { errorClass: safeStringField('errorClass', value.name) };
  if (Array.isArray(value)) return { redacted: true };
  if (typeof value === 'object' && depth < 2) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([nestedKey]) => SAFE_LOG_KEYS.has(nestedKey))
        .slice(0, 40)
        .map(([nestedKey, nestedValue]) => [
          nestedKey,
          sanitizeValue(nestedKey, nestedValue, depth + 1),
        ]),
    );
  }
  return { redacted: true };
}

export function sanitizeLogRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => SAFE_LOG_KEYS.has(key))
      .slice(0, 80)
      .map(([key, value]) => [key, sanitizeValue(key, value, 0)]),
  );
}

function safeMessage(value: string | undefined): string {
  if (value !== undefined) {
    const match = /^\[([A-Za-z0-9_./-]{1,80})\]/.exec(value);
    const tag = match?.[1];
    if (tag !== undefined && SAFE_MESSAGE_TAGS.has(tag)) {
      return `[${tag}] event`;
    }
  }
  return '[research] event';
}

function emit(method: ConsoleMethod, obj: Record<string, unknown> | string, msg?: string): void {
  if (typeof obj === 'string') {
    method(safeMessage(obj));
    return;
  }
  if (msg !== undefined) {
    method(safeMessage(msg), sanitizeLogRecord(obj));
    return;
  }
  method(sanitizeLogRecord(obj));
}

/**
 * Console-backed logger used by default. Mirrors pino's `(obj, msg)` /
 * `(msg)` overloads so harvested call sites need no changes.
 */
function consoleLogger(): Logger {
  return {
    info(obj, msg) {
      emit(console.info.bind(console), obj, msg);
    },
    warn(obj, msg) {
      emit(console.warn.bind(console), obj, msg);
    },
    error(obj, msg) {
      emit(console.error.bind(console), obj, msg);
    },
    debug(obj, msg) {
      emit(console.debug.bind(console), obj, msg);
    },
  };
}

export function createSanitizedLogger(sink: Logger): Logger {
  const forward = (
    method: keyof Logger,
    obj: Record<string, unknown> | string,
    msg?: string,
  ): void => {
    if (typeof obj === 'string') {
      sink[method](safeMessage(obj));
      return;
    }
    sink[method](sanitizeLogRecord(obj), safeMessage(msg));
  };
  return {
    info: (obj, msg) => forward('info', obj, msg),
    warn: (obj, msg) => forward('warn', obj, msg),
    error: (obj, msg) => forward('error', obj, msg),
    debug: (obj, msg) => forward('debug', obj, msg),
  };
}

/** Default logger never emits briefs, queries, URLs, bodies, or raw errors. */
export const logger: Logger = consoleLogger();

export function safeLogger(loggerOverride: Logger | undefined): Logger {
  return loggerOverride === undefined ? logger : createSanitizedLogger(loggerOverride);
}
