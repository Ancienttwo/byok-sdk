import { defineConfig } from 'vitest/config';

// Tests import the built public SDK and start real synthetic CLI processes.
// Serialize files and bound both tests and awaited process-disposal teardown.
// One short per-run TMPDIR, removed in teardown; see scripts/vitest/tmp-root.mjs.
export default defineConfig({
  test: {
    globalSetup: ['../../scripts/vitest/tmp-root.mjs'],
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 10_000,
  },
});
