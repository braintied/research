import assert from 'node:assert/strict';
import test from 'node:test';

import { createRedditProvider } from '../src/providers/reddit.js';

test('Reddit fetch rejects non-canonical targets before loading credentials', async () => {
  // Deliberately unconfigured: the URL must be refused before the provider
  // ever reaches for a credential.
  const redditProvider = createRedditProvider({});

  {
    for (const url of [
      'https://evil.example/r/research/comments/abc',
      'https://reddit.com.evil.example/r/research/comments/abc',
      'https://reddit.com@evil.example/r/research/comments/abc',
      'http://www.reddit.com/r/research/comments/abc',
      'https://www.reddit.com:8443/r/research/comments/abc',
    ]) {
      const result = await redditProvider.fetch?.(url);
      assert.ok(result !== undefined);
      assert.equal(result.fetch_status, 'failed');
      assert.match(result.fetch_error ?? '', /canonical Reddit HTTPS URL/);
    }
  }
});
