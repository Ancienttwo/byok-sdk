import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/input-image-upload.ts', 'src/execution-core/index.ts', 'src/execution-core/canonical.ts'],
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
  }],
  esbuildOptions(options) {
    options.legalComments = 'inline';
  },
});
