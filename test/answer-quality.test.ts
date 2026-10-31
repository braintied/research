import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessFetchedPage,
  buildAnswerQuality,
  evidenceFitsFacetKind,
  focusContentWindow,
  isBoilerplateEvidence,
  primarySourcesNamedInBrief,
  questionTerms,
  sanitizePrimarySources,
  selectFacetAnswers,
  type BriefRequirements,
  type EvidenceJudgment,
  type EvidenceUnitForJudging,
} from '../src/answer-quality.js';
import { assembleFinalReport } from '../src/synthesis.js';
import { buildGroundingEvidenceChunks, validateGrounding } from '../src/grounding.js';
import { primarySourceDirectResults, primarySourceSubqueries } from '../src/index.js';
import type { FinalReport, SectionDraft } from '../src/types.js';

// The 2026-10-12 Telegram run, reduced to the evidence that mattered.
const CHANGELOG = 'https://core.telegram.org/bots/api-changelog';
const PYPI = 'https://pypi.org/project/rsstt/';
const DISCORD = 'https://en.wikipedia.org/wiki/Discord';

const telegramRequirements: BriefRequirements = {
  questions: [{
    question: 'What changed in the Telegram Bot API in its most recent release?',
    facets: [
      { key: 'version', label: 'Version', kind: 'version' },
      { key: 'date', label: 'Release date', kind: 'date' },
      { key: 'features', label: 'Main new features', kind: 'list' },
    ],
  }],
  primary_sources: [{ name: 'Telegram Bot API changelog', domain: 'core.telegram.org', urls: [CHANGELOG] }],
};

function unit(text: string, sourceUrl: string): EvidenceUnitForJudging {
  return { key: `${sourceUrl}\u0000${text.toLowerCase()}`, text, sourceUrl };
}

const units = [
  unit('Discord was publicly released in May 2015 under the domain name discordapp.com.', DISCORD),
  unit('A required part of this site couldn’t load.', PYPI),
  unit('Bot API 10.3', CHANGELOG),
  unit('August 24, 2026', CHANGELOG),
  unit('Added the class RichMessageButton representing a button in a RichMessage.', CHANGELOG),
  unit('Bot API 10.2', CHANGELOG),
];

const verdicts: EvidenceJudgment[] = [
  { relevance: 0, answers: [] },
  { relevance: 0, answers: [] },
  { relevance: 3, answers: ['q1.version'] },
  { relevance: 3, answers: ['q1.date'] },
  { relevance: 3, answers: ['q1.features'] },
  { relevance: 3, answers: ['q1.version'] },
];
const judgments = new Map<string, EvidenceJudgment>(
  units.flatMap((u, i): Array<[string, EvidenceJudgment]> => {
    const verdict = verdicts[i];
    return verdict === undefined ? [] : [[u.key, verdict]];
  }),
);

test('an error banner is never evidence, even when it is verbatim', () => {
  assert.equal(isBoilerplateEvidence('A required part of this site couldn’t load.'), true);
  assert.equal(isBoilerplateEvidence('You are using an outdated browser.'), true);
  assert.equal(isBoilerplateEvidence('Please enable JavaScript to continue.'), true);
  assert.equal(isBoilerplateEvidence('© 2026 Apple Inc. All rights reserved.'), true);
  assert.equal(isBoilerplateEvidence('Added the class RichMessageButton representing a button.'), false);
  assert.equal(isBoilerplateEvidence('Workers requests are subject to a rate limit of 1000 per minute.'), false);
});

