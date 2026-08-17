/**
 * Unified YouTube transcript stack — promoted and generalized from Swishh's
 * `lib/youtube-knowledge/transcript-service.ts` +
 * `lib/podcast/groq-whisper-service.ts`.
 *
 * Tier ladder (first success wins):
 *   1. Captions, free:
 *      a. `youtube-transcript-plus` (multi-client innertube captions)
 *      b. Watch-page captionTracks + timedtext XML (ported from this
 *         package's `advice-youtube.ts` page-scrape fallback — the more
 *         battle-tested of the two caption implementations in the fleet:
 *         it carries bracket-depth JSON extraction, HTML entity decoding,
 *         and the manual-en > auto-en > any-en > first track selection)
 *   2. `youtubei.js` audio stream -> Groq Whisper `whisper-large-v3-turbo`
 *      (audio is downloaded locally, then uploaded — Groq never sees the
 *      googlevideo URL, avoiding decipher IP-binding issues)
 *   3. Deepgram Nova-3 (only when deepgramApiKey is provided; same local
 *      download, raw-bytes POST)
 *
 * All keys arrive as function arguments — this package never reads
 * process.env. When every tier fails, throws TranscriptUnavailableError with
 * the per-tier reasons (no silent empty transcripts).
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { sleep } from '../pipeline-core.js';

// =============================================================================
// Public types
// =============================================================================

export type TranscriptTier = 'captions' | 'groq-whisper' | 'deepgram';

/** Timestamp-anchored transcript window (~30s soft target, 45s hard cap). */
export interface TranscriptSegmentWindow {
  /** Window start time in seconds. */
  t: number;
  text: string;
}

export interface TranscriptUsage {
  provider: 'groq' | 'deepgram';
  audioDurationSeconds: number;
  estimatedCostUsd: number;
}

export interface TranscriptResult {
  text: string;
  segments: TranscriptSegmentWindow[];
  tier: TranscriptTier;
  hasCaptions: boolean;
  language: string | null;
  /** Present only on the paid tiers (2/3). */
  usage?: TranscriptUsage;
}

export class TranscriptUnavailableError extends Error {
  readonly videoId: string;
  readonly tierErrors: Record<string, string>;

  constructor(videoId: string, tierErrors: Record<string, string>) {
    const detail = Object.entries(tierErrors)
      .map(([tier, reason]) => `${tier}: ${reason}`)
      .join('; ');
    super(`No transcript available for video ${videoId}. ${detail}`);
    this.name = 'TranscriptUnavailableError';
    this.videoId = videoId;
    this.tierErrors = tierErrors;
  }
}

// =============================================================================
// Internal segment model + windowing
// =============================================================================

interface RawSegment {
  start: number;
  duration: number;
  text: string;
}

const WINDOW_SOFT_SECONDS = 30;
const WINDOW_HARD_SECONDS = 45;
const WINDOW_GAP_BREAK_SECONDS = 2;

/**
 * Group raw caption/whisper segments into timestamp-anchored windows.
 * Mirrors advice-youtube's paragraph logic: break on >2s gaps, at sentence
 * boundaries past the 30s soft target, and unconditionally past 45s.
 */
function windowSegments(raw: RawSegment[]): TranscriptSegmentWindow[] {
  if (raw.length === 0) return [];

  const windows: TranscriptSegmentWindow[] = [];
  let currentTexts: string[] = [];
  let windowStart = raw[0] !== undefined ? raw[0].start : 0;

  const flush = (): void => {
    if (currentTexts.length === 0) return;
    windows.push({ t: Math.floor(windowStart), text: currentTexts.join(' ') });
    currentTexts = [];
  };

  for (let i = 0; i < raw.length; i++) {
    const segment = raw[i];
    if (segment === undefined) continue;

    const prev = i > 0 ? raw[i - 1] : undefined;
    let shouldBreak = false;

    if (prev !== undefined) {
      const gap = segment.start - (prev.start + prev.duration);
      if (gap > WINDOW_GAP_BREAK_SECONDS) shouldBreak = true;
    }

    const elapsed = segment.start - windowStart;
    if (elapsed > WINDOW_SOFT_SECONDS && currentTexts.length > 0) {
      const lastText = currentTexts[currentTexts.length - 1];
      if (lastText !== undefined) {
        const lastChar = lastText.trim().slice(-1);
        if (lastChar === '.' || lastChar === '!' || lastChar === '?') {
          shouldBreak = true;
        }
      }
      if (elapsed > WINDOW_HARD_SECONDS) shouldBreak = true;
    }

    if (shouldBreak) {
      flush();
      windowStart = segment.start;
    }

    currentTexts.push(segment.text);
  }

  flush();
  return windows;
}

