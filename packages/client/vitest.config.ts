import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: unknown };
if (typeof manifest.version !== 'string') throw new Error('packages/client/package.json must declare a string version');

// This suite drives real child processes, sockets and SQLite/filesystem I/O.
// Bound file-level workers so CPU-count-based fan-out does not overwhelm those
// shared resources. Individual concurrency tests still exercise their own races;
// their assertions and deadlines are unchanged.
export default defineConfig({
  resolve: { alias: { '#byok-hermes-session': fileURLToPath(new URL('./src/adapters/hermes/hermes-session-runtime.ts', import.meta.url)) } },
  define: {
    __BYOK_CLIENT_PACKAGE_VERSION__: JSON.stringify(manifest.version),
    __BYOK_PI_SUBAGENTS__: 'true',
  },
  test: {
    // One short per-run TMPDIR, removed in teardown; see scripts/vitest/tmp-root.mjs.
    globalSetup: ['../../scripts/vitest/tmp-root.mjs'],
    setupFiles: ['./src/__tests__/setup-device-credentials.ts', './src/__tests__/setup-runtime-environment.ts'],
    maxWorkers: 4,
    testTimeout: 10_000,
  },
});