test('a short error or bot-wall page is rejected; a long article with a banner is kept', () => {
  const wall = '# Just a moment...\n\nChecking if the site connection is secure. Please wait while we verify you are human.';
  assert.deepEqual(assessFetchedPage(wall).usable, false);
  assert.equal(assessFetchedPage(wall).reason, 'error_page');

  const nav = Array.from({ length: 40 }, (_, i) => `- [Link ${i}](https://x.example/${i})`).join('\n');
  assert.equal(assessFetchedPage(nav).reason, 'no_prose');

  const article = [
    'A required part of this site couldn’t load.',
    ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i} explains the release in plain words and ends with a full stop.`),
  ].join('\n\n');
  assert.equal(assessFetchedPage(article).usable, true);
  assert.equal(assessFetchedPage('').reason, 'empty');
});

test('a long page is cut around the question, keeping verbatim lines in page order', () => {
  const filler = Array.from({ length: 60 }, (_, i) => `Unrelated line ${i} about something else entirely.`).join('\n');
  const answer = 'The Workers Paid plan costs $5 per month and includes 10 million requests.';
  const content = `# Pricing\n${filler}\n${filler}\n${answer}\n${filler}\n${filler}`;
  const terms = questionTerms(null, 'How much does the Workers Paid plan cost per month and how many requests are included?');
  const window = focusContentWindow(content, terms, 5000);
  assert.ok(content.length > 10000);
  assert.ok(window.length <= 5000);
  assert.match(window, /^# Pricing/u);
  assert.ok(window.includes(answer));
  for (const line of window.split('\n').filter((l) => l.length > 0)) {
    assert.ok(content.includes(line), `window line not verbatim: ${line}`);
  }
  assert.equal(focusContentWindow('short page', terms, 5000), 'short page');
});

test('facet kinds are checked mechanically under the judge', () => {
  assert.equal(evidenceFitsFacetKind('version', 'Bot API 10.3'), true);
  assert.equal(evidenceFitsFacetKind('version', 'Introduced initial support for Communities.'), false);
  assert.equal(evidenceFitsFacetKind('date', 'August 24, 2026'), true);
  assert.equal(evidenceFitsFacetKind('date', 'Release date: Oct. 9, 2026'), true);
  assert.equal(evidenceFitsFacetKind('price', 'a minimum charge of $5 USD per month'), true);
  assert.equal(evidenceFitsFacetKind('price', 'The plan includes increased allotments.'), false);
});

test('facet answers prefer the primary source and its first (newest) entry', () => {
  const answers = selectFacetAnswers({ requirements: telegramRequirements, units, judgments });
  const byKey = new Map(answers.map((a) => [a.facet.key, a.units.map((u) => u.text)]));
  assert.deepEqual(byKey.get('version'), ['Bot API 10.3']);
  assert.deepEqual(byKey.get('date'), ['August 24, 2026']);
  assert.deepEqual(byKey.get('features'), ['Added the class RichMessageButton representing a button in a RichMessage.']);
});

test('the answer check names each asked fact and fails when one is missing', () => {
  const answers = selectFacetAnswers({
    requirements: telegramRequirements,
    units: units.filter((u) => !u.text.startsWith('August')),
    judgments,
  });
  const quality = buildAnswerQuality({
    requirements: telegramRequirements,
    answers,
    anchorByUrl: new Map([[CHANGELOG, '[^1]']]),
    citedUrls: [CHANGELOG],
    gate: { status: 'applied', judged: 6, kept: 4, dropped: 2, unjudged: 0 },
    fetchQuality: { pagesRejected: 1, evidenceRejected: 1 },
  });
  assert.equal(quality.status, 'partial');
  assert.equal(quality.facets_answered, 2);
  assert.equal(quality.passed, false);
  assert.equal(quality.primary_source_cited, true);
  assert.equal(quality.summary_line, 'answered: version ✓, release date ✗, main new features ✓; primary source ✓');

  const notAssessed = buildAnswerQuality({
    requirements: null,
    analysisError: 'model reply was not JSON',
    answers: [],
    anchorByUrl: new Map(),
    citedUrls: [],
    gate: { status: 'not_run', judged: 0, kept: 0, dropped: 0, unjudged: 0 },
    fetchQuality: { pagesRejected: 0, evidenceRejected: 0 },
  });
  assert.equal(notAssessed.status, 'not_assessed');
  assert.equal(notAssessed.passed, false);
  assert.equal(notAssessed.error, 'model reply was not JSON');
});

test('the executive summary answers the question and stays fully grounded', async () => {
  const sectionBody = 'Added the class RichMessageButton representing a button in a RichMessage [^1].';
  const section: SectionDraft = {
    section_path: 'A.0',
    heading: 'Research Findings 1',
    level: 2,
    body_md: sectionBody,
    source_urls: [CHANGELOG],
    inline_citations: [{
      anchor: '[^1]',
      source_url: CHANGELOG,
      quote_excerpt: 'Added the class RichMessageButton representing a button in a RichMessage.',
    }],
    word_count: 12,
  };
  const assembly = await assembleFinalReport({
    promptMd: 'What changed in the Telegram Bot API in its most recent release?',
    sections: [section],
    gaps: [],
    answerCheck: {
      requirements: telegramRequirements,
      answers: selectFacetAnswers({ requirements: telegramRequirements, units, judgments }),
      gate: { status: 'applied', judged: 6, kept: 4, dropped: 2, unjudged: 0 },
      fetchQuality: { pagesRejected: 0, evidenceRejected: 1 },
    },
  });
  const summary = assembly.report.executive_summary;
  assert.match(summary, /\*\*What changed in the Telegram Bot API in its most recent release\?\*\*/u);
  assert.match(summary, /\*Version:\*\n\nBot API 10\.3 \[\^1\]\./u);
  assert.match(summary, /\*Release date:\*\n\nAugust 24, 2026 \[\^1\]\./u);
  assert.doesNotMatch(summary, /Discord|couldn’t load/u);
  assert.equal(assembly.report.answer_quality?.status, 'answered');
  assert.equal(assembly.report.answer_quality?.passed, true);

  const grounding = validateGrounding({
    fullMarkdown: assembly.report.full_markdown,
    bibliography: assembly.report.bibliography,
    chunks: buildGroundingEvidenceChunks({
      sourceQuotesByUrl: {
        [CHANGELOG]: units.filter((u) => u.sourceUrl === CHANGELOG)
          .map((u) => ({ quote: u.text, context: '', source_url: CHANGELOG, engagement: {} })),
      },
      claimsBySection: {},
    }),
  });
  assert.equal(grounding.ratio, 1);
});

test('a short citation grounds only as an exact verbatim quote, never as a claim', () => {
  const bibliography: FinalReport['bibliography'] = [{
    citation_anchor: '[^1]', source_url: CHANGELOG, title: '', author: '', provider: 'searxng',
  }];
  const claimOnly = buildGroundingEvidenceChunks({
    sourceQuotesByUrl: {},
    claimsBySection: { 'A.0': [{ claim: 'Bot API 10.3', source_url: CHANGELOG, provider: 'searxng' }] },
  });
  assert.equal(validateGrounding({ fullMarkdown: 'Bot API 10.3 [^1].', bibliography, chunks: claimOnly }).valid_citations, 0);
  const quote = buildGroundingEvidenceChunks({
    sourceQuotesByUrl: { [CHANGELOG]: [{ quote: 'Bot API 10.3', context: '', source_url: CHANGELOG, engagement: {} }] },
    claimsBySection: {},
  });
  assert.equal(validateGrounding({ fullMarkdown: 'Bot API 10.3 [^1].', bibliography, chunks: quote }).valid_citations, 1);
  assert.equal(validateGrounding({ fullMarkdown: 'Bot API 10.4 [^1].', bibliography, chunks: quote }).valid_citations, 0);
});

test('primary sources: URLs in the brief always count; off-domain URLs are dropped', () => {
  const named = primarySourcesNamedInBrief('Check https://www.python.org/downloads/ and http://python.org/about.');
  assert.equal(named.length, 1);
  assert.equal(named[0]?.domain, 'python.org');
  assert.deepEqual(named[0]?.urls, ['https://www.python.org/downloads/', 'https://python.org/about']);

  const cleaned = sanitizePrimarySources([
    { name: 'Telegram', domain: 'https://core.telegram.org/bots', urls: [CHANGELOG, 'https://evil.example/x'] },
    { name: 'dup', domain: 'core.telegram.org', urls: [] },
  ]);
  assert.deepEqual(cleaned, [{ name: 'Telegram', domain: 'core.telegram.org', urls: [CHANGELOG] }]);
});

test('primary-source searches are domain-restricted and canonical pages are fetched directly', () => {
  const subqueries = primarySourceSubqueries(telegramRequirements, { searxng: {}, tavily: {} });
  assert.equal(subqueries.length, 1);
  assert.equal(subqueries[0]?.section_path, 'A.0');
  assert.match(subqueries[0]?.query ?? '', / site:core\.telegram\.org$/u);
  assert.deepEqual(subqueries[0]?.search_options.include_domains, ['core.telegram.org']);
  assert.deepEqual(subqueries[0]?.providers, ['searxng', 'tavily']);
  assert.deepEqual(primarySourceSubqueries(null, { searxng: {} }), []);

  const direct = primarySourceDirectResults(telegramRequirements, []);
  assert.equal(direct.length, 1);
  assert.equal(direct[0]?.url, CHANGELOG);
  assert.equal(direct[0]?.provider, 'crawl4ai');
  assert.deepEqual(direct[0]?.retrieved_for, ['A.0']);
  const first = direct[0];
  assert.ok(first !== undefined);
  assert.equal(
    primarySourceDirectResults(telegramRequirements, [{ ...first, provider: 'searxng' }]).length,
    0,
  );
});
