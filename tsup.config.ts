import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['@anthropic-ai/sdk', '@google/genai', 'openai', 'youtube-transcript', 'youtube-transcript-plus', 'youtubei.js', 'zod'],
});