function fullTextFromWindows(windows: TranscriptSegmentWindow[]): string {
  return windows.map((w) => w.text).join('\n\n');
}

// =============================================================================
// HTML entity decoding (ported from advice-youtube.ts)
// =============================================================================

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCharCode(Number(dec)));
}

// =============================================================================
// Tier 1a: captions via youtube-transcript-plus (free)
// =============================================================================

interface CaptionTierResult {
  raw: RawSegment[];
  language: string | null;
}

async function captionsViaTranscriptPlus(videoId: string): Promise<CaptionTierResult> {
  const { fetchTranscript } = await import('youtube-transcript-plus');
  const segments = await fetchTranscript(videoId, { lang: 'en' });
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('No caption segments returned');
  }
  // TranscriptResponse offsets/durations are fractional seconds (parsed from
  // the timedtext XML start/dur attributes).
  const first = segments[0];
  const raw: RawSegment[] = segments.map((s) => ({
    text: decodeHtmlEntities(s.text),
    start: s.offset,
    duration: s.duration,
  }));
  return {
    raw,
    language: first !== undefined && first.lang.length > 0 ? first.lang : null,
  };
}

// =============================================================================
// Tier 1b: watch-page captionTracks + timedtext XML (ported from advice-youtube)
// =============================================================================

const WATCH_PAGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CaptionTrackSchema = z.object({
  baseUrl: z.string(),
  languageCode: z.string(),
  kind: z.string().optional(),
});

async function captionsViaPageScrape(videoId: string): Promise<CaptionTierResult> {
  const pageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'User-Agent': WATCH_PAGE_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!pageResponse.ok) {
    throw new Error(`YouTube watch page returned ${pageResponse.status}`);
  }
  const html = await pageResponse.text();

  // Extract the captionTracks array with bracket-depth parsing.
  const captionMarker = '"captionTracks":';
  const markerIdx = html.indexOf(captionMarker);
  if (markerIdx === -1) {
    throw new Error('No captions found in page HTML');
  }
  const arrayStart = html.indexOf('[', markerIdx + captionMarker.length);
  if (arrayStart === -1) {
    throw new Error('No caption array found');
  }
  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < html.length && i < arrayStart + 50_000; i++) {
    const ch = html[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { arrayEnd = i; break; }
    }
  }
  if (arrayEnd === -1) {
    throw new Error('Could not parse caption array bounds');
  }

  const rawTracksJson: unknown = JSON.parse(html.slice(arrayStart, arrayEnd + 1));
  const tracks = z.array(CaptionTrackSchema).parse(rawTracksJson);

  // Select best track: manual en > auto en > any en > first.
  let selectedTrack: z.infer<typeof CaptionTrackSchema> | undefined;
  for (const track of tracks) {
    if (track.languageCode === 'en' && track.kind !== 'asr') { selectedTrack = track; break; }
  }
  if (selectedTrack === undefined) {
    for (const track of tracks) {
      if (track.languageCode === 'en') { selectedTrack = track; break; }
    }
  }
  if (selectedTrack === undefined) {
    for (const track of tracks) {
      if (track.languageCode.startsWith('en')) { selectedTrack = track; break; }
    }
  }
  if (selectedTrack === undefined) {
    selectedTrack = tracks[0];
  }
  if (selectedTrack === undefined) {
    throw new Error('No usable caption track');
  }

  const transcriptResponse = await fetch(selectedTrack.baseUrl, {
    headers: { 'User-Agent': WATCH_PAGE_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!transcriptResponse.ok) {
    throw new Error(`Transcript XML returned ${transcriptResponse.status}`);
  }
  const xml = await transcriptResponse.text();
  if (xml.length === 0) {
    throw new Error('Transcript XML was empty');
  }

  const raw: RawSegment[] = [];
  const textRegex = /<text\s+start="([^"]+)"\s+dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match = textRegex.exec(xml);
  while (match !== null) {
    const startStr = match[1];
    const durStr = match[2];
    const rawText = match[3];
    if (startStr !== undefined && durStr !== undefined && rawText !== undefined) {
      const cleaned = decodeHtmlEntities(rawText.replace(/<[^>]*>/g, '').trim());
      if (cleaned.length > 0) {
        raw.push({ text: cleaned, start: parseFloat(startStr), duration: parseFloat(durStr) });
      }
    }
    match = textRegex.exec(xml);
  }
  if (raw.length === 0) {
    throw new Error('No text segments in transcript XML');
  }

  return {
    raw,
    language: selectedTrack.languageCode.length > 0 ? selectedTrack.languageCode : null,
  };
}

