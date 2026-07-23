/** Evidence, claims, and run-lineage contracts for reusable investigations. */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProviderNameSchema } from './types.js';
import { ResearchModeSchema, SourceLaneSchema } from './profiles/types.js';

const IsoTimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const EvidenceVisibilitySchema = z.enum(['public', 'private', 'restricted']);
export type EvidenceVisibility = z.infer<typeof EvidenceVisibilitySchema>;

export const EvidenceSourceClassSchema = z.enum([
  'official_documentation', 'primary_research', 'first_party_statement',
  'journalism', 'community_discussion', 'social_post', 'internal_record',
  'secondary_analysis',
]);
export type EvidenceSourceClass = z.infer<typeof EvidenceSourceClassSchema>;

const EvidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{24}$/);
const ClaimIdSchema = z.string().regex(/^cl_[a-f0-9]{24}$/);

export const EvidenceItemSchema = z.object({
  id: EvidenceIdSchema,
  contentSha256: Sha256Schema,
  sourceRef: z.string().min(1).max(2_000),
  canonicalUrl: z.string().url().optional(),
  title: z.string().max(1_000).default(''),
  author: z.string().max(500).optional(),
  publishedAt: IsoTimestampSchema.optional(),
  retrievedAt: IsoTimestampSchema,
  provider: ProviderNameSchema.or(z.literal('internal')).or(z.literal('manual')),
  sourceClass: EvidenceSourceClassSchema,
  lane: SourceLaneSchema,
  sourcePackId: z.string().min(1).max(120),
  visibility: EvidenceVisibilitySchema,
  query: z.string().max(2_000).optional(),
  sectionPath: z.string().max(200).optional(),
  exactQuote: z.string().max(20_000).optional(),
  contentRef: z.string().max(2_000).optional(),
  engagement: z.record(z.string(), z.number()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const ResearchClaimSchema = z.object({
  id: ClaimIdSchema,
  text: z.string().min(3).max(10_000),
  status: z.enum(['unknown', 'supported', 'contested', 'refuted']),
  supportingEvidenceIds: z.array(EvidenceIdSchema).default([]),
  contradictingEvidenceIds: z.array(EvidenceIdSchema).default([]),
  confidence: z.number().min(0).max(1),
  confidenceRationale: z.string().min(1).max(5_000),
  inference: z.boolean().default(false),
  falsifiers: z.array(z.string().min(1).max(2_000)).default([]),
});
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>;

export const ResearchFindingSchema = z.object({
  id: z.string().regex(/^fi_[a-f0-9]{24}$/),
  title: z.string().min(3).max(500),
  summary: z.string().min(3).max(20_000),
  claimIds: z.array(ClaimIdSchema).min(1),
  recommendation: z.string().max(10_000).optional(),
  reversibility: z.enum(['easy', 'moderate', 'hard']).optional(),
  revisitTriggers: z.array(z.string().min(1).max(2_000)).default([]),
});
export type ResearchFinding = z.infer<typeof ResearchFindingSchema>;

export const ResearchRunContextSchema = z.object({
  runId: z.string().min(1).max(200),
  correlationId: z.string().min(1).max(200),
  parentRunId: z.string().min(1).max(200).optional(),
  baselineRunId: z.string().min(1).max(200).optional(),
  profileId: z.string().min(1).max(120),
  profileVersion: z.number().int().positive(),
  profileSha256: Sha256Schema,
  briefSha256: Sha256Schema,
  mode: ResearchModeSchema,
  startedAt: IsoTimestampSchema,
  providerManifest: z.array(z.object({
    provider: ProviderNameSchema.or(z.literal('internal')).or(z.literal('manual')),
    version: z.string().max(200).optional(),
    enabled: z.boolean(),
  })).default([]),
});
export type ResearchRunContext = z.infer<typeof ResearchRunContextSchema>;

export interface EvidenceIdentityInput {
  sourceRef: string;
  content: string;
  publishedAt?: string;
}

export function createEvidenceIdentity(input: EvidenceIdentityInput): {
  id: string;
  contentSha256: string;
} {
  const normalizedContent = input.content.replace(/\s+/g, ' ').trim();
  const contentSha256 = createHash('sha256').update(normalizedContent).digest('hex');
  const identity = [input.sourceRef.trim(), input.publishedAt ?? '', contentSha256].join('\n');
  return {
    id: `ev_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`,
    contentSha256,
  };
}

export function createClaimId(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
  return `cl_${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}
