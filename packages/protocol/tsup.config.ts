import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/constants.ts', 'src/agent-memory.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
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
