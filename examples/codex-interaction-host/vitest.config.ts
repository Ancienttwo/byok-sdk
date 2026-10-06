import { defineConfig } from 'vitest/config';

// Tests import the built public SDK and start real synthetic CLI processes.
// Serialize files and bound both tests and awaited process-disposal teardown.
export default defineConfig({ test: { maxWorkers: 1, testTimeout: 30_000, hookTimeout: 10_000 } });
