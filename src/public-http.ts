import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const TARGET_FINGERPRINT_KEY = randomBytes(32);

const blockedAddresses = new BlockList();
const globallyRoutableIpv6 = new BlockList();
globallyRoutableIpv6.addSubnet('2000::', 3, 'ipv6');

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4');
}

for (const [address, prefix] of [
  ['::', 96],
  ['3fff::', 20],
  ['5f00::', 16],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fec0::', 10],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6');
}

const blockedHostnameSuffixes = [
  '.home.arpa',
  '.internal',
  '.invalid',
  '.local',
  '.localhost',
] as const;

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type PublicHostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface ResolvedPublicUrl {
  address: string;
  family: 4 | 6;
  url: URL;
}

export interface PublicTextResponse {
  finalUrl: string;
  headers: http.IncomingHttpHeaders;
  ok: boolean;
  status: number;
  text: string;
}

export interface PublicTextFetchOptions {
  acceptedContentTypes?: readonly string[];
  headers?: Readonly<Record<string, string>>;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

interface BoundResponse {
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  status: number;
}

type BoundRequester = (
  target: ResolvedPublicUrl,
  options: Required<Pick<PublicTextFetchOptions, 'maxBytes' | 'timeoutMs'>> & {
    headers: Readonly<Record<string, string>>;
  },
) => Promise<BoundResponse>;

export interface PublicTextFetchDependencies {
  request?: BoundRequester;
  resolve?: PublicHostResolver;
}

/** Read an already-fetched web response without allowing decoded bytes to grow unbounded. */
export async function readBoundedWebResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('Invalid response byte limit');
  }
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new UnsafeOutboundUrlError();
  }
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UnsafeOutboundUrlError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export class UnsafeOutboundUrlError extends Error {
  constructor() {
    super('Outbound URL is not an approved public HTTP target');
    this.name = 'UnsafeOutboundUrlError';
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function hostnameIsBlocked(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.arpa')
    || blockedHostnameSuffixes.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    );
}

export function isPublicAddress(address: string, family?: 4 | 6): boolean {
  const normalized = address.split('%', 1)[0] ?? address;
  const detected = isIP(normalized);
  if (detected !== 4 && detected !== 6) return false;
  if (family !== undefined && detected !== family) return false;
  // Public IPv6 destinations must be allocated from the global-unicast
  // 2000::/3 space. This fail-closed positive gate rejects translated,
  // mapped, site-local, unallocated, and future-use encodings before the
  // narrower special-purpose denylist is consulted.
  if (detected === 6 && !globallyRoutableIpv6.check(normalized, 'ipv6')) return false;
  return !blockedAddresses.check(normalized, detected === 4 ? 'ipv4' : 'ipv6');
}

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.flatMap((result): ResolvedAddress[] =>
    result.family === 4 || result.family === 6
      ? [{ address: result.address, family: result.family }]
      : []);
}

export async function resolvePublicHttpUrl(
  rawUrl: string,
  resolver: PublicHostResolver = defaultResolver,
): Promise<ResolvedPublicUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeOutboundUrlError();
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== '') {
    throw new UnsafeOutboundUrlError();
  }
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port !== '' && url.port !== expectedPort) {
    throw new UnsafeOutboundUrlError();
  }

  const hostname = normalizedHostname(url);
  if (hostname === '' || hostnameIsBlocked(hostname)) {
    throw new UnsafeOutboundUrlError();
  }

  const literalFamily = isIP(hostname);
  const addresses: ResolvedAddress[] = literalFamily === 4 || literalFamily === 6
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname);
  if (addresses.length === 0
      || addresses.some((entry) => !isPublicAddress(entry.address, entry.family))) {
    throw new UnsafeOutboundUrlError();
  }

  const preferred = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (preferred === undefined) throw new UnsafeOutboundUrlError();
  return { ...preferred, url };
}

