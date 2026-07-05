/**
 * RSS/Podcast Feed Parser — Advice Pipeline
 *
 * Lightweight RSS 2.0 and Atom feed parser. Zero dependencies.
 *
 * Features:
 * - Date filtering (only recent episodes, configurable)
 * - Guest name extraction from episode titles and descriptions
 * - YouTube link extraction from episode descriptions (many podcasts embed video links)
 * - Transcript URL detection (some shows include transcript links)
 * - Duration parsing (HH:MM:SS and seconds formats)
 * - Dedup against already-ingested URLs
 */

import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface FeedItem {
  title: string;
  url: string;
  description: string;
  publishedAt: string | null;
  publishedDate: Date | null;
  audioUrl: string | null;
  duration: string | null;
  durationSeconds: number | null;
  guid: string | null;
  youtubeUrl: string | null;
  transcriptUrl: string | null;
  guestNames: string[];
}

export interface FeedResult {
  success: boolean;
  feedTitle: string;
  feedUrl: string;
  items: FeedItem[];
  totalItemsParsed: number;
  error: string | null;
}

// ── XML Helpers ──────────────────────────────────────────────────────────────

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function extractTag(xml: string, tag: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)</${escapedTag}>`, 'i');
  const match = xml.match(pattern);
  if (match !== null && match[1] !== undefined) {
    return decodeXmlEntities(match[1].trim());
  }
  return '';
}

function extractAttribute(xml: string, tag: string, attr: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<${escapedTag}[^>]*?${escapedAttr}="([^"]*)"`, 'i');
  const match = xml.match(pattern);
  if (match !== null && match[1] !== undefined) {
    return decodeXmlEntities(match[1]);
  }
  return '';
}

function extractItems(xml: string): string[] {
  const items: string[] = [];

  // RSS 2.0: <item>...</item>
  const rssPattern = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match = rssPattern.exec(xml);
  while (match !== null) {
    if (match[1] !== undefined) items.push(match[1]);
    match = rssPattern.exec(xml);
  }

  // Atom: <entry>...</entry>
  if (items.length === 0) {
    const atomPattern = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    match = atomPattern.exec(xml);
    while (match !== null) {
      if (match[1] !== undefined) items.push(match[1]);
      match = atomPattern.exec(xml);
    }
  }

  return items;
}

// ── Duration Parsing ────────────────────────────────────────────────────────

function parseDurationToSeconds(duration: string): number | null {
  if (duration.length === 0) return null;

  // Pure seconds: "3600"
  if (/^\d+$/.test(duration)) return parseInt(duration, 10);

  // HH:MM:SS or MM:SS
  const parts = duration.split(':');
  if (parts.length === 3) {
    const h = parseInt(parts[0] !== undefined ? parts[0] : '0', 10);
    const m = parseInt(parts[1] !== undefined ? parts[1] : '0', 10);
    const s = parseInt(parts[2] !== undefined ? parts[2] : '0', 10);
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const m = parseInt(parts[0] !== undefined ? parts[0] : '0', 10);
    const s = parseInt(parts[1] !== undefined ? parts[1] : '0', 10);
    return m * 60 + s;
  }

  return null;
}

// ── YouTube / Transcript URL Extraction ─────────────────────────────────────

const YOUTUBE_URL_PATTERN = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/gi;
const TRANSCRIPT_URL_PATTERN = /https?:\/\/[^\s"<>]*transcript[^\s"<>]*/gi;

function extractYouTubeUrl(text: string): string | null {
  const match = text.match(YOUTUBE_URL_PATTERN);
  if (match !== null && match[0] !== undefined) return match[0];
  return null;
}

function extractTranscriptUrl(text: string): string | null {
  const match = text.match(TRANSCRIPT_URL_PATTERN);
  if (match !== null && match[0] !== undefined) return match[0];
  return null;
}

// ── Guest Name Extraction ───────────────────────────────────────────────────

/**
 * Attempts to extract guest names from episode titles.
 * Common patterns:
 * - "Guest Name — Topic"
 * - "Guest Name: Topic"
 * - "Topic with Guest Name"
 * - "Guest Name | Topic"
 * - "#123 - Guest Name - Topic"
 */
