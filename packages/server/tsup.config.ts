import { isAbsolute, relative, resolve, sep } from 'node:path';
import { defineConfig } from 'tsup';

const coreSource = resolve('../core/src');
const publicCoreModules = new Set([
  'blob', 'errors', 'retention', 'tenant', 'time',
  'in-memory/board', 'in-memory/clock', 'in-memory/mailbox', 'in-memory/presence',
  'in-memory/quota', 'in-memory/skill-pack', 'in-memory/storage-ledger', 'in-memory/truth',
].map(module => resolve(coreSource, module + '.js')));
const bundledCoreModules = new Set([
  'in-memory/index', 'in-memory/blob', 'in-memory/archive-access', 'in-memory/device-assertion-replay',
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
      build.onResolve({ filter: /.*/ }, args => {
        if (!args.path.startsWith('./') && !args.path.startsWith('../') && !isAbsolute(args.path)) return;
        const target = resolve(args.resolveDir, args.path);
        const corePath = relative(coreSource, target);
        if (corePath.startsWith('..' + sep) || corePath === '..' || !corePath) return;
        if (publicCoreModules.has(target)) {
          return { path: '@byok-sdk/core', external: true };
        }
        if (!bundledCoreModules.has(target)) {
          return { errors: [{ text: `Unclassified core module in embedded blob storage: ${corePath}` }] };
        }
      });
    },
  }],
  esbuildOptions(options) {
    options.legalComments = 'inline';
  },
});
