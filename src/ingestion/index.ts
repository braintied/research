/**
 * @swishh/research — Knowledge-Ingestion core (storage-agnostic).
 *
 * Pipeline: ingestSource() → categorizeItems() → embedItems().
 * The core returns plain IngestedItem[] data; the consuming app persists it.
 */

export * from './types.js';
export { ingestSource } from './ingest-source.js';
export { categorizeItems } from './categorize.js';
export { embedItems } from './embed-items.js';