// =============================================================================
// Innertube audio stream resolution (shared by tiers 2 and 3)
// =============================================================================

interface AudioStream {
  url: string;
  mimeType: string;
}

async function resolveAudioStreamUrl(videoId: string): Promise<AudioStream> {
  const { Innertube } = await import('youtubei.js');
  const yt = await Innertube.create({ generate_session_locally: true });
  const info = await yt.getInfo(videoId);

  // chooseFormat throws when no format matches (per youtubei.js FormatUtils),
  // so a returned value is always a real Format.
  const audioFormat = info.chooseFormat({ type: 'audio', quality: 'best' });

  const player = yt.session.player;
  if (player === undefined) {
    throw new Error('Innertube player unavailable — cannot decipher audio stream');
  }

  const streamUrl = await audioFormat.decipher(player);
  if (streamUrl.length === 0) {
    throw new Error('Could not decipher audio stream URL');
  }

  return { url: streamUrl, mimeType: audioFormat.mime_type };
}

// =============================================================================
// Audio download (shared by tiers 2 and 3)
// =============================================================================

const GROQ_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEEPGRAM_MAX_AUDIO_BYTES = 100 * 1024 * 1024;

async function downloadAudioBytes(streamUrl: string, maxBytes: number): Promise<ArrayBuffer> {
  const response = await fetch(streamUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`Audio download failed: ${response.status}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(`Audio too large (${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB > ${Math.round(maxBytes / 1024 / 1024)}MB cap)`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Audio too large (${Math.round(bytes.byteLength / 1024 / 1024)}MB > ${Math.round(maxBytes / 1024 / 1024)}MB cap)`);
  }
  return bytes;
}

// =============================================================================
// Tier 2: Groq Whisper (ported from Swishh groq-whisper-service; key as arg)
// =============================================================================

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
// Per Swishh CLAUDE.md (verified against Groq pricing): turbo $0.04/hr.
const GROQ_TURBO_COST_PER_HOUR_USD = 0.04;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

const GroqVerboseResponseSchema = z.object({
  text: z.string().default(''),
  language: z.string().optional(),
  duration: z.number().optional(),
  segments: z.array(z.object({
    start: z.number(),
    end: z.number(),
    text: z.string(),
  })).default([]),
});

async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await sleep(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }
  if (lastError !== null) throw lastError;
  throw new Error('Retry failed with no error');
}

async function transcribeWithGroq(
  audioBytes: ArrayBuffer,
  mimeType: string,
  groqApiKey: string,
): Promise<{ text: string; raw: RawSegment[]; language: string | null; durationSeconds: number }> {
  const extension = mimeType.includes('webm') ? 'webm' : (mimeType.includes('mp4') ? 'm4a' : 'mp3');
  const formData = new FormData();
  formData.append('file', new Blob([audioBytes], { type: mimeType }), `audio.${extension}`);
  formData.append('model', GROQ_MODEL);
  formData.append('response_format', 'verbose_json');

  const response = await retryWithBackoff(async () => {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}` },
      body: formData,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Groq API error (${res.status}): ${errorText.slice(0, 200)}`);
    }
    return res;
  });

  const rawJson: unknown = await response.json();
  const parsed = GroqVerboseResponseSchema.parse(rawJson);
  const text = parsed.text.trim();
  if (text.length === 0) {
    throw new Error('Groq returned an empty transcription');
  }

  const raw: RawSegment[] = parsed.segments.map((seg) => ({
    start: seg.start,
    duration: Math.max(0, seg.end - seg.start),
    text: seg.text.trim(),
  })).filter((seg) => seg.text.length > 0);

  return {
    text,
    raw,
    language: parsed.language !== undefined && parsed.language.length > 0 ? parsed.language : null,
    durationSeconds: parsed.duration !== undefined ? parsed.duration : 0,
  };
}

