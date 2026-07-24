import { ResearchProfileSchema } from './types.js';

/**
 * Decision-grade source contract for Parlor's reusable website-design
 * intelligence. Private recall stays tenant-bound and is reconciled separately
 * from the public synthesis boundary.
 */
export const WEB_DESIGN_INTELLIGENCE_PROFILE_V1 = ResearchProfileSchema.parse({
  id: 'web-design-intelligence',
  version: 1,
  name: 'Beautiful, sunny, award-level website design intelligence',
  description:
    'Build and maintain a rights-aware repository of current website inspiration, premium templates, implementation code, design prompts, and deterministic evaluation harnesses for Parlor agents.',
  safePreamble:
    'Research for a multi-tenant commercial website builder as of the stated date. Separate visual inspiration from reusable implementation authority. Prefer primary publisher, pricing, license, terms, repository, award, and benchmark evidence. Deliberately counter-sample bright, warm, optimistic, tactile, editorial, playful, hospitality, culture, wellness, beauty, fashion, food, travel, and premium-commerce work so generic dark SaaS aesthetics do not dominate.',
  sourcePacks: [
    {
      id: 'parlor-cortex-design-prior',
      label: 'Parlor and Ora Cortex design prior',
      purpose:
        'Recover tenant-scoped research reports, design discoveries, prior source evaluations, implementation lessons, contradictions, and previously accepted design-language decisions.',
      lane: 'private_cortex',
      visibility: 'private',
      transport: 'internal_memory',
      executionMode: 'cortex',
      adapterId: 'ora-cortex-braintied',
      queryHints: [
        'beautiful sunny optimistic website design art direction templates components',
        'award winning agency website inspiration Awwwards CSS Design Awards Framer Webflow',
        'AI website prompts design skills harnesses visual critic evaluation benchmarks',
        'Parlor design language aesthetic library site generation quality',
      ],
    },
    {
      id: 'braintied-telegram-design-prior',
      label: 'Braintied Research Telegram design prior',
      purpose:
        'Recover curator-shared design links, tools, templates, prompts, visual references, taste judgments, and unresolved leads from the registered Braintied Research channel.',
      lane: 'private_telegram',
      visibility: 'private',
      transport: 'internal_memory',
      executionMode: 'telegram',
      adapterId: 'ora-cortex-braintied',
      queryHints: [
        'website design inspiration beautiful sunny warm optimistic',
        'templates prompts Framer Webflow Figma Tailwind React motion',
        'taste design skill agent website harness benchmark visual critic',
        'agency award winning site gallery resources',
      ],
    },
    {
      id: 'award-editorial-sources',
      label: 'Award and editorial design authorities',
      purpose:
        'Identify actively maintained award archives and human-curated galleries with useful filtering, credible publisher identity, and current examples across website categories and aesthetics.',
      lane: 'web',
      visibility: 'public',
      transport: 'external_search',
      executionMode: 'web',
      providers: ['tavily', 'searxng'],
      expectedSourceTypes: ['documentation', 'longform'],
      includeDomains: [
        'awwwards.com', 'cssdesignawards.com', 'thefwa.com', 'godly.website',
        'siteinspire.com', 'httpster.net', 'land-book.com', 'lapa.ninja',
        'onepagelove.com', 'saasframe.io', 'mobbin.com', 'pageflows.com',
      ],
      queryHints: [
        '2026 current award winning website design gallery categories filters collections pricing terms',
        'bright warm optimistic playful editorial hospitality wellness food travel website inspiration curated',
      ],
      recencyDays: 730,
      sort: 'relevance',
      maxPages: 2,
      searchResultLimit: 20,
    },
    {
      id: 'premium-template-authorities',
      label: 'Premium template and asset authorities',
      purpose:
        'Verify current template, section, asset, and membership sources, including exact pricing posture, license scope, redistribution restrictions, client-work rights, and builder-platform limits.',
      lane: 'documentation',
      visibility: 'public',
      transport: 'external_search',
      executionMode: 'web',
      providers: ['tavily', 'searxng'],
      expectedSourceTypes: ['documentation', 'longform'],
      includeDomains: [
        'framer.com', 'webflow.com', 'themes.shopify.com', 'themeforest.net',
        'wordpress.org', 'figma.com', 'creativemarket.com', 'tailwindcss.com',
        'relume.io', 'untitledui.com', 'motionsites.ai', 'jiro.build',
        'framebite.com', 'getdesign.md',
      ],
      queryHints: [
        'official website template marketplace pricing license commercial client work redistribution terms 2026',
        'premium website sections components design assets prompts membership annual lifetime pricing terms',
      ],
      recencyDays: 730,
      sort: 'relevance',
      maxPages: 2,
      searchResultLimit: 24,
    },
    {
      id: 'open-implementation-sources',
      label: 'Open implementation and design-system sources',
      purpose:
        'Verify maintained repositories for accessible components, interaction primitives, creative motion, design systems, and agent-readable design instructions, using repository licenses and releases as authority.',
      lane: 'developer_github',
      visibility: 'public',
      transport: 'external_search',
      executionMode: 'github',
      providers: ['github', 'tavily', 'searxng'],
      expectedSourceTypes: ['repository', 'code'],
      includeDomains: ['github.com'],
      queryHints: [
        'website design component library animation creative frontend design system license maintained stars release',
        'AI frontend design skill DESIGN.md prompt repository visual design instructions license',
      ],
      recencyDays: 730,
      sort: 'mixed',
      maxPages: 2,
      searchResultLimit: 24,
    },
    {
      id: 'ai-design-guidance',
      label: 'Primary AI design guidance and agent harnesses',
      purpose:
        'Find primary instructions, engineering reports, and evaluation systems for producing and judging non-generic, accessible, responsive, visually coherent websites with agents.',
      lane: 'primary',
      visibility: 'public',
      transport: 'external_search',
      executionMode: 'web',
      providers: ['tavily', 'searxng'],
      expectedSourceTypes: ['documentation', 'academic', 'longform'],
      includeDomains: [
        'anthropic.com', 'openai.com', 'developers.openai.com', 'web.dev',
        'w3.org', 'storybook.js.org', 'playwright.dev', 'arxiv.org', 'github.com',
      ],
      queryHints: [
        'AI frontend design agent skill non generic website design prompt harness primary source',
        'website visual aesthetic evaluation benchmark design to code accessibility responsive motion agent',
      ],
      recencyDays: 730,
      sort: 'relevance',
      maxPages: 2,
      searchResultLimit: 20,
    },
    {
      id: 'design-practitioner-signal',
      label: 'Independent design practitioner signal',
      purpose:
        'Collect current practitioner workflows, criticism, failure reports, and counterevidence about AI website taste, template quality, component libraries, and visual-evaluation practice.',
      lane: 'community',
      visibility: 'public',
      transport: 'external_search',
      executionMode: 'community',
      providers: ['hn', 'rss', 'podcasts'],
      expectedSourceTypes: ['forum', 'newsletter', 'podcast'],
      feedUrls: [
        'https://www.smashingmagazine.com/feed/',
        'https://web.dev/static/blog/feed.xml',
        'https://alistapart.com/main/feed/',
        'https://css-tricks.com/feed/',
      ],
      queryHints: [
        'AI generated website design taste failure generic aesthetics design systems practitioner',
        'frontend design agent workflow visual QA screenshot benchmark template library experience',
      ],
      recencyDays: 730,
      sort: 'relevance',
      searchResultLimit: 14,
    },
  ],
  coverageRequirements: [
    {
      id: 'award-source-coverage',
      description: 'Current award or editorial authorities across multiple publishers and visual categories.',
      sourcePackIds: ['award-editorial-sources'],
      minimumEvidence: 8,
      minimumUniqueSources: 5,
      maxAgeDays: 900,
      allowUndated: true,
    },
    {
      id: 'template-rights-coverage',
      description: 'First-party access, pricing, license, or terms evidence for commercial template and asset sources.',
      sourcePackIds: ['premium-template-authorities'],
      minimumEvidence: 10,
      minimumUniqueSources: 6,
      maxAgeDays: 900,
      allowUndated: true,
    },
    {
      id: 'implementation-coverage',
      description: 'Maintained and explicitly licensed implementation or design-system repositories.',
      sourcePackIds: ['open-implementation-sources'],
      minimumEvidence: 8,
      minimumUniqueSources: 5,
      maxAgeDays: 900,
      allowUndated: false,
    },
    {
      id: 'guidance-harness-coverage',
      description: 'Primary AI design guidance plus deterministic and visual evaluation harness evidence.',
      sourcePackIds: ['ai-design-guidance'],
      minimumEvidence: 6,
      minimumUniqueSources: 4,
      maxAgeDays: 900,
      allowUndated: true,
    },
    {
      id: 'practitioner-counterevidence',
      description: 'Independent practitioner experience and counterevidence.',
      sourcePackIds: ['design-practitioner-signal'],
      minimumEvidence: 3,
      minimumUniqueSources: 2,
      maxAgeDays: 900,
      allowUndated: false,
    },
    {
      id: 'cortex-design-prior',
      description: 'Tenant-scoped prior design research and implementation lessons from Ora Cortex.',
      sourcePackIds: ['parlor-cortex-design-prior'],
      minimumEvidence: 3,
      minimumUniqueSources: 2,
      allowUndated: true,
    },
    {
      id: 'telegram-design-prior',
      description: 'Curator-shared design resources and taste context from Braintied Research Telegram.',
      sourcePackIds: ['braintied-telegram-design-prior'],
      minimumEvidence: 3,
      minimumUniqueSources: 2,
      allowUndated: true,
    },
  ],
  verification: {
    preferPrimarySources: true,
    independentSourcesPerCriticalClaim: 2,
    trackContradictions: true,
    verifyDatesAndVersions: true,
    labelInference: true,
    failOnMissingRequiredCoverage: true,
    requireEvidenceLinkedRecommendations: true,
  },
  output: {
    format: 'decision_brief',
    requiredSections: [
      'Executive decision',
      'Resource landscape',
      'Beautiful and sunny art-direction strategy',
      'Award and editorial inspiration',
      'Premium templates and commercial rights',
      'Open code and design-system substrates',
      'Prompts, skills, and agent instructions',
      'Evaluation and QA harnesses',
      'Automation and ingestion boundaries',
      'Recommended Parlor repository architecture',
      'Evidence gaps and counterevidence',
      'Refresh and monitoring plan',
    ],
    requiredFields: [
      'recommendation', 'confidence', 'resource_category', 'access_model',
      'rights_posture', 'automation_posture', 'evidence_date', 'unknowns',
      'next_actions', 'revisit_triggers',
    ],
    includeComparisonMatrix: true,
    includeCounterevidence: true,
    includeUnknowns: true,
    includeRevisitTriggers: true,
  },
  update: {
    supportedModes: ['snapshot', 'update', 'monitor'],
    defaultMode: 'snapshot',
    materialityThreshold: 'meaningful_change',
    preserveClaimHistory: true,
    diffEvidence: true,
  },
  dataBoundary: {
    requireSanitizedOutboundBrief: true,
    privateEvidenceExternalization: 'deny',
    privateRecallExecution: 'trusted_local_only',
  },
});

/**
 * Version 2 makes native GitHub public-repository evidence a hard contract.
 * The version-1 object remains byte-for-byte/hash compatible for pinned runs;
 * generic web search cannot stand in for implementation-repository evidence
 * in the latest profile.
 */
export const WEB_DESIGN_INTELLIGENCE_PROFILE = ResearchProfileSchema.parse({
  ...WEB_DESIGN_INTELLIGENCE_PROFILE_V1,
  version: 2,
  requiredProviders: ['github'],
  sourcePacks: WEB_DESIGN_INTELLIGENCE_PROFILE_V1.sourcePacks.map((pack) =>
    pack.id === 'open-implementation-sources'
      ? { ...pack, providers: ['github'] }
      : pack),
});
