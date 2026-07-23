import { ResearchProfileSchema } from './types.js';

/** Reusable investigation contract for Ora's agent-runtime architecture. */
export const ORA_AGENT_RUNTIME_PROFILE = ResearchProfileSchema.parse({
  id: 'ora-agent-runtime',
  version: 1,
  name: 'Ora agent runtime and work-graph architecture',
  description:
    'Decision-grade research for evolving Ora from isolated agent loops into a durable, observable work graph without duplicating its workflow or knowledge infrastructure.',
  safePreamble:
    'Assess the architecture as a production operating-system decision. Distinguish agent cognition from durable coordination, and distinguish verified product capabilities from proposals or community claims.',
  sourcePacks: [
    {
      id: 'ora-cortex-prior',
      label: 'Ora Cortex prior knowledge',
      purpose:
        'Recover prior decisions, research reports, public-artifact observations, operational evidence, and contradictions from the tenant-scoped Ora knowledge plane.',
      lane: 'private_cortex', visibility: 'private', transport: 'internal_memory',
      executionMode: 'cortex', adapterId: 'ora-cortex-braintied',
      queryHints: [
        'loops, loop engineering, graphs, work graphs, org graphs',
        'long-running agents, Inngest, OpenClaw, Cortex, Conductor',
        'agent reliability, checkpoints, leases, approvals, evaluation, evolution',
      ],
    },
    {
      id: 'braintied-telegram-prior',
      label: 'Braintied Research Telegram prior knowledge',
      purpose:
        'Recover private curator context, shared links, earlier hypotheses, and contradictions from the explicitly registered Braintied Research Telegram corpus.',
      lane: 'private_telegram', visibility: 'private', transport: 'internal_memory',
      executionMode: 'telegram', adapterId: 'ora-cortex-braintied',
      queryHints: [
        'loops, graphs, long-running agents, Inngest, OpenClaw',
        'agent operating systems, work graphs, research agents, evolution',
      ],
    },
    {
      id: 'official-runtime-docs',
      label: 'Official runtime and framework documentation',
      purpose:
        'Verify durability, state, resume, cancellation, versioning, limits, and observability claims from maintainers rather than secondary summaries.',
      lane: 'documentation', visibility: 'public', transport: 'external_search',
      executionMode: 'web',
      providers: ['tavily', 'searxng', 'rss'], expectedSourceTypes: ['documentation'],
      includeDomains: ['inngest.com', 'openclaw.ai', 'temporal.io', 'restate.dev', 'dbos.dev', 'trigger.dev', 'docs.langchain.com', 'pydantic.dev'],
      queryHints: [
        'durable agents dynamic workflow graph deterministic replay',
        'task flow background tasks approvals resume cancellation revision conflicts',
        'long-running agent state checkpoint versioning limits',
      ],
    },
    {
      id: 'primary-agent-evidence',
      label: 'Primary agent engineering and evaluation evidence',
      purpose:
        'Ground long-horizon capability, multi-agent economics, harness design, safety, observability, and evaluation recommendations in primary engineering reports and research.',
      lane: 'primary', visibility: 'public', transport: 'external_search',
      executionMode: 'web',
      providers: ['tavily', 'searxng', 'rss'],
      expectedSourceTypes: ['longform', 'academic', 'documentation'],
      includeDomains: ['anthropic.com', 'openai.com', 'developers.openai.com', 'metr.org', 'opentelemetry.io', 'genai.owasp.org', 'nist.gov', 'arxiv.org'],
      queryHints: [
        'effective harnesses long-running agents persistent workspace verification',
        'multi-agent research token cost parallelism evaluation',
        'agent autonomy time horizon safety identity observability',
        'agent workflow optimization evolution GEPA AFlow AlphaEvolve external evaluator',
      ],
    },
    {
      id: 'x-practitioner-signal',
      label: 'X practitioner signal',
      purpose:
        'Trace the current loops-to-graphs discussion to direct posts and capture high-signal practitioner arguments without treating popularity as proof.',
      lane: 'social_x', visibility: 'public', transport: 'external_search',
      executionMode: 'x',
      providers: ['x', 'searxng'], expectedSourceTypes: ['social'],
      handles: ['steipete'],
      queryHints: ['loop engineering agents graphs work graph org graph', 'long-running agents durable execution production failure modes'],
      recencyDays: 90, sort: 'mixed', maxPages: 2, searchResultLimit: 16,
    },
    {
      id: 'reddit-practitioner-signal',
      label: 'Reddit practitioner evidence',
      purpose:
        'Collect concrete production failures, operating practices, skepticism, and counterexamples from Reddit threads and comment trees while labeling anecdotal evidence as such.',
      lane: 'social_reddit', visibility: 'public', transport: 'external_search',
      executionMode: 'reddit',
      providers: ['reddit'], expectedSourceTypes: ['forum', 'audience_voice'],
      communities: ['AI_Agents', 'LocalLLaMA', 'ClaudeCode', 'programming'],
      queryHints: ['long-running agents production reliability context drift retries cost caps', 'agent orchestration graphs loops state machines durable workflows'],
      recencyDays: 365, sort: 'mixed', maxPages: 2, searchResultLimit: 18,
    },
    {
      id: 'youtube-practitioner-signal',
      label: 'YouTube engineering talks and discussion',
      purpose:
        'Find current technical talks, demos, interviews, transcripts, and comment-thread counterevidence about long-running agents and graph runtimes.',
      lane: 'social_youtube', visibility: 'public', transport: 'external_search',
      executionMode: 'youtube', providers: ['youtube'], expectedSourceTypes: ['video', 'video_comments'],
      queryHints: ['long running AI agents work graphs loops engineering', 'durable agent workflows Inngest OpenClaw architecture'],
      recencyDays: 365, sort: 'mixed', maxPages: 1, searchResultLimit: 12,
    },
    {
      id: 'github-implementation-evidence',
      label: 'GitHub implementation and issue evidence',
      purpose:
        'Inspect real repositories, releases, pull requests, and issue discussions for implementation maturity, failure modes, and active maintenance.',
      lane: 'developer_github', visibility: 'public', transport: 'external_search',
      executionMode: 'github', providers: ['github', 'tavily', 'searxng'],
      expectedSourceTypes: ['repository', 'issue', 'code'],
      includeDomains: ['github.com'],
      queryHints: ['agent loops work graph orchestration durable jobs repository', 'long running agent checkpoint resume issues'],
      recencyDays: 365, sort: 'mixed', maxPages: 1, searchResultLimit: 12,
    },
    {
      id: 'community-practitioner-signal',
      label: 'Hacker News, RSS, and podcast practitioner evidence',
      purpose:
        'Collect independent technical discussion, first-party feeds, and long-form practitioner context outside platform-specific social ranking.',
      lane: 'community', visibility: 'public', transport: 'external_search',
      executionMode: 'community', providers: ['hn', 'rss', 'podcasts'],
      expectedSourceTypes: ['forum', 'newsletter', 'podcast'],
      queryHints: ['agent orchestration graphs loops durable workflows production', 'long-running coding agents harness reliability'],
      recencyDays: 365,
    },
  ],
  coverageRequirements: [
    { id: 'official-capabilities', description: 'Official documentation for the runtimes that materially affect the recommendation.', sourcePackIds: ['official-runtime-docs'], minimumEvidence: 6, minimumUniqueSources: 4, allowUndated: true },
    { id: 'primary-evidence', description: 'Primary evidence for capability, economics, evaluation, observability, and safety claims.', sourcePackIds: ['primary-agent-evidence'], minimumEvidence: 6, minimumUniqueSources: 4, allowUndated: true },
    { id: 'current-x-signal', description: 'Direct and recent X evidence for the loops-to-graphs discussion.', sourcePackIds: ['x-practitioner-signal'], minimumEvidence: 2, minimumUniqueSources: 2, minimumUniqueAuthors: 1, maxAgeDays: 120, allowUndated: false },
    { id: 'reddit-counterevidence', description: 'Recent practitioner experience and failure reports from Reddit threads.', sourcePackIds: ['reddit-practitioner-signal'], minimumEvidence: 4, minimumUniqueSources: 3, minimumUniqueAuthors: 3, maxAgeDays: 450, allowUndated: false },
    { id: 'youtube-evidence', description: 'Current YouTube talks/transcripts and comment-thread evidence.', sourcePackIds: ['youtube-practitioner-signal'], minimumEvidence: 2, minimumUniqueSources: 2, minimumUniqueAuthors: 2, maxAgeDays: 450, allowUndated: false },
    { id: 'github-evidence', description: 'Current implementation and issue evidence from GitHub.', sourcePackIds: ['github-implementation-evidence'], minimumEvidence: 3, minimumUniqueSources: 2, minimumUniqueAuthors: 1, maxAgeDays: 450, allowUndated: false },
    { id: 'community-counterevidence', description: 'Independent practitioner evidence from Hacker News, RSS, or podcasts.', sourcePackIds: ['community-practitioner-signal'], minimumEvidence: 3, minimumUniqueSources: 2, minimumUniqueAuthors: 2, maxAgeDays: 450, allowUndated: false },
    { id: 'ora-cortex-prior-art', description: 'Tenant-scoped Ora Cortex prior knowledge, including conflicting earlier conclusions.', sourcePackIds: ['ora-cortex-prior'], minimumEvidence: 3, minimumUniqueSources: 2, allowUndated: true },
    { id: 'braintied-telegram-prior-art', description: 'Private Braintied Research Telegram curator context and earlier hypotheses.', sourcePackIds: ['braintied-telegram-prior'], minimumEvidence: 3, minimumUniqueSources: 2, allowUndated: true },
  ],
  verification: {
    preferPrimarySources: true, independentSourcesPerCriticalClaim: 2,
    trackContradictions: true, verifyDatesAndVersions: true, labelInference: true,
    failOnMissingRequiredCoverage: true, requireEvidenceLinkedRecommendations: true,
  },
  output: {
    format: 'decision_brief',
    requiredSections: [
      'Executive decision', 'What loops-to-graphs actually means', 'Fit with Ora today',
      'Architecture and ownership boundaries', 'Runtime comparison',
      'Failure modes, security, and observability', 'Agent and graph evolution strategy',
      '30/60/90-day rollout', 'Experiments and acceptance gates', 'Evidence gaps and counterevidence',
    ],
    requiredFields: ['recommendation', 'confidence', 'alternatives', 'assumptions', 'unknowns', 'reversibility', 'next_actions', 'revisit_triggers'],
    includeComparisonMatrix: true, includeCounterevidence: true,
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
