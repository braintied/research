/**
 * Unit tests for the 2026-07-05 Momus-audit fixes (v0.3.0).
 * No network for grounding tests; assembleFinalReport needs ANTHROPIC_API_KEY
 * (title/summary call). Run: npx tsx scripts/unit-audit-fixes.ts
 */

import { assembleFinalReport } from '../src/synthesis.js';
import { validateGrounding } from '../src/grounding.js';
import type { SectionDraft } from '../src/types.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // m1: zero-citation grounding is 0/ungrounded, not 1
  // ---------------------------------------------------------------------------
  const g0 = validateGrounding({ fullMarkdown: 'No citations here at all.', bibliography: [], chunks: [] });
  check('m1: zero-citation ratio is 0', g0.ratio === 0);
  check('m1: zero-citation status is ungrounded', g0.status === 'ungrounded');

  // ---------------------------------------------------------------------------
  // M4 + m2 + m3 + hallucination strip via assembleFinalReport
  // Sections deliberately constructed with:
  //  - colliding local numbering (A [^1]=x, B [^1]=z, B [^2]=x)
  //  - an OFFERED-but-uncited citation in A ([^9] never appears in body) → pruned
  //  - a hallucinated anchor in B body ([^7], never offered) → stripped
  // ---------------------------------------------------------------------------
  const sections: SectionDraft[] = [
    {
      section_path: 'A.1', heading: 'Alpha', level: 2, word_count: 40,
      body_md: 'Fact one [^1]. Fact two [^2].',
      source_urls: ['https://x.com/a', 'https://y.com/b', 'https://dead.com/never'],
      inline_citations: [
        { anchor: '[^1]', source_url: 'https://x.com/a', quote_excerpt: 'q' },
        { anchor: '[^2]', source_url: 'https://y.com/b', quote_excerpt: 'q' },
        { anchor: '[^9]', source_url: 'https://dead.com/never', quote_excerpt: 'offered but never cited' },
      ],
    },
    {
      section_path: 'B.1', heading: 'Beta', level: 2, word_count: 40,
      body_md: 'Other fact [^1]. Shared source [^2]. Hallucinated claim [^7].',
      source_urls: ['https://z.com/c', 'https://x.com/a'],
      inline_citations: [
        { anchor: '[^1]', source_url: 'https://z.com/c', quote_excerpt: 'q' },
        { anchor: '[^2]', source_url: 'https://x.com/a', quote_excerpt: 'q' },
      ],
    },
  ];

  const sourceMeta = {
    'https://x.com/a': { provider: 'searxng', title: 'X article', author: 'Ann', published_at: undefined },
    'https://y.com/b': { provider: 'tavily', title: 'Y paper', author: '', published_at: undefined },
    'https://z.com/c': { provider: 'not-a-provider', title: 'Z blog', author: '', published_at: undefined },
  };

  const { report } = await assembleFinalReport({ promptMd: 'test', sections, gaps: [], sourceMeta });

  // m2: offered-but-uncited pruned — dead.com must not be in the bibliography
  check('m2: uncited offered source pruned from bibliography',
    !report.bibliography.some((b) => b.source_url.includes('dead.com')));
  check('m2: bibliography has exactly the 3 cited sources', report.bibliography.length === 3);

  // Hallucination strip: [^7] gone from full_markdown (global numbering only reaches [^3])
  check('halluc: [^7] stripped from full_markdown', !report.full_markdown.includes('[^7]'));
  check('halluc: prose around stripped anchor survives', report.full_markdown.includes('Hallucinated claim'));

  // M4: report.sections carry GLOBAL anchors — B's body must reference [^3] (z.com) and [^1] (shared x.com)
  const sectionB = report.sections.find((s) => s.section_path === 'B.1');
  check('M4: section B body renumbered to global [^3]',
    sectionB !== undefined && sectionB.body_md.includes('Other fact [^3]'));
  check('M4: section B shared source renumbered to global [^1]',
    sectionB !== undefined && sectionB.body_md.includes('Shared source [^1]'));
  check('M4: section B inline_citations carry global anchors',
    sectionB !== undefined && sectionB.inline_citations.some((ic) => ic.anchor === '[^3]'));

  // m3: provenance flows through; unknown provider falls back to crawl4ai
  const bibX = report.bibliography.find((b) => b.source_url === 'https://x.com/a');
  const bibZ = report.bibliography.find((b) => b.source_url === 'https://z.com/c');
  check('m3: provider from search phase (searxng)', bibX !== undefined && bibX.provider === 'searxng');
  check('m3: title from search phase', bibX !== undefined && bibX.title === 'X article');
  check('m3: unknown provider falls back to crawl4ai', bibZ !== undefined && bibZ.provider === 'crawl4ai');

  // grounding sanity on the assembled report: quotes exist for cited URLs → validated status
  const g1 = validateGrounding({
    fullMarkdown: report.full_markdown,
    bibliography: report.bibliography,
    chunks: report.bibliography.map((b) => ({
      chunk_kind: 'quote', section_path: '', heading: null,
      content: 'Fact one Fact two Other fact Shared source',
      source_url: b.source_url, source_provider: null, source_author: null,
      source_published_at: null, source_engagement: {}, citation_anchor: null, metadata: {},
    })),
  });
  check('grounding: assembled report validates (status validated)', g1.status === 'validated');
  check('grounding: nonzero ratio on grounded report', g1.ratio > 0);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('ERR:', err instanceof Error ? err.message : err);
  process.exit(1);
});
