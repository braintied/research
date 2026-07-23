import type { EvidenceItem } from '../evidence.js';
import type { CoverageRequirement, ResearchProfile } from './types.js';

export interface CoverageRequirementResult {
  id: string;
  required: boolean;
  passed: boolean;
  evidenceCount: number;
  uniqueSourceCount: number;
  uniqueAuthorCount: number;
  staleEvidenceCount: number;
  futureEvidenceCount: number;
  undatedEvidenceCount: number;
  reasons: string[];
}

export interface CoverageReport {
  profileRef: string;
  asOf: string;
  passed: boolean;
  requirements: CoverageRequirementResult[];
  missingRequiredRequirementIds: string[];
}

function ageDays(timestamp: string, asOf: Date): number {
  return Math.floor((asOf.getTime() - new Date(timestamp).getTime()) / 86_400_000);
}

function evidenceForRequirement(requirement: CoverageRequirement, evidence: EvidenceItem[], asOf: Date) {
  const matching = evidence.filter((item) => requirement.sourcePackIds.includes(item.sourcePackId));
  let stale = 0;
  let future = 0;
  let undated = 0;
  const eligible = matching.filter((item) => {
    if (item.publishedAt === undefined) {
      undated += 1;
      return requirement.allowUndated;
    }
    const age = ageDays(item.publishedAt, asOf);
    if (age < 0) {
      future += 1;
      return false;
    }
    if (requirement.maxAgeDays !== undefined && age > requirement.maxAgeDays) {
      stale += 1;
      return false;
    }
    return true;
  });
  return { eligible, stale, future, undated };
}

export function evaluateCoverage(
  profile: ResearchProfile,
  evidence: EvidenceItem[],
  asOfInput: string | Date,
): CoverageReport {
  const asOf = typeof asOfInput === 'string'
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(asOfInput) ? `${asOfInput}T23:59:59.999Z` : asOfInput)
    : asOfInput;
  if (Number.isNaN(asOf.getTime())) throw new Error('Coverage asOf must be a valid date.');

  const requirements = profile.coverageRequirements.map((requirement): CoverageRequirementResult => {
    const { eligible, stale, future, undated } = evidenceForRequirement(requirement, evidence, asOf);
    const sources = new Set(eligible.map((item) => item.canonicalUrl ?? item.sourceRef));
    const authors = new Set(eligible.map((item) => item.author?.trim()).filter((author): author is string => author !== undefined && author.length > 0));
    const failures: string[] = [];
    const notes: string[] = [];

    if (eligible.length < requirement.minimumEvidence) failures.push(`needs ${requirement.minimumEvidence} evidence items; found ${eligible.length}`);
    if (sources.size < requirement.minimumUniqueSources) failures.push(`needs ${requirement.minimumUniqueSources} unique sources; found ${sources.size}`);
    if (authors.size < requirement.minimumUniqueAuthors) failures.push(`needs ${requirement.minimumUniqueAuthors} unique authors; found ${authors.size}`);
    if (!requirement.allowUndated && undated > 0) notes.push(`${undated} undated evidence item(s) were excluded`);
    if (stale > 0) notes.push(`${stale} stale evidence item(s) were excluded`);
    if (future > 0) notes.push(`${future} evidence item(s) newer than the as-of boundary were excluded`);

    return {
      id: requirement.id, required: requirement.required, passed: failures.length === 0,
      evidenceCount: eligible.length, uniqueSourceCount: sources.size,
      uniqueAuthorCount: authors.size, staleEvidenceCount: stale,
      futureEvidenceCount: future,
      undatedEvidenceCount: undated, reasons: [...failures, ...notes],
    };
  });

  const missingRequiredRequirementIds = requirements
    .filter((requirement) => requirement.required && !requirement.passed)
    .map((requirement) => requirement.id);
  return {
    profileRef: `${profile.id}@${profile.version}`,
    asOf: asOf.toISOString(),
    passed: missingRequiredRequirementIds.length === 0,
    requirements,
    missingRequiredRequirementIds,
  };
}
