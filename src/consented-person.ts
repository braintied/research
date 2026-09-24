/**
 * Running `consented-person@1`.
 *
 * The profile in `profiles/consented-person.ts` is the contract. This is the
 * execution, and its whole job is the three refusals a person-subject lookup
 * needs before a single search is paid for:
 *
 *   1. no consent row for `source:web_research` → refuse;
 *   2. no approved budget → refuse;
 *   3. no anchors the person supplied → refuse.
 *
 * And the one after: every returned item is checked against the anchors and
 * the data-broker denylist, so a namesake's page and a broker's dossier are
 * dropped rather than shown to the person as something we found about them.
 *
 * The per-subject cost ceiling is the APPROVED BUDGET — `@braintied/on-demand`'s
 * `OnDemandApproval`, whose `approvedMaxCostUsd` is passed straight through to
 * the pipeline's existing `maxCostUsd` cap. There is no new cap field: a
 * number the runner reads and the pipeline does not is a lie told to whoever
 * reads the config, and `~/.agents/rules/research.md` already names the one
 * ladder (estimate → approve → run). An optional `spendGate` lets a host put
 * `@braintied/pricing/gate`'s account and capability allowances in front of
 * that, so a per-person ceiling and a pilot-wide ceiling are the same gate
 * rather than two that do not know about each other.
 *
 * There is deliberately no `ON_DEMAND_REQUIRE_APPROVAL=0` bypass. This package
 * reads no environment at all (`test/no-direct-env.test.ts`), and an env var
 * that turns off budget approval for a run against a named human is the wrong
 * thing to have available.
 *
 * Namesake resolution is INJECTED, not imported. `@braintied/entity-resolution`
 * depends on `@supabase/supabase-js`, and putting a database client inside a
 * third-party-safe engine to reach two pure name functions is the wrong trade;
 * ora-ai's image dependency-security gate would see it too. The default
 * `anchorMatch` below is exact-anchor matching and fails closed, and a host
 * that wants fuzzier scoring passes `entity-resolution`'s `namesMatch` in.
 */

import { requireSourceConsent, type ConsentProof } from './consent-gate.js';
import type { EvidenceItem } from './evidence.js';
import { DATA_BROKER_DENYLIST, isDeniedSource } from './profiles/consented-person.js';
import { logger } from './logger.js';
import type { ResearchProgramResult, RunResearchProgramInput } from './research-program.js';

/** The consent purpose a caller must hold before this program will run. */
export const CONSENTED_PERSON_PURPOSE = 'source:web_research';

/** The profile ref this program executes. Stable across hosts. */
export const CONSENTED_PERSON_PROFILE_REF = 'consented-person@1';

/**
 * What the person themselves supplied, and the only thing a returned item may
 * be tied to.
 *
 * `name` is required because a lookup with no name is not a lookup of a
 * person. Everything else is optional and at least one of them must be
 * present: a name alone matches every namesake, which is the failure the
 * anchor check exists to prevent.
 */
export interface SubjectAnchors {
  readonly name: string;
  /** Sites, profiles and handles the person said are theirs. */
  readonly urls?: readonly string[];
  /** Handles without a platform URL, e.g. `@someone`. */
  readonly handles?: readonly string[];
  /** City or region, never a street address. */
  readonly city?: string;
  /** Employer, school, band, label — whatever they named. */
  readonly affiliations?: readonly string[];
}

/** Why an anchor set was refused. */
export type AnchorRefusal = 'no_name' | 'name_only';

export class SubjectAnchorsRequiredError extends Error {
  constructor(public readonly reason: AnchorRefusal) {
    super(
      reason === 'no_name'
        ? 'consented-person@1 requires the subject\'s name'
        : 'consented-person@1 requires at least one anchor besides the name '
          + '(a link, handle, city, or affiliation the person supplied). A name '
          + 'alone matches every namesake.',
    );
    this.name = 'SubjectAnchorsRequiredError';
  }
}

