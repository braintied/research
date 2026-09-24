/**
 * `consented-person@1` — what the open web says about ONE person who asked.
 *
 * This profile exists for a single shape of work: a person joins something,
 * hands over their own name, city and a link they own, taps "look me up", and
 * gets back a small set of "Is this you?" cards they can keep, fix, or toss.
 * It is the versioned contract for that run, named by the fleet's
 * `slug@version` convention, so the text a run was executed under is
 * recoverable from the run itself.
 *
 * What it deliberately does NOT do, in the order people ask:
 *
 * 1. **No people-search sites.** Every data broker, background-check site and
 *    reverse-lookup aggregator is excluded by domain. Their pages are not
 *    published by the person, are frequently wrong, and buying a person's
 *    dossier back from a broker is not "looking someone up" — it is the thing
 *    the subject would most object to. `DATA_BROKER_DENYLIST` is the list and
 *    it is applied twice: as `excludeDomains` on every pack, and again by
 *    `isDeniedSource` after results come back, because a search provider that
 *    ignores an exclude parameter fails silently.
 * 2. **No inference of personal facts.** The output contract carries what a
 *    source SAID, with the link. It does not draw a conclusion about anyone's
 *    health, politics, finances, family, sexuality, immigration status,
 *    religion, or character. See `EXCLUDED_CATEGORIES` and the safe preamble.
 *    The rule this encodes is `~/.agents/rules/claims-about-people.md`: a real
 *    name plus a personal fact requires a source you actually read.
 * 3. **Nobody but the subject.** Every query is anchored to the subject's own
 *    name plus something they supplied. A result that matches none of their
 *    anchors is dropped as a probable namesake rather than attached to them.
 * 4. **No Cortex ingest.** `dataBoundary` keeps private corpora out, and there
 *    is no private source pack: a person's consented lookup is not research
 *    the fleet gets to keep. The corpus-capture rule in
 *    `~/.agents/rules/research.md` is about findings we may reuse; one
 *    person's identity check is not one of those.
 * 5. **No monitoring.** `supportedModes` is `snapshot` only. A standing watch
 *    on a named human is a different product and would need its own consent.
 */

import type { ResearchProfile } from './types.js';
import { ResearchProfileSchema } from './types.js';

/**
 * Categories no claim about a person may assert, whatever a page says.
 *
 * The plan's list plus the three the same reasoning reaches: an immigration
 * status, a religion and a sexuality are each a fact a page can state and a
 * reader can be harmed by, and none of them is why anyone is being introduced
 * to anyone. `legal` covers arrest and court records, which is where a
 * people-search result most often leads.
 */
export const EXCLUDED_CATEGORIES = [
  'health',
  'finances',
  'family',
  'legal',
  'sexuality',
  'politics',
  'immigration',
  'religion',
] as const;
export type ExcludedCategory = (typeof EXCLUDED_CATEGORIES)[number];

/**
 * Data brokers, people-search and background-check sites.
 *
 * Not a complete list of such sites and it never will be, which is why the
 * anchor check in `consented-person.ts` is the real defence and this is the
 * cheap one. Matched on the registrable suffix, so `www.spokeo.com` and
 * `teaser.spokeo.com` are both denied.
 */
export const DATA_BROKER_DENYLIST: readonly string[] = [
  'spokeo.com', 'whitepages.com', 'beenverified.com', 'truthfinder.com',
  'intelius.com', 'peoplefinders.com', 'peoplesmart.com', 'instantcheckmate.com',
  'mylife.com', 'radaris.com', 'fastpeoplesearch.com', 'truepeoplesearch.com',
  'searchpeoplefree.com', 'usphonebook.com', 'anywho.com', 'zabasearch.com',
  'checkpeople.com', 'peekyou.com', 'thatsthem.com', 'nuwber.com',
  'clustrmaps.com', 'ussearch.com', 'publicrecordsnow.com', 'idtrue.com',
  'backgroundcheck.run', 'smartbackgroundchecks.com', 'verecor.com',
  'advancedbackgroundchecks.com', 'cyberbackgroundchecks.com', 'infotracer.com',
  'socialcatfish.com', 'familytreenow.com', 'rocketreach.co', 'apollo.io',
  'zoominfo.com', 'lusha.com', 'signalhire.com', 'contactout.com',
  'snov.io', 'hunter.io', 'clearbit.com', 'pipl.com', 'been-verified.com',
];

/** True when a URL's host is on (or under) the data-broker denylist. */
export function isDeniedSource(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    // An unparseable source ref is not a source we can clear.
    return true;
  }
  return DATA_BROKER_DENYLIST.some(
    (denied) => hostname === denied || hostname.endsWith(`.${denied}`),
  );
}

const SAFE_PREAMBLE = [
  'You are looking up ONE person who asked to be looked up, so that a system',
  'can show them what it found and let them keep, correct, or delete each item.',
  '',
  'Report only what a page states, with the link. Never state a personal fact',
  'about this person that you did not read on a page you can cite. Never draw a',
  'conclusion about their health, finances, family, legal history, sexuality,',
  'politics, immigration status, or religion, and never repeat such a claim from',
  'a page: if a source raises one of those, leave the item out entirely rather',
  'than summarising it.',
  '',
  'People share names. Every item you return must be traceable to the anchors',
  'the person supplied — their name plus a link, handle, employer, or city they',
  'gave you. When a page is about someone with the same name and nothing ties it',
  'to those anchors, say so and drop it; a mistaken identity presented',
  'confidently is worse than a short result.',
  '',
  'Do not use data brokers, people-search, background-check, or contact-scraping',
  'sites. Prefer what the person published themselves: their own site, their own',
  'profiles, their own writing, and coverage that quotes them directly.',
  '',
  'A short, correct, well-sourced result is the goal. Returning nothing is a',
  'valid outcome and a better one than filling the page.',
].join('\n');

