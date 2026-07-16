import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin/byok-agent.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  // The pi adapter lazy-imports this optionalDependency at runtime; never bundle it.
  external: ['@earendil-works/pi-coding-agent'],
});
