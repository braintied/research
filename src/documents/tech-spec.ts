/**
 * Technical spec / architecture doc type.
 */

import { z } from 'zod';
import { JSON_OUTPUT_INSTRUCTION, type DocTypeDefinition } from './types.js';

export const TechSpecComponentSchema = z.object({
  name: z.string().min(1),
  responsibility: z.string().default(''),
  interfaces: z.array(z.string()).default([]),
});

export const TechSpecTradeoffSchema = z.object({
  decision: z.string().min(1),
  rationale: z.string().default(''),
  alternatives_considered: z.array(z.string()).default([]),
});

export const TechSpecSchema = z.object({
  title: z.string().min(1),
  overview: z.string().min(1),
  goals: z.array(z.string()).default([]),
  non_goals: z.array(z.string()).default([]),
  architecture: z.string().default(''),
  components: z.array(TechSpecComponentSchema).default([]),
  data_model_notes: z.string().default(''),
  tradeoffs: z.array(TechSpecTradeoffSchema).default([]),
  risks: z.array(z.string()).default([]),
  milestones: z.array(z.string()).default([]),
  references: z.array(z.object({
    title: z.string().default(''),
    url: z.string().nullable().default(null),
  })).default([]),
});

export type TechSpec = z.infer<typeof TechSpecSchema>;

export const techSpecDefinition: DocTypeDefinition<typeof TechSpecSchema> = {
  docType: 'tech-spec',
  description: 'Research-informed technical design/architecture document',
  researchKindDefault: 'standard',
  schema: TechSpecSchema,
  systemPrompt:
    'You are a staff engineer writing a technical design doc grounded in research (current best practices, real library capabilities, known pitfalls). State trade-offs honestly; prefer proven patterns from the evidence over speculation.',
  buildUserPrompt: (input) => `Write a technical spec for:

${input.brief}
${input.context !== undefined && input.context !== '' ? `\nAdditional context (codebase, constraints):\n${input.context}\n` : ''}
Research evidence:
${input.researchMarkdown}

Bibliography:
${input.bibliography}

Produce a JSON object with:
- "title"
- "overview": what is being built and why (2-5 sentences)
- "goals": 3-6 goals
- "non_goals": 1-4 explicit non-goals
- "architecture": prose description of the design (data flow, key decisions)
- "components": [{"name", "responsibility", "interfaces": []}]
- "data_model_notes": schema/storage considerations
- "tradeoffs": [{"decision", "rationale", "alternatives_considered": []}]
- "risks": 2-5 technical risks
- "milestones": 2-6 delivery milestones
- "references": [{"title", "url"}] drawn from the bibliography

${JSON_OUTPUT_INSTRUCTION}`,
};
