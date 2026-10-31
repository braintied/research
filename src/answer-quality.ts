/**
 * Answer quality — does the report answer the question it was asked?
 *
 * Grounding proves every cited sentence is really in its source. It says
 * nothing about whether those sentences answer the brief. Measured
 * 2026-10-12: a quick run on "What changed in the Telegram Bot API in its
 * most recent release (version, date, and the main new features)? Cite the
 * official changelog." scored grounding 1.0, 10 of 10 citations valid, while
 * its executive summary was ten unrelated sentences (a Discord founding
 * date, a PyPI "A required part of this site couldn't load" banner, a CMS
 * announcement) and never stated the version or the date.
 *
 * This module owns the other half of the contract, stage by stage:
 *
 *   brief      → `analyzeBriefRequirements`: the explicit questions, the
 *                facts each asks for (version, date, price...), and the
 *                primary source the brief names or implies.
 *   fetch      → `assessFetchedPage` / `isBoilerplateEvidence`: error pages,
 *                bot walls, and site chrome never become evidence.
 *   extract    → `focusContentWindow`: long pages are cut around the
 *                question's terms, not at the first 12k characters.
 *   relevance  → `judgeEvidenceRelevance`: every evidence unit is scored
 *                against the questions; off-topic units are dropped before
 *                synthesis, and each unit names the facts it states.
 *   summary    → `selectFacetAnswers` + `renderAnswerSummary`: the executive
 *                summary answers each question fact by fact with exact
 *                evidence sentences, or says which fact is missing.
 *   metric     → `buildAnswerQuality`: answered facets, primary-source use,
 *                gate counts, and a pass flag, carried on the report.
 */

import { z } from 'zod';
import type { ResearchCredentials } from './credentials.js';
import { callModel } from './model-call.js';
import { researchStageResolution } from './model-policy.js';
import { logger } from './logger.js';
import {
  BriefRequirementsSchema,
  FACET_KINDS,
  type AnswerFacet,
  type AnswerQuality,
  type BriefRequirements,
  type PrimarySource,
} from './answer-quality-schema.js';

export * from './answer-quality-schema.js';

// =============================================================================
// Brief requirements
// =============================================================================

