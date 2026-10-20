import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// One short per-run TMPDIR, removed in teardown; see scripts/vitest/tmp-root.mjs.
export default defineConfig({
  test: {
    globalSetup: ['../../scripts/vitest/tmp-root.mjs'],
    // Files start real workerd processes and share host CPU and disk I/O.
    // Bound file workers; keep native tool concurrency and all deadlines intact.
    maxWorkers: Math.min(4, Math.max(1, availableParallelism() - 1)),
  },
});
