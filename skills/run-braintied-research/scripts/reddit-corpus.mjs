#!/usr/bin/env node
/**
 * Reddit corpus runner: subreddits x queries -> one JSON file per thread with
 * the full comment tree, through @braintied/research's OAuth Reddit client.
 *
 * Unauthenticated Reddit answers HTTP 403. This runner never scrapes it and
 * never falls back to web search: missing credentials exit 2 before any
 * request is made.
 */

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs';
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseAllowlistedEnvFile } from './research-env-file.mjs';

const REDDIT_ENV = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'];
const SEARCH_SORTS = new Set(['relevance', 'hot', 'top', 'new', 'comments']);
const TIME_FILTERS = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);
const COMMENT_MODES = new Set(['none', 'top', 'full']);
const COMMENT_SORTS = new Set(['confidence', 'top', 'new', 'controversial', 'old', 'qa']);

const USAGE = `Usage:
  reddit-corpus.mjs collect --subs <csv> (--query <q> ... | --queries-file <path>) --out <dir> [options]
  reddit-corpus.mjs discover --topic <t> ... [--per-topic 25] [--min-subscribers 1000] [--out <file.json>]
  reddit-corpus.mjs check

collect options:
  --subs <csv>              Subreddits (with or without r/)
  --subs-file <path>        One subreddit per line (adds to --subs)
  --query <q>               Repeatable; queries may contain commas
  --queries-file <path>     One query per line; blank lines and # comments skipped
  --thread-urls-file <path> Extra thread URLs to collect, one per line
  --out <dir>               Store: <dir>/threads/<id>.json, <dir>/searches/, run logs
  --sort <csv>              Search orders per query: relevance,top,new,comments (default relevance)
  --t <filter>              Reddit search window: hour|day|week|month|year|all (default all)
  --since <YYYY-MM-DD>      Drop posts created before this date
  --since-days <n>          Same, relative to now
  --per-query <n>           Posts per (subreddit, query, sort) (default 25)
  --min-comments <n>        Skip posts with fewer comments (default 1)
  --max-threads <n>         Stop after writing this many new threads
  --comments <mode>         full|top|none (default full: morechildren + continue-thread expansion)
  --comment-sort <sort>     Thread comment order (default top)
  --more-cap <n>            Expansion requests per thread (default 25)
  --concurrency <n>         Threads in flight; the client still spaces requests (default 2)
  --include-authors         Keep usernames. Off by default: authors omitted, u/ mentions redacted

Credentials (OAuth only):
  REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT from the process
  environment, or --research-env-file <absolute path> (owner-only dotenv; only
  those three names are read). Missing credentials exit 2.
`;

function fail(message, code = 1) {
  process.stderr.write(`reddit-corpus: ${message}\n`);
  process.exit(code);
}

function resolvePackageRoot() {
  const fromImport = fileURLToPath(new URL('../../../', import.meta.url));
  const override = process.env.BRAINTIED_RESEARCH_PACKAGE_ROOT;
  const candidates = [fromImport];
  if (typeof override === 'string' && override.trim() !== '') candidates.push(override.trim());
  candidates.push(path.join(os.homedir(), 'Development/.worktrees/research-main/packages/research'));
  for (const root of candidates) {
    const pkg = path.join(root, 'package.json');
    if (!fs.existsSync(path.join(root, 'dist', 'index.mjs')) || !fs.existsSync(pkg)) continue;
    try {
      if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === '@braintied/research') return root;
    } catch {
      continue;
    }
  }
  return fail('built @braintied/research not found; run pnpm build in packages/research or set BRAINTIED_RESEARCH_PACKAGE_ROOT');
}

async function loadEnvFile(absolutePath) {
  if (!path.isAbsolute(absolutePath)) fail('--research-env-file must be an absolute path', 2);
  const handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) fail(`${absolutePath} is not a regular file`, 2);
    if ((stats.mode & 0o077) !== 0) fail(`${absolutePath} must be owner-only (0600 or stricter)`, 2);
    const parsed = parseAllowlistedEnvFile(await handle.readFile({ encoding: 'utf8' }), absolutePath, new Set(REDDIT_ENV));
    for (const [name, value] of parsed) {
      if (value.trim() !== '') process.env[name] = value;
    }
  } finally {
    await handle.close();
  }
}

async function readLines(file) {
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
}

function positiveInt(name, raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail(`--${name} must be a non-negative integer`);
  return value;
}

