import { defineConfig } from 'vitest/config';

// The goal/btw tests pair a real daemon over HTTP. CI runners have no OS
// credential provider, so use the SDK's test-only in-memory authority, the
// same switch packages/client/vitest.config.ts sets. Product construction
// never receives this flag from DaemonConfig.
export default defineConfig({
  test: {
    // One short per-run TMPDIR, removed in teardown; see scripts/vitest/tmp-root.mjs.
    globalSetup: ['../../scripts/vitest/tmp-root.mjs'],
    env: { BYOK_TEST_DEVICE_CREDENTIAL_STORE: '1' },
    testTimeout: 10_000,
  },
});
