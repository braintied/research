/**
 * Estimate-research doc type — contractor-oriented (Krue Contractor OS):
 * material pricing, permit/code requirements, and supplier research that
 * feeds a job estimate.
 */

import { z } from 'zod';
import { JSON_OUTPUT_INSTRUCTION, type DocTypeDefinition } from './types.js';

export const EstimateMaterialSchema = z.object({
  item: z.string().min(1),
  spec: z.string().default(''),
  unit: z.string().default(''),
  estimated_unit_cost_usd: z.number().nullable().default(null),
  source_url: z.string().nullable().default(null),
});

export const EstimatePermitSchema = z.object({
  requirement: z.string().min(1),
  jurisdiction_note: z.string().default(''),
  source_url: z.string().nullable().default(null),
});

export const EstimateSupplierSchema = z.object({
  name: z.string().min(1),
  location_note: z.string().default(''),
  note: z.string().default(''),
});

export const EstimateResearchSchema = z.object({
  title: z.string().min(1),
  job_summary: z.string().min(1),
  materials: z.array(EstimateMaterialSchema).default([]),
  labor_considerations: z.array(z.string()).default([]),
  permits_and_codes: z.array(EstimatePermitSchema).default([]),
  suppliers: z.array(EstimateSupplierSchema).default([]),
  risk_factors: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  references: z.array(z.object({
    title: z.string().default(''),
    url: z.string().nullable().default(null),
  })).default([]),
});

export type EstimateResearch = z.infer<typeof EstimateResearchSchema>;

export const estimateResearchDefinition: DocTypeDefinition<typeof EstimateResearchSchema> = {
  docType: 'estimate-research',
  description: 'Contractor estimate research — material pricing, permits/codes, suppliers, risk factors for a job',
  researchKindDefault: 'quick',
  schema: EstimateResearchSchema,
  systemPrompt:
    'You are an experienced construction estimator researching a job. Prices must come from the research evidence — when the evidence lacks a price, set estimated_unit_cost_usd to null rather than guessing. Note jurisdiction-specific permit requirements explicitly; call out assumptions.',
  buildUserPrompt: (input) => `Research this job for an estimate:

${input.brief}
${input.context !== undefined && input.context !== '' ? `\nJob context (location, scope, client notes):\n${input.context}\n` : ''}
Research evidence:
${input.researchMarkdown}

Bibliography:
${input.bibliography}

Produce a JSON object with:
- "title"
- "job_summary": what the job involves (2-4 sentences)
- "materials": [{"item", "spec", "unit", "estimated_unit_cost_usd" (number or null), "source_url" (url or null)}]
- "labor_considerations": crew, skill, sequencing notes
- "permits_and_codes": [{"requirement", "jurisdiction_note", "source_url"}]
- "suppliers": [{"name", "location_note", "note"}]
- "risk_factors": 2-6 things that could blow the estimate
- "assumptions": explicit assumptions made
- "references": [{"title", "url"}] drawn from the bibliography

${JSON_OUTPUT_INSTRUCTION}`,
};