function extractGuestNames(title: string, description: string): string[] {
  const names: string[] = [];

  // Pattern: "Name — Topic" or "Name - Topic" or "Name: Topic" or "Name | Topic"
  // Skip if starts with a number (episode number)
  const cleanTitle = title.replace(/^#?\d+[\s.:·-]+/, '').trim();

  // Split on common delimiters
  const delimiters = [' — ', ' – ', ' - ', ': ', ' | '];
  for (const delim of delimiters) {
    const parts = cleanTitle.split(delim);
    if (parts.length >= 2) {
      const firstPart = parts[0];
      if (firstPart !== undefined) {
        const candidate = firstPart.trim();
        // Name heuristic: 2-4 capitalized words, 5-40 chars, no common non-name words
        if (candidate.length >= 5 && candidate.length <= 40) {
          const words = candidate.split(/\s+/);
          const allCapitalized = words.every(w => /^[A-Z]/.test(w));
          const notKeyword = !['How', 'Why', 'What', 'When', 'The', 'Part', 'Episode', 'Season', 'Best', 'Top'].includes(words[0] !== undefined ? words[0] : '');
          if (allCapitalized && words.length >= 2 && words.length <= 4 && notKeyword) {
            names.push(candidate);
            break;
          }
        }
      }
    }
  }

  // Pattern: "with Guest Name" in title
  const withMatch = title.match(/\bwith\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/);
  if (withMatch !== null && withMatch[1] !== undefined && names.length === 0) {
    names.push(withMatch[1]);
  }

  // Pattern: guest name in description (first sentence often names the guest)
  if (names.length === 0) {
    const firstSentence = description.split(/[.!?\n]/).slice(0, 1).join('');
    const guestMatch = firstSentence.match(/(?:guest|joins?|featuring|speaks? with|interviews?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i);
    if (guestMatch !== null && guestMatch[1] !== undefined) {
      names.push(guestMatch[1]);
    }
  }

  return names;
}

// ── Item Parser ─────────────────────────────────────────────────────────────

function parseItem(itemXml: string): FeedItem {
  const title = extractTag(itemXml, 'title');

  // URL: <link> tag or <link href="..."> (Atom)
  let url = extractTag(itemXml, 'link');
  if (url === '') url = extractAttribute(itemXml, 'link', 'href');

  // Description
  let description = extractTag(itemXml, 'description');
  if (description === '') description = extractTag(itemXml, 'summary');
  if (description === '') description = extractTag(itemXml, 'content');
  // Also check itunes:summary which often has cleaner text
  const itunesSummary = extractTag(itemXml, 'itunes:summary');
  if (itunesSummary.length > description.length) description = itunesSummary;

  // Strip HTML
  const rawDescription = description;
  description = description.replace(/<[^>]*>/g, '').trim();

  // Published date
  let publishedAt = extractTag(itemXml, 'pubDate');
  if (publishedAt === '') publishedAt = extractTag(itemXml, 'published');
  if (publishedAt === '') publishedAt = extractTag(itemXml, 'dc:date');

  let publishedDate: Date | null = null;
  if (publishedAt.length > 0) {
    const parsed = new Date(publishedAt);
    if (!isNaN(parsed.getTime())) publishedDate = parsed;
  }

  // Audio URL
  const audioUrl = extractAttribute(itemXml, 'enclosure', 'url');

  // Duration
  const duration = extractTag(itemXml, 'itunes:duration');
  const durationSeconds = parseDurationToSeconds(duration);

  // GUID
  const guid = extractTag(itemXml, 'guid');

  // YouTube URL from description (many podcasts embed video links)
  const youtubeUrl = extractYouTubeUrl(rawDescription);

  // Transcript URL from description
  const transcriptUrl = extractTranscriptUrl(rawDescription);

  // Guest names
  const guestNames = extractGuestNames(title, description);

  return {
    title,
    url: url.length > 0 ? url : (audioUrl.length > 0 ? audioUrl : ''),
    description: description.slice(0, 2000),
    publishedAt: publishedAt.length > 0 ? publishedAt : null,
    publishedDate,
    audioUrl: audioUrl.length > 0 ? audioUrl : null,
    duration: duration.length > 0 ? duration : null,
    durationSeconds,
    guid: guid.length > 0 ? guid : null,
    youtubeUrl,
    transcriptUrl,
    guestNames,
  };
}

// ── Main Fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch and parse an RSS/Atom feed.
 *
 * @param feedUrl - RSS feed URL
 * @param maxItems - Maximum items to return
 * @param maxAgeDays - Only return items published within this many days (0 = no filter)
 * @param existingUrls - Set of already-ingested URLs to skip
 */
export async function fetchRssFeed(
  feedUrl: string,
  maxItems: number = 20,
  maxAgeDays: number = 90,
  existingUrls?: Set<string>,
): Promise<FeedResult> {
  const empty: FeedResult = {
    success: false, feedTitle: '', feedUrl,
    items: [], totalItemsParsed: 0, error: null,
  };

  try {
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'OraResearch/1.0 (advice-pipeline; contact: team@braintied.com)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      return { ...empty, error: `Feed returned ${response.status}` };
    }

    const xml = await response.text();

    if (xml.length < 100) {
      return { ...empty, error: 'Feed response too short' };
    }

    const feedTitle = extractTag(xml, 'title');
    const rawItems = extractItems(xml);
    const items: FeedItem[] = [];
    const cutoff = maxAgeDays > 0 ? new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000) : null;

    for (const rawItem of rawItems) {
      const item = parseItem(rawItem);
      if (item.title.length === 0) continue;
      if (item.url.length === 0 && item.audioUrl === null) continue;

      // Date filter
      if (cutoff !== null && item.publishedDate !== null && item.publishedDate < cutoff) continue;

      // Dedup against existing
      if (existingUrls !== undefined && existingUrls.has(item.url)) continue;

      items.push(item);
      if (items.length >= maxItems) break;
    }

    logger.info(
      { feedUrl: feedUrl.slice(0, 50), feedTitle: feedTitle.slice(0, 30), parsed: rawItems.length, returned: items.length },
      '[RSS] Feed parsed',
    );

    return {
      success: true,
      feedTitle,
      feedUrl,
      items,
      totalItemsParsed: rawItems.length,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ feedUrl, error: message }, '[RSS] Feed fetch error');
    return { ...empty, error: message };
  }
}

