import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/pi-catalog.ts', 'src/model-route.ts', 'src/bin/pi-provider-launcher.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
