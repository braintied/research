/**
 * Research model policy — wire ids come only from `@braintied/models`.
 *
 * Hardcoding `gemini-3.1-flash-lite` (or any provider id) at research call sites
 * is the treadmill that produced the 2026-08 canary ApiError when
 * `gemini-2.0-flash` disappeared from the API while still named in code paths.
 *
 * Every stage resolves a **use-case**. Research use-cases declare
 * `providers: ['google']` so the role ladder never lands on DeepSeek-first cheap
 * (or Sonnet when Anthropic is invalid). Refreshing the models catalog moves
 * research with the rest of the fleet.
 *
 * Escalation to Sonnet remains available via `synthesisModelOverride` when that
 * provider key is valid and the brief warrants STRONG judgment spend.
 */

import {
  pricing,
  resolveForUseCase,
  toCostTrackFields,
  type ModelResolution,
} from '@braintied/models';

const RESEARCH_MODULE_ID = 'research';

export type ResearchModelStage =
  | 'extract'
  | 'synthesis-answer'
  | 'synthesis-quick'
  | 'synthesis-standard'
  | 'synthesis-deep'
  | 'critique'
  | 'assembly';

/**
 * Volume quote extraction is Gemini-native today (extractQuotesWithGemini).
 * `research-extract` is MICRO + google on the models use-case registry.
 */
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

function resolveStage(stage: ResearchModelStage): ModelResolution {
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
  return toCostTrackFields(resolveStage(stage));
}