// ── Voice Matching ──────────────────────────────────────────────────────────

/**
 * Match a podcast episode to a voice by checking if the voice's name
 * appears in the episode title, guest list, or description.
 *
 * Returns the matched voice slug or null.
 */
export function matchEpisodeToVoice(
  item: FeedItem,
  voices: Array<{ slug: string; name: string }>,
): string | null {
  // Check extracted guest names first (most reliable)
  for (const guestName of item.guestNames) {
    const guestLower = guestName.toLowerCase();
    for (const voice of voices) {
      const nameParts = voice.name.toLowerCase().split(' ');
      const lastName = nameParts[nameParts.length - 1];
      const firstName = nameParts[0];
      if (lastName !== undefined && firstName !== undefined) {
        // Match on last name + first name substring
        if (guestLower.includes(lastName) && guestLower.includes(firstName)) {
          return voice.slug;
        }
      }
    }
  }

  // Check title
  const titleLower = item.title.toLowerCase();
  for (const voice of voices) {
    const nameParts = voice.name.toLowerCase().split(' ');
    const lastName = nameParts[nameParts.length - 1];
    if (lastName !== undefined && lastName.length > 2 && titleLower.includes(lastName)) {
      // Verify with first name to avoid false positives on common last names
      const firstName = nameParts[0];
      if (firstName !== undefined && titleLower.includes(firstName)) {
        return voice.slug;
      }
    }
  }

  // Check description (first 500 chars)
  const descLower = item.description.slice(0, 500).toLowerCase();
  for (const voice of voices) {
    // Full name match in description
    if (descLower.includes(voice.name.toLowerCase())) {
      return voice.slug;
    }
  }

  return null;
}

// ── Podcast Feeds ───────────────────────────────────────────────────────────

export interface PodcastFeed {
  name: string;
  feedUrl: string;
  voiceSlugs: string[];
  domains: string[];
}

export const PODCAST_FEEDS: PodcastFeed[] = [
  {
    name: 'Lex Fridman Podcast',
    feedUrl: 'https://lexfridman.com/feed/podcast/',
    voiceSlugs: [],
    domains: ['strategy', 'engineering', 'leadership'],
  },
  {
    name: "Lenny's Podcast",
    feedUrl: 'https://www.lennysnewsletter.com/feed',
    voiceSlugs: ['lenny-rachitsky'],
    domains: ['product', 'growth'],
  },
  {
    name: 'How I Built This (NPR)',
    feedUrl: 'https://feeds.npr.org/510313/podcast.xml',
    voiceSlugs: [],
    domains: ['strategy', 'leadership', 'product'],
  },
  {
    name: 'All-In Podcast',
    feedUrl: 'https://feeds.megaphone.fm/all-in-with-chamath-jason-sacks-friedberg',
    voiceSlugs: ['david-sacks'],
    domains: ['strategy', 'fundraising'],
  },
  {
    name: 'Acquired',
    feedUrl: 'https://feeds.pacific-content.com/acquired',
    voiceSlugs: [],
    domains: ['strategy', 'operations'],
  },
  {
    name: 'The Twenty Minute VC',
    feedUrl: 'https://thetwentyminutevc.libsyn.com/rss',
    voiceSlugs: [],
    domains: ['fundraising', 'strategy'],
  },
  {
    name: 'Masters of Scale (Reid Hoffman)',
    feedUrl: 'https://rss.art19.com/masters-of-scale',
    voiceSlugs: ['reid-hoffman'],
    domains: ['growth', 'strategy', 'leadership'],
  },
  {
    name: 'a16z Podcast',
    feedUrl: 'https://feeds.simplecast.com/JGE3yC0V',
    voiceSlugs: ['marc-andreessen', 'ben-horowitz'],
    domains: ['strategy', 'product', 'engineering'],
  },
  {
    name: 'The Knowledge Project (Shane Parrish)',
    feedUrl: 'https://theknowledgeproject.libsyn.com/rss',
    voiceSlugs: [],
    domains: ['strategy', 'leadership'],
  },
  {
    name: 'My First Million',
    feedUrl: 'https://feeds.megaphone.fm/HSW2674920984',
    voiceSlugs: [],
    domains: ['growth', 'marketing', 'sales'],
  },
  {
    name: 'The Tim Ferriss Show',
    feedUrl: 'https://rss.art19.com/tim-ferriss-show',
    voiceSlugs: [],
    domains: ['leadership', 'strategy', 'operations'],
  },
  {
    name: 'Invest Like the Best (Patrick OShaughnessy)',
    feedUrl: 'https://investlikethebest.libsyn.com/rss',
    voiceSlugs: [],
    domains: ['strategy', 'fundraising'],
  },
];
