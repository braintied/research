/**
 * Proof of consent, as an input this package refuses to run without.
 *
 * This engine does not decide consent. `@braintied/consent` owns the purpose
 * registry, the notice hashing, the event log and the fold; a route calls its
 * `requireConsent(current, purpose, scope)` and gets back a `ConsentRow`. What
 * this module adds is the refusal: a person-subject fetch or research run in
 * `@braintied/research` takes that row as an argument and throws when it is
 * absent, wrong-purpose, or not a current grant.
 *
 * Why the ROW and not a boolean. A boolean is the caller's assertion that it
 * checked; the row is the check's result, and it carries the notice version
 * and sha256 the person actually saw, the method by which they answered, and
 * the `recordUri` that proves it. Passing a boolean means nothing downstream —
 * an evidence log, an "Is this you?" card, a later audit — can say what was
 * agreed to. It also means the gate is satisfied by `true`, which is the
 * literal shape of the failure it exists to prevent.
 *
 * Why a structural type rather than importing `ConsentRow`. Every field below
 * is present on `@braintied/consent`'s `ConsentRow` with the same name and
 * type, so a row passes with no adaptation and TypeScript checks it at the
 * call site. Declaring the four fields this gate reads keeps `research` — an
 * engine that ships to third parties and reads no environment — from taking a
 * package dependency for a type it never constructs. The relationship is
 * asserted by a test, not by a comment: `test/consent-gate.test.ts` builds a
 * real `ConsentRow` through `currentConsent` + `requireConsent` and passes it
 * here.
 */

/**
 * The part of `@braintied/consent`'s `ConsentRow` this gate reads.
 *
 * `state` is deliberately the full five-value vocabulary rather than
 * `'granted'`, so a caller cannot satisfy the type by narrowing and a
 * `withdrawn` row arrives here to be refused BY NAME instead of being absent.
 */
export interface ConsentProof {
  readonly purpose: string;
  readonly scope: string;
  readonly state: 'never_asked' | 'denied' | 'granted' | 'withdrawn' | 'stale';
  /** Proof of the winning answer: where the recorded consent lives. */
  readonly recordUri: string;
}

/** Thrown when a person-subject read was attempted without a current grant. */
export class ConsentProofRequiredError extends Error {
  constructor(
    public readonly purpose: string,
    public readonly reason:
      | 'missing'
      | 'wrong_purpose'
      | 'not_granted'
      | 'no_record_uri',
    public readonly detail?: string,
  ) {
    super(
      `${purpose} requires a current consent row from @braintied/consent `
      + `requireConsent(): ${reason}${detail !== undefined ? ` (${detail})` : ''}`,
    );
    this.name = 'ConsentProofRequiredError';
  }
}

/**
 * Refuse unless `consent` is a current grant for exactly `purpose`.
 *
 * Four refusals, each named, because "no consent" and "consent for something
 * else" are different bugs and the second one is the quiet one: a route that
 * holds `source:interview` and reaches a web-research fetch has a real grant
 * in hand and is still reading something the person did not agree to.
 */
export function requireSourceConsent(
  consent: ConsentProof | null | undefined,
  purpose: string,
): ConsentProof {
  if (consent === null || consent === undefined) {
    throw new ConsentProofRequiredError(purpose, 'missing');
  }
  if (consent.purpose !== purpose) {
    throw new ConsentProofRequiredError(
      purpose,
      'wrong_purpose',
      `row is for "${consent.purpose}"`,
    );
  }
  if (consent.state !== 'granted') {
    throw new ConsentProofRequiredError(purpose, 'not_granted', `state is "${consent.state}"`);
  }
  // A grant with no proof is an assertion. `@braintied/consent` requires a
  // `recordUri` on every event, so an empty one here means the row was built
  // by hand to get past this function.
  if (consent.recordUri.trim().length === 0) {
    throw new ConsentProofRequiredError(purpose, 'no_record_uri');
  }
  return consent;
}
