import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORA_AGENT_RUNTIME_PROFILE,
  WEB_DESIGN_INTELLIGENCE_PROFILE,
  compileResearchBrief,
  getResearchProfile,
} from '../src/profiles/index.js';

const question = 'How should Ora combine long-running agents, durable workflows, and evolving work graphs?';

test('profile registry resolves a pinned or unpinned profile reference', () => {
  assert.equal(getResearchProfile('ora-agent-runtime').version, 1);
  assert.equal(getResearchProfile('ora-agent-runtime@1').id, 'ora-agent-runtime');
  assert.throws(() => getResearchProfile('missing-profile'), /Unknown research profile/);
  assert.equal(getResearchProfile('web-design-intelligence@1').id, 'web-design-intelligence');
});

test('web design profile separates public source authority from private design recall', () => {
  const compiled = compileResearchBrief(WEB_DESIGN_INTELLIGENCE_PROFILE, {
    question: 'Which resources should Parlor agents use to create exceptional websites?',
    asOf: '2026-07-22',
    mode: 'snapshot',
  });

  assert.match(compiled.outboundBrief, /Beautiful, sunny, award-level website design intelligence/);
  assert.match(compiled.outboundBrief, /Premium template and asset authorities/);
  assert.doesNotMatch(compiled.outboundBrief, /Braintied Research Telegram design prior/);
  assert.match(compiled.privateRecallBrief ?? '', /Braintied Research Telegram design prior/);
  assert.match(compiled.privateRecallBrief ?? '', /Parlor and Ora Cortex design prior/);
});

test('compiled profile keeps private recall out of the outbound brief', () => {
  const compiled = compileResearchBrief(ORA_AGENT_RUNTIME_PROFILE, {
    question,
    asOf: '2026-07-21',
    mode: 'snapshot',
  });

  assert.equal(compiled.profileRef, 'ora-agent-runtime@1');
  assert.match(compiled.outboundBrief, /Public source packs/);
  assert.match(compiled.outboundBrief, /Official runtime and framework documentation/);
  assert.doesNotMatch(compiled.outboundBrief, /Braintied prior knowledge/);
  assert.doesNotMatch(compiled.outboundBrief, /ora-cortex-braintied/);
  assert.match(compiled.privateRecallBrief ?? '', /TRUSTED-LOCAL RECALL ONLY/);
  assert.match(compiled.privateRecallBrief ?? '', /ora-cortex-braintied/);
  assert.equal(compiled.profileSha256.length, 64);
});

test('profile hash and compiled brief are deterministic', () => {
  const input = { question, asOf: '2026-07-21' } as const;
  const first = compileResearchBrief('ora-agent-runtime@1', input);
  const second = compileResearchBrief('ora-agent-runtime@1', input);
  assert.equal(first.profileSha256, second.profileSha256);
  assert.equal(first.outboundBrief, second.outboundBrief);
});
