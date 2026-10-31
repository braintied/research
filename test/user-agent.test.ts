import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { researchUserAgent, setResearchUserAgentContact } from '../src/user-agent.js';

describe('researchUserAgent', () => {
  afterEach(() => setResearchUserAgentContact(null));

  it('names no contact unless the host configures one', () => {
    assert.equal(researchUserAgent('catalog'), 'OraResearch/1.0 (catalog)');
  });

  it('appends whichever contact the host supplies', () => {
    setResearchUserAgentContact('ops@acme.dev');
    assert.equal(researchUserAgent('catalog'), 'OraResearch/1.0 (catalog; contact: ops@acme.dev)');
    setResearchUserAgentContact('team@braintied.com');
    assert.equal(
      researchUserAgent('deep-research'),
      'OraResearch/1.0 (deep-research; contact: team@braintied.com)',
    );
  });
});
