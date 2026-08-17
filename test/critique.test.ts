import assert from 'node:assert/strict';
import test from 'node:test';

import { critiqueDraft } from '../src/critique.js';
import type { ResearchCredentials } from '../src/credentials.js';

test('critique degrades safely when Anthropic is not configured', async () => {
  const credentials: ResearchCredentials = {};
  {
    const result = await critiqueDraft({
      credentials,
      promptMd: 'Research an example topic.',
      sections: [{
        section_path: 'A.1',
        heading: 'Example',
        level: 2,
        body_md: 'A grounded section.',
        source_urls: [],
        inline_citations: [],
        word_count: 3,
      }],
      targetWordCount: { min: 3, max: 20 },
      providerCoverageBySection: { 'A.1': ['searxng'] },
    });
    assert.equal(result.meets_target, true);
    assert.deepEqual(result.gaps, []);
  }
});
