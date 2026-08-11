import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin/byok-agent.ts', 'src/bin/byok-approval-mcp.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  // Pi is a required runtime dependency, but its CLI stays external because the
  // adapter launches it as a version-pinned Node subprocess.
  external: ['@earendil-works/pi-coding-agent'],
});
