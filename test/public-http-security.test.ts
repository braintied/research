import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchPublicText,
  isPublicAddress,
  readBoundedWebResponseText,
  resolvePublicHttpUrl,
  UnsafeOutboundUrlError,
  type PublicHostResolver,
  type ResolvedPublicUrl,
} from '../src/public-http.js';

const publicResolver: PublicHostResolver = async () => [
  { address: '93.184.216.34', family: 4 },
];

test('public-address policy blocks local, private, link-local, mapped, and reserved ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:0:10.0.0.1',
    '::ffff:0:127.0.0.1',
    '3fff::1',
    '4000::1',
    '5f00::1',
    '64:ff9b::a00:1',
    '64:ff9b::7f00:1',
    '8000::1',
    'fc00::1',
    'fec0::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('bounded web-response reads reject declared and streamed overflow', async () => {
  await assert.rejects(
    readBoundedWebResponseText(new Response('small', {
      headers: { 'content-length': '1000' },
    }), 10),
    UnsafeOutboundUrlError,
  );
  await assert.rejects(
    readBoundedWebResponseText(new Response('x'.repeat(11)), 10),
    UnsafeOutboundUrlError,
  );
  assert.equal(
    await readBoundedWebResponseText(new Response('bounded'), 10),
    'bounded',
  );
});

test('URL resolution rejects unsafe schemes, credentials, ports, names, and DNS answers', async () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/file',
    'https://user:password@example.com/',
    'https://example.com:8443/',
    'http://localhost/',
    'http://ora-auth.internal/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
  ]) {
    await assert.rejects(resolvePublicHttpUrl(url, publicResolver), UnsafeOutboundUrlError);
  }

  await assert.rejects(
    resolvePublicHttpUrl('https://rebind.example/', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]),
    UnsafeOutboundUrlError,
  );
});

test('fetch pins the validated address and blocks a private redirect before a second request', async () => {
  const requested: ResolvedPublicUrl[] = [];
  await assert.rejects(
    fetchPublicText(
      'https://public.example/start',
      {},
      {
        resolve: publicResolver,
        request: async (target) => {
          requested.push(target);
          return {
            body: Buffer.alloc(0),
            headers: { location: 'http://127.0.0.1/private' },
            status: 302,
          };
        },
      },
    ),
    UnsafeOutboundUrlError,
  );
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.address, '93.184.216.34');
});

test('fetch revalidates every redirect against fresh DNS answers', async () => {
  let resolution = 0;
  let requests = 0;
  await assert.rejects(
    fetchPublicText(
      'https://rebind.example/start',
      {},
      {
        resolve: async () => {
          resolution += 1;
          return resolution === 1
            ? [{ address: '93.184.216.34', family: 4 }]
            : [{ address: '10.0.0.8', family: 4 }];
        },
        request: async () => {
          requests += 1;
          return {
            body: Buffer.alloc(0),
            headers: { location: '/next' },
            status: 302,
          };
        },
      },
    ),
    UnsafeOutboundUrlError,
  );
  assert.equal(resolution, 2);
  assert.equal(requests, 1);
});

test('cross-origin redirects cannot forward credentials or arbitrary headers', async () => {
  const observedHeaders: Array<Readonly<Record<string, string>>> = [];
  let requestNumber = 0;
  const response = await fetchPublicText(
    'https://a.example/start',
    {
      headers: {
        Accept: 'text/plain',
        Authorization: 'Bearer private-token',
        Cookie: 'session=private',
        'User-Agent': 'ResearchTest/1.0',
        'X-Api-Key': 'private-key',
      },
    },
    {
      resolve: publicResolver,
      request: async (_target, requestOptions) => {
        observedHeaders.push(requestOptions.headers);
        requestNumber += 1;
        if (requestNumber === 1) {
          return {
            body: Buffer.alloc(0),
            headers: { location: 'https://b.example/final' },
            status: 302,
          };
        }
        return {
          body: Buffer.from('bounded public response'),
          headers: { 'content-type': 'text/plain' },
          status: 200,
        };
      },
    },
  );

  assert.equal(response.ok, true);
  assert.equal(observedHeaders.length, 2);
  assert.equal(observedHeaders[0]?.Authorization, 'Bearer private-token');
  assert.deepEqual(observedHeaders[1], {
    Accept: 'text/plain',
    'User-Agent': 'ResearchTest/1.0',
  });
});

test('one monotonic deadline covers DNS and every redirect hop', async () => {
  await assert.rejects(
    fetchPublicText('https://slow-dns.example/', { timeoutMs: 10 }, {
      resolve: async () => new Promise((resolve) => {
        setTimeout(() => resolve([{ address: '93.184.216.34', family: 4 }]), 50);
      }),
    }),
    UnsafeOutboundUrlError,
  );

  let requests = 0;
  await assert.rejects(
    fetchPublicText('https://redirect.example/start', { timeoutMs: 25 }, {
      resolve: publicResolver,
      request: async () => {
        requests += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          body: Buffer.alloc(0),
          headers: { location: `/hop-${requests}` },
          status: 302,
        };
      },
    }),
    UnsafeOutboundUrlError,
  );
  assert.ok(requests < 5);
});

test('fetch enforces response bytes, content type, encoding, and redirect downgrade', async () => {
  const baseDependencies = {
    resolve: publicResolver,
  };
  await assert.rejects(
    fetchPublicText('https://public.example/', { maxBytes: 10 }, {
      ...baseDependencies,
      request: async () => ({
        body: Buffer.alloc(11),
        headers: { 'content-type': 'text/html' },
        status: 200,
      }),
    }),
    UnsafeOutboundUrlError,
  );
  await assert.rejects(
    fetchPublicText('https://public.example/', {}, {
      ...baseDependencies,
      request: async () => ({
        body: Buffer.from('{}'),
        headers: { 'content-type': 'application/octet-stream' },
        status: 200,
      }),
    }),
    UnsafeOutboundUrlError,
  );
  await assert.rejects(
    fetchPublicText('https://public.example/', {}, {
      ...baseDependencies,
      request: async () => ({
        body: Buffer.from('<p>compressed</p>'),
        headers: { 'content-encoding': 'gzip', 'content-type': 'text/html' },
        status: 200,
      }),
    }),
    UnsafeOutboundUrlError,
  );
  await assert.rejects(
    fetchPublicText('https://public.example/', {}, {
      ...baseDependencies,
      request: async () => ({
        body: Buffer.alloc(0),
        headers: { location: 'http://public.example/' },
        status: 302,
      }),
    }),
    UnsafeOutboundUrlError,
  );
});

test('fetch returns bounded text for an approved pinned response', async () => {
  const body = '<html><body>' + 'public research '.repeat(30) + '</body></html>';
  const response = await fetchPublicText('https://public.example/article', {}, {
    resolve: publicResolver,
    request: async (target) => {
      assert.equal(target.address, '93.184.216.34');
      return {
        body: Buffer.from(body),
        headers: { 'content-type': 'text/html; charset=utf-8' },
        status: 200,
      };
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.text, body);
});
