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
  // #2286: the Node-only core entry is inlined. Worker bundles reach HostLedger through host-kit's execution-core import, and
  // the entry's `node` export condition does not resolve there; its Node builtins load only when a ledger is constructed.
  noExternal: ['@byok-sdk/core/sqlite-node'],
  minifyWhitespace: true,
  esbuildOptions(options) {
    options.legalComments = 'inline';
  },
});
