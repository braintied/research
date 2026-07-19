/**
 * YouTube Transcript Fetcher — Advice Pipeline
 *
 * Primary: `youtube-transcript` npm package (uses ANDROID client, works from datacenter IPs)
 * Fallback: Page HTML scraping for captionTracks + timedtext API
 *
 * Output includes paragraph-structured text (grouped by ~30s windows).
 */

import { logger } from './logger.js';

interface YTTranscriptSegment {
  text: string;
  offset: number;
  duration: number;
}

interface YTTranscriptModule {
  YoutubeTranscript: {
    fetchTranscript: (videoId: string, config?: { lang?: string }) => Promise<YTTranscriptSegment[]>;
  };
}

let _ytModule: YTTranscriptModule | null = null;

async function getYTModule(): Promise<YTTranscriptModule> {
  if (_ytModule !== null) return _ytModule;
  // youtube-transcript ^1.3.1 ships a proper exports map. Keep resolution
  // inside this function so a packaging change cannot crash at module load.
  _ytModule = (await import('youtube-transcript')) as YTTranscriptModule;
  return _ytModule;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

export interface YouTubeTranscriptResult {
  success: boolean;
  videoId: string;
  title: string;
  channelName: string;
  description: string;
  durationSeconds: number;
  transcript: string;
  segments: TranscriptSegment[];
  wordCount: number;
  viewCount: number;
  likeCount: number;
  keywords: string[];
  publishDate: string;
  category: string;
  isLiveContent: boolean;
  error: string | null;
}

// ── Video ID Extraction ─────────────────────────────────────────────────────

function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');

    if (host === 'youtu.be') {
      const path = parsed.pathname.slice(1).split('/')[0];
      return path !== undefined && path.length > 0 ? path : null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const vParam = parsed.searchParams.get('v');
      if (vParam !== null && vParam.length > 0) return vParam;

      const pathSegments = parsed.pathname.split('/');
      if (pathSegments.length >= 3) {
        const prefix = pathSegments[1];
        const id = pathSegments[2];
        if ((prefix === 'embed' || prefix === 'shorts' || prefix === 'live') && id !== undefined && id.length > 0) {
          return id;
        }
      }
    }
  } catch {
    // invalid URL
  }
  return null;
}

// ── HTML Entity Decoding ────────────────────────────────────────────────────

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

// ── Paragraph Structuring ───────────────────────────────────────────────────

function structureIntoParagraphs(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return '';

  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];
  let paragraphStartTime = 0;

  const firstSegment = segments[0];
  if (firstSegment !== undefined) {
    paragraphStartTime = firstSegment.start;
  }

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;

    const prevSegment = i > 0 ? segments[i - 1] : undefined;
    let shouldBreak = false;

    if (prevSegment !== undefined) {
      const gap = segment.start - (prevSegment.start + prevSegment.duration);
      if (gap > 2.0) shouldBreak = true;
    }

    const elapsed = segment.start - paragraphStartTime;
    if (elapsed > 30 && currentParagraph.length > 0) {
      const lastText = currentParagraph[currentParagraph.length - 1];
      if (lastText !== undefined) {
        const lastChar = lastText.trim().slice(-1);
        if (lastChar === '.' || lastChar === '!' || lastChar === '?') {
          shouldBreak = true;
        }
      }
      if (elapsed > 45) shouldBreak = true;
    }

    if (shouldBreak && currentParagraph.length > 0) {
      paragraphs.push(currentParagraph.join(' '));
      currentParagraph = [];
      paragraphStartTime = segment.start;
    }

    currentParagraph.push(segment.text);
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph.join(' '));
  }

  return paragraphs.join('\n\n');
}

// ── Video Metadata (innertube) ──────────────────────────────────────────────

interface InnertubePlayerResponse {
  videoDetails?: {
    title?: string;
    author?: string;
    shortDescription?: string;
    lengthSeconds?: string;
    viewCount?: string;
    likeCount?: string;
    keywords?: string[];
    publishDate?: string;
    category?: string;
    isLiveContent?: boolean;
    isShorts?: boolean;
  };
}

