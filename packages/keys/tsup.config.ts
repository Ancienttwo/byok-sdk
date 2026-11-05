import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/pi-catalog.ts', 'src/model-route.ts', 'src/bin/pi-provider-launcher.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  dts: false,
  // Optional, so tsup would inline it; it has to resolve at runtime beside its platform addon.
  external: ['koffi'],
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minifyWhitespace: true,
  esbuildOptions(options) {
    options.legalComments = 'inline';
  },
});
