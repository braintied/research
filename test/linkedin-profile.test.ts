/**
 * Strict LinkedIn public-profile provider.
 *
 * The three things this provider exists to refuse, each with its own test:
 * a URL that is not one member's profile, a profile that turns out to be a
 * different person than the caller declared, and a fetch with no consent row.
 * Fixtures only — `globalThis.fetch` is replaced, so no test can reach Bright
 * Data and no test needs a credential.
 */

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  BRIGHTDATA_LINKEDIN_PROFILES_DATASET_ID,
  LINKEDIN_PUBLIC_PROFILE_PURPOSE,
  canonicalizeLinkedInProfileUrl,
  fetchLinkedInPublicProfile,
  linkedInProfileEvidence,
  linkedInPublicIdentifier,
  normalizeLinkedInProfileRecord,
  LinkedInProfileIdentityMismatchError,
  NotALinkedInProfileUrlError,
} from '../src/providers/linkedin.js';
import { ConsentProofRequiredError, type ConsentProof } from '../src/consent-gate.js';
import { MissingCredentialError, type ResearchCredentials } from '../src/credentials.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Fake token: the transport is stubbed in every test, so nothing is sent.
const credentials: ResearchCredentials = {
  brightdata: { apiToken: 'test-brightdata-token' },  // git-secret-allow: fake fixture value, never a live credential
};

const consent: ConsentProof = {
  purpose: LINKEDIN_PUBLIC_PROFILE_PURPOSE,
  scope: 'circle:galen-40',
  state: 'granted',
  recordUri: 'consent://soon/evt_0001',
};

/** A Bright Data LinkedIn profile record, in the dataset's own field names. */
const RECORD = {
  url: 'https://www.linkedin.com/in/jane-maker/',
  name: 'Jane Maker',
  position: 'Founder at Pressing Matters',
  about: 'I run a small vinyl press in Los Angeles.',
  city: 'Los Angeles, California',
  current_company_name: 'Pressing Matters',
  experience: [
    {
      title: 'Founder',
      company: 'Pressing Matters',
      start_date: '2021',
      location: 'Los Angeles',
    },
    { title: 'Producer', company: 'Night Shift Audio', start_date: '2016', end_date: '2021' },
  ],
  education: [{ title: 'CalArts', degree: 'BFA', field: 'Music Technology' }],
  skills: ['Mastering', { name: 'A&R' }, 'Mastering'],
  websites: ['pressingmatters.example', 'https://www.linkedin.com/company/pressing-matters/'],
  // Fields the normalizer must never read, present on purpose.
  connections: 1840,
  people_also_viewed: [{ name: 'Someone Else', url: 'https://www.linkedin.com/in/someone-else/' }],
  recommendations: [{ author: 'A Colleague', text: 'Jane is great.' }],
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubScrape(body: unknown): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(url);
    assert.equal(new URL(url).hostname, 'api.brightdata.com');
    const headers = init.headers as Record<string, string> | undefined;
    assert.equal(headers?.Authorization, 'Bearer test-brightdata-token');
    return jsonResponse(body);
  }) as typeof fetch;
  return { calls };
}

test('only /in/<id> is a member profile URL', () => {
  assert.equal(
    canonicalizeLinkedInProfileUrl('https://linkedin.com/in/Jane-Maker'),
    'https://www.linkedin.com/in/jane-maker/',
  );
  assert.equal(
    canonicalizeLinkedInProfileUrl('https://uk.linkedin.com/in/jane-maker/?trk=nav'),
    'https://www.linkedin.com/in/jane-maker/',
  );
  assert.equal(linkedInPublicIdentifier('https://www.linkedin.com/in/jane-maker/'), 'jane-maker');

  // Not a person's profile.
  for (const rejected of [
    'https://www.linkedin.com/company/pressing-matters/',
    'https://www.linkedin.com/school/calarts/',
    'https://www.linkedin.com/feed/',
    'https://www.linkedin.com/posts/jane-maker_activity-123',
    'https://www.linkedin.com/search/results/people/?keywords=jane',
    'https://www.linkedin.com/in/jane-maker/recent-activity/all/',
    'https://www.linkedin.com/in/jane-maker/detail/contact-info/',
    'https://www.linkedin.com/in/',
    'https://notlinkedin.com/in/jane-maker/',
    'https://evil.example/www.linkedin.com/in/jane-maker/',
    'not a url',
  ]) {
    assert.equal(canonicalizeLinkedInProfileUrl(rejected), null, rejected);
  }
});

test('a non-profile URL is refused before any fetch', async () => {
  globalThis.fetch = (async () => {
    throw new Error('a company page must never reach Bright Data');
  }) as typeof fetch;

  await assert.rejects(
    fetchLinkedInPublicProfile({
      credentials,
      consent,
      profileUrl: 'https://www.linkedin.com/company/pressing-matters/',
    }),
    NotALinkedInProfileUrlError,
  );
});