async function fetchVideoMetadata(videoId: string): Promise<{
  title: string;
  channelName: string;
  description: string;
  durationSeconds: number;
  viewCount: number;
  likeCount: number;
  keywords: string[];
  publishDate: string;
  category: string;
  isLiveContent: boolean;
}> {
  const empty = {
    title: '', channelName: '', description: '', durationSeconds: 0,
    viewCount: 0, likeCount: 0, keywords: [] as string[],
    publishDate: '', category: '', isLiveContent: false,
  };

  try {
    const response = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' } },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return empty;

    const data = (await response.json()) as InnertubePlayerResponse;
    const details = data.videoDetails;
    if (details === undefined) return empty;

    return {
      title: typeof details.title === 'string' ? details.title : '',
      channelName: typeof details.author === 'string' ? details.author : '',
      description: typeof details.shortDescription === 'string' ? details.shortDescription.slice(0, 2000) : '',
      durationSeconds: typeof details.lengthSeconds === 'string' ? parseInt(details.lengthSeconds, 10) : 0,
      viewCount: typeof details.viewCount === 'string' ? parseInt(details.viewCount, 10) : 0,
      likeCount: typeof details.likeCount === 'string' ? parseInt(details.likeCount, 10) : 0,
      keywords: Array.isArray(details.keywords) ? details.keywords : [],
      publishDate: typeof details.publishDate === 'string' ? details.publishDate : '',
      category: typeof details.category === 'string' ? details.category : '',
      isLiveContent: details.isLiveContent === true,
    };
  } catch {
    return empty;
  }
}

// ── Main Fetcher ─────────────────────────────────────────────────────────────

