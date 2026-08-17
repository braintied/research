/**
 * YC portfolio provider — public yc-oss API
 * (https://yc-oss.github.io/api/companies/all.json, maintained by the
 * YC OSS community; no key required, CORS-open, ~6,000 companies).
 *
 * Maps the full company list to typed `YcCompany` records. The list endpoint
 * does not expose founder names (the per-company `api` detail URLs may) —
 * fields the API does not provide are omitted, never invented. Each record
 * keeps the full Zod-validated payload on `raw` for future re-extraction.
 */

import { z } from 'zod';
import { logger } from '../logger.js';

// =============================================================================
// API schema (verified against all.json 2026-07-26)
// =============================================================================

const YcApiCompanySchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  batch: z.string().default(''),
  status: z.string().default(''),
  one_liner: z.string().nullish(),
  long_description: z.string().nullish(),
  website: z.string().nullish(),
  all_locations: z.string().nullish(),
  industry: z.string().nullish(),
  subindustry: z.string().nullish(),
  industries: z.array(z.string()).nullish(),
  tags: z.array(z.string()).nullish(),
  regions: z.array(z.string()).nullish(),
  stage: z.string().nullish(),
  team_size: z.number().nullish(),
  launched_at: z.number().nullish(),
  top_company: z.boolean().nullish(),
  isHiring: z.boolean().nullish(),
  nonprofit: z.boolean().nullish(),
  small_logo_thumb_url: z.string().nullish(),
  url: z.string().nullish(),
  api: z.string().nullish(),
});

const YcApiResponseSchema = z.array(YcApiCompanySchema);

type YcApiCompany = z.infer<typeof YcApiCompanySchema>;

// =============================================================================
// Public type
// =============================================================================

export interface YcCompany {
  ycId: number;
  name: string;
  slug: string;
  batch: string;
  status: string;
  oneLiner: string | undefined;
  description: string | undefined;
  website: string | undefined;
  /** YC's industry ladder (e.g. ["B2B", "Analytics"]). */
  sectors: string[];
  /** Free-form tags (e.g. ["SaaS", "AI"]). */
  tags: string[];
  location: string | undefined;
  regions: string[];
  /** Derived from launched_at (UTC year); undefined when the API omits it. */
  foundedYear: number | undefined;
  /** ISO 8601 launch date; undefined when the API omits launched_at. */
  launchedAt: string | undefined;
  teamSize: number | undefined;
  industry: string | undefined;
  subindustry: string | undefined;
  stage: string | undefined;
  topCompany: boolean;
  isHiring: boolean;
  nonprofit: boolean;
  smallLogoThumbUrl: string | undefined;
  ycUrl: string | undefined;
  apiUrl: string | undefined;
  /** The full Zod-validated API record, preserved for future re-extraction. */
  raw: unknown;
}

// =============================================================================
// Mapping
// =============================================================================

function emptyToUndefined(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

function toYcCompany(record: YcApiCompany): YcCompany {
  let launchedAt: string | undefined;
  let foundedYear: number | undefined;
  if (record.launched_at !== null && record.launched_at !== undefined && record.launched_at > 0) {
    const date = new Date(record.launched_at * 1000);
    if (!Number.isNaN(date.getTime())) {
      launchedAt = date.toISOString();
      foundedYear = date.getUTCFullYear();
    }
  }

  return {
    ycId: record.id,
    name: record.name,
    slug: record.slug,
    batch: record.batch,
    status: record.status,
    oneLiner: emptyToUndefined(record.one_liner),
    description: emptyToUndefined(record.long_description),
    website: emptyToUndefined(record.website),
    sectors: record.industries !== null && record.industries !== undefined ? record.industries : [],
    tags: record.tags !== null && record.tags !== undefined ? record.tags : [],
    location: emptyToUndefined(record.all_locations),
    regions: record.regions !== null && record.regions !== undefined ? record.regions : [],
    foundedYear,
    launchedAt,
    teamSize: record.team_size !== null && record.team_size !== undefined ? record.team_size : undefined,
    industry: emptyToUndefined(record.industry),
    subindustry: emptyToUndefined(record.subindustry),
    stage: emptyToUndefined(record.stage),
    topCompany: record.top_company === true,
    isHiring: record.isHiring === true,
    nonprofit: record.nonprofit === true,
    smallLogoThumbUrl: emptyToUndefined(record.small_logo_thumb_url),
    ycUrl: emptyToUndefined(record.url),
    apiUrl: emptyToUndefined(record.api),
    raw: record,
  };
}

// =============================================================================
// Public API
// =============================================================================

const YC_OSS_ALL_COMPANIES_URL = 'https://yc-oss.github.io/api/companies/all.json';

/** Fetch the full YC portfolio (~6,000 companies) from the public yc-oss API. */
export async function fetchYcPortfolio(): Promise<YcCompany[]> {
  const response = await fetch(YC_OSS_ALL_COMPANIES_URL, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`yc-oss companies fetch failed: ${response.status}`);
  }

  const rawJson: unknown = await response.json();
  const parsed = YcApiResponseSchema.parse(rawJson);
  const companies = parsed.map(toYcCompany);

  logger.info({ count: companies.length }, '[YcPortfolio] Fetched YC company list');
  return companies;
}
