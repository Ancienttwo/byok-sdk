import { defineConfig } from 'tsup';

// Two builds, one per public entry:

// - The root entry is Node-only by construction: it drives `pg` sockets and
//   reads migration files off disk. That is exactly why it is a separate
//   package (design §4) — the two platform-neutral packages stay loadable on
//   Workers because the database driver never enters their dependency graph.
// - The runtime entry is the Worker-loadable online surface, so it builds for
//   the neutral platform: no node builtin is external there, which makes the
//   esbuild pass fail the build the moment the runtime subgraph reaches one.
//   That failure is the point — the alternative is a Worker that breaks at
//   deploy time.
//
// Neither config cleans. tsup runs array configs concurrently, and a config's
// clean globs and deletes everything under `dist/` whenever that config gets
// there — after the other config may already have written its output. The
// `build` and `dev` scripts remove `dist/` once, before tsup starts.
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'es2022',
    platform: 'node',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    minifyWhitespace: true,
    esbuildOptions(options) {
      options.legalComments = 'inline';
    },
  },
  {
    entry: { runtime: 'src/runtime.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'neutral',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    minifyWhitespace: true,
    esbuildOptions(options) {
      options.legalComments = 'inline';
    },
  },
]);