// =============================================================================
// Tier 3: Deepgram Nova-3 (raw-bytes POST)
// =============================================================================

const DEEPGRAM_API_URL = 'https://api.deepgram.com/v1/listen';
// Deepgram Nova-3 pay-as-you-go list price (~$0.0043/min).
const DEEPGRAM_NOVA3_COST_PER_MINUTE_USD = 0.0043;

const DeepgramResponseSchema = z.object({
  metadata: z.object({
    duration: z.number().optional(),
  }).optional(),
  results: z.object({
    channels: z.array(z.object({
      detected_language: z.string().optional(),
      alternatives: z.array(z.object({
        transcript: z.string().default(''),
      })).default([]),
    })).default([]),
    utterances: z.array(z.object({
      start: z.number(),
      end: z.number(),
      transcript: z.string(),
    })).default([]),
  }),
});

async function transcribeWithDeepgram(
  audioBytes: ArrayBuffer,
  mimeType: string,
  deepgramApiKey: string,
): Promise<{ text: string; raw: RawSegment[]; language: string | null; durationSeconds: number }> {
  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
  });

  const response = await fetch(`${DEEPGRAM_API_URL}?${params.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${deepgramApiKey}`,
      'Content-Type': mimeType,
    },
    body: audioBytes,
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deepgram API error (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const rawJson: unknown = await response.json();
  const parsed = DeepgramResponseSchema.parse(rawJson);

  const channel = parsed.results.channels[0];
  const alternative = channel !== undefined ? channel.alternatives[0] : undefined;
  const text = alternative !== undefined ? alternative.transcript.trim() : '';
  if (text.length === 0) {
    throw new Error('Deepgram returned an empty transcription');
  }

  const raw: RawSegment[] = parsed.results.utterances.map((u) => ({
    start: u.start,
    duration: Math.max(0, u.end - u.start),
    text: u.transcript.trim(),
  })).filter((seg) => seg.text.length > 0);

  const detectedLanguage = channel !== undefined ? channel.detected_language : undefined;
  const metadataDuration = parsed.metadata !== undefined ? parsed.metadata.duration : undefined;

  return {
    text,
    raw,
    language: detectedLanguage !== undefined && detectedLanguage.length > 0 ? detectedLanguage : null,
    durationSeconds: metadataDuration !== undefined ? metadataDuration : 0,
  };
}

// =============================================================================
// Main: tiered fallback chain
// =============================================================================

/**
 * Extract a transcript for a YouTube video.
 *
 * Tier 1 captions runs always (free). Tier 2 Groq Whisper runs when
 * `groqApiKey` is provided; tier 3 Deepgram only when `deepgramApiKey` is
 * provided. Throws TranscriptUnavailableError when every available tier
 * fails.
 */
