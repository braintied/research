/**
 * Versioned investigation profiles.
 *
 * A research kind controls cost/depth. A profile controls what evidence an
 * investigation must seek, how it is verified, and what the final artifact
 * must contain. Public and private source packs are deliberately separate so
 * callers cannot accidentally forward private corpus instructions to external
 * search or model providers.
 */

import { z } from 'zod';
import { ExpectedSourceTypeSchema, FeedUrlSchema, ProviderNameSchema } from '../types.js';

const ProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/);
const PackIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/);
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ResearchModeSchema = z.enum(['snapshot', 'update', 'monitor']);
export type ResearchMode = z.infer<typeof ResearchModeSchema>;

export const SourceLaneSchema = z.enum([
  'private_corpus',
  'private_cortex',
  'private_telegram',
  'primary',
  'documentation',
  'academic',
  'news',
  'social_x',
  'social_reddit',
  'social_youtube',
  'developer_github',
  'community',
  'web',
]);
export type SourceLane = z.infer<typeof SourceLaneSchema>;

export const SourcePackSchema = z.object({
  id: PackIdSchema,
  label: z.string().min(3).max(120),
  purpose: z.string().min(10).max(1_000),
  lane: SourceLaneSchema,
  visibility: z.enum(['public', 'private', 'restricted']),
  transport: z.enum(['external_search', 'internal_memory', 'manual']),
  executionMode: z.enum([
    'web', 'x', 'reddit', 'youtube', 'github', 'community',
    'instagram', 'tiktok', 'facebook_groups', 'cortex', 'telegram',
  ]).optional(),
  required: z.boolean().default(true),
  providers: z.array(ProviderNameSchema).default([]),
  expectedSourceTypes: z.array(ExpectedSourceTypeSchema).default([]),
  queryHints: z.array(z.string().min(3).max(500)).default([]),
  includeDomains: z.array(z.string().min(1)).default([]),
  excludeDomains: z.array(z.string().min(1)).default([]),
  /** Verified, explicit RSS/Atom endpoints. Domain filters are not feed URLs. */
  feedUrls: z.array(FeedUrlSchema).default([]),
  handles: z.array(z.string().min(1)).default([]),
  communities: z.array(z.string().min(1)).default([]),
  recencyDays: z.number().int().positive().optional(),
  sort: z.enum(['relevance', 'latest', 'top', 'new', 'comments', 'views', 'rating', 'mixed']).optional(),
  maxPages: z.number().int().min(1).max(10).optional(),
  searchResultLimit: z.number().int().min(1).max(100).optional(),
  adapterId: z.string().min(1).max(120).optional(),
}).superRefine((pack, ctx) => {
  if (pack.transport === 'external_search' && pack.visibility !== 'public') {
    ctx.addIssue({
      code: 'custom',
      path: ['visibility'],
      message: 'External-search source packs must be public.',
    });
  }
  if (pack.transport === 'internal_memory' && pack.adapterId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['adapterId'],
      message: 'Internal-memory source packs require an adapterId.',
    });
  }
  if (pack.providers.includes('rss') && pack.feedUrls.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['feedUrls'],
      message: 'Source packs that enable RSS must declare at least one explicit feed URL.',
    });
  }
  if (!pack.providers.includes('rss') && pack.feedUrls.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['feedUrls'],
      message: 'feedUrls requires the RSS provider.',
    });
  }
});
export type SourcePack = z.infer<typeof SourcePackSchema>;

export const CoverageRequirementSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  description: z.string().min(5).max(500),
  sourcePackIds: z.array(PackIdSchema).min(1),
  required: z.boolean().default(true),
  minimumEvidence: z.number().int().nonnegative().default(1),
  minimumUniqueSources: z.number().int().nonnegative().default(1),
  minimumUniqueAuthors: z.number().int().nonnegative().default(0),
  maxAgeDays: z.number().int().positive().optional(),
  allowUndated: z.boolean().default(true),
});
export type CoverageRequirement = z.infer<typeof CoverageRequirementSchema>;

