import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

const coreSource = resolve('../core/src');
const publicCoreModules = new Set([
  'blob', 'errors', 'retention', 'tenant', 'time',
  'in-memory/board', 'in-memory/clock', 'in-memory/mailbox', 'in-memory/presence',
  'in-memory/quota', 'in-memory/skill-pack', 'in-memory/storage-ledger', 'in-memory/truth',
].map(module => resolve(coreSource, module + '.js')));

export default defineConfig({
  entry: ['src/index.ts', 'src/input-image-upload.ts', 'src/embedded-blob-storage.ts', 'src/execution-core/index.ts', 'src/execution-core/canonical.ts'],
  external: ['#byok-embedded-blob-storage'],
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minifyWhitespace: true,
  esbuildPlugins: [{
    name: 'lazy-input-image-upload',
    setup(build) {
      build.onResolve({ filter: /^\.\/input-image-upload\.js$/ }, args =>
        args.kind === 'dynamic-import' ? { path: args.path, external: true } : undefined);
    },
  }, {
    name: 'embedded-core-public-dependencies',
    setup(build) {
      // Bundle only the private composition and object store. Reuse the public
      // stores, helpers and error classes, including their runtime identities.
      build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, args => {
        if (publicCoreModules.has(resolve(args.resolveDir, args.path))) {
          return { path: '@byok-sdk/core', external: true };
        }
      });
    },
  }],
  esbuildOptions(options) {
    options.legalComments = 'inline';
  },
});
