/**
 * Deep-Research Cost Tracker
 *
 * Accumulates CostEntry records during a prompt run and exposes helpers
 * for cap enforcement and per-category breakdown.
 */

import { computeTotalCost } from './types.js';
import type { CostEntry } from './types.js';

export class CostTracker {
  private readonly entries: CostEntry[] = [];
  private readonly capUsd: number;

  constructor(capUsd: number = 10) {
    this.capUsd = capUsd;
  }

  record(entry: CostEntry): void {
    this.entries.push(entry);
  }

  /**
   * Bulk-record entries returned from a step.run boundary. Used by the
   * Inngest-replay-safe pattern: cost-emitting steps accumulate entries
   * locally and return them; the outer scope (which re-runs on every
   * Inngest replay from memoized step returns) calls recordMany() so the
   * tracker rebuilds correctly even when step bodies are not re-executed.
   */
  recordMany(entries: CostEntry[]): void {
    for (const e of entries) this.entries.push(e);
  }

  total(): number {
    return computeTotalCost(this.entries);
  }

  exceedsCap(): boolean {
    return this.total() > this.capUsd;
  }

  byCategory(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const entry of this.entries) {
      const current = result[entry.category];
      const cost = entry.units * entry.unit_cost_usd;
      result[entry.category] = current !== undefined ? current + cost : cost;
    }
    return result;
  }

  /**
   * Roll up spend by `metadata.model`. Entries without a model in metadata
   * (search, fetch, embed) are bucketed under '__no_model__' so totals match.
   * Phase 1 Experiment 1 — bake-off comparison view depends on this.
   */
  byModel(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const entry of this.entries) {
      const modelRaw = entry.metadata['model'];
      const key = typeof modelRaw === 'string' && modelRaw.length > 0 ? modelRaw : '__no_model__';
      const current = result[key];
      const cost = entry.units * entry.unit_cost_usd;
      result[key] = current !== undefined ? current + cost : cost;
    }
    return result;
  }

  allEntries(): CostEntry[] {
    return [...this.entries];
  }
}