/** Token usage of one answer-quality model call. */
export interface AnswerQualityModelUsage {
  stage: 'brief-analysis' | 'relevance';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type AnswerQualityUsageSink = (usage: AnswerQualityModelUsage) => void;

function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  let host = trimmed;
  if (/^https?:\/\//u.test(trimmed)) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./u, '').replace(/\/.*$/u, '');
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(host) ? host : null;
}

/** True when `url` is https and its host is `domain` or a subdomain of it. */
export function urlIsOnDomain(url: string, domain: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/**
 * Primary sources the brief names literally: every http(s) URL in its text.
 * These never depend on a model.
 */
export function primarySourcesNamedInBrief(brief: string): PrimarySource[] {
  const sources: PrimarySource[] = [];
  const seen = new Set<string>();
  for (const match of brief.matchAll(/https?:\/\/[^\s)>\]"'`]+/gu)) {
    const url = match[0].replace(/[.,;:]+$/u, '');
    const domain = normalizeDomain(url);
    if (domain === null) continue;
    const existing = sources.find((s) => s.domain === domain);
    const httpsUrl = url.replace(/^http:/u, 'https:');
    if (existing !== undefined) {
      if (!existing.urls.includes(httpsUrl) && existing.urls.length < 4) existing.urls.push(httpsUrl);
      continue;
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    sources.push({ name: domain, domain, urls: [httpsUrl] });
  }
  return sources;
}

/** Keep only well-formed primary sources whose URLs sit on their own domain. */
export function sanitizePrimarySources(sources: PrimarySource[]): PrimarySource[] {
  const out: PrimarySource[] = [];
  for (const source of sources) {
    const domain = normalizeDomain(source.domain);
    if (domain === null || out.some((s) => s.domain === domain)) continue;
    out.push({
      name: source.name,
      domain,
      urls: source.urls.filter((url) => urlIsOnDomain(url, domain)),
    });
  }
  return out;
}

const BRIEF_ANALYSIS_SYSTEM_PROMPT =
  'You read a research brief and state what a correct answer must contain. Reply with one JSON object and nothing else.';

function briefAnalysisPrompt(brief: string): string {
  return `Research brief:
"""
${brief.slice(0, 6000)}
"""

Return JSON exactly in this shape:
{
  "questions": [
    {
      "question": "<one explicit question the brief asks, close to its own words>",
      "facets": [ { "key": "version", "label": "Version", "kind": "version" } ]
    }
  ],
  "primary_sources": [
    { "name": "<official source>", "domain": "<host, e.g. docs.example.com>", "urls": ["https://<host>/<path>"] }
  ]
}

Rules:
- questions: only the questions the brief explicitly asks (1 to 8). Do not add scope. Keep one question per explicit question and put each fact it asks for in its facets; do not split "what version, and when was it released" into two questions. Each question must stand alone: name its subject instead of a pronoun ("When was Rust 1.x released?", never "When was it released?"). An instruction about sources or format ("cite the official changelog", "use python.org") is not a question: record that source in primary_sources instead.
- facets: the specific facts each question asks for (1 to 6), such as a version, a date, a price, a person's name, a count, a command or a setting. kind is one of: ${FACET_KINDS.join(', ')}. Use "list" for asks like "the main new features"; use "text" only when nothing narrower fits. key is a short lowercase id unique within its question.
- primary_sources: the official or first-party source the brief names or clearly implies: the vendor's own changelog, documentation or pricing page, the project's own site, the awarding body. Give its domain, and give canonical https URLs on that domain only when you are confident they exist. Use an empty array when the brief implies no primary source.`;
}

/**
 * One cheap model call that turns the brief into checkable requirements.
 * URLs written in the brief are always primary sources, whatever the model
 * says. Throws when the model reply is not valid; the caller records the
 * failure on the answer-quality verdict instead of guessing.
 */
export async function analyzeBriefRequirements(input: {
  credentials: ResearchCredentials;
  brief: string;
  usageSink?: AnswerQualityUsageSink;
}): Promise<BriefRequirements> {
  const result = await callModel({
    credentials: input.credentials,
    system: BRIEF_ANALYSIS_SYSTEM_PROMPT,
    user: briefAnalysisPrompt(input.brief),
    model: researchStageResolution('extract'),
    maxTokens: 2048,
    temperature: 0,
    jsonResponse: true,
  });
  input.usageSink?.({
    stage: 'brief-analysis',
    provider: result.provider,
    model: result.model,
    inputTokens: result.inputTokens + result.cachedReadTokens,
    outputTokens: result.outputTokens,
  });
  const parsed = BriefRequirementsSchema.parse(parseJsonObject(result.text));
  return {
    questions: parsed.questions.map((question) => ({
      question: question.question,
      facets: dedupeFacetKeys(question.facets),
    })),
    primary_sources: sanitizePrimarySources([
      ...primarySourcesNamedInBrief(input.brief),
      ...parsed.primary_sources,
    ]),
  };
}

function dedupeFacetKeys(facets: AnswerFacet[]): AnswerFacet[] {
  const seen = new Set<string>();
  const out: AnswerFacet[] = [];
  for (const facet of facets) {
    const key = facet.key.toLowerCase().replace(/[^a-z0-9_-]+/gu, '_');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...facet, key });
  }
  return out;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in model reply');
  return JSON.parse(trimmed.slice(start, end + 1));
}

/** Facet id used across the judge, the selection, and the metric: "q1.version". */
export function facetId(questionIndex: number, facetKey: string): string {
  return `q${questionIndex + 1}.${facetKey}`;
}

// =============================================================================
// Fetch quality — error pages, bot walls and site chrome are not evidence
// =============================================================================

/**
 * Markers that a fetched page did NOT render its content: script failures,
 * bot walls, access errors. Used at page level only for short pages.
 */
const PAGE_FAILURE_PATTERNS: RegExp[] = [
  /\bcould\s*n[o’']?t\s+load\b/iu,
  /\b(?:enable|turn\s+on)\s+javascript\b/iu,
  /\bjavascript\s+(?:is\s+)?(?:disabled|required)\b/iu,
  /\bjust\s+a\s+moment\b/iu,
  /\bchecking\s+(?:if\s+the\s+site\s+connection\s+is\s+secure|your\s+browser)\b/iu,
  /\bverify(?:ing)?\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human\b/iu,
  /\bare\s+you\s+a\s+robot\b/iu,
  /\bcaptcha\b/iu,
  /\baccess\s+(?:to\s+this\s+page\s+(?:has\s+been\s+)?)?denied\b/iu,
  /\b(?:403\s+forbidden|404\s+not\s+found|page\s+not\s+found|this\s+page\s+(?:isn[’']t|is\s+not|could\s+not\s+be)\s+(?:available|found))\b/iu,
  /\bsomething\s+went\s+wrong\b/iu,
  /\btoo\s+many\s+requests\b/iu,
  /\bsign\s+in\s+to\s+(?:continue|view)\b/iu,
];

/**
 * Sentences that are never evidence about anything but the page itself:
 * render failures, browser nags, cookie and consent banners, newsletter
 * prompts, copyright lines, skip links, menu labels. A quote of one is
 * grounded and useless.
 */
const SENTENCE_BOILERPLATE_PATTERNS: RegExp[] = [
  /\bcould\s*n[o’']?t\s+load\b/iu,
  /\b(?:enable|turn\s+on)\s+javascript\b/iu,
  /\bjavascript\s+(?:is\s+)?(?:disabled|required)\b/iu,
  /\byour\s+browser\s+(?:is\s+)?(?:not\s+supported|out\s*of\s*date|outdated)\b/iu,
  /\busing\s+an\s+outdated\s+browser\b/iu,
  /\bupgrade\s+your\s+browser\b/iu,
  /\bjust\s+a\s+moment\b/iu,
  /\bverify(?:ing)?\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human\b/iu,
  /\bare\s+you\s+a\s+robot\b/iu,
  /\baccess\s+(?:to\s+this\s+page\s+(?:has\s+been\s+)?)?denied\b/iu,
  /\b(?:page\s+not\s+found|this\s+page\s+(?:isn[’']t|is\s+not|could\s+not\s+be)\s+(?:available|found))\b/iu,
  /\bsomething\s+went\s+wrong\b/iu,
  /\bsign\s+in\s+to\s+(?:continue|view)\b/iu,
  /\bcookies?\b.*\b(?:accept|consent|preferences)\b/iu,
  /\ball\s+rights\s+reserved\b/iu,
  /^copyright\b|©/iu,
  /\bskip\s+to\s+(?:main\s+)?content\b/iu,
  /\bsubscribe\s+to\s+(?:our|the)\s+newsletter\b/iu,
  /\bopen\s+the\s+search\s+menu\b/iu,
  /\btoggle\s+(?:navigation|menu)\b/iu,
];

/** True when one evidence sentence is an error banner or site chrome. */
export function isBoilerplateEvidence(text: string): boolean {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) return true;
  return SENTENCE_BOILERPLATE_PATTERNS.some((p) => p.test(normalized));
}

export interface FetchedPageAssessment {
  usable: boolean;
  reason?: 'empty' | 'error_page' | 'no_prose';
  /** Characters of prose lines (sentences of six or more words). */
  proseChars: number;
}

const MIN_PROSE_CHARS = 200;
/** A page with this much prose is content even when a banner line mentions an error. */
const ERROR_PAGE_PROSE_CEILING = 1500;

/**
 * Page-level fetch quality. A page is rejected when it has almost no prose
 * (navigation shell, link farm) or when it is short AND carries an error,
 * bot-wall or script-failure marker. A long article that merely contains
 * "404" or a consent banner stays usable; its banner sentences are removed
 * later by `isBoilerplateEvidence`.
 */
export function assessFetchedPage(markdown: string): FetchedPageAssessment {
  const text = markdown.trim();
  if (text.length === 0) return { usable: false, reason: 'empty', proseChars: 0 };
  let proseChars = 0;
  for (const line of text.split(/\r?\n/u)) {
    const plain = line.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/[#>*_`|-]+/gu, ' ').trim();
    const words = plain.split(/\s+/u).filter((w) => w.length > 0);
    if (words.length >= 6 && /[.!?:]["')\]]*$/u.test(plain)) proseChars += plain.length;
  }
  if (proseChars < ERROR_PAGE_PROSE_CEILING) {
    const head = text.slice(0, 4000);
    if (PAGE_FAILURE_PATTERNS.some((p) => p.test(head))) {
      return { usable: false, reason: 'error_page', proseChars };
    }
  }
  if (proseChars < MIN_PROSE_CHARS) return { usable: false, reason: 'no_prose', proseChars };
  return { usable: true, proseChars };
}

// =============================================================================
// Extraction window — cut long pages around the question, not at the top
// =============================================================================

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'what', 'which', 'when', 'where', 'who', 'whom', 'how', 'why', 'does',
  'did', 'its', 'their', 'this', 'that', 'from', 'into', 'about', 'are', 'was', 'were', 'has', 'have',
  'give', 'cite', 'most', 'main', 'new', 'per', 'can', 'you', 'your', 'our', 'any', 'all', 'one',
]);

/** Lowercase content words of the questions (and facet labels). */
export function questionTerms(requirements: BriefRequirements | null, fallback: string): string[] {
  const source = requirements === null || requirements.questions.length === 0
    ? fallback
    : requirements.questions
      .map((q) => `${q.question} ${q.facets.map((f) => f.label).join(' ')}`)
      .join(' ');
  const terms = new Set<string>();
  for (const raw of source.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+-]*/gu) ?? []) {
    const term = raw.replace(/[.+-]+$/u, '');
    if (term.length >= 3 && !STOPWORDS.has(term)) terms.add(term);
  }
  return Array.from(terms);
}

/**
 * Return at most `maxChars` of `content`, chosen around the question. Short
 * pages are returned whole. Long pages keep their opening block (title,
 * lede, latest changelog entry) and then the highest-scoring blocks by
 * question-term hits, re-emitted in document order so every kept line is
 * still a verbatim line of the page.
 */
export function focusContentWindow(content: string, terms: string[], maxChars: number): string {
  if (content.length <= maxChars || terms.length === 0) return content.slice(0, maxChars);
  const blockSize = 1500;
  const lines = content.split('\n');
  const blocks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > blockSize && current.length > 0) {
      blocks.push(current);
      current = '';
    }
    current += `${line}\n`;
  }
  if (current.length > 0) blocks.push(current);

  const scored = blocks.map((block, index) => {
    const lower = block.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let from = 0;
      while (true) {
        const at = lower.indexOf(term, from);
        if (at === -1) break;
        score++;
        from = at + term.length;
      }
    }
    return { index, score };
  });

  const keep = new Set<number>([0, 1]);
  let used = (blocks[0]?.length ?? 0) + (blocks[1]?.length ?? 0);
  for (const candidate of scored.slice(2).sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (candidate.score === 0) break;
    const size = blocks[candidate.index]?.length ?? 0;
    if (used + size > maxChars) continue;
    keep.add(candidate.index);
    used += size;
  }
  return blocks.filter((_, index) => keep.has(index)).join('').slice(0, maxChars);
}

// =============================================================================
// Relevance gate
// =============================================================================

export interface EvidenceUnitForJudging {
  /** Stable key: source URL + normalized text. */
  key: string;
  text: string;
  sourceUrl: string;
}

export interface EvidenceJudgment {
  /** 3 states an asked fact; 2 on-subject context; 1 same broad topic; 0 unrelated. */
  relevance: number;
  /** Facet ids ("q1.version") whose value this unit states. */
  answers: string[];
}

export const RELEVANCE_KEEP_THRESHOLD = 2;
const JUDGE_BATCH_SIZE = 60;

const RELEVANCE_SYSTEM_PROMPT =
  'You judge whether exact source sentences answer specific research questions. Reply with one JSON object and nothing else.';

const JudgeReplySchema = z.object({
  judgments: z.array(z.object({
    id: z.string(),
    relevance: z.number().int().min(0).max(3),
    answers: z.array(z.string()).default([]),
  })),
});

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return url.slice(0, 60);
  }
}

function relevancePrompt(requirements: BriefRequirements, units: EvidenceUnitForJudging[]): string {
  const questionLines = requirements.questions.map((q, qi) => {
    const facets = q.facets.map((f) => `    - ${facetId(qi, f.key)} (${f.kind}): ${f.label}`).join('\n');
    return `Q${qi + 1}. ${q.question}\n${facets}`;
  }).join('\n');
  const unitLines = units.map((u, i) => `U${i + 1} [${hostOf(u.sourceUrl)}] ${u.text.slice(0, 400)}`).join('\n');
  return `Research questions and the facts each one asks for:
${questionLines}

Evidence units (exact sentences from fetched pages; the host is in brackets):
${unitLines}

For EVERY unit return {"id":"U<n>","relevance":<0-3>,"answers":[<facet ids>]}.
relevance: 3 = the unit itself states a fact one of the questions asks for; 2 = directly about a question's subject and useful context for answering it; 1 = same broad topic but does not help answer; 0 = unrelated, an error or browser message, navigation, marketing for something else.
answers: the facet ids whose value the unit itself states (for example a unit "Bot API 10.3" states q1.version). Leave it empty when the unit does not contain the value. A unit about a different product, a different person, or a different release than the question asks about answers nothing and is relevance 0 or 1.
Reply exactly {"judgments":[...]}.`;
}

export interface JudgeEvidenceResult {
  judgments: Map<string, EvidenceJudgment>;
  /** Units the judge returned no verdict for (kept, and counted). */
  unjudged: number;
  /** Batches whose call or reply failed. */
  failedBatches: number;
}

/**
 * Score evidence units against the brief's questions in batches. Units a
 * failed batch did not cover are reported as unjudged rather than invented.
 */
export async function judgeEvidenceRelevance(input: {
  credentials: ResearchCredentials;
  requirements: BriefRequirements;
  units: EvidenceUnitForJudging[];
  usageSink?: AnswerQualityUsageSink;
  concurrency?: number;
}): Promise<JudgeEvidenceResult> {
  const judgments = new Map<string, EvidenceJudgment>();
  const validFacetIds = new Set<string>();
  input.requirements.questions.forEach((q, qi) => {
    for (const f of q.facets) validFacetIds.add(facetId(qi, f.key));
  });
  const batches: EvidenceUnitForJudging[][] = [];
  for (let i = 0; i < input.units.length; i += JUDGE_BATCH_SIZE) {
    batches.push(input.units.slice(i, i + JUDGE_BATCH_SIZE));
  }
  let unjudged = 0;
  let failedBatches = 0;
  const concurrency = Math.max(1, input.concurrency ?? 4);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batch = batches[next];
      next++;
      if (batch === undefined) continue;
      try {
        const result = await callModel({
          credentials: input.credentials,
          system: RELEVANCE_SYSTEM_PROMPT,
          user: relevancePrompt(input.requirements, batch),
          model: researchStageResolution('extract'),
          maxTokens: 4096,
          temperature: 0,
          jsonResponse: true,
        });
        input.usageSink?.({
          stage: 'relevance',
          provider: result.provider,
          model: result.model,
          inputTokens: result.inputTokens + result.cachedReadTokens,
          outputTokens: result.outputTokens,
        });
        const reply = JudgeReplySchema.parse(parseJsonObject(result.text));
        const seen = new Set<number>();
        for (const judgment of reply.judgments) {
          const index = Number.parseInt(judgment.id.replace(/^U/iu, ''), 10) - 1;
          const unit = batch[index];
          if (unit === undefined || seen.has(index)) continue;
          seen.add(index);
          judgments.set(unit.key, {
            relevance: judgment.relevance,
            answers: judgment.answers.filter((id) => validFacetIds.has(id)),
          });
        }
        unjudged += batch.length - seen.size;
      } catch (error: unknown) {
        failedBatches++;
        unjudged += batch.length;
        logger.warn(
          { units: batch.length, error: error instanceof Error ? error.message.slice(0, 160) : String(error) },
          '[answer-quality] Relevance batch failed; its units are unjudged',
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  return { judgments, unjudged, failedBatches };
}

// =============================================================================
// Facet answers
// =============================================================================

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_PATTERN = new RegExp(
  `\\b(?:(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS})\\.?\\s+\\d{4})\\b`,
  'iu',
);

/**
 * A mechanical floor under the judge: a unit can only answer a version facet
 * if it contains a version-like token, a date facet only with a date, and so
 * on. Free-text kinds pass through on the judge's verdict alone.
 */
export function evidenceFitsFacetKind(kind: AnswerFacet['kind'], text: string): boolean {
  switch (kind) {
    case 'version':
      return /\b\d+(?:\.\d+)+\b|\bv\d+\b/iu.test(text);
    case 'date':
      return DATE_PATTERN.test(text) || /\b(?:19|20)\d{2}\b/u.test(text);
    case 'price':
      return /[$€£¥]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:usd|eur|gbp|dollars?|cents?)\b|\bfree\b/iu.test(text);
    case 'number':
      return /\d/u.test(text) || /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion)\b/iu.test(text);
    case 'person':
    case 'organization':
    case 'name':
      return /\p{Lu}/u.test(text);
    default:
      return true;
  }
}

export interface FacetAnswerUnit {
  text: string;
  sourceUrl: string;
}

export interface FacetAnswer {
  questionIndex: number;
  facet: AnswerFacet;
  units: FacetAnswerUnit[];
}

export interface SelectFacetAnswersInput {
  requirements: BriefRequirements;
  /** Every accepted evidence unit, in extraction order. */
  units: EvidenceUnitForJudging[];
  judgments: Map<string, EvidenceJudgment>;
}

/** True when a URL is on one of the run's primary-source domains. */
export function isPrimarySourceUrl(url: string, primarySources: PrimarySource[]): boolean {
  return primarySources.some((s) => urlIsOnDomain(url, s.domain));
}

/**
 * For each facet, the evidence units that state it: relevance-3 units the
 * judge mapped to the facet and that pass the kind check. Primary-source
 * units come first, then extraction order (which follows page order, so a
 * changelog's newest entry precedes older ones). One unit for scalar facets,
 * up to three for lists.
 */
export function selectFacetAnswers(input: SelectFacetAnswersInput): FacetAnswer[] {
  const { requirements, units, judgments } = input;
  const answers: FacetAnswer[] = [];
  requirements.questions.forEach((question, qi) => {
    for (const facet of question.facets) {
      const id = facetId(qi, facet.key);
      const candidates = units
        .map((unit, order) => ({ unit, order, judgment: judgments.get(unit.key) }))
        .filter((c) => c.judgment !== undefined
          && c.judgment.relevance >= RELEVANCE_KEEP_THRESHOLD
          && c.judgment.answers.includes(id)
          && evidenceFitsFacetKind(facet.kind, c.unit.text)
          && !isBoilerplateEvidence(c.unit.text))
        .sort((a, b) => {
          const pa = isPrimarySourceUrl(a.unit.sourceUrl, requirements.primary_sources) ? 0 : 1;
          const pb = isPrimarySourceUrl(b.unit.sourceUrl, requirements.primary_sources) ? 0 : 1;
          if (pa !== pb) return pa - pb;
          const ra = a.judgment?.relevance ?? 0;
          const rb = b.judgment?.relevance ?? 0;
          if (ra !== rb) return rb - ra;
          return a.order - b.order;
        });
      const limit = facet.kind === 'list' ? 3 : 1;
      const picked: FacetAnswerUnit[] = [];
      for (const c of candidates) {
        if (picked.some((p) => p.text === c.unit.text)) continue;
        picked.push({ text: c.unit.text, sourceUrl: c.unit.sourceUrl });
        if (picked.length >= limit) break;
      }
      answers.push({ questionIndex: qi, facet, units: picked });
    }
  });
  return answers;
}

// =============================================================================
// Metric
// =============================================================================

export interface GateCounts {
  status: 'applied' | 'unavailable' | 'not_run';
  judged: number;
  kept: number;
  dropped: number;
  unjudged: number;
}

export interface FetchQualityCounts {
  pagesRejected: number;
  evidenceRejected: number;
}

export function buildAnswerQuality(input: {
  requirements: BriefRequirements | null;
  analysisError?: string;
  answers: FacetAnswer[];
  /** source URL → global bibliography anchor. */
  anchorByUrl: Map<string, string>;
  citedUrls: string[];
  gate: GateCounts;
  fetchQuality: FetchQualityCounts;
}): AnswerQuality {
  const gate = {
    status: input.gate.status,
    units_judged: input.gate.judged,
    units_kept: input.gate.kept,
    units_dropped: input.gate.dropped,
    units_unjudged: input.gate.unjudged,
  };
  const fetchQuality = {
    pages_rejected: input.fetchQuality.pagesRejected,
    evidence_rejected: input.fetchQuality.evidenceRejected,
  };
  if (input.requirements === null || input.requirements.questions.length === 0) {
    return {
      status: 'not_assessed',
      answered_ratio: 0,
      facets_total: 0,
      facets_answered: 0,
      questions: [],
      primary_sources: [],
      primary_source_cited: null,
      relevance_gate: gate,
      fetch_quality: fetchQuality,
      summary_line: 'answered: not assessed',
      passed: false,
      ...(input.analysisError !== undefined ? { error: input.analysisError } : {}),
    };
  }
  const requirements = input.requirements;
  const questions = requirements.questions.map((question, qi) => ({
    question: question.question,
    facets: question.facets.map((facet) => {
      const answer = input.answers.find((a) => a.questionIndex === qi && a.facet.key === facet.key);
      const units = answer?.units ?? [];
      const anchors = Array.from(new Set(units
        .map((u) => input.anchorByUrl.get(u.sourceUrl))
        .filter((a): a is string => a !== undefined)));
      return {
        id: facetId(qi, facet.key),
        label: facet.label,
        kind: facet.kind,
        answered: units.length > 0 && anchors.length > 0,
        citation_anchors: anchors,
        evidence: units.map((u) => u.text),
      };
    }),
  }));
  const allFacets = questions.flatMap((q) => q.facets);
  const answered = allFacets.filter((f) => f.answered).length;
  const ratio = allFacets.length === 0 ? 0 : answered / allFacets.length;
  const primarySources = requirements.primary_sources.map((source) => ({
    name: source.name,
    domain: source.domain,
    cited: input.citedUrls.some((url) => urlIsOnDomain(url, source.domain)),
  }));
  const primaryCited = primarySources.length === 0 ? null : primarySources.some((s) => s.cited);
  const status: AnswerQuality['status'] = ratio === 1 ? 'answered' : ratio >= 0.5 ? 'partial' : 'unanswered';
  const facetMarks = allFacets.map((f) => `${f.label.toLowerCase()} ${f.answered ? '✓' : '✗'}`).join(', ');
  const primaryMark = primaryCited === null
    ? ''
    : `; primary source ${primaryCited ? '✓' : '✗'}`;
  return {
    status,
    answered_ratio: Math.round(ratio * 1000) / 1000,
    facets_total: allFacets.length,
    facets_answered: answered,
    questions,
    primary_sources: primarySources,
    primary_source_cited: primaryCited,
    relevance_gate: gate,
    fetch_quality: fetchQuality,
    summary_line: `answered: ${facetMarks}${primaryMark}`,
    passed: ratio === 1 && primaryCited !== false,
  };
}
