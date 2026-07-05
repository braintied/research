/**
 * PRD doc type — product requirements document from research.
 *
 * Ported/adapted from ora-ai Watchtower's prd-generator.ts (which used simple
 * Tavily aggregation); this version consumes the grounded research report and
 * validates with Zod instead of a bare JSON.parse cast.
 */

import { z } from 'zod';
import { JSON_OUTPUT_INSTRUCTION, type DocTypeDefinition } from './types.js';

export const PrdTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  priority: z.number().int().min(1).max(5).default(3),
  depends_on: z.array(z.string()).default([]),
});

export const PrdSchema = z.object({
  title: z.string().min(1),
  problem: z.string().min(1),
  solution: z.string().min(1),
  approach: z.string().default(''),
  user_stories: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  tasks: z.array(PrdTaskSchema).default([]),
  risks: z.array(z.string()).default([]),
  references: z.array(z.object({
    title: z.string().default(''),
    url: z.string().nullable().default(null),
  })).default([]),
  estimated_complexity: z.enum(['low', 'medium', 'high']).default('medium'),
});

export type Prd = z.infer<typeof PrdSchema>;

export const prdDefinition: DocTypeDefinition<typeof PrdSchema> = {
  docType: 'prd',
  description: 'Product requirements document — problem, solution, user stories, tasks, acceptance criteria',
  researchKindDefault: 'standard',
  schema: PrdSchema,
  systemPrompt:
    'You are a senior product manager writing a PRD grounded in research evidence. Be specific and testable — vague requirements are useless. Prefer the research findings over general knowledge; cite sources in references.',
  buildUserPrompt: (input) => `Write a PRD for the following:

${input.brief}
${input.context !== undefined && input.context !== '' ? `\nAdditional context:\n${input.context}\n` : ''}
Research evidence:
${input.researchMarkdown}

Bibliography:
${input.bibliography}

Produce a JSON object with:
- "title": concise PRD title
- "problem": what problem this solves and for whom (2-4 sentences)
- "solution": the proposed solution (2-4 sentences)
- "approach": technical/product approach informed by the research (2-6 sentences; name specific technologies, patterns, or competitor moves the evidence supports)
- "user_stories": 3-8 "As a … I want … so that …" stories
- "acceptance_criteria": 3-8 testable criteria
- "tasks": implementation subtasks [{"title", "description", "priority" 1-5, "depends_on": [task titles]}]
- "risks": 2-5 risks or open questions
- "references": [{"title", "url"}] drawn from the bibliography
- "estimated_complexity": "low" | "medium" | "high"

${JSON_OUTPUT_INSTRUCTION}`,
};
