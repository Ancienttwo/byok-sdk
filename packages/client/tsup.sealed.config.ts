import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';
import { subagentsBuild } from './scripts/subagents-build';
import { workspaceExternals } from './scripts/workspace-externals';
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Build-time author selection only. S1 retains its compiler-bearing artifact.
export default defineConfig({
  entry: ['src/bin/pi-runtime-host-sealed.ts'], outDir: 'dist/bin',
  format: ['esm'], target: 'es2022', platform: 'node', dts: false,
  sourcemap: true, clean: false, splitting: false, treeshake: true, metafile: true,
  minifyWhitespace: true,
  esbuildOptions(options) {
    options.legalComments = 'inline';
  },
  esbuildPlugins: [workspaceExternals(), subagentsBuild(true)],
  noExternal: [/^@byok-sdk\//],
  external: ['koffi', '#byok-pi-todo-runtime', 'typebox', 'typebox/compile',
    'undici', 'jiti', 'yaml'],
  define: { __BYOK_CLIENT_PACKAGE_VERSION__: JSON.stringify(manifest.version) },
});
