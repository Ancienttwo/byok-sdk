import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/input-preparation-version.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
