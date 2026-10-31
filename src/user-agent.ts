/**
 * User-Agent for the library's own HTTP lanes (RSS, sitemap, Hacker News).
 *
 * The operator contact is deployment config, not library code. This package
 * never reads the ambient environment, so the host calls
 * `setResearchUserAgentContact('ops@example.com')` once at its process
 * boundary. Unset, the agent names the library and the lane only.
 */
let contact: string | null = null;

export function setResearchUserAgentContact(value: string | null): void {
  const trimmed = value === null ? '' : value.trim();
  contact = trimmed === '' ? null : trimmed;
}

export function researchUserAgent(lane: string): string {
  return contact === null
    ? `OraResearch/1.0 (${lane})`
    : `OraResearch/1.0 (${lane}; contact: ${contact})`;
}
