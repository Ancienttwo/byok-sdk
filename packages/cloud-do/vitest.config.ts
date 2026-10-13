import { defineConfig } from 'vitest/config';

// One short per-run TMPDIR, removed in teardown; see scripts/vitest/tmp-root.mjs.
// Every other vitest default is left untouched on purpose.
export default defineConfig({
  test: {
    globalSetup: ['../../scripts/vitest/tmp-root.mjs'],
  },
});