export async function extractTranscriptWithFallback(input: {
  videoId: string;
  groqApiKey?: string;
  deepgramApiKey?: string;
}): Promise<TranscriptResult> {
  const tierErrors: Record<string, string> = {};

  // ---------------------------------------------------------------------------
  // Tier 1: captions (free) — youtube-transcript-plus, then page scrape
  // ---------------------------------------------------------------------------
  let captionResult: CaptionTierResult | null = null;
  try {
    captionResult = await captionsViaTranscriptPlus(input.videoId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    tierErrors['captions-youtube-transcript-plus'] = msg;
    logger.warn({ videoId: input.videoId }, '[YouTubeTranscript] youtube-transcript-plus failed, trying page scrape');
    try {
      captionResult = await captionsViaPageScrape(input.videoId);
    } catch (scrapeErr) {
      tierErrors['captions-page-scrape'] = scrapeErr instanceof Error ? scrapeErr.message : String(scrapeErr);
    }
  }

  if (captionResult !== null && captionResult.raw.length > 0) {
    const segments = windowSegments(captionResult.raw);
    logger.info(
      { videoId: input.videoId, count: segments.length },
      '[YouTubeTranscript] Success via captions tier',
    );
    return {
      text: fullTextFromWindows(segments),
      segments,
      tier: 'captions',
      hasCaptions: true,
      language: captionResult.language,
    };
  }

  // ---------------------------------------------------------------------------
  // Tiers 2/3 need an innertube audio stream URL — resolve once, share.
  // ---------------------------------------------------------------------------
  const wantsGroq = input.groqApiKey !== undefined && input.groqApiKey.length > 0;
  const wantsDeepgram = input.deepgramApiKey !== undefined && input.deepgramApiKey.length > 0;

  let audioStream: AudioStream | null = null;
  if (wantsGroq || wantsDeepgram) {
    try {
      audioStream = await resolveAudioStreamUrl(input.videoId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tierErrors['innertube-audio-stream'] = msg;
      logger.warn({ videoId: input.videoId }, '[YouTubeTranscript] Audio stream resolution failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 2: Groq Whisper
  // ---------------------------------------------------------------------------
  if (wantsGroq && audioStream !== null && input.groqApiKey !== undefined) {
    try {
      const audioBytes = await downloadAudioBytes(audioStream.url, GROQ_MAX_AUDIO_BYTES);
      const groq = await transcribeWithGroq(audioBytes, audioStream.mimeType, input.groqApiKey);
      const segments = windowSegments(groq.raw);
      logger.info(
        { videoId: input.videoId, count: segments.length },
        '[YouTubeTranscript] Success via Groq Whisper tier',
      );
      return {
        text: groq.raw.length > 0 ? fullTextFromWindows(segments) : groq.text,
        segments,
        tier: 'groq-whisper',
        hasCaptions: false,
        language: groq.language,
        usage: {
          provider: 'groq',
          audioDurationSeconds: groq.durationSeconds,
          estimatedCostUsd: (groq.durationSeconds / 3600) * GROQ_TURBO_COST_PER_HOUR_USD,
        },
      };
    } catch (err) {
      tierErrors['groq-whisper'] = err instanceof Error ? err.message : String(err);
      logger.warn({ videoId: input.videoId }, '[YouTubeTranscript] Groq Whisper tier failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 3: Deepgram Nova-3
  // ---------------------------------------------------------------------------
  if (wantsDeepgram && audioStream !== null && input.deepgramApiKey !== undefined) {
    try {
      const audioBytes = await downloadAudioBytes(audioStream.url, DEEPGRAM_MAX_AUDIO_BYTES);
      const deepgram = await transcribeWithDeepgram(audioBytes, audioStream.mimeType, input.deepgramApiKey);
      const segments = windowSegments(deepgram.raw);
      logger.info(
        { videoId: input.videoId, count: segments.length },
        '[YouTubeTranscript] Success via Deepgram tier',
      );
      return {
        text: deepgram.raw.length > 0 ? fullTextFromWindows(segments) : deepgram.text,
        segments,
        tier: 'deepgram',
        hasCaptions: false,
        language: deepgram.language,
        usage: {
          provider: 'deepgram',
          audioDurationSeconds: deepgram.durationSeconds,
          estimatedCostUsd: (deepgram.durationSeconds / 60) * DEEPGRAM_NOVA3_COST_PER_MINUTE_USD,
        },
      };
    } catch (err) {
      tierErrors['deepgram'] = err instanceof Error ? err.message : String(err);
      logger.warn({ videoId: input.videoId }, '[YouTubeTranscript] Deepgram tier failed');
    }
  }

  if (Object.keys(tierErrors).length === 0) {
    tierErrors['config'] = 'Captions unavailable and no groqApiKey or deepgramApiKey provided for paid tiers';
  }
  logger.error({ videoId: input.videoId }, '[YouTubeTranscript] All transcript tiers failed');
  throw new TranscriptUnavailableError(input.videoId, tierErrors);
}
