import path from 'node:path';
import { defineConfig, type Options } from 'tsup';

const shared: Options = {
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: false,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minifyWhitespace: true,
  esbuildOptions(options) {
    options.legalComments = 'inline';
  },
};

const ERRORS_MODULE = path.resolve('src/errors.ts');

/**
 * The subpath bundle takes `ByokCoreError` from the package root, so the root
 * and the subpath throw one class and `isCoreError` works on both. The other
 * shared modules are stateless, so the subpath keeps its own copy and the root
 * bundle does not change.
 */
type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number];

const errorsFromRoot: EsbuildPlugin = {
  name: 'core-errors-from-root',
  setup(build) {
    build.onResolve({ filter: /(^|\/)errors$/ }, (args) =>
      path.resolve(args.resolveDir, `${args.path}.ts`) === ERRORS_MODULE ? { path: '@byok-sdk/core', external: true } : undefined);
  },
};

export default defineConfig([
  // The two configs build in parallel, so the root clean keeps the subpath output.
  { ...shared, entry: ['src/index.ts'], clean: ['!sealed-payload/**'] },
  { ...shared, entry: { 'sealed-payload/index': 'src/sealed-payload/index.ts' }, clean: false, esbuildPlugins: [errorsFromRoot] },
]);
