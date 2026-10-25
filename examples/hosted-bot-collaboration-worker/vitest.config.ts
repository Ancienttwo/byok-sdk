import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  globalSetup: ['../../scripts/vitest/tmp-root.mjs'], maxWorkers: 1,
  testTimeout: 120_000, hookTimeout: 240_000,
} });
