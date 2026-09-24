/**
 * `consented-person@1` — the profile contract and the three refusals.
 *
 * No provider is reached: the program runner is injected, so these tests
 * exercise the gate, the anchor check and the denylist without a credential or
 * a network call. What they do NOT establish is that a real run returns useful
 * evidence; that needs providers and a budget and is a host's integration test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApprovedBudgetRequiredError,
  CONSENTED_PERSON_PROFILE_REF,
  CONSENTED_PERSON_PURPOSE,
  SpendGateRefusedError,
  SubjectAnchorsRequiredError,
  anchorMatch,
  assertAnchors,
  consentedPersonBrief,
  runConsentedPersonResearch,
  type ApprovedBudget,
  type SubjectAnchors,
} from '../src/consented-person.js';
import { ConsentProofRequiredError, type ConsentProof } from '../src/consent-gate.js';
import {
  CONSENTED_PERSON_PROFILE_V1,
  DATA_BROKER_DENYLIST,
  EXCLUDED_CATEGORIES,
  isDeniedSource,
} from '../src/profiles/consented-person.js';
import { getResearchProfile, compileResearchBrief } from '../src/profiles/registry.js';
import { EvidenceItemSchema, createEvidenceIdentity, type EvidenceItem } from '../src/evidence.js';
import type { ResearchProgramResult } from '../src/research-program.js';

const consent: ConsentProof = {
  purpose: CONSENTED_PERSON_PURPOSE,
  scope: 'circle:galen-40',
  state: 'granted',
  recordUri: 'consent://soon/evt_0002',
};

const budget: ApprovedBudget = {
  proposalId: 'prop_1',
  estimatedCostUsd: 0.4,
  approvedMaxCostUsd: 1.5,
  approvedBy: 'galen',
  approvedAt: '2026-09-15T10:00:00.000Z',
};

const anchors: SubjectAnchors = {
  name: 'Jane Maker',
  urls: ['https://pressingmatters.example/about'],
  handles: ['@janemakes'],
  city: 'Los Angeles',
  affiliations: ['Pressing Matters'],
};

function evidence(overrides: Partial<EvidenceItem> & { sourceRef: string }): EvidenceItem {
  const identity = createEvidenceIdentity({
    sourceRef: overrides.sourceRef,
    content: overrides.exactQuote ?? overrides.title ?? overrides.sourceRef,
  });
  return EvidenceItemSchema.parse({
    id: identity.id,
    contentSha256: identity.contentSha256,
    retrievedAt: '2026-09-15T10:30:00.000Z',
    provider: 'tavily',
    sourceClass: 'journalism',
    lane: 'web',
    sourcePackId: 'subject-work-record',
    visibility: 'public',
    title: '',
    ...overrides,
  });
}

function programResult(publicEvidence: EvidenceItem[]): ResearchProgramResult {
  return {
    status: 'complete',
    sourcePlan: {
      modes: [], missingModes: [], missingRequiredProviders: [], ready: true,
    } as unknown as ResearchProgramResult['sourcePlan'],
    sourceCoverage: {} as unknown as ResearchProgramResult['sourceCoverage'],
    profileCoverage: null,
    publicResearch: null,
    publicEvidence,
    trustedEvidence: [],
    trustedRecallFailures: [],
    costUsd: 0.37,
    dataBoundary: 'public_report_and_private_manifest_separate',
  };
}

test('the profile is registered under the fleet slug@version convention', () => {
  const byRef = getResearchProfile(CONSENTED_PERSON_PROFILE_REF);
  assert.equal(byRef.id, 'consented-person');
  assert.equal(byRef.version, 1);
  // Bare slug resolves to the newest version, which is how a host pins loosely.
  assert.equal(getResearchProfile('consented-person').version, 1);

  const compiled = compileResearchBrief(CONSENTED_PERSON_PROFILE_V1, {
    question: consentedPersonBrief(anchors),
    asOf: '2026-09-15',
  });
  assert.equal(compiled.profileRef, 'consented-person@1');
  assert.match(compiled.profileSha256, /^[a-f0-9]{64}$/);
  // Snapshot only: a standing watch on a named human is a different product.
  assert.deepEqual(CONSENTED_PERSON_PROFILE_V1.update.supportedModes, ['snapshot']);
  assert.throws(
    () => compileResearchBrief(CONSENTED_PERSON_PROFILE_V1, {
      question: consentedPersonBrief(anchors),
      asOf: '2026-09-15',
      mode: 'monitor',
    }),
    /does not support monitor/,
  );
});

test('what the profile deliberately does NOT do is in the contract, not only the comments', () => {
  const profile = CONSENTED_PERSON_PROFILE_V1;

  // No private pack, so no Cortex or Telegram recall: nothing to ingest and
  // nothing to externalize.
  assert.deepEqual(profile.sourcePacks.filter((pack) => pack.visibility !== 'public'), []);
  assert.equal(profile.dataBoundary.privateEvidenceExternalization, 'deny');
  assert.equal(compileResearchBrief(profile, {
    question: 'x'.repeat(20), asOf: '2026-09-15',
  }).privateRecallBrief, null);

  // Every pack excludes every data broker, and the brief names the refusal.
  for (const pack of profile.sourcePacks) {
    for (const denied of DATA_BROKER_DENYLIST) {
      assert.ok(pack.excludeDomains.includes(denied), `${pack.id} allows ${denied}`);
    }
  }

  // The preamble forbids inference in each excluded category by name, and says
  // the subject is the only person being looked up.
  const preamble = profile.safePreamble.toLowerCase();
  for (const category of EXCLUDED_CATEGORIES) {
    assert.ok(preamble.includes(category), `preamble does not name ${category}`);
  }
  assert.ok(preamble.includes('one person who asked'));
  assert.ok(preamble.includes('never state a personal fact'));
  assert.ok(preamble.includes('do not use data brokers'));

  // The output must show its work: a link and the quote, per item.
  assert.deepEqual(profile.output.requiredFields, ['source_url', 'exact_quote', 'anchor_matched']);
  assert.ok(profile.output.requiredSections.includes('Items I could not tie to this person'));
  assert.ok(profile.output.requiredSections.includes('What I did not look for'));
});

test('a broker host is denied however it is spelled, and an unparseable ref is not cleared', () => {
  assert.equal(isDeniedSource('https://www.spokeo.com/Jane-Maker'), true);
  assert.equal(isDeniedSource('https://teaser.spokeo.com/x'), true);
  assert.equal(isDeniedSource('https://fastpeoplesearch.com/name/jane'), true);
  assert.equal(isDeniedSource('https://pressingmatters.example/about'), false);
  // Fails closed: something we cannot parse is something we cannot clear.
  assert.equal(isDeniedSource('not a url'), true);
  // A lookalike that merely contains the string is NOT denied by accident.
  assert.equal(isDeniedSource('https://notspokeo.com/x'), false);
});

test('a name with nothing to anchor it to is refused', () => {
  assert.throws(() => assertAnchors({ name: '   ' }), (error: unknown) => {
    assert.ok(error instanceof SubjectAnchorsRequiredError);
    assert.equal(error.reason, 'no_name');
    return true;
  });
  assert.throws(() => assertAnchors({ name: 'Jane Maker' }), (error: unknown) => {
    assert.ok(error instanceof SubjectAnchorsRequiredError);
    assert.equal(error.reason, 'name_only');
    return true;
  });
  assert.throws(
    () => assertAnchors({ name: 'Jane Maker', urls: ['  '], handles: [], city: '' }),
    SubjectAnchorsRequiredError,
  );
  assert.equal(assertAnchors(anchors).name, 'Jane Maker');
});

test('the brief is built from the subject own anchors and carries no free-text question', () => {
  const brief = consentedPersonBrief(anchors);
  assert.ok(brief.includes('Jane Maker'));
  assert.ok(brief.includes('https://pressingmatters.example/about'));
  assert.ok(brief.includes('@janemakes'));
  assert.ok(brief.includes('Los Angeles'));
  assert.ok(brief.includes('Pressing Matters'));
  assert.ok(brief.includes('asked to be looked up'));
});

test('a namesake page is dropped, the subject own site is kept', () => {
  const ownSite = evidence({
    sourceRef: 'https://pressingmatters.example/about',
    canonicalUrl: 'https://pressingmatters.example/about',
    title: 'About',
    exactQuote: 'We press vinyl in small runs.',
  });
  // Same name, a different person, nothing tying it to any anchor.
  const namesake = evidence({
    sourceRef: 'https://county.example/news/obituary',
    canonicalUrl: 'https://county.example/news/obituary',
    title: 'Jane Maker, 84, of Bangor',
    exactQuote: 'Jane Maker was a lifelong resident of Bangor, Maine.',
  });
  const quoted = evidence({
    sourceRef: 'https://magazine.example/interview',
    canonicalUrl: 'https://magazine.example/interview',
    title: 'Jane Maker of Pressing Matters on small-run vinyl',
    exactQuote: 'Jane Maker told us the press runs at night.',
  });

  assert.equal(anchorMatch(ownSite, anchors), 'url:pressingmatters.example');
  assert.equal(anchorMatch(namesake, anchors), null);
  assert.equal(anchorMatch(quoted, anchors), 'affiliation:pressing matters');

  // A page that does not even carry the name never matches.
  assert.equal(
    anchorMatch(evidence({ sourceRef: 'https://other.example/', title: 'Unrelated' }), anchors),
    null,
  );
});

test('the run refuses without consent, without an approved budget, and without anchors', async () => {
  let ran = false;
  const runProgram = async (): Promise<ResearchProgramResult> => {
    ran = true;
    return programResult([]);
  };
  const program = { credentials: {}, asOf: '2026-09-15' } as never;

  await assert.rejects(
    runConsentedPersonResearch({
      consent: undefined as unknown as ConsentProof, anchors, budget, runProgram, program,
    }),
    ConsentProofRequiredError,
  );
  await assert.rejects(
    runConsentedPersonResearch({
      consent: { ...consent, state: 'withdrawn' }, anchors, budget, runProgram, program,
    }),
    ConsentProofRequiredError,
  );
  await assert.rejects(
    runConsentedPersonResearch({
      consent, anchors, budget: undefined as unknown as ApprovedBudget, runProgram, program,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApprovedBudgetRequiredError);
      assert.equal(error.reason, 'missing');
      return true;
    },
  );
  await assert.rejects(
    runConsentedPersonResearch({
      consent, anchors, budget: { ...budget, approvedMaxCostUsd: 0 }, runProgram, program,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApprovedBudgetRequiredError);
      assert.equal(error.reason, 'not_positive');
      return true;
    },
  );
  await assert.rejects(
    runConsentedPersonResearch({
      consent,
      anchors,
      budget: { ...budget, estimatedCostUsd: 9, approvedMaxCostUsd: 1 },
      runProgram,
      program,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApprovedBudgetRequiredError);
      assert.equal(error.reason, 'below_estimate');
      return true;
    },
  );
  await assert.rejects(
    runConsentedPersonResearch({
      consent, anchors, budget: { ...budget, approvedBy: '' }, runProgram, program,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApprovedBudgetRequiredError);
      assert.equal(error.reason, 'no_approver');
      return true;
    },
  );
  await assert.rejects(
    runConsentedPersonResearch({
      consent, anchors: { name: 'Jane Maker' }, budget, runProgram, program,
    }),
    SubjectAnchorsRequiredError,
  );
  await assert.rejects(
    runConsentedPersonResearch({
      consent,
      anchors,
      budget,
      spendGate: { allowed: false, reason: 'account_allowance_exhausted', remainingUsd: 0 },
      runProgram,
      program,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SpendGateRefusedError);
      assert.equal(error.reason, 'account_allowance_exhausted');
      return true;
    },
  );

  // Not one of those refusals paid for a search.
  assert.equal(ran, false);
});

test('an approved run pins the profile, caps at the tighter ceiling, and ingests nothing', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const runProgram = async (input: Record<string, unknown>): Promise<ResearchProgramResult> => {
    seen.push(input);
    return programResult([
      evidence({
        sourceRef: 'https://pressingmatters.example/about',
        canonicalUrl: 'https://pressingmatters.example/about',
        title: 'About',
        exactQuote: 'We press vinyl in small runs.',
      }),
      evidence({
        sourceRef: 'https://www.spokeo.com/Jane-Maker',
        canonicalUrl: 'https://www.spokeo.com/Jane-Maker',
        title: 'Jane Maker — age, address, phone',
        exactQuote: 'Jane Maker, Los Angeles, Pressing Matters.',
      }),
      evidence({
        sourceRef: 'https://county.example/obituary',
        canonicalUrl: 'https://county.example/obituary',
        title: 'Jane Maker, 84, of Bangor',
      }),
    ]);
  };

  const result = await runConsentedPersonResearch({
    consent,
    anchors,
    budget,
    // Tighter than the approved $1.50, so it binds.
    spendGate: { allowed: true, remainingUsd: 0.75 },
    runProgram: runProgram as never,
    program: { credentials: {}, asOf: '2026-09-15' } as never,
  });

  assert.equal(seen.length, 1);
  const passed = seen[0];
  assert.equal(passed?.profileRef, 'consented-person@1');
  assert.equal(passed?.profileMode, 'snapshot');
  assert.equal(passed?.maxCostUsd, 0.75);
  assert.equal(passed?.indexSink, undefined);
  assert.ok(String(passed?.brief).includes('Jane Maker'));

  // A broker page is dropped even though it matched three anchors, and the
  // namesake obituary is dropped for matching none. Both are REPORTED.
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.canonicalUrl, 'https://pressingmatters.example/about');
  assert.equal(result.evidence[0]?.metadata.anchorMatched, 'url:pressingmatters.example');
  assert.equal(result.evidence[0]?.metadata.subjectConsented, true);
  assert.deepEqual(
    [...result.unresolved].map((item) => item.reason).sort(),
    ['denied_source', 'no_anchor_match'],
  );
  assert.equal(result.costUsd, 0.37);
  assert.equal(result.consentRecordUri, 'consent://soon/evt_0002');
  assert.equal(result.profileRef, 'consented-person@1');

  // Every kept item still carries its source URL, so a review card can show it.
  for (const item of result.evidence) {
    assert.ok(typeof item.canonicalUrl === 'string' && item.canonicalUrl.length > 0);
  }
});

test('the approved budget binds when it is tighter than the gate', async () => {
  const seen: Array<Record<string, unknown>> = [];
  await runConsentedPersonResearch({
    consent,
    anchors,
    budget: { ...budget, approvedMaxCostUsd: 0.5 },
    spendGate: { allowed: true, remainingUsd: 40 },
    runProgram: (async (input: Record<string, unknown>) => {
      seen.push(input);
      return programResult([]);
    }) as never,
    program: { credentials: {}, asOf: '2026-09-15' } as never,
  });
  assert.equal(seen[0]?.maxCostUsd, 0.5);
});

test('a host can inject a fuzzier matcher without the package taking a DB dependency', async () => {
  const result = await runConsentedPersonResearch({
    consent,
    anchors,
    budget,
    matcher: () => 'injected:entity-resolution',
    runProgram: (async () => programResult([
      evidence({ sourceRef: 'https://elsewhere.example/', title: 'J. Maker' }),
    ])) as never,
    program: { credentials: {}, asOf: '2026-09-15' } as never,
  });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.metadata.anchorMatched, 'injected:entity-resolution');
});