export const VerificationPolicySchema = z.object({
  preferPrimarySources: z.boolean().default(true),
  independentSourcesPerCriticalClaim: z.number().int().min(1).max(10).default(2),
  trackContradictions: z.boolean().default(true),
  verifyDatesAndVersions: z.boolean().default(true),
  labelInference: z.boolean().default(true),
  failOnMissingRequiredCoverage: z.boolean().default(true),
  requireEvidenceLinkedRecommendations: z.boolean().default(true),
});
export type VerificationPolicy = z.infer<typeof VerificationPolicySchema>;

export const OutputContractSchema = z.object({
  format: z.enum(['research_report', 'decision_brief']).default('research_report'),
  requiredSections: z.array(z.string().min(2).max(160)).min(1),
  requiredFields: z.array(z.string().min(2).max(120)).default([]),
  includeComparisonMatrix: z.boolean().default(false),
  includeCounterevidence: z.boolean().default(true),
  includeUnknowns: z.boolean().default(true),
  includeRevisitTriggers: z.boolean().default(false),
});
export type OutputContract = z.infer<typeof OutputContractSchema>;

export const UpdatePolicySchema = z.object({
  supportedModes: z.array(ResearchModeSchema).min(1).default(['snapshot']),
  defaultMode: ResearchModeSchema.default('snapshot'),
  materialityThreshold: z.enum(['any_change', 'meaningful_change', 'decision_change'])
    .default('meaningful_change'),
  preserveClaimHistory: z.boolean().default(true),
  diffEvidence: z.boolean().default(true),
}).superRefine((policy, ctx) => {
  if (!policy.supportedModes.includes(policy.defaultMode)) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultMode'],
      message: 'defaultMode must appear in supportedModes.',
    });
  }
});
export type UpdatePolicy = z.infer<typeof UpdatePolicySchema>;

export const DataBoundaryPolicySchema = z.object({
  requireSanitizedOutboundBrief: z.literal(true).default(true),
  privateEvidenceExternalization: z.enum(['deny', 'summaries_only']).default('deny'),
  privateRecallExecution: z.literal('trusted_local_only').default('trusted_local_only'),
});
export type DataBoundaryPolicy = z.infer<typeof DataBoundaryPolicySchema>;

export const ResearchProfileSchema = z.object({
  id: ProfileIdSchema,
  version: z.number().int().positive(),
  name: z.string().min(3).max(160),
  description: z.string().min(10).max(2_000),
  safePreamble: z.string().min(10).max(5_000),
  sourcePacks: z.array(SourcePackSchema).min(1),
  coverageRequirements: z.array(CoverageRequirementSchema).min(1),
  verification: VerificationPolicySchema,
  output: OutputContractSchema,
  update: UpdatePolicySchema,
  dataBoundary: DataBoundaryPolicySchema,
}).superRefine((profile, ctx) => {
  const packIds = new Set(profile.sourcePacks.map((pack) => pack.id));
  if (packIds.size !== profile.sourcePacks.length) {
    ctx.addIssue({ code: 'custom', path: ['sourcePacks'], message: 'Source pack IDs must be unique.' });
  }
  for (let index = 0; index < profile.coverageRequirements.length; index++) {
    for (const packId of profile.coverageRequirements[index].sourcePackIds) {
      if (!packIds.has(packId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['coverageRequirements', index, 'sourcePackIds'],
          message: `Unknown source pack: ${packId}.`,
        });
      }
    }
  }
});
export type ResearchProfile = z.infer<typeof ResearchProfileSchema>;

export const CompileResearchBriefInputSchema = z.object({
  question: z.string().trim().min(10).max(20_000),
  asOf: IsoDateSchema,
  mode: ResearchModeSchema.optional(),
});
export type CompileResearchBriefInput = z.infer<typeof CompileResearchBriefInputSchema>;

export interface CompiledResearchBrief {
  profileId: string;
  profileVersion: number;
  profileRef: string;
  profileSha256: string;
  asOf: string;
  mode: ResearchMode;
  /** Safe to send to external search/model providers after caller review. */
  outboundBrief: string;
  /** Trusted-local retrieval instructions. Never forward private results externally. */
  privateRecallBrief: string | null;
  coverageRequirementIds: string[];
}
