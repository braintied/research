/**
 * Market/competitive research report doc type.
 */

import { z } from 'zod';
import { JSON_OUTPUT_INSTRUCTION, type DocTypeDefinition } from './types.js';

export const CompetitorSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  pricing_note: z.string().default(''),
});

export const MarketReportSchema = z.object({
  title: z.string().min(1),
  executive_summary: z.string().min(1),
  market_overview: z.string().default(''),
  competitors: z.array(CompetitorSchema).default([]),
  trends: z.array(z.string()).default([]),
  opportunities: z.array(z.string()).default([]),
  threats: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
  references: z.array(z.object({
    title: z.string().default(''),
    url: z.string().nullable().default(null),
  })).default([]),
});

export type MarketReport = z.infer<typeof MarketReportSchema>;

export const marketReportDefinition: DocTypeDefinition<typeof MarketReportSchema> = {
  docType: 'market-report',
  description: 'Cited market/competitive research report — landscape, trends, SWOT-style analysis, recommendations',
  researchKindDefault: 'deep',
  schema: MarketReportSchema,
  systemPrompt:
    'You are a market analyst producing a cited competitive report. Every competitive claim must trace to the research evidence — never invent market share, pricing, or funding figures. Flag uncertainty explicitly.',
  buildUserPrompt: (input) => `Write a market/competitive research report on:

${input.brief}
${input.context !== undefined && input.context !== '' ? `\nAdditional context:\n${input.context}\n` : ''}
Research evidence:
${input.researchMarkdown}

Bibliography:
${input.bibliography}

Produce a JSON object with:
- "title"
- "executive_summary": 3-6 sentence summary of the landscape and headline recommendation
- "market_overview": market definition, size signals, dynamics (grounded in evidence)
- "competitors": [{"name", "description", "strengths": [], "weaknesses": [], "pricing_note"}]
- "trends": 3-8 evidenced trends
- "opportunities": 2-6
- "threats": 2-6
- "recommendations": 3-6 concrete, prioritized recommendations
- "references": [{"title", "url"}] drawn from the bibliography

${JSON_OUTPUT_INSTRUCTION}`,
};
