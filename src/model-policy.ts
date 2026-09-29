/**
 * Research model policy — every stage's model comes only from `@braintied/models`.
 *
 * Hardcoding `gemini-3.1-flash-lite` (or any provider id) at research call sites
 * is the treadmill that produced the 2026-08 canary ApiError when
 * `gemini-2.0-flash` disappeared from the API while still named in code paths.
 *
 * Every stage resolves a **use-case**, and every stage call goes through
 * `callModel` (model-call.ts), which reaches whichever provider the resolution
 * names. The research use-cases therefore carry no `providers` filter: the
 * fleet profile moves them with the rest of the fleet (DeepSeek V4.1 Flash
 * under the `deepseek_flash` default), and a host that must keep data in the
 * US sets `BRAINTIED_DATA_RESIDENCY=us`, which resolves the same weights on
 * Fireworks.
 *
 * Escalation to a stronger model remains available via `synthesisModelOverride`.
 */

import {
  pricing,
  resolveForStyle,
  resolveForUseCase,
  toCostTrackFields,
  type ModelResolution,
} from '@braintied/models';
import type { ResearchCredentials } from './credentials.js';
import { credentialFieldForProvider, providerForModelId } from './model-call.js';

const RESEARCH_MODULE_ID = 'research';

export type ResearchModelStage =
  | 'extract'
  | 'synthesis-answer'
  | 'synthesis-quick'
  | 'synthesis-standard'
  | 'synthesis-deep'
  | 'critique'
  | 'assembly';

/** Per-page quote extraction, planning and categorisation: `research-extract`. */
export function resolveResearchExtractionModel(): string {
  return resolveForUseCase('research-extract', {
    moduleId: RESEARCH_MODULE_ID,
  }).apiModelId;
}

/**
 * Synthesis / assembly / answer defaults by research kind.
 * Callers may still pass `synthesisModelOverride` (validated at request time).
 */
export function resolveResearchSynthesisModel(
  kind: 'answer' | 'quick' | 'standard' | 'deep' | 'social' | 'managed',
): string {
  if (kind === 'deep' || kind === 'social') {
    return resolveForUseCase('research-synthesis-deep', {
      moduleId: RESEARCH_MODULE_ID,
    }).apiModelId;
  }
  if (kind === 'answer' || kind === 'quick') {
    return resolveForUseCase('research-synthesis-quick', {
      moduleId: RESEARCH_MODULE_ID,
    }).apiModelId;
  }
  return resolveForUseCase('research-synthesis', {
    moduleId: RESEARCH_MODULE_ID,
  }).apiModelId;
}

export function resolveResearchCritiqueModel(): string {
  return resolveForUseCase('research-critique', {
    moduleId: RESEARCH_MODULE_ID,
  }).apiModelId;
}

export function resolveResearchAssemblyModel(): string {
  return resolveForUseCase('research-synthesis', {
    moduleId: RESEARCH_MODULE_ID,
  }).apiModelId;
}

/** Catalog unit rates for a resolved wire id (USD per 1M tokens). */
export function researchModelRates(modelId: string): {
  inputUsdPerM: number;
  outputUsdPerM: number;
} {
  const rates = pricing(modelId);
  if (rates === null || rates === undefined) {
    throw new Error(
      `research model rates missing for "${modelId}" — refresh @braintied/models catalog`,
    );
  }
  return {
    inputUsdPerM: rates.inputPer1M,
    outputUsdPerM: rates.outputPer1M,
  };
}

/**
 * The full resolution for a stage. Hand it to `callModel` so the provider,
 * wire id and reasoning effort all come from the same decision.
 */
export function researchStageResolution(stage: ResearchModelStage): ModelResolution {
  switch (stage) {
    case 'extract':
      return resolveForUseCase('research-extract', {
        moduleId: RESEARCH_MODULE_ID,
      });
    case 'critique':
      return resolveForUseCase('research-critique', {
        moduleId: RESEARCH_MODULE_ID,
      });
    case 'synthesis-deep':
      return resolveForUseCase('research-synthesis-deep', {
        moduleId: RESEARCH_MODULE_ID,
      });
    case 'synthesis-answer':
    case 'synthesis-quick':
      return resolveForUseCase('research-synthesis-quick', {
        moduleId: RESEARCH_MODULE_ID,
      });
    case 'synthesis-standard':
    case 'assembly':
      return resolveForUseCase('research-synthesis', {
        moduleId: RESEARCH_MODULE_ID,
      });
    default: {
      const _exhaustive: never = stage;
      throw new Error(`unknown research model stage: ${String(_exhaustive)}`);
    }
  }
}

/** Cost-track fields for ledger attribution on research stages. */
export function researchStageCostFields(stage: ResearchModelStage): ReturnType<typeof toCostTrackFields> {
  return toCostTrackFields(researchStageResolution(stage));
}

/**
 * One model call a research run will make, and the credential it needs.
 * `required: false` marks a call whose failure degrades rather than fails
 * the run: the critique (permissive fallback) and the planner's STRONG
 * fallback (only called when the primary planner fails).
 */
export interface ResearchModelRequirement {
  readonly stage: ResearchModelStage | 'plan-fallback';
  readonly provider: string;
  readonly model: string;
  /** Null when ResearchCredentials has no field for the provider. */
  readonly credentialField: keyof ResearchCredentials | null;
  readonly required: boolean;
}

function requirement(
  stage: ResearchModelRequirement['stage'],
  provider: string,
  model: string,
  required: boolean,
): ResearchModelRequirement {
  return { stage, provider, model, credentialField: credentialFieldForProvider(provider), required };
}

function stageRequirement(stage: ResearchModelStage, required: boolean): ResearchModelRequirement {
  const resolution = researchStageResolution(stage);
  return requirement(stage, resolution.provider, resolution.apiModelId, required);
}

/** A synthesis stage, honouring a caller's override the way the pipeline does. */
function synthesisRequirement(
  stage: ResearchModelStage,
  synthesisModelOverride: string | undefined,
): ResearchModelRequirement {
  if (synthesisModelOverride === undefined || synthesisModelOverride.length === 0) {
    return stageRequirement(stage, true);
  }
  return requirement(stage, providerForModelId(synthesisModelOverride), synthesisModelOverride, true);
}

/**
 * Every model call a run of `kind` makes, from the same resolutions the
 * pipeline uses. A preflight reads this instead of keeping its own table of
 * which key each kind needs, which is how the skill runner went on demanding
 * a Gemini key after the stages moved.
 */
export function researchModelRequirements(
  kind: 'answer' | 'quick' | 'standard' | 'deep' | 'social',
  synthesisModelOverride?: string,
): ResearchModelRequirement[] {
  if (kind === 'answer') {
    return [synthesisRequirement('synthesis-answer', synthesisModelOverride)];
  }
  const synthesisStage: ResearchModelStage = kind === 'quick'
    ? 'synthesis-quick'
    : kind === 'standard'
      ? 'synthesis-standard'
      : 'synthesis-deep';
  const fallback = resolveForStyle('STRONG', { moduleId: RESEARCH_MODULE_ID });
  return [
    stageRequirement('extract', true),
    synthesisRequirement(synthesisStage, synthesisModelOverride),
    synthesisRequirement('assembly', synthesisModelOverride),
    stageRequirement('critique', false),
    requirement('plan-fallback', fallback.provider, fallback.apiModelId, false),
  ];
}
