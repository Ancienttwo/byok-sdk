import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One short per-run TMPDIR, removed in teardown; see scripts/vitest/tmp-root.mjs.
    globalSetup: ['../../scripts/vitest/tmp-root.mjs'],
    testTimeout: 10_000,
  },
});
