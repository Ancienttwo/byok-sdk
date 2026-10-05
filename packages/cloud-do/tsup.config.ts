import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'neutral',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  clean: true,
  external: ['cloudflare:workers', /^@earendil-works\//],
});
