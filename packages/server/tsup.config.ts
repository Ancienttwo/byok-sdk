import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/execution-core/index.ts', 'src/execution-core/canonical.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minifyWhitespace: true,
  esbuildOptions(options) {
    options.legalComments = 'inline';
  },
});
