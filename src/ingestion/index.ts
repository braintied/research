/**
 * @swishh/research — Knowledge-Ingestion core (storage-agnostic).
 *
 * Pipeline: ingestSource() → categorizeItems() → embedItems().
 * The core returns plain IngestedItem[] data; the consuming app persists it.
 */

export * from './types.js';
export { ingestSource } from './ingest-source.js';
export {
  categorizeItems,
  CategorizeTaxonomyError,
  CONTRACTOR_TAXONOMY,
  type CategorizeTaxonomy,
} from './categorize.js';
export { embedItems } from './embed-items.js';
export { buildIngestedItem, toExcerpt } from './build-item.js';
export type { BuildItemInput } from './build-item.js';
export { ingestCatalog, parseCatalogConfig, listSitemapPages } from './catalog.js';
export type { CatalogConfig, CatalogDependencies, CatalogIngestOptions, CatalogIngestResult } from './catalog.js';
