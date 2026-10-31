import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBibliographyLine } from '../src/synthesis.js';
import { parseMarkdownReport } from '../src/parse-markdown-report.js';

test('bibliography line carries author and published date when known', () => {
  assert.equal(
    formatBibliographyLine({ citation_anchor: '[^1]', source_url: 'https://a.example', author: 'Jane Doe', published_at: '2026-03-04T10:00:00Z' }),
    '[^1]: https://a.example — Jane Doe, 2026-03-04',
  );
  assert.equal(
    formatBibliographyLine({ citation_anchor: '[^2]', source_url: 'https://b.example', author: '', published_at: '2026-03-04' }),
    '[^2]: https://b.example — 2026-03-04',
  );
});

test('bibliography line stays a bare URL when nothing else is known', () => {
  assert.equal(
    formatBibliographyLine({ citation_anchor: '[^3]', source_url: 'https://c.example', author: '' }),
    '[^3]: https://c.example',
  );
  assert.equal(
    formatBibliographyLine({ citation_anchor: '[^4]', source_url: 'https://d.example', author: '', published_at: 'last week' }),
    '[^4]: https://d.example',
  );
});

test('an author containing commas cannot shift the date out of place', () => {
  assert.equal(
    formatBibliographyLine({ citation_anchor: '[^5]', source_url: 'https://e.example', author: 'Doe, Jane', published_at: '2025-12-01' }),
    '[^5]: https://e.example — Doe Jane, 2025-12-01',
  );
});

test('what formatBibliographyLine writes, parseMarkdownReport reads back with its date', () => {
  const lines = [
    formatBibliographyLine({ citation_anchor: '[^1]', source_url: 'https://a.example', author: 'Jane Doe', published_at: '2026-03-04' }),
    formatBibliographyLine({ citation_anchor: '[^2]', source_url: 'https://b.example', author: '', published_at: '2026-05-06' }),
    formatBibliographyLine({ citation_anchor: '[^3]', source_url: 'https://c.example', author: '' }),
  ];
  const markdown = [
    '---', 'prompt_id: t/bib', 'tool: claude_code', 'date_anchor: 2026-10-10', '---',
    '# Report', '', '## Executive Summary', '', 'Summary [^1].', '',
    '## Findings', '', 'A [^1]. B [^2]. C [^3].', '', '## Bibliography', '', ...lines, '',
  ].join('\n');
  const parsed = parseMarkdownReport({ markdown, promptId: '' });
  const byUrl = new Map(parsed.report.bibliography.map((b) => [b.source_url, b]));
  assert.equal(byUrl.get('https://a.example')?.published_at, '2026-03-04');
  assert.equal(byUrl.get('https://a.example')?.author, 'Jane Doe');
  assert.equal(byUrl.get('https://b.example')?.published_at, '2026-05-06');
  assert.equal(byUrl.get('https://b.example')?.author, '');
  assert.equal(byUrl.get('https://c.example')?.published_at, undefined);
});
