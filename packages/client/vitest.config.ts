import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: unknown };
if (typeof manifest.version !== 'string') throw new Error('packages/client/package.json must declare a string version');

// This suite drives real child processes, sockets and SQLite/filesystem I/O.
// Bound file-level workers so CPU-count-based fan-out does not overwhelm those
// shared resources. Individual concurrency tests still exercise their own races;
// their assertions and deadlines are unchanged.
export default defineConfig({
  define: {
    __BYOK_CLIENT_PACKAGE_VERSION__: JSON.stringify(manifest.version),
  },
  test: {
    env: {
      // Test-only in-memory credential authority. Product construction never
      // gets this flag from public DaemonConfig and has no filesystem fallback.
      BYOK_TEST_DEVICE_CREDENTIAL_STORE: '1',
    },
    maxWorkers: 4,
    testTimeout: 10_000,
  },
});
