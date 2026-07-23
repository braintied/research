import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceItemSchema, createClaimId, createEvidenceIdentity } from '../src/evidence.js';
import { ORA_AGENT_RUNTIME_PROFILE, evaluateCoverage } from '../src/profiles/index.js';

function evidenceItem(overrides: Record<string, unknown> = {}) {
  const sourceRef = String(overrides.sourceRef ?? 'https://docs.example/item');
  const content = String(overrides.exactQuote ?? 'Durable execution checkpoints every completed step.');
  const identity = createEvidenceIdentity({ sourceRef, content });
  return EvidenceItemSchema.parse({
    ...identity,
    sourceRef,
    canonicalUrl: sourceRef,
    retrievedAt: '2026-07-21T12:00:00.000Z',
    publishedAt: '2026-07-20T12:00:00.000Z',
    provider: 'searxng',
    sourceClass: 'official_documentation',
    lane: 'documentation',
    sourcePackId: 'official-runtime-docs',
    visibility: 'public',
    exactQuote: content,
    ...overrides,
  });
}

test('evidence and claim identities are stable across whitespace changes', () => {
  const first = createEvidenceIdentity({ sourceRef: 'https://example.com/a', content: 'one  two\nthree' });
  const second = createEvidenceIdentity({ sourceRef: 'https://example.com/a', content: 'one two three' });
  assert.deepEqual(first, second);
  assert.equal(createClaimId('Agents need durable state.'), createClaimId('  agents need durable   state. '));
});

test('coverage report fails closed when required source lanes are missing', () => {
  const report = evaluateCoverage(ORA_AGENT_RUNTIME_PROFILE, [evidenceItem()], '2026-07-21');
  assert.equal(report.passed, false);
  assert.ok(report.missingRequiredRequirementIds.includes('primary-evidence'));
  assert.ok(report.missingRequiredRequirementIds.includes('ora-cortex-prior-art'));
  assert.ok(report.missingRequiredRequirementIds.includes('braintied-telegram-prior-art'));
});

test('coverage excludes evidence newer than the reproducible as-of boundary', () => {
  const future = evidenceItem({ publishedAt: '2026-07-22T00:00:00.000Z' });
  const report = evaluateCoverage(ORA_AGENT_RUNTIME_PROFILE, [future], '2026-07-21');
  const coverage = report.requirements.find((requirement) => requirement.id === 'official-capabilities');
  assert.equal(coverage?.futureEvidenceCount, 1);
  assert.equal(coverage?.evidenceCount, 0);
});

test('coverage excludes stale social evidence when freshness is required', () => {
  const stale = evidenceItem({
    sourceRef: 'https://x.com/example/status/1',
    canonicalUrl: 'https://x.com/example/status/1',
    provider: 'x',
    sourceClass: 'social_post',
    lane: 'social_x',
    sourcePackId: 'x-practitioner-signal',
    author: 'example',
    publishedAt: '2025-01-01T00:00:00.000Z',
  });
  const report = evaluateCoverage(ORA_AGENT_RUNTIME_PROFILE, [stale], '2026-07-21');
  const xCoverage = report.requirements.find((requirement) => requirement.id === 'current-x-signal');
  assert.equal(xCoverage?.passed, false);
  assert.equal(xCoverage?.staleEvidenceCount, 1);
  assert.equal(xCoverage?.evidenceCount, 0);
});
