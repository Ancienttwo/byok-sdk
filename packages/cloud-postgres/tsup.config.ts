import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  // Unlike `@byok/core` and `@byok/cloud`, this package is Node-only by
  // construction: it drives `pg` sockets and reads migration files off disk.
  // That is exactly why it is a separate package (design §4) — the two
  // platform-neutral packages stay loadable on Workers because the database
  // driver never enters their dependency graph.
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
