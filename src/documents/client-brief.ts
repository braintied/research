/**
 * Client brief / proposal doc type — client-facing research brief that feeds
 * SOW/canvas document flows.
 */

import { z } from 'zod';
import { JSON_OUTPUT_INSTRUCTION, type DocTypeDefinition } from './types.js';

export const ClientBriefDeliverableSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
});

export const ClientBriefPhaseSchema = z.object({
  phase: z.string().min(1),
  duration_note: z.string().default(''),
  description: z.string().default(''),
});

export const ClientBriefSchema = z.object({
  title: z.string().min(1),
  client_context: z.string().min(1),
  objectives: z.array(z.string()).default([]),
  scope: z.array(z.object({
    item: z.string().min(1),
    description: z.string().default(''),
  })).default([]),
  approach: z.string().default(''),
  deliverables: z.array(ClientBriefDeliverableSchema).default([]),
  timeline: z.array(ClientBriefPhaseSchema).default([]),
  next_steps: z.array(z.string()).default([]),
  references: z.array(z.object({
    title: z.string().default(''),
    url: z.string().nullable().default(null),
  })).default([]),
});

export type ClientBrief = z.infer<typeof ClientBriefSchema>;

export const clientBriefDefinition: DocTypeDefinition<typeof ClientBriefSchema> = {
  docType: 'client-brief',
  description: 'Client-facing brief/proposal — context, objectives, scope, approach, deliverables, timeline',
  researchKindDefault: 'standard',
  schema: ClientBriefSchema,
  systemPrompt:
    'You are a consulting principal writing a client-facing brief. Professional, concrete, benefit-led. No em dashes. Never overpromise beyond what the research supports; scope items must be specific enough to estimate.',
  buildUserPrompt: (input) => `Write a client brief/proposal for:

${input.brief}
${input.context !== undefined && input.context !== '' ? `\nClient context:\n${input.context}\n` : ''}
Research evidence:
${input.researchMarkdown}

Bibliography:
${input.bibliography}

Produce a JSON object with:
- "title"
- "client_context": the client's situation and why this engagement matters (2-5 sentences)
- "objectives": 3-6 outcomes the engagement targets
- "scope": [{"item", "description"}] — concrete workstreams
- "approach": how the work will be executed (informed by research)
- "deliverables": [{"name", "description"}]
- "timeline": [{"phase", "duration_note", "description"}]
- "next_steps": 2-4 immediate next steps
- "references": [{"title", "url"}] drawn from the bibliography

${JSON_OUTPUT_INSTRUCTION}`,
};