export async function fetchYouTubeTranscript(url: string): Promise<YouTubeTranscriptResult> {
  const videoId = extractVideoId(url);
  const empty: YouTubeTranscriptResult = {
    success: false,
    videoId: videoId !== null ? videoId : '',
    title: '', channelName: '', description: '',
    durationSeconds: 0, transcript: '', segments: [],
    wordCount: 0,
    viewCount: 0, likeCount: 0, keywords: [],
    publishDate: '', category: '', isLiveContent: false,
    error: null,
  };

  if (videoId === null) {
    return { ...empty, error: `Could not extract video ID from: ${url}` };
  }

  // Fetch metadata (title, channel, description) — this always works
  const metadata = await fetchVideoMetadata(videoId);

  // Primary: youtube-transcript npm package (ANDROID client, works from datacenter IPs)
  try {
    const ytModule = await getYTModule();
    const rawSegments = await ytModule.YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });

    if (rawSegments.length > 0) {
      const segments: TranscriptSegment[] = rawSegments.map(s => ({
        text: decodeHtmlEntities(s.text),
        start: typeof s.offset === 'number' ? s.offset / 1000 : 0,
        duration: typeof s.duration === 'number' ? s.duration / 1000 : 0,
      }));

      const transcript = structureIntoParagraphs(segments);
      const wordCount = transcript.split(/\s+/).length;

      logger.info(
        { videoId, title: metadata.title.slice(0, 50), segments: segments.length, words: wordCount },
        '[YouTubeTranscript] Success via youtube-transcript package',
      );

      return {
        success: true,
        videoId,
        title: metadata.title,
        channelName: metadata.channelName,
        description: metadata.description,
        durationSeconds: metadata.durationSeconds,
        transcript,
        segments,
        wordCount,
        viewCount: metadata.viewCount,
        likeCount: metadata.likeCount,
        keywords: metadata.keywords,
        publishDate: metadata.publishDate,
        category: metadata.category,
        isLiveContent: metadata.isLiveContent,
        error: null,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ videoId, error: msg }, '[YouTubeTranscript] youtube-transcript package failed, trying page scrape');
  }

  // Fallback: Page HTML scraping
  try {
    const pageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!pageResponse.ok) {
      return { ...empty, ...metadata, error: `YouTube page returned ${pageResponse.status}` };
    }

    const html = await pageResponse.text();

    // Update metadata from page if innertube didn't return it
    if (metadata.title.length === 0) {
      const titleMatch = html.match(/<title>([^<]*)<\/title>/);
      if (titleMatch !== null && titleMatch[1] !== undefined) {
        metadata.title = decodeHtmlEntities(titleMatch[1].replace(/ - YouTube$/, ''));
      }
    }

    // Extract caption tracks with bracket-depth parsing
    const captionMarker = '"captionTracks":';
    const markerIdx = html.indexOf(captionMarker);
    if (markerIdx === -1) {
      return { ...empty, ...metadata, error: 'No captions found in page HTML' };
    }

    const arrayStart = html.indexOf('[', markerIdx + captionMarker.length);
    if (arrayStart === -1) {
      return { ...empty, ...metadata, error: 'No caption array found' };
    }

    let depth = 0;
    let arrayEnd = -1;
    for (let i = arrayStart; i < html.length && i < arrayStart + 50000; i++) {
      const ch = html[i];
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) { arrayEnd = i; break; }
      }
    }

    if (arrayEnd === -1) {
      return { ...empty, ...metadata, error: 'Could not parse caption array bounds' };
    }

    interface CaptionTrack { baseUrl: string; languageCode: string; kind?: string; }

    let tracks: CaptionTrack[];
    try {
      tracks = JSON.parse(html.slice(arrayStart, arrayEnd + 1));
    } catch {
      return { ...empty, ...metadata, error: 'Failed to parse caption tracks JSON' };
    }

    // Select best track: manual en > auto en > any en > first
    let captionUrl: string | null = null;
    for (const track of tracks) {
      if (track.languageCode === 'en' && track.kind !== 'asr') { captionUrl = track.baseUrl; break; }
    }
    if (captionUrl === null) {
      for (const track of tracks) {
        if (track.languageCode === 'en') { captionUrl = track.baseUrl; break; }
      }
    }
    if (captionUrl === null) {
      for (const track of tracks) {
        if (track.languageCode.startsWith('en')) { captionUrl = track.baseUrl; break; }
      }
    }
    if (captionUrl === null && tracks.length > 0) {
      const first = tracks[0];
      if (first !== undefined) captionUrl = first.baseUrl;
    }

    if (captionUrl === null) {
      return { ...empty, ...metadata, error: 'No usable caption track' };
    }

    // Fetch transcript XML
    const transcriptResponse = await fetch(captionUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    });

    if (!transcriptResponse.ok) {
      return { ...empty, ...metadata, error: `Transcript XML returned ${transcriptResponse.status}` };
    }

    const xml = await transcriptResponse.text();
    if (xml.length === 0) {
      return { ...empty, ...metadata, error: 'Transcript XML was empty' };
    }

    // Parse XML segments
    const segments: TranscriptSegment[] = [];
    const textRegex = /<text\s+start="([^"]+)"\s+dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let match = textRegex.exec(xml);
    while (match !== null) {
      const startStr = match[1];
      const durStr = match[2];
      const rawText = match[3];
      if (startStr !== undefined && durStr !== undefined && rawText !== undefined) {
        const cleaned = decodeHtmlEntities(rawText.replace(/<[^>]*>/g, '').trim());
        if (cleaned.length > 0) {
          segments.push({ text: cleaned, start: parseFloat(startStr), duration: parseFloat(durStr) });
        }
      }
      match = textRegex.exec(xml);
    }

    if (segments.length === 0) {
      return { ...empty, ...metadata, error: 'No text segments in transcript XML' };
    }

    const transcript = structureIntoParagraphs(segments);
    const wordCount = transcript.split(/\s+/).length;

    logger.info(
      { videoId, title: metadata.title.slice(0, 50), segments: segments.length, words: wordCount },
      '[YouTubeTranscript] Success via page scrape fallback',
    );

    return {
      success: true,
      videoId,
      title: metadata.title,
      channelName: metadata.channelName,
      description: metadata.description,
      durationSeconds: metadata.durationSeconds,
      transcript,
      segments,
      wordCount,
      viewCount: metadata.viewCount,
      likeCount: metadata.likeCount,
      keywords: metadata.keywords,
      publishDate: metadata.publishDate,
      category: metadata.category,
      isLiveContent: metadata.isLiveContent,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ videoId, error: message }, '[YouTubeTranscript] All methods failed');
    return { ...empty, ...metadata, error: message };
  }
}

export function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}

export { extractVideoId };