/**
 * The approved budget. Structurally `@braintied/on-demand`'s
 * `OnDemandApproval`, so a host passes the record it already minted; the
 * fields below are the ones this runner reads.
 */
export interface ApprovedBudget {
  readonly proposalId: string;
  readonly estimatedCostUsd: number;
  /** The per-subject ceiling for this run, in USD. */
  readonly approvedMaxCostUsd: number;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export type BudgetRefusal =
  | 'missing'
  | 'not_positive'
  | 'below_estimate'
  | 'no_approver';

export class ApprovedBudgetRequiredError extends Error {
  constructor(public readonly reason: BudgetRefusal, detail?: string) {
    super(
      `consented-person@1 will not start without an approved budget: ${reason}`
      + `${detail !== undefined ? ` (${detail})` : ''}`,
    );
    this.name = 'ApprovedBudgetRequiredError';
  }
}

/**
 * `@braintied/pricing/gate`'s answer, structurally. A host wires
 * `allows({ catalog, ledger, accountId, planId, capabilityId })` and hands the
 * decision here; this package owns no ledger and opens no connection.
 */
export type SpendGateDecision =
  | { readonly allowed: true; readonly remainingUsd: number }
  | { readonly allowed: false; readonly reason: string; readonly remainingUsd: number };

export class SpendGateRefusedError extends Error {
  constructor(public readonly reason: string, public readonly remainingUsd: number) {
    super(`consented-person@1 refused by the spend gate: ${reason} (remaining $${remainingUsd})`);
    this.name = 'SpendGateRefusedError';
  }
}

/**
 * Does this item belong to the person who asked?
 *
 * Returns the anchor it matched, or null. Null means dropped: the item is
 * reported as unresolved rather than shown as a finding about them.
 */
export type AnchorMatcher = (
  item: EvidenceItem,
  anchors: SubjectAnchors,
) => string | null;

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function itemHaystack(item: EvidenceItem): string {
  return normalizeText([
    item.title,
    item.author ?? '',
    item.exactQuote ?? '',
    item.sourceRef,
  ].join('\n'));
}

/**
 * Exact-anchor matching, failing closed.
 *
 * An item matches when its host is one the person named, or when its text
 * carries the person's name AND one further anchor (a handle, their city, or
 * an affiliation). Name-only is never a match, which is the whole point: the
 * pages about a different person with the same name are exactly the ones that
 * carry the name and nothing else.
 *
 * Deliberately not a similarity score. A threshold here would be a number
 * chosen to be wrong in one direction, and `~/.agents/rules/research.md`
 * already records the measurement that the noise ceiling sits above the
 * weakest true positive. A host that wants fuzzy name handling injects
 * `@braintied/entity-resolution`.
 */
export const anchorMatch: AnchorMatcher = (item, anchors) => {
  const ownHosts = new Set<string>();
  for (const url of anchors.urls ?? []) {
    const host = hostOf(url);
    if (host !== null) ownHosts.add(host);
  }
  const itemHost = item.canonicalUrl !== undefined
    ? hostOf(item.canonicalUrl)
    : hostOf(item.sourceRef);
  if (itemHost !== null && ownHosts.has(itemHost)) return `url:${itemHost}`;

  const haystack = itemHaystack(item);
  const name = normalizeText(anchors.name);
  if (name.length === 0 || !haystack.includes(name)) return null;

  for (const handle of anchors.handles ?? []) {
    const needle = normalizeText(handle).replace(/^@/, '');
    if (needle.length > 1 && haystack.includes(needle)) return `handle:${needle}`;
  }
  for (const affiliation of anchors.affiliations ?? []) {
    const needle = normalizeText(affiliation);
    if (needle.length > 2 && haystack.includes(needle)) return `affiliation:${needle}`;
  }
  if (anchors.city !== undefined) {
    const needle = normalizeText(anchors.city);
    if (needle.length > 2 && haystack.includes(needle)) return `city:${needle}`;
  }
  return null;
};

export interface RunConsentedPersonInput {
  /**
   * The consent row from `@braintied/consent`'s
   * `requireConsent(current, 'source:web_research', scope)`.
   */
  readonly consent: ConsentProof;
  readonly anchors: SubjectAnchors;
  readonly budget: ApprovedBudget;
  /**
   * `@braintied/pricing/gate`'s decision, evaluated by the host before this
   * call. Absent means the host declared no account ceiling for this run; the
   * approved budget still applies.
   */
  readonly spendGate?: SpendGateDecision;
  /** Overrides `anchorMatch`. Wire `@braintied/entity-resolution` here. */
  readonly matcher?: AnchorMatcher;
  /**
   * The program runner. Injected so this module is testable without a
   * provider and so a host can wrap it in its own durable execution.
   */
  readonly runProgram: (input: RunResearchProgramInput) => Promise<ResearchProgramResult>;
  /** Everything the program runner needs that is not decided here. */
  readonly program: Omit<
    RunResearchProgramInput,
    'brief' | 'profileRef' | 'profileMode' | 'maxCostUsd' | 'indexSink'
  >;
}

/** One item that could not be tied to the subject, kept so the run can say so. */
export interface UnresolvedItem {
  readonly sourceRef: string;
  readonly title: string;
  readonly reason: 'no_anchor_match' | 'denied_source';
}

export interface ConsentedPersonResult {
  readonly profileRef: string;
  /** Items tied to the subject, each carrying its source URL. */
  readonly evidence: readonly EvidenceItem[];
  /** Dropped items, reported rather than silently discarded. */
  readonly unresolved: readonly UnresolvedItem[];
  readonly costUsd: number;
  readonly budget: ApprovedBudget;
  readonly consentRecordUri: string;
  readonly status: ResearchProgramResult['status'];
}

function assertBudget(budget: ApprovedBudget | null | undefined): ApprovedBudget {
  if (budget === null || budget === undefined) {
    throw new ApprovedBudgetRequiredError('missing');
  }
  if (!Number.isFinite(budget.approvedMaxCostUsd) || budget.approvedMaxCostUsd <= 0) {
    throw new ApprovedBudgetRequiredError(
      'not_positive',
      `approvedMaxCostUsd is ${String(budget.approvedMaxCostUsd)}`,
    );
  }
  // Same comparison as `@braintied/on-demand`'s `assertBudgetCoversEstimate`,
  // including its float tolerance, so a host using both cannot get two answers.
  if (budget.approvedMaxCostUsd + 1e-9 < budget.estimatedCostUsd) {
    throw new ApprovedBudgetRequiredError(
      'below_estimate',
      `approved $${budget.approvedMaxCostUsd} is below estimate $${budget.estimatedCostUsd}`,
    );
  }
  if (budget.approvedBy.trim().length === 0) {
    throw new ApprovedBudgetRequiredError('no_approver');
  }
  return budget;
}

export function assertAnchors(anchors: SubjectAnchors): SubjectAnchors {
  if (anchors.name.trim().length === 0) throw new SubjectAnchorsRequiredError('no_name');
  const hasSecond = (anchors.urls ?? []).some((url) => url.trim().length > 0)
    || (anchors.handles ?? []).some((handle) => handle.trim().length > 0)
    || (anchors.affiliations ?? []).some((value) => value.trim().length > 0)
    || (anchors.city !== undefined && anchors.city.trim().length > 0);
  if (!hasSecond) throw new SubjectAnchorsRequiredError('name_only');
  return anchors;
}

/**
 * The outbound brief, built from the person's own anchors and nothing else.
 *
 * Their anchors are the query, so there is no place for a caller to inject a
 * question about a third party: this function takes no free-text question.
 */
export function consentedPersonBrief(anchors: SubjectAnchors): string {
  const lines = [
    `Look up ${anchors.name.trim()}, who asked to be looked up.`,
    '',
    'Anchors this person supplied. Every item you return must tie to one of them:',
    `- name: ${anchors.name.trim()}`,
  ];
  for (const url of anchors.urls ?? []) {
    if (url.trim().length > 0) lines.push(`- their link: ${url.trim()}`);
  }
  for (const handle of anchors.handles ?? []) {
    if (handle.trim().length > 0) lines.push(`- their handle: ${handle.trim()}`);
  }
  for (const affiliation of anchors.affiliations ?? []) {
    if (affiliation.trim().length > 0) lines.push(`- they mentioned: ${affiliation.trim()}`);
  }
  if (anchors.city !== undefined && anchors.city.trim().length > 0) {
    lines.push(`- city or region: ${anchors.city.trim()}`);
  }
  lines.push(
    '',
    'Return what their own pages and direct quotes say about their work, each with',
    'its link. Drop anything you cannot tie to an anchor above and say that you',
    'dropped it.',
  );
  return lines.join('\n');
}

/**
 * Run `consented-person@1` for one subject.
 *
 * @throws ConsentProofRequiredError      no current `source:web_research` grant
 * @throws ApprovedBudgetRequiredError    no approved budget, or one below the estimate
 * @throws SubjectAnchorsRequiredError    a name with nothing to anchor it to
 * @throws SpendGateRefusedError          the host's ledger gate said no
 */
export async function runConsentedPersonResearch(
  input: RunConsentedPersonInput,
): Promise<ConsentedPersonResult> {
  const consent = requireSourceConsent(input.consent, CONSENTED_PERSON_PURPOSE);
  const budget = assertBudget(input.budget);
  const anchors = assertAnchors(input.anchors);

  if (input.spendGate !== undefined && !input.spendGate.allowed) {
    throw new SpendGateRefusedError(input.spendGate.reason, input.spendGate.remainingUsd);
  }

  // The gate's remaining headroom binds the run when it is tighter than the
  // approved budget. Taking the looser of two ceilings is how Sentigen ended
  // up with two limits and no bound.
  const ceilingUsd = input.spendGate !== undefined
    ? Math.min(budget.approvedMaxCostUsd, input.spendGate.remainingUsd)
    : budget.approvedMaxCostUsd;

  const result = await input.runProgram({
    ...input.program,
    brief: consentedPersonBrief(anchors),
    profileRef: CONSENTED_PERSON_PROFILE_REF,
    profileMode: 'snapshot',
    maxCostUsd: ceilingUsd,
    // No index sink. A consented lookup of one person is not corpus the fleet
    // keeps: `dataBoundary` covers the inbound half, this covers the outbound.
  });

  const matcher = input.matcher !== undefined ? input.matcher : anchorMatch;
  const evidence: EvidenceItem[] = [];
  const unresolved: UnresolvedItem[] = [];

  for (const item of result.publicEvidence) {
    // Re-checked after the fact: `excludeDomains` is a request to a search
    // provider, and a provider that ignores it fails silently.
    const ref = item.canonicalUrl !== undefined ? item.canonicalUrl : item.sourceRef;
    if (isDeniedSource(ref)) {
      unresolved.push({ sourceRef: ref, title: item.title, reason: 'denied_source' });
      continue;
    }
    const matched = matcher(item, anchors);
    if (matched === null) {
      unresolved.push({ sourceRef: ref, title: item.title, reason: 'no_anchor_match' });
      continue;
    }
    evidence.push({
      ...item,
      metadata: { ...item.metadata, anchorMatched: matched, subjectConsented: true },
    });
  }

  logger.info(
    {
      profileRef: CONSENTED_PERSON_PROFILE_REF,
      kept: evidence.length,
      dropped: unresolved.length,
      costUsd: result.costUsd,
      ceilingUsd,
      denylistSize: DATA_BROKER_DENYLIST.length,
      proposalId: budget.proposalId,
    },
    '[consented-person] run complete',
  );

  return {
    profileRef: CONSENTED_PERSON_PROFILE_REF,
    evidence,
    unresolved,
    costUsd: result.costUsd,
    budget,
    consentRecordUri: consent.recordUri,
    status: result.status,
  };
}
