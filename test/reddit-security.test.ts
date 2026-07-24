import assert from 'node:assert/strict';
import test from 'node:test';

import { redditProvider } from '../src/providers/reddit.js';

test('Reddit fetch rejects non-canonical targets before loading credentials', async () => {
  const previousId = process.env.REDDIT_CLIENT_ID;
  const previousSecret = process.env.REDDIT_CLIENT_SECRET;
  const previousAgent = process.env.REDDIT_USER_AGENT;
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  delete process.env.REDDIT_USER_AGENT;

  try {
    for (const url of [
      'https://evil.example/r/research/comments/abc',
      'https://reddit.com.evil.example/r/research/comments/abc',
      'https://reddit.com@evil.example/r/research/comments/abc',
      'http://www.reddit.com/r/research/comments/abc',
      'https://www.reddit.com:8443/r/research/comments/abc',
    ]) {
      const result = await redditProvider.fetch(url);
      assert.equal(result.fetch_status, 'failed');
      assert.match(result.fetch_error ?? '', /canonical Reddit HTTPS URL/);
    }
  } finally {
    if (previousId === undefined) delete process.env.REDDIT_CLIENT_ID;
    else process.env.REDDIT_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.REDDIT_CLIENT_SECRET;
    else process.env.REDDIT_CLIENT_SECRET = previousSecret;
    if (previousAgent === undefined) delete process.env.REDDIT_USER_AGENT;
    else process.env.REDDIT_USER_AGENT = previousAgent;
  }
});
