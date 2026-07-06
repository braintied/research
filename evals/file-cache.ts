/**
 * File-backed ResearchCacheAdapter — persists fetched source content between
 * eval runs so re-running a baseline reuses fetch+extract work (the bulk of
 * the spend) instead of re-crawling. Not for production; eval tooling only.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ResearchCacheAdapter } from '../src/index.js';

interface CacheEntry {
  value: string;
  expiresAtMs: number;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return typeof record['value'] === 'string' && typeof record['expiresAtMs'] === 'number';
}

export class FileCache implements ResearchCacheAdapter {
  private store: Map<string, CacheEntry>;

  constructor(private readonly filePath: string, private readonly nowMs: number) {
    this.store = new Map();
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object') {
          for (const [key, entry] of Object.entries(parsed)) {
            if (isCacheEntry(entry)) {
              this.store.set(key, entry);
            }
          }
        }
      } catch {
        // Corrupt cache file → start empty rather than crash the sweep.
        this.store = new Map();
      }
    }
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAtMs < this.nowMs) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAtMs: this.nowMs + ttlSeconds * 1000 });
  }

  /** Persist the in-memory store to disk. Call once at the end of a sweep. */
  flush(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const obj: Record<string, CacheEntry> = {};
    for (const [key, entry] of this.store.entries()) {
      obj[key] = entry;
    }
    writeFileSync(this.filePath, JSON.stringify(obj), 'utf8');
  }

  get size(): number {
    return this.store.size;
  }
}
