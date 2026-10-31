import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // `./evidence` is the offline evidence validator on its own. It is pure
    // string matching with no imports, and it was reachable from nowhere: the
    // two functions are used inside `index.ts` and never re-exported from it,
    // so a second consumer had to copy them. @braintied/intros is that second
    // consumer, and a copy of a sentence matcher is how a fail-closed check
    // quietly becomes a substring check.
    'evidence-validation': 'src/evidence-validation.ts',
    // `./public-http` is the outbound guard on its own (node built-ins only): every
    // hop resolved, checked against the public-address gate and pinned for the
    // connection. @braintied/artists fetches studio sites through it instead of a
    // second copy of the address list (review of braintied/stack#1270).
    'public-http': 'src/public-http.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['@anthropic-ai/sdk', '@google/genai', 'openai', 'youtube-transcript', 'youtube-transcript-plus', 'youtubei.js', 'zod'],
});