export const CONSENTED_PERSON_PROFILE_V1: ResearchProfile = ResearchProfileSchema.parse({
  id: 'consented-person',
  version: 1,
  name: 'Consented person lookup',
  description:
    'What the open web says about one person who asked to be looked up, anchored to '
    + 'the name, links and city they supplied, excluding data brokers and sensitive '
    + 'categories, for a review card they can keep, fix, or toss. Never fetches '
    + 'anyone else and never infers a personal fact.',
  safePreamble: SAFE_PREAMBLE,
  sourcePacks: [
    {
      id: 'subject-owned-pages',
      label: 'Pages the person publishes themselves',
      purpose:
        'The person\'s own site, portfolio, newsletter, bio page, or shop — the '
        + 'places where what is said about them is said by them. Highest authority '
        + 'and the anchor every other pack is checked against.',
      lane: 'primary',
      visibility: 'public',
      transport: 'external_search',
      executionMode: 'web',
      required: true,
      providers: ['tavily', 'searxng', 'serper'],
      expectedSourceTypes: ['longform', 'documentation'],
      queryHints: [
        'the person\'s name plus a site, handle, or employer they supplied',
        'the person\'s name plus "about" or "bio" on a domain they own',
      ],
      excludeDomains: [...DATA_BROKER_DENYLIST],
      searchResultLimit: 10,
    },
    {
      id: 'subject-work-record',
      label: 'What they have made or shipped',
      purpose:
        'Talks, credits, bylines, products, projects and public work, so a review '
        + 'card can show something true about what the person does rather than a '
        + 'biography assembled from fragments.',
      lane: 'web',
      visibility: 'public',
      transport: 'external_search',
      executionMode: 'web',
      required: false,
      providers: ['tavily', 'searxng', 'serper'],
      expectedSourceTypes: ['longform', 'documentation', 'news'],
      queryHints: [
        'the person\'s name plus their stated field or employer',
        'the person\'s name plus a project, product, or credit they mentioned',
      ],
      excludeDomains: [...DATA_BROKER_DENYLIST],
      searchResultLimit: 10,
    },
    {
      id: 'subject-quoted',
      label: 'Coverage that quotes them directly',
      purpose:
        'Interviews, panels and articles carrying the person\'s own words. A direct '
        + 'quote is first-party even in a third-party publication; a description of '
        + 'them is not, and is treated as weaker evidence.',
      lane: 'news',
      visibility: 'public',
      transport: 'external_search',
      executionMode: 'web',
      required: false,
      providers: ['tavily', 'searxng'],
      expectedSourceTypes: ['news', 'longform'],
      queryHints: [
        'the person\'s name plus interview, said, or told, with their field',
      ],
      excludeDomains: [...DATA_BROKER_DENYLIST],
      searchResultLimit: 8,
    },
  ],
  coverageRequirements: [
    {
      id: 'anchored-to-the-subject',
      description:
        'At least one item traceable to an anchor the person supplied, so the run '
        + 'establishes it found THIS person and not a namesake.',
      sourcePackIds: ['subject-owned-pages', 'subject-work-record', 'subject-quoted'],
      required: true,
      minimumEvidence: 1,
      minimumUniqueSources: 1,
      allowUndated: true,
    },
    {
      id: 'what-they-do',
      description:
        'Something about the person\'s own work, in their own words or from their '
        + 'own pages, that an interview could open with.',
      sourcePackIds: ['subject-owned-pages', 'subject-work-record'],
      required: false,
      minimumEvidence: 1,
      minimumUniqueSources: 1,
      allowUndated: true,
    },
  ],
  verification: {
    preferPrimarySources: true,
    // One good citation per item, because every item is shown to the person
    // who is its subject and they are the second source. Demanding two
    // independent sources for "she runs a record label" would drop the true
    // item her own site states once.
    independentSourcesPerCriticalClaim: 1,
    trackContradictions: true,
    verifyDatesAndVersions: false,
    labelInference: true,
    failOnMissingRequiredCoverage: false,
    requireEvidenceLinkedRecommendations: true,
  },
  output: {
    format: 'research_report',
    requiredSections: [
      'What this person publishes about themselves',
      'What they have made',
      'In their own words',
      'Items I could not tie to this person',
      'What I did not look for',
    ],
    requiredFields: ['source_url', 'exact_quote', 'anchor_matched'],
    includeComparisonMatrix: false,
    includeCounterevidence: true,
    includeUnknowns: true,
    includeRevisitTriggers: false,
  },
  update: {
    // Snapshot only. See note 5 in the module header: a standing watch on a
    // named human is a different product with different consent.
    supportedModes: ['snapshot'],
    defaultMode: 'snapshot',
    materialityThreshold: 'any_change',
    preserveClaimHistory: false,
    diffEvidence: false,
  },
  dataBoundary: {
    requireSanitizedOutboundBrief: true,
    privateEvidenceExternalization: 'deny',
    privateRecallExecution: 'trusted_local_only',
  },
});

/** Latest `consented-person`. */
export const CONSENTED_PERSON_PROFILE = CONSENTED_PERSON_PROFILE_V1;
