/**
 * Content brief doc type — formalizes the research-to-content-briefs shape
 * used by the Swishh content pipeline.
 */

import { z } from 'zod';
import { JSON_OUTPUT_INSTRUCTION, type DocTypeDefinition } from './types.js';

export const ContentBriefSectionSchema = z.object({
  heading: z.string().min(1),
  points: z.array(z.string()).default([]),
});

export const ContentBriefSchema = z.object({
  title: z.string().min(1),
  target_audience: z.string().min(1),
  key_message: z.string().min(1),
  outline: z.array(ContentBriefSectionSchema).default([]),
  keywords: z.array(z.string()).default([]),
  tone_notes: z.string().default(''),
  call_to_action: z.string().default(''),
  references: z.array(z.object({
    title: z.string().default(''),
    url: z.string().nullable().default(null),
  })).default([]),
});

export type ContentBrief = z.infer<typeof ContentBriefSchema>;

export const contentBriefDefinition: DocTypeDefinition<typeof ContentBriefSchema> = {
  docType: 'content-brief',
  description: 'Content brief — audience, key message, outline, keywords for a writer or content pipeline',
  researchKindDefault: 'quick',
  schema: ContentBriefSchema,
  systemPrompt:
    'You are a content strategist turning research into a brief a writer can execute without re-research. Audience-first; every outline point should be backed by evidence or verbatim audience voice from the research.',
  buildUserPrompt: (input) => `Write a content brief for:

${input.brief}
${input.context !== undefined && input.context !== '' ? `\nAdditional context (brand, channel):\n${input.context}\n` : ''}
Research evidence:
${input.researchMarkdown}

Bibliography:
${input.bibliography}

Produce a JSON object with:
- "title": working title for the piece
- "target_audience": who this is for and what they already believe
- "key_message": the single takeaway
- "outline": [{"heading", "points": []}]
- "keywords": 5-12 SEO/topic keywords surfaced by the research
- "tone_notes": voice and style guidance
- "call_to_action": what the reader should do next
- "references": [{"title", "url"}] drawn from the bibliography

${JSON_OUTPUT_INSTRUCTION}`,
};