test('a URL naming a different person than the caller declared is refused before any fetch', async () => {
  globalThis.fetch = (async () => {
    throw new Error('a mismatched subject must never reach Bright Data — records are billed');
  }) as typeof fetch;

  await assert.rejects(
    fetchLinkedInPublicProfile({
      credentials,
      consent,
      profileUrl: 'https://www.linkedin.com/in/someone-else/',
      expectedPublicIdentifier: 'jane-maker',
    }),
    (error: unknown) => {
      assert.ok(error instanceof LinkedInProfileIdentityMismatchError);
      assert.equal(error.expectedIdentifier, 'jane-maker');
      assert.equal(error.returnedIdentifier, 'someone-else');
      return true;
    },
  );
});

test('a record for a different person is refused, never merged', () => {
  assert.throws(
    () => normalizeLinkedInProfileRecord(
      { ...RECORD, url: 'https://www.linkedin.com/in/someone-else/' },
      'https://www.linkedin.com/in/jane-maker/',
    ),
    LinkedInProfileIdentityMismatchError,
  );
  // And a record carrying no identifier at all cannot be assumed to be theirs.
  assert.throws(
    () => normalizeLinkedInProfileRecord(
      { name: 'Jane Maker', about: 'A bio with no link back to a profile.' },
      'https://www.linkedin.com/in/jane-maker/',
    ),
    LinkedInProfileIdentityMismatchError,
  );
});

test('no consent row refuses, and so does a row for another purpose or a withdrawn one', async () => {
  globalThis.fetch = (async () => {
    throw new Error('a consent-less fetch must never reach Bright Data');
  }) as typeof fetch;

  const profileUrl = 'https://www.linkedin.com/in/jane-maker/';

  await assert.rejects(
    // A caller that simply omits the row. Typed as never-undefined, so this is
    // the runtime hole a JS host would fall through.
    fetchLinkedInPublicProfile({
      credentials,
      consent: undefined as unknown as ConsentProof,
      profileUrl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConsentProofRequiredError);
      assert.equal(error.reason, 'missing');
      return true;
    },
  );

  await assert.rejects(
    fetchLinkedInPublicProfile({
      credentials,
      consent: { ...consent, purpose: 'source:interview' },
      profileUrl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConsentProofRequiredError);
      assert.equal(error.reason, 'wrong_purpose');
      return true;
    },
  );

  for (const state of ['never_asked', 'denied', 'withdrawn', 'stale'] as const) {
    await assert.rejects(
      fetchLinkedInPublicProfile({ credentials, consent: { ...consent, state }, profileUrl }),
      (error: unknown) => {
        assert.ok(error instanceof ConsentProofRequiredError);
        assert.equal(error.reason, 'not_granted');
        return true;
      },
    );
  }

  // A hand-built row with no proof of anything.
  await assert.rejects(
    fetchLinkedInPublicProfile({
      credentials,
      consent: { ...consent, recordUri: '  ' },
      profileUrl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConsentProofRequiredError);
      assert.equal(error.reason, 'no_record_uri');
      return true;
    },
  );
});

test('a missing Bright Data token refuses rather than returning an empty profile', async () => {
  globalThis.fetch = (async () => {
    throw new Error('must not fetch without a token');
  }) as typeof fetch;

  await assert.rejects(
    fetchLinkedInPublicProfile({
      credentials: {},
      consent,
      profileUrl: 'https://www.linkedin.com/in/jane-maker/',
    }),
    MissingCredentialError,
  );
});