function boundRequest(
  target: ResolvedPublicUrl,
  options: Required<Pick<PublicTextFetchOptions, 'maxBytes' | 'timeoutMs'>> & {
    headers: Readonly<Record<string, string>>;
  },
): Promise<BoundResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: BoundResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error);
    };
    const transport = target.url.protocol === 'https:' ? https : http;
    const request = transport.request({
      agent: false,
      family: target.family,
      headers: {
        ...options.headers,
        'Accept-Encoding': 'identity',
        Host: target.url.host,
      },
      hostname: target.address,
      method: 'GET',
      path: `${target.url.pathname}${target.url.search}`,
      port: target.url.protocol === 'https:' ? 443 : 80,
      ...(target.url.protocol === 'https:'
        ? { servername: normalizedHostname(target.url) }
        : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const declaredLength = Number(response.headers['content-length'] ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
        response.destroy();
        fail(new UnsafeOutboundUrlError());
        return;
      }
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > options.maxBytes) {
          response.destroy();
          fail(new UnsafeOutboundUrlError());
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        finish({
          body: Buffer.concat(chunks),
          headers: response.headers,
          status: response.statusCode ?? 0,
        });
      });
      response.on('error', fail);
    });
    const deadline = setTimeout(() => {
      request.destroy(new UnsafeOutboundUrlError());
    }, options.timeoutMs);
    request.on('error', fail);
    request.end();
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const CROSS_ORIGIN_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'user-agent',
]);

function headersAfterRedirect(
  headers: Readonly<Record<string, string>>,
  from: URL,
  to: URL,
): Readonly<Record<string, string>> {
  if (from.origin === to.origin) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => (
      CROSS_ORIGIN_HEADER_ALLOWLIST.has(name.toLowerCase())
    )),
  );
}

async function completeBeforeDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const remainingMs = Math.floor(deadline - performance.now());
  if (remainingMs < 1) throw new UnsafeOutboundUrlError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new UnsafeOutboundUrlError()), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function fetchPublicText(
  rawUrl: string,
  options: PublicTextFetchOptions = {},
  dependencies: PublicTextFetchDependencies = {},
): Promise<PublicTextResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1
      || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError('Invalid public text fetch limits');
  }

  const resolveHost = dependencies.resolve ?? defaultResolver;
  const requestOnce = dependencies.request ?? boundRequest;
  let current = rawUrl;
  let currentHeaders: Readonly<Record<string, string>> = options.headers ?? {};
  const deadline = performance.now() + timeoutMs;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const target = await completeBeforeDeadline(
      () => resolvePublicHttpUrl(current, resolveHost),
      deadline,
    );
    const requestTimeoutMs = Math.max(1, Math.floor(deadline - performance.now()));
    const response = await completeBeforeDeadline(
      () => requestOnce(target, {
        headers: currentHeaders,
        maxBytes,
        timeoutMs: requestTimeoutMs,
      }),
      deadline,
    );
    if (response.body.length > maxBytes) throw new UnsafeOutboundUrlError();
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = firstHeader(response.headers.location);
      if (location === undefined || hop === maxRedirects) {
        throw new UnsafeOutboundUrlError();
      }
      const redirected = new URL(location, target.url);
      if (target.url.protocol === 'https:' && redirected.protocol !== 'https:') {
        throw new UnsafeOutboundUrlError();
      }
      currentHeaders = headersAfterRedirect(currentHeaders, target.url, redirected);
      current = redirected.toString();
      continue;
    }

    const encoding = firstHeader(response.headers['content-encoding']);
    if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
      throw new UnsafeOutboundUrlError();
    }
    const contentType = (firstHeader(response.headers['content-type']) ?? '')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase() ?? '';
    const accepted = options.acceptedContentTypes ?? ['text/html', 'application/xhtml+xml', 'text/plain'];
    if (!accepted.includes(contentType)) {
      throw new UnsafeOutboundUrlError();
    }
    return {
      finalUrl: target.url.toString(),
      headers: response.headers,
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: response.body.toString('utf8'),
    };
  }

  throw new UnsafeOutboundUrlError();
}

export function outboundTargetFingerprint(rawUrl: string): string {
  let origin: string;
  try {
    origin = new URL(rawUrl).origin;
  } catch {
    origin = 'invalid';
  }
  return createHmac('sha256', TARGET_FINGERPRINT_KEY)
    .update(origin)
    .digest('hex')
    .slice(0, 16);
}
