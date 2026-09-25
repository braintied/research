import { ResearchProfileSchema } from './types.js';

/**
 * Travel intelligence: what the people who have done this trip know that a
 * fare or rate search does not.
 *
 * Built after the first real trip the fleet planned (Goa, Mumbai and Bali,
 * 2026-09-24). The price tools answered "what does it cost"; the questions
 * that decided the plan came from elsewhere: which airport is near the event,
 * whether a 30-day visa covers 31 days, what a monthly lease costs against a
 * nightly rate, whether the Wi-Fi works. Those answers live in official rule
 * pages, a handful of expert blogs, destination subreddits, video walkthroughs
 * and local Facebook groups. This profile sends each question to all of them
 * and ranks official rules above everything else.
 */
export const TRAVEL_INTELLIGENCE_PROFILE = ResearchProfileSchema.parse({
  id: 'travel-intelligence',
  version: 1,
  name: 'Travel intelligence: hacks, rules and local knowledge for a real trip',
  description:
    'Decision-grade research for one trip or one destination: entry rules, getting there, where to stay by horizon (days, months, a year), money-saving tactics that hold up, traps and scams, and local knowledge, sourced from official pages, expert blogs, Reddit, X, YouTube, short video and local groups.',
  safePreamble:
    'Research this as a traveller about to spend real money and time. Official government and airline pages decide entry rules, fees and rights; community posts never override them. Label anecdote as anecdote, give every tip a date and a source, prefer tactics repeated by independent people over single viral claims, and name anything that breaks airline, platform or local rules (hidden-city tickets, borrowed corporate codes, off-platform payment, working on a tourist visa) as not recommended.',
  sourcePacks: [
    {
      id: 'official-entry-and-rights',
      label: 'Official entry rules, fees and passenger rights',
      purpose:
        'Establish visas, permitted stays, extensions, levies, arrival forms, and passenger-rights rules from the governments and regulators that set them, with their effective dates.',
      lane: 'primary', visibility: 'public', transport: 'external_search',
      executionMode: 'web',
      providers: ['tavily', 'searxng'], expectedSourceTypes: ['documentation'],
      includeDomains: [
        'travel.state.gov', 'transportation.gov', 'ftc.gov',
        'indianvisaonline.gov.in', 'boi.gov.in', 'mea.gov.in',
        'imigrasi.go.id', 'evisa.imigrasi.go.id',
        'europa.eu', 'gov.uk',
      ],
      queryHints: [
        'visa requirements permitted stay extension fee official',
        'arrival card tourist levy entry requirements official',
        'passenger rights refund delay cancellation rule',
      ],
    },
    {
      id: 'expert-travel-blogs',
      label: 'Expert travel and points blogs',
      purpose:
        'Collect tested tactics, fare and product reviews, loyalty and upgrade mechanics, and dated rule changes from writers who travel for a living, with the date each claim was true.',
      lane: 'web', visibility: 'public', transport: 'external_search',
      executionMode: 'web',
      providers: ['tavily', 'searxng'], expectedSourceTypes: ['longform', 'news'],
      includeDomains: [
        'onemileatatime.com', 'thepointsguy.com', 'frequentmiler.com', 'viewfromthewing.com',
        'upgradedpoints.com', 'thriftytraveler.com', 'going.com', 'doctorofcredit.com',
        'awardwallet.com', 'headforpoints.com', 'nomadicmatt.com', 'seatguru.com',
      ],
      queryHints: [
        'best way to fly route cabin review wifi seat',
        'hacks saving money booking tactic tested',
        'upgrade bid lounge status match stopover program',
      ],
      recencyDays: 730, sort: 'mixed',
    },
    {
      id: 'reddit-traveller-signal',
      label: 'Reddit traveller and resident experience',
      purpose:
        'Collect first-hand experience from travellers and residents in destination and travel communities: what it actually cost, what went wrong, local prices, neighbourhoods, transport, scams, and counterexamples to blog advice. Label single reports as anecdote.',
      lane: 'social_reddit', visibility: 'public', transport: 'external_search',
      executionMode: 'reddit',
      providers: ['reddit'], expectedSourceTypes: ['forum', 'audience_voice'],
      communities: ['travel', 'solotravel', 'TravelHacks', 'digitalnomad', 'Flights', 'awardtravel'],
      queryHints: [
        'first time tips what I wish I knew',
        'scam warning avoid overpaid',
        'long term stay monthly rent neighbourhood',
      ],
      recencyDays: 730, sort: 'mixed', maxPages: 2, searchResultLimit: 20,
    },
    {
      id: 'x-traveller-signal',
      label: 'X travel-hacker and local signal',
      purpose:
        'Find recent posts on fare drops, error fares, rule changes, strikes and closures, and on-the-ground updates that blogs have not caught up with.',
      lane: 'social_x', visibility: 'public', transport: 'external_search',
      executionMode: 'x', required: false,
      providers: ['x', 'searxng'], expectedSourceTypes: ['social'],
      queryHints: ['travel update rule change this week', 'fare deal route cabin'],
      recencyDays: 120, sort: 'mixed', maxPages: 1, searchResultLimit: 16,
    },
    {
      id: 'youtube-walkthroughs',
      label: 'YouTube reviews, walkthroughs and area guides',
      purpose:
        'Find cabin and seat reviews, airport and arrival walkthroughs, neighbourhood and villa tours, and cost-of-living breakdowns, using transcripts and comment threads as evidence.',
      lane: 'social_youtube', visibility: 'public', transport: 'external_search',
      executionMode: 'youtube', required: false,
      providers: ['youtube'], expectedSourceTypes: ['video', 'video_comments'],
      queryHints: ['review walkthrough 2026', 'cost of living month neighbourhood tour'],
      recencyDays: 540, sort: 'mixed', maxPages: 1, searchResultLimit: 12,
    },
    {
      id: 'short-video-local-scene',
      label: 'TikTok and Instagram local scene',
      purpose:
        'Sample what is current on the ground (openings, closures, crowds, prices seen this season) from short video, treating it as a lead to verify, never as proof.',
      lane: 'social_x', visibility: 'public', transport: 'external_search',
      executionMode: 'tiktok', required: false,
      providers: ['tiktok', 'instagram'], expectedSourceTypes: ['social_video'],
      queryHints: ['things to know before you go', 'where to stay area guide this season'],
      recencyDays: 180, sort: 'mixed', maxPages: 1, searchResultLimit: 12,
    },
    {
      id: 'local-groups-market',
      label: 'Local Facebook groups: rentals, services, community',
      purpose:
        'Find how locals and long-stayers actually rent, hire drivers, and find community, where that market lives in groups rather than on platforms, including typical monthly and yearly prices and the scam patterns members warn about.',
      lane: 'community', visibility: 'public', transport: 'external_search',
      executionMode: 'facebook_groups', required: false,
      providers: ['facebook_groups'], expectedSourceTypes: ['forum', 'audience_voice'],
      queryHints: ['long term rental monthly yearly villa', 'recommend driver visa agent'],
      recencyDays: 365, sort: 'mixed', maxPages: 1, searchResultLimit: 12,
    },
    {
      id: 'braintied-travel-prior',
      label: 'Braintied travel research prior',
      purpose:
        'Recover earlier travel sweeps, measured price facts and lessons from the tenant-scoped corpus before paying for new evidence.',
      lane: 'private_cortex', visibility: 'private', transport: 'internal_memory',
      executionMode: 'cortex', adapterId: 'ora-cortex-braintied', required: false,
      queryHints: ['travel hacks flights stays visas', 'destination long stay rental'],
    },
  ],
  coverageRequirements: [
    { id: 'official-rules', description: 'Entry, fee and rights rules from the authority that sets them, with an effective date.', sourcePackIds: ['official-entry-and-rights'], minimumEvidence: 2, minimumUniqueSources: 2, maxAgeDays: 730, allowUndated: true },
    { id: 'expert-tactics', description: 'Tested tactics and reviews from independent expert writers.', sourcePackIds: ['expert-travel-blogs'], minimumEvidence: 3, minimumUniqueSources: 2, maxAgeDays: 730, allowUndated: false },
    { id: 'traveller-experience', description: 'First-hand traveller and resident experience from at least three different people.', sourcePackIds: ['reddit-traveller-signal'], minimumEvidence: 4, minimumUniqueSources: 3, minimumUniqueAuthors: 3, maxAgeDays: 730, allowUndated: false },
    { id: 'current-signal', description: 'Recent social or video evidence of what is true this season.', sourcePackIds: ['x-traveller-signal', 'youtube-walkthroughs', 'short-video-local-scene'], required: false, minimumEvidence: 2, minimumUniqueSources: 2, maxAgeDays: 180, allowUndated: false },
    { id: 'local-market', description: 'How the local long-stay market works, from the groups where it trades.', sourcePackIds: ['local-groups-market'], required: false, minimumEvidence: 2, minimumUniqueSources: 2, maxAgeDays: 365, allowUndated: false },
    { id: 'travel-prior-art', description: 'Earlier Braintied travel research and measured lessons.', sourcePackIds: ['braintied-travel-prior'], required: false, minimumEvidence: 1, minimumUniqueSources: 1, allowUndated: true },
  ],
  verification: {
    preferPrimarySources: true, independentSourcesPerCriticalClaim: 2,
    trackContradictions: true, verifyDatesAndVersions: true, labelInference: true,
    failOnMissingRequiredCoverage: true, requireEvidenceLinkedRecommendations: true,
  },
  output: {
    format: 'decision_brief',
    requiredSections: [
      'Recommendation',
      'Rules and deadlines (official)',
      'Tactics that change the plan, with the saving',
      'Where to stay and how locals rent',
      'Getting there and getting around',
      'Traps, scams and things not to do',
      'Local knowledge',
      'Counterevidence and disagreements',
      'Unknowns',
    ],
    requiredFields: ['recommendation', 'confidence', 'alternatives', 'assumptions', 'unknowns', 'next_actions', 'revisit_triggers'],
    includeComparisonMatrix: false, includeCounterevidence: true,
    includeUnknowns: true, includeRevisitTriggers: true,
  },
  update: {
    supportedModes: ['snapshot', 'update', 'monitor'], defaultMode: 'snapshot',
    materialityThreshold: 'decision_change', preserveClaimHistory: true, diffEvidence: true,
  },
  dataBoundary: {
    requireSanitizedOutboundBrief: true,
    privateEvidenceExternalization: 'deny',
    privateRecallExecution: 'trusted_local_only',
  },
});
