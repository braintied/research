/**
 * On-disk store for `collectRedditCorpus`: one JSON file per thread under
 * `<dir>/threads/<id>.json`, one per search page under
 * `<dir>/searches/<sha256>.json`. Writes go to a temp file and rename, so a
 * killed run never leaves a half-written thread that a resume would skip.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { RedditCorpusSearchPage, RedditCorpusThread, RedditThreadStore } from './reddit-corpus.js';
import type { RedditPost } from './reddit-client.js';

const THREAD_ID = /^[a-z0-9]+$/i;

const CachedPostSchema = z.object({
  id: z.string(),
  title: z.string(),
  selftext: z.string(),
  permalink: z.string(),
  url: z.string(),
  author: z.string(),
  subreddit: z.string(),
  createdUtc: z.number(),
  created: z.string().optional(),
  ups: z.number(),
  score: z.number(),
  numComments: z.number(),
  externalUrl: z.string().optional(),
  isSelf: z.boolean(),
  linkFlairText: z.string().nullable(),
  over18: z.boolean(),
  quarantine: z.boolean(),
});

const SearchPageSchema = z.object({
  key: z.string(),
  posts: z.array(CachedPostSchema),
  after: z.string().nullable(),
});

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, contents, 'utf8');
  await rename(temp, file);
}

export function createDirectoryThreadStore(dir: string): RedditThreadStore {
  const threadsDir = path.join(dir, 'threads');
  const searchesDir = path.join(dir, 'searches');

  function threadFile(id: string): string {
    if (!THREAD_ID.test(id)) throw new Error(`invalid thread id "${id.slice(0, 40)}"`);
    return path.join(threadsDir, `${id}.json`);
  }

  function searchFile(key: string): string {
    return path.join(searchesDir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  return {
    async hasThread(id) {
      try {
        await stat(threadFile(id));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },

    async writeThread(thread: RedditCorpusThread) {
      await writeAtomic(threadFile(thread.id), `${JSON.stringify(thread)}\n`);
    },

    async readSearch(key) {
      let raw: string;
      try {
        raw = await readFile(searchFile(key), 'utf8');
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      const parsed = SearchPageSchema.safeParse(JSON.parse(raw));
      // A corrupt or foreign page is re-fetched rather than trusted.
      if (!parsed.success || parsed.data.key !== key) return undefined;
      const posts: RedditPost[] = parsed.data.posts;
      return { posts, after: parsed.data.after };
    },

    async writeSearch(key, page: RedditCorpusSearchPage) {
      await writeAtomic(searchFile(key), `${JSON.stringify({ key, posts: page.posts, after: page.after })}\n`);
    },
  };
}
