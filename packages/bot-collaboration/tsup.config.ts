import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/host-kit.ts', 'src/rules/index.ts', 'src/testing.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  // Shared chunks keep one copy of each module across the entries, so an error class
  // thrown by the Host is the class a vector from `./testing` checks with instanceof.
  splitting: true,
  treeshake: true,
  minifyWhitespace: true,
  esbuildOptions(options) {
    options.legalComments = 'inline';
  },
});
