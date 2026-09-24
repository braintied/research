/**
 * The consent gate, against a REAL `@braintied/consent` row.
 *
 * `ConsentProof` in `src/consent-gate.ts` is a structural type, so the claim
 * "a row from `requireConsent` satisfies it" is only as good as a test that
 * builds one through consent's own API and passes it. Without this file the
 * two shapes could drift apart silently and the gate would still compile.
 *
 * `@braintied/consent` is a devDependency for exactly this reason: the
 * relationship is asserted here, and the engine takes no runtime dependency on
 * a package whose type it never constructs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentConsent,
  definePurposes,
  noticeVersion,
  requireConsent,
  type ConsentEvent,
} from '@braintied/consent';

import {
  ConsentProofRequiredError,
  requireSourceConsent,
  type ConsentProof,
} from '../src/consent-gate.js';
import { CONSENTED_PERSON_PURPOSE } from '../src/consented-person.js';
import { LINKEDIN_PUBLIC_PROFILE_PURPOSE } from '../src/providers/linkedin.js';

const WEB_NOTICE = noticeVersion(
  'We will search the open web for you, using only the name, city and links '
  + 'you gave us, and show you everything we find before anything else sees it.',
  'draft-2.1-web',
);
const LINKEDIN_NOTICE = noticeVersion(
  'We will read your own public LinkedIn profile from the URL you paste. '
  + 'Never your connections, never your messages, never anyone else.',
  'draft-2.1-linkedin',
);

const registry = definePurposes([
  { id: LINKEDIN_PUBLIC_PROFILE_PURPOSE, label: 'Read my own public LinkedIn profile', scopeWide: false },
  { id: CONSENTED_PERSON_PURPOSE, label: 'Look me up on the open web', scopeWide: false },
] as const);

const notices = {
  [LINKEDIN_PUBLIC_PROFILE_PURPOSE]: LINKEDIN_NOTICE,
  [CONSENTED_PERSON_PURPOSE]: WEB_NOTICE,
} as const;

function grant(
  purpose: string,
  noticeFor: typeof WEB_NOTICE,
  effectiveAt: string,
): ConsentEvent {
  return {
    subjectId: 'person_1',
    scope: 'circle:galen-40',
    purpose,
    state: 'granted',
    method: 'web_form',
    recordUri: `consent://soon/${purpose}/${effectiveAt}`,
    noticeVersion: noticeFor.version,
    noticeSha256: noticeFor.sha256,
    effectiveAt,
    source: 'ui',
  };
}

test('a row from requireConsent satisfies the gate without adaptation', () => {
  const projection = currentConsent(
    [
      grant(LINKEDIN_PUBLIC_PROFILE_PURPOSE, LINKEDIN_NOTICE, '2026-09-15T09:00:00.000Z'),
      grant(CONSENTED_PERSON_PURPOSE, WEB_NOTICE, '2026-09-15T09:01:00.000Z'),
    ],
    { registry, notices },
  );
  const subject = projection.forSubject('person_1');

  const row = requireConsent(subject, CONSENTED_PERSON_PURPOSE, 'circle:galen-40');
  // The row IS the proof — assigned to the gate's type with no cast or mapping.
  const proof: ConsentProof = row;
  assert.equal(requireSourceConsent(proof, CONSENTED_PERSON_PURPOSE), proof);
  assert.equal(proof.state, 'granted');
  assert.ok(proof.recordUri.length > 0);

  const linkedin: ConsentProof = requireConsent(
    subject,
    LINKEDIN_PUBLIC_PROFILE_PURPOSE,
    'circle:galen-40',
  );
  assert.equal(requireSourceConsent(linkedin, LINKEDIN_PUBLIC_PROFILE_PURPOSE).purpose,
    LINKEDIN_PUBLIC_PROFILE_PURPOSE);

  // The quiet bug: a real grant, for a different purpose.
  assert.throws(
    () => requireSourceConsent(linkedin, CONSENTED_PERSON_PURPOSE),
    (error: unknown) => {
      assert.ok(error instanceof ConsentProofRequiredError);
      assert.equal(error.reason, 'wrong_purpose');
      return true;
    },
  );
});

test('a withdrawal and a stale notice both reach the gate as refusals, by name', () => {
  const withdrawn: ConsentEvent = {
    ...grant(CONSENTED_PERSON_PURPOSE, WEB_NOTICE, '2026-09-15T12:00:00.000Z'),
    state: 'withdrawn',
  };

  const projection = currentConsent(
    [grant(CONSENTED_PERSON_PURPOSE, WEB_NOTICE, '2026-09-15T09:00:00.000Z'), withdrawn],
    { registry, notices },
  );
  const row = projection.find('person_1', CONSENTED_PERSON_PURPOSE, 'circle:galen-40');
  assert.ok(row !== null);
  assert.equal(row.state, 'withdrawn');
  assert.throws(
    () => requireSourceConsent(row, CONSENTED_PERSON_PURPOSE),
    (error: unknown) => {
      assert.ok(error instanceof ConsentProofRequiredError);
      assert.equal(error.reason, 'not_granted');
      assert.match(error.message, /withdrawn/);
      return true;
    },
  );

  // Notice text changed after the person answered: `stale`, not still valid.
  const rewritten = noticeVersion(
    'We will search the open web for you and may also check public records.',
    'draft-2.2-web',
  );
  const staleProjection = currentConsent(
    [grant(CONSENTED_PERSON_PURPOSE, WEB_NOTICE, '2026-09-15T09:00:00.000Z')],
    { registry, notices: { ...notices, [CONSENTED_PERSON_PURPOSE]: rewritten } },
  );
  const staleRow = staleProjection.find('person_1', CONSENTED_PERSON_PURPOSE, 'circle:galen-40');
  assert.ok(staleRow !== null);
  assert.equal(staleRow.state, 'stale');
  assert.throws(
    () => requireSourceConsent(staleRow, CONSENTED_PERSON_PURPOSE),
    /not_granted/,
  );
});

test('a boolean cannot satisfy the gate', () => {
  for (const notARow of [true, 1, 'granted', {}, { purpose: CONSENTED_PERSON_PURPOSE }]) {
    assert.throws(
      () => requireSourceConsent(notARow as unknown as ConsentProof, CONSENTED_PERSON_PURPOSE),
      ConsentProofRequiredError,
    );
  }
});
