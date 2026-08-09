import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  // Same posture as `@byok-sdk/core`: a hosted composition has to be loadable on
  // Workers/Deno as well as Node, so nothing in this package may reach for a
  // Node built-in (asserted by `src/__tests__/constraints.test.ts`).
  platform: 'neutral',
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