async function redditClient(research, values) {
  if (values['research-env-file'] !== undefined) await loadEnvFile(values['research-env-file']);
  const credentials = research.resolveResearchCredentials(process.env);
  if (credentials.reddit === undefined) {
    const missing = REDDIT_ENV.filter((name) => (process.env[name] ?? '').trim() === '');
    fail(
      `Reddit credentials missing (${missing.join(', ')}). Unauthenticated Reddit is HTTP 403; this runner never `
        + 'scrapes it or substitutes web search. Pass --research-env-file <owner-only dotenv> or export the variables.',
      2,
    );
  }
  const probe = await research.probeReddit(credentials);
  if (!probe.ok) fail(`Reddit probe failed at ${probe.stage}${probe.status === undefined ? '' : ` (HTTP ${probe.status})`}: ${probe.reason}`, 2);
  return research.createRedditClient(credentials.reddit);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      subs: { type: 'string' },
      'subs-file': { type: 'string' },
      query: { type: 'string', multiple: true },
      'queries-file': { type: 'string' },
      'thread-urls-file': { type: 'string' },
      topic: { type: 'string', multiple: true },
      'per-topic': { type: 'string' },
      'min-subscribers': { type: 'string' },
      out: { type: 'string' },
      sort: { type: 'string' },
      t: { type: 'string' },
      since: { type: 'string' },
      'since-days': { type: 'string' },
      'per-query': { type: 'string' },
      'min-comments': { type: 'string' },
      'max-threads': { type: 'string' },
      comments: { type: 'string' },
      'comment-sort': { type: 'string' },
      'more-cap': { type: 'string' },
      concurrency: { type: 'string' },
      'include-authors': { type: 'boolean' },
      'research-env-file': { type: 'string' },
    },
    strict: true,
  });

  const research = await import(pathToFileURL(path.join(resolvePackageRoot(), 'dist', 'index.mjs')).href);
  if (typeof research.collectRedditCorpus !== 'function') fail('built package has no collectRedditCorpus; rebuild packages/research');

  if (command === 'check') {
    await redditClient(research, values);
    process.stdout.write('reddit: OAuth token and listing probe OK\n');
    return;
  }

  if (command === 'discover') {
    const topics = values.topic ?? [];
    if (topics.length === 0) fail('discover needs at least one --topic');
    const client = await redditClient(research, values);
    const result = await research.discoverSubreddits(client, topics, {
      perTopic: positiveInt('per-topic', values['per-topic'], 25),
      minSubscribers: positiveInt('min-subscribers', values['min-subscribers'], 0),
    });
    const body = `${JSON.stringify(result, null, 2)}\n`;
    if (values.out !== undefined) await writeFile(values.out, body, 'utf8');
    else process.stdout.write(body);
    for (const error of result.errors) process.stderr.write(`error ${error.stage} ${error.target}: ${error.status ?? ''} ${error.reason}\n`);
    process.stderr.write(`discover: ${result.subreddits.length} subreddits, ${result.errors.length} errors\n`);
    if (result.subreddits.length === 0 && result.errors.length > 0) process.exit(1);
    return;
  }

  if (command !== 'collect') fail(`unknown command "${command}"\n${USAGE}`);

  const subreddits = (values.subs ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (values['subs-file'] !== undefined) subreddits.push(...await readLines(values['subs-file']));
  const queries = [...(values.query ?? [])];
  if (values['queries-file'] !== undefined) queries.push(...await readLines(values['queries-file']));
  const threadUrls = values['thread-urls-file'] === undefined ? [] : await readLines(values['thread-urls-file']);
  if (values.out === undefined) fail('collect needs --out <dir>');
  if (threadUrls.length === 0 && (subreddits.length === 0 || queries.length === 0)) {
    fail('collect needs --subs and at least one query, or --thread-urls-file');
  }
  const sorts = (values.sort ?? 'relevance').split(',').map((s) => s.trim());
  for (const sort of sorts) if (!SEARCH_SORTS.has(sort)) fail(`--sort "${sort}" is not one of ${[...SEARCH_SORTS].join(', ')}`);
  const t = values.t ?? 'all';
  if (!TIME_FILTERS.has(t)) fail(`--t "${t}" is not one of ${[...TIME_FILTERS].join(', ')}`);
  const comments = values.comments ?? 'full';
  if (!COMMENT_MODES.has(comments)) fail('--comments must be full, top or none');
  const commentSort = values['comment-sort'] ?? 'top';
  if (!COMMENT_SORTS.has(commentSort)) fail(`--comment-sort "${commentSort}" is not valid`);
  let sinceUtc;
  if (values.since !== undefined) {
    const ms = Date.parse(`${values.since}T00:00:00Z`);
    if (Number.isNaN(ms)) fail('--since must be YYYY-MM-DD');
    sinceUtc = Math.floor(ms / 1000);
  } else if (values['since-days'] !== undefined) {
    sinceUtc = Math.floor(Date.now() / 1000) - positiveInt('since-days', values['since-days'], 0) * 86_400;
  }

  const outDir = path.resolve(values.out);
  await mkdir(outDir, { recursive: true });
  const client = await redditClient(research, values);
  const startedAt = new Date().toISOString();
  const errorsFile = path.join(outDir, 'errors.jsonl');
  let lastLog = 0;
  const result = await research.collectRedditCorpus(client, research.createDirectoryThreadStore(outDir), {
    subreddits,
    queries,
    sorts,
    timeFilter: t,
    ...(sinceUtc === undefined ? {} : { sinceUtc }),
    perQuery: positiveInt('per-query', values['per-query'], 25),
    minComments: positiveInt('min-comments', values['min-comments'], 1),
    threadUrls,
    ...(values['max-threads'] === undefined ? {} : { maxThreads: positiveInt('max-threads', values['max-threads'], 0) }),
    comments,
    commentSort,
    expansionCap: positiveInt('more-cap', values['more-cap'], 25),
    concurrency: positiveInt('concurrency', values.concurrency, 2),
    includeAuthors: values['include-authors'] === true,
    onProgress: (progress) => {
      const at = Date.now();
      if (progress.done === progress.total || at - lastLog > 5_000) {
        lastLog = at;
        process.stderr.write(`[${progress.phase}] ${progress.done}/${progress.total} ${progress.label}\n`);
      }
    },
  });
  for (const error of result.errors) await appendFile(errorsFile, `${JSON.stringify({ at: startedAt, ...error })}\n`, 'utf8');
  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    options: { subreddits, queries, sorts, t, sinceUtc, comments, includeAuthors: values['include-authors'] === true },
    ...result,
    errors: result.errors.length,
  };
  await writeFile(path.join(outDir, `run-${startedAt.replace(/[:.]/g, '-')}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...summary, options: undefined }, null, 2)}\n`);
  // Searches all failed, or every attempted thread failed: that is not a corpus.
  if (result.searches.run + result.searches.cached === 0 && result.searches.failed > 0) process.exit(1);
  if (result.threads.written === 0 && result.threads.skippedExisting === 0 && result.threads.failed > 0) process.exit(1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
