import { defineConfig } from 'tsup';

// Two builds, one per public entry:

// - The root entry is Node-only by construction: it drives `pg` sockets and
//   reads migration files off disk. That is exactly why it is a separate
//   package (design §4) — the two platform-neutral packages stay loadable on
//   Workers because the database driver never enters their dependency graph.
//   This config is unchanged from the single-config era, `clean` included.
// - The runtime entry is the Worker-loadable online surface, so it builds for
//   the neutral platform: no node builtin is external there, which makes the
//   esbuild pass fail the build the moment the runtime subgraph reaches one.
//   That failure is the point — the alternative is a Worker that breaks at
//   deploy time. `clean: false` because the root config above already cleaned
//   the output directory for this run; only one config may own the clean.
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'es2022',
    platform: 'node',
    dts: false,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
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
  },
]);