test('the profile the person published becomes one evidence item per field', async () => {
  const { calls } = stubScrape([RECORD]);

  const result = await fetchLinkedInPublicProfile({
    credentials,
    consent,
    profileUrl: 'https://linkedin.com/in/Jane-Maker?trk=public',
    expectedPublicIdentifier: 'Jane-Maker',
    now: () => new Date('2026-09-15T10:30:00.000Z'),
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.includes(`dataset_id=${BRIGHTDATA_LINKEDIN_PROFILES_DATASET_ID}`));

  const { profile, evidence } = result;
  assert.equal(profile.url, 'https://www.linkedin.com/in/jane-maker/');
  assert.equal(profile.publicIdentifier, 'jane-maker');
  assert.equal(profile.fullName, 'Jane Maker');
  assert.equal(profile.headline, 'Founder at Pressing Matters');
  assert.equal(profile.summary, 'I run a small vinyl press in Los Angeles.');
  assert.equal(profile.location, 'Los Angeles, California');
  assert.equal(profile.currentCompany, 'Pressing Matters');
  assert.equal(profile.positions.length, 2);
  assert.equal(profile.positions[0]?.title, 'Founder');
  assert.equal(profile.education[0]?.school, 'CalArts');
  // Deduped, and the object form read through its `name`.
  assert.deepEqual(profile.skills, ['Mastering', 'A&R']);
  // The LinkedIn company URL is not a site this person owns.
  assert.deepEqual(profile.websites, ['https://pressingmatters.example/']);

  // Every field tagged with source and retrieval time.
  assert.ok(evidence.length >= 8);
  for (const item of evidence) {
    assert.equal(item.sourceRef, 'https://www.linkedin.com/in/jane-maker/');
    assert.equal(item.canonicalUrl, 'https://www.linkedin.com/in/jane-maker/');
    assert.equal(item.retrievedAt, '2026-09-15T10:30:00.000Z');
    assert.equal(item.provider, 'linkedin');
    assert.equal(item.sourceClass, 'first_party_statement');
    assert.equal(item.lane, 'primary');
    assert.equal(item.visibility, 'public');
    assert.equal(item.metadata.publicIdentifier, 'jane-maker');
    assert.equal(item.metadata.subjectOwnProfile, true);
    assert.ok(typeof item.exactQuote === 'string' && item.exactQuote.length > 0);
  }

  const fields = evidence.map((item) => item.metadata.fieldId);
  assert.deepEqual(
    [...new Set(fields)].sort(),
    ['current_company', 'education', 'headline', 'location', 'position', 'skills', 'summary', 'website'],
  );
  // Evidence ids are content-addressed, so the same profile read twice is the
  // same set of items and a review card does not duplicate.
  const again = linkedInProfileEvidence(profile, '2026-09-15T10:30:00.000Z');
  assert.deepEqual(again.map((item) => item.id), evidence.map((item) => item.id));
});

test('connections, recommendations and other people never leave the normalizer', async () => {
  stubScrape([RECORD]);
  const { profile, evidence } = await fetchLinkedInPublicProfile({
    credentials,
    consent,
    profileUrl: 'https://www.linkedin.com/in/jane-maker/',
  });

  const serialized = JSON.stringify({ profile, evidence });
  for (const forbidden of ['Someone Else', 'someone-else', 'A Colleague', 'Jane is great', '1840']) {
    assert.ok(!serialized.includes(forbidden), `leaked: ${forbidden}`);
  }
  assert.ok(!Object.hasOwn(profile, 'connections'));
  // The person's own content IS there; it is only other people that are not.
  assert.equal(profile.currentCompany, 'Pressing Matters');
});

test('an accepted snapshot is polled, never mistaken for an empty profile', async () => {
  let progressCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/scrape?')) return jsonResponse({ snapshot_id: 'snap-1' });
    if (url.includes('/progress/')) {
      progressCalls += 1;
      return jsonResponse({ status: progressCalls === 1 ? 'running' : 'ready' });
    }
    if (url.includes('/snapshot/')) return jsonResponse([RECORD]);
    throw new Error(`unexpected URL: ${url}`);
  }) as typeof fetch;

  const result = await fetchLinkedInPublicProfile({
    credentials,
    consent,
    profileUrl: 'https://www.linkedin.com/in/jane-maker/',
  });
  assert.equal(result.profile.publicIdentifier, 'jane-maker');
  assert.equal(progressCalls, 2);
});

test('an empty or contentless response throws instead of reading as no profile', async () => {
  stubScrape([]);
  await assert.rejects(
    fetchLinkedInPublicProfile({
      credentials,
      consent,
      profileUrl: 'https://www.linkedin.com/in/jane-maker/',
    }),
    /no record/,
  );

  stubScrape([{ url: 'https://www.linkedin.com/in/jane-maker/' }]);
  await assert.rejects(
    fetchLinkedInPublicProfile({
      credentials,
      consent,
      profileUrl: 'https://www.linkedin.com/in/jane-maker/',
    }),
    /no profile content/,
  );
});

test('LinkedIn is not a search provider and not in the closed provider set', async () => {
  const { PROVIDER_NAMES } = await import('../src/types.js');
  const { createProviderRegistry } = await import('../src/providers/index.js');

  // Widening this enum is a major change (a consumer keying a map on it stops
  // compiling), and one person's profile is not a search result. So there is
  // no registry lane at all: the only door carries a consent row.
  assert.ok(!(PROVIDER_NAMES as readonly string[]).includes('linkedin'));
  assert.ok(!('linkedin' in createProviderRegistry(credentials)));

  // The evidence contract still names the transport honestly, so a Bright Data
  // LinkedIn read is never mislabelled as something the person pasted.
  const { EvidenceItemSchema } = await import('../src/evidence.js');
  const item = EvidenceItemSchema.parse({
    id: 'ev_a1b2c3d4e5f60718293a4b5c',
    contentSha256: 'f'.repeat(64),
    sourceRef: 'https://www.linkedin.com/in/jane-maker/',
    retrievedAt: '2026-09-15T10:30:00.000Z',
    provider: 'linkedin',
    sourceClass: 'first_party_statement',
    lane: 'primary',
    sourcePackId: 'linkedin-public-profile',
    visibility: 'public',
  });
  assert.equal(item.provider, 'linkedin');
});
