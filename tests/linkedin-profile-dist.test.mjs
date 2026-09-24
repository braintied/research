/**
 * The new surface, read from the BUILT package rather than from src.
 *
 * `test/linkedin-profile.test.ts` and friends import source files, so they
 * cannot see a `tsup` entry that was never emitted or a subpath whose exports
 * map is wrong. Both of those ship as "the consumer cannot import it" and are
 * invisible to a source-level suite — which is the same shape as the
 * build-before-you-check rule in this repo's CLAUDE.md.
 *
 * `./evidence` is checked here because two packages outside this one
 * (`@braintied/intros`, `@braintied/onboarding-core`) import the evidence
 * contract through that subpath specifically to avoid pulling the engine.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as engine from '../dist/index.mjs';
import * as evidenceSubpath from '../dist/evidence-validation.mjs';

test('the strict LinkedIn profile surface is exported from the built package', () => {
  for (const name of [
    'fetchLinkedInPublicProfile',
    'canonicalizeLinkedInProfileUrl',
    'linkedInPublicIdentifier',
    'normalizeLinkedInProfileRecord',
    'linkedInProfileEvidence',
    'NotALinkedInProfileUrlError',
    'LinkedInProfileIdentityMismatchError',
    'BRIGHTDATA_LINKEDIN_PROFILES_DATASET_ID',
    'LINKEDIN_PUBLIC_PROFILE_PURPOSE',
  ]) {
    assert.ok(name in engine, `dist is missing ${name}`);
  }
  assert.equal(engine.BRIGHTDATA_LINKEDIN_PROFILES_DATASET_ID, 'gd_l1viktl72bvl7bjuj0');
  assert.equal(engine.LINKEDIN_PUBLIC_PROFILE_PURPOSE, 'source:linkedin_public_profile');
  // `linkedin` is deliberately NOT in the closed provider set: widening it is
  // a major change, and there is no search lane to register. The evidence
  // contract carries the transport name instead.
  assert.ok(!engine.PROVIDER_NAMES.includes('linkedin'));
  assert.equal('createLinkedInProvider' in engine, false);
  assert.ok(!('linkedin' in engine.createProviderRegistry({})));
});

test('consented-person@1 and the consent gate are exported from the built package', () => {
  for (const name of [
    'runConsentedPersonResearch',
    'requireSourceConsent',
    'ConsentProofRequiredError',
    'ApprovedBudgetRequiredError',
    'SubjectAnchorsRequiredError',
    'SpendGateRefusedError',
    'anchorMatch',
    'assertAnchors',
    'consentedPersonBrief',
    'CONSENTED_PERSON_PROFILE_V1',
    'CONSENTED_PERSON_PROFILE_REF',
    'CONSENTED_PERSON_PURPOSE',
    'DATA_BROKER_DENYLIST',
    'EXCLUDED_CATEGORIES',
    'isDeniedSource',
  ]) {
    assert.ok(name in engine, `dist is missing ${name}`);
  }
  assert.equal(engine.CONSENTED_PERSON_PROFILE_REF, 'consented-person@1');
  assert.equal(engine.CONSENTED_PERSON_PURPOSE, 'source:web_research');
  assert.equal(engine.getResearchProfile('consented-person@1').version, 1);
  assert.ok(engine.DATA_BROKER_DENYLIST.includes('spokeo.com'));
  assert.equal(engine.isDeniedSource('https://www.spokeo.com/x'), true);

  // The refusals survive the build, which is the half a type cannot prove.
  assert.throws(
    () => engine.requireSourceConsent(undefined, 'source:web_research'),
    /requires a current consent row/,
  );
  assert.throws(() => engine.assertAnchors({ name: 'Jane Maker' }), /at least one anchor/);
});

test('the ./evidence subpath carries both halves of the contract', () => {
  // The two validators a consumer imports instead of copying a sentence check.
  assert.equal(typeof evidenceSubpath.isVerbatimQuoteSupportedBySource, 'function');
  assert.equal(typeof evidenceSubpath.isKeyClaimSupportedBySource, 'function');
  assert.equal(
    evidenceSubpath.isVerbatimQuoteSupportedBySource('I run a small vinyl press.',
      'Some preamble.\nI run a small vinyl press.\nMore text.'),
    true,
  );
  // EvidenceItem is a TYPE, so it must NOT appear at runtime here: the whole
  // point of this subpath is that it stays free of the engine's bundle.
  assert.equal('EvidenceItem' in evidenceSubpath, false);
  assert.equal('EvidenceItemSchema' in evidenceSubpath, false);
  // The runtime schema lives at the root for a consumer that needs to parse.
  assert.equal(typeof engine.EvidenceItemSchema?.parse, 'function');
});
