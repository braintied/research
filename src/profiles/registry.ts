import { createHash } from 'node:crypto';
import { ORA_AGENT_RUNTIME_PROFILE } from './ora-agent-runtime.js';
import {
  WEB_DESIGN_INTELLIGENCE_PROFILE,
  WEB_DESIGN_INTELLIGENCE_PROFILE_V1,
} from './web-design-intelligence.js';
import { SubquerySchema } from '../types.js';
import type { ProviderName, Subquery } from '../types.js';
import type { AtomicSourceMode, SourceMode, TrustedSourceMode } from '../source-modes.js';
import {
  CompileResearchBriefInputSchema,
  type CompiledResearchBrief,
  type CompileResearchBriefInput,
  type ResearchProfile,
} from './types.js';

export const RESEARCH_PROFILES = [
  ORA_AGENT_RUNTIME_PROFILE,
  WEB_DESIGN_INTELLIGENCE_PROFILE,
  WEB_DESIGN_INTELLIGENCE_PROFILE_V1,
] as const;

function profileRef(profile: ResearchProfile): string {
  return `${profile.id}@${profile.version}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function list(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function publicPackInstructions(profile: ResearchProfile): string {
  return profile.sourcePacks
    .filter((pack) => pack.visibility === 'public' && pack.transport === 'external_search')
    .map((pack) => [
      `### ${pack.label} (${pack.id})`,
      pack.purpose,
      pack.queryHints.length > 0 ? `Query directions:\n${list(pack.queryHints)}` : '',
      pack.includeDomains.length > 0 ? `Prefer direct sources on: ${pack.includeDomains.join(', ')}.` : '',
      pack.handles.length > 0 ? `Trace claims to direct posts from: ${pack.handles.join(', ')}.` : '',
      pack.communities.length > 0 ? `Sample relevant discussion from: ${pack.communities.join(', ')}.` : '',
      pack.recencyDays !== undefined ? `Recency window: ${pack.recencyDays} days.` : '',
    ].filter((value) => value.length > 0).join('\n'))
    .join('\n\n');
}

function privatePackInstructions(profile: ResearchProfile): string | null {
  const privatePacks = profile.sourcePacks.filter((pack) => pack.visibility !== 'public');
  if (privatePacks.length === 0) return null;

  const body = privatePacks.map((pack) => [
    `### ${pack.label} (${pack.id})`,
    `Adapter: ${pack.adapterId ?? 'caller-supplied'}`,
    pack.purpose,
    pack.queryHints.length > 0 ? `Recall directions:\n${list(pack.queryHints)}` : '',
  ].filter((value) => value.length > 0).join('\n')).join('\n\n');

  return [
    'TRUSTED-LOCAL RECALL ONLY',
    'Do not send retrieved private/restricted text, identifiers, or excerpts to external providers.',
    'Preserve tenant scope, visibility, source lineage, and contradictions. Return evidence references to the trusted coordinator.',
    body,
  ].join('\n\n');
}

export function getResearchProfile(ref: string): ResearchProfile {
  const normalized = ref.trim();
  const exact = RESEARCH_PROFILES.find((profile) => normalized === profileRef(profile));
  if (exact !== undefined) return exact;
  const latest = RESEARCH_PROFILES
    .filter((profile) => normalized === profile.id)
    .sort((left, right) => right.version - left.version)[0];
  if (latest !== undefined) return latest;
  throw new Error(`Unknown research profile: ${ref}.`);
}

/** Compile public/outbound and private/local instructions as separate artifacts. */
export function compileResearchBrief(
  profileOrRef: ResearchProfile | string,
  rawInput: CompileResearchBriefInput,
): CompiledResearchBrief {
  const profile = typeof profileOrRef === 'string'
    ? getResearchProfile(profileOrRef)
    : profileOrRef;
  const input = CompileResearchBriefInputSchema.parse(rawInput);
  const mode = input.mode ?? profile.update.defaultMode;
  if (!profile.update.supportedModes.includes(mode)) {
    throw new Error(`Profile ${profileRef(profile)} does not support ${mode} mode.`);
  }

  const publicRequirementLines = profile.coverageRequirements
    .filter((requirement) => requirement.sourcePackIds.some((packId) => {
      const pack = profile.sourcePacks.find((candidate) => candidate.id === packId);
      return pack?.visibility === 'public';
    }))
    .map((requirement) => {
      const age = requirement.maxAgeDays !== undefined
        ? `; evidence no older than ${requirement.maxAgeDays} days`
        : '';
      return `${requirement.description} Minimum ${requirement.minimumEvidence} evidence items from ${requirement.minimumUniqueSources} unique sources${age}.`;
    });

  const verification = profile.verification;
  const outboundBrief = [
    `# Investigation: ${profile.name}`,
    `Profile: ${profileRef(profile)}`,
    `As of: ${input.asOf}`,
    `Mode: ${mode}`,
    '',
    '## Decision question', input.question,
    '',
    '## Research stance', profile.safePreamble,
    '',
    '## Public source packs', publicPackInstructions(profile),
    '',
    '## Public evidence coverage', list(publicRequirementLines),
    '',
    '## Verification',
    list([
      `Use at least ${verification.independentSourcesPerCriticalClaim} independent sources for every critical claim when available.`,
      verification.preferPrimarySources ? 'Prefer primary and official sources over summaries.' : 'Use the most appropriate source for each claim.',
      verification.trackContradictions ? 'Find and preserve counterevidence and contradictions.' : 'Note material uncertainty.',
      verification.verifyDatesAndVersions ? 'Verify dates, versions, limits, and deployment status.' : 'Label date-sensitive claims.',
      verification.labelInference ? 'Label inference separately from sourced fact.' : 'Keep sourced facts explicit.',
      'Treat social engagement and practitioner anecdotes as signal, not proof.',
    ]),
    '',
    '## Output contract',
    `Format: ${profile.output.format}.`,
    `Required sections:\n${list(profile.output.requiredSections)}`,
    profile.output.requiredFields.length > 0
      ? `Required structured fields:\n${list(profile.output.requiredFields)}`
      : '',
    '',
    '## Data boundary',
    'This outbound brief contains public research instructions only. Do not assume access to private corpora. Private recall and reconciliation happen in a separate trusted-local stage.',
  ].filter((value) => value.length > 0).join('\n');

  return {
    profileId: profile.id,
    profileVersion: profile.version,
    profileRef: profileRef(profile),
    profileSha256: createHash('sha256').update(stableJson(profile)).digest('hex'),
    asOf: input.asOf,
    mode,
    outboundBrief,
    privateRecallBrief: privatePackInstructions(profile),
    coverageRequirementIds: profile.coverageRequirements.map((requirement) => requirement.id),
  };
}

