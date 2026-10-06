import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'], format: ['esm'], target: 'es2022',
  // Preserve the CLI's lazy local boundary so signals/argument checks run before SDK loading.
  external: ['./index.js'],
  platform: 'node', dts: false, sourcemap: true, clean: true, splitting: false,
});
