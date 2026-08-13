import { defineConfig } from 'vitest/config';

// `setupFiles` runs once per test worker before its files import. The single
// entry disables fetch keep-alive so no idle MinIO socket survives to be reset
// at teardown — see support/disable-fetch-keepalive.ts for the full why. Every
// other vitest default is left untouched on purpose.
export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/support/disable-fetch-keepalive.ts'],
  },
});