export interface CompiledProfileExecution {
  profile: ResearchProfile;
  compiledBrief: CompiledResearchBrief;
  requiredProviders: ProviderName[];
  sourceModes: SourceMode[];
  seedSubqueries: Subquery[];
  trustedPacksByMode: Partial<Record<TrustedSourceMode, Array<{
    id: string;
    queryHints: string[];
  }>>>;
}

/**
 * Compile profile source packs into deterministic executable searches. Public
 * packs become locked subqueries; private packs become trusted adapter inputs.
 */
export function compileProfileExecution(
  profileOrRef: ResearchProfile | string,
  rawInput: CompileResearchBriefInput,
  availableProviders: ProviderName[],
): CompiledProfileExecution {
  const profile = typeof profileOrRef === 'string' ? getResearchProfile(profileOrRef) : profileOrRef;
  const compiledBrief = compileResearchBrief(profile, rawInput);
  const available = new Set(availableProviders);
  const sourceModes: SourceMode[] = [];
  const seedSubqueries: Subquery[] = [];
  const trustedPacksByMode: CompiledProfileExecution['trustedPacksByMode'] = {};

  for (const pack of profile.sourcePacks) {
    const executionMode = pack.executionMode as AtomicSourceMode | undefined;
    if (executionMode === undefined) continue;
    if (!sourceModes.includes(executionMode)) sourceModes.push(executionMode);

    if (pack.transport === 'internal_memory') {
      if (executionMode === 'cortex' || executionMode === 'telegram') {
        const current = trustedPacksByMode[executionMode] ?? [];
        current.push({ id: pack.id, queryHints: pack.queryHints });
        trustedPacksByMode[executionMode] = current;
      }
      continue;
    }
    if (pack.transport !== 'external_search' || pack.visibility !== 'public') continue;

    const selectedProviders = pack.providers.filter((provider) =>
      provider !== 'crawl4ai' && available.has(provider));
    if (selectedProviders.length === 0) continue;
    const providers = selectedProviders;
    const hints = pack.queryHints.length > 0 ? pack.queryHints.slice(0, 2) : [rawInput.question];
    for (let index = 0; index < hints.length; index++) {
      const hint = hints[index];
      if (hint === undefined) continue;
      seedSubqueries.push(SubquerySchema.parse({
        // Query hints fan out acquisition, not report structure. Keeping one
        // stable section per source pack lets evidence from every hint merge
        // into one synthesis and prevents duplicate headings/content.
        section_path: `source.${pack.id}`,
        // Query hints are already source-specific and should remain concise;
        // prepending a long decision brief hurts GitHub/social search syntax.
        query: hint.slice(0, 1_800),
        providers,
        expected_source_types: pack.expectedSourceTypes,
        rationale: `Required source pack: ${pack.label}.`,
        source_pack_id: pack.id,
        source_mode: executionMode,
        required: pack.required,
        search_options: {
          limit: pack.searchResultLimit,
          recency_days: pack.recencyDays,
          published_before: `${rawInput.asOf}T23:59:59.999Z`,
          sort: pack.sort,
          include_domains: pack.includeDomains.length > 0 ? pack.includeDomains : undefined,
          exclude_domains: pack.excludeDomains.length > 0 ? pack.excludeDomains : undefined,
          feed_urls: pack.feedUrls.length > 0 ? pack.feedUrls : undefined,
          communities: pack.communities.length > 0 ? pack.communities : undefined,
          handles: pack.handles.length > 0 ? pack.handles : undefined,
          max_pages: pack.maxPages,
        },
      }));
    }
  }

  return {
    profile,
    compiledBrief,
    requiredProviders: profile.requiredProviders ?? [],
    sourceModes,
    seedSubqueries,
    trustedPacksByMode,
  };
}
