/**
 * Shared helpers for the YouTube ingestion modules (channel/metadata/comments).
 */

export const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

/** Parse a date string to ISO 8601; undefined when empty or unparseable. */
export function toIsoString(dateStr: string): string | undefined {
  if (dateStr.length === 0) return undefined;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** Parse an integer-ish API string; undefined when missing or non-numeric. */
export function safeParseInt(val: string | undefined): number | undefined {
  if (val === undefined || val === '') return undefined;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Parse an ISO 8601 duration (YouTube contentDetails.duration, e.g.
 * "PT1H2M10S" or "P1DT3H") to seconds. Returns 0 when the string does not
 * match the grammar — YouTube always emits valid durations, so a mismatch
 * means the payload drifted; 0 marks "unknown" without inventing a value.
 */
export function iso8601DurationToSeconds(duration: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration);
  if (match === null) return 0;
  const days = match[1] !== undefined ? parseInt(match[1], 10) : 0;
  const hours = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  const minutes = match[3] !== undefined ? parseInt(match[3], 10) : 0;
  const seconds = match[4] !== undefined ? parseInt(match[4], 10) : 0;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

export interface YtThumbnail {
  url?: string;
  width?: number;
  height?: number;
}

/**
 * Explicit thumbnail preference chain: maxres -> standard -> high -> medium
 * -> default. First entry with a non-empty URL wins; undefined when the API
 * returned no usable thumbnail at all.
 */
export function selectThumbnailUrl(thumbnails: Record<string, YtThumbnail | undefined>): string | undefined {
  const order = ['maxres', 'standard', 'high', 'medium', 'default'];
  for (const key of order) {
    const thumb = thumbnails[key];
    if (thumb !== undefined && thumb.url !== undefined && thumb.url.length > 0) {
      return thumb.url;
    }
  }
  return undefined;
}
