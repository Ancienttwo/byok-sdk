import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../../vitest.config';

// #1103: the runtime contract suite runs real runtime CLIs, so it is its own
// run (`bun run test:runtime-contract`), never part of `bun run test`. It has
// no skip-everything default: without a mode the run refuses to start.
const mode = process.env.BYOK_RUNTIME_CONTRACT;
if (mode !== 'qualified' && mode !== 'latest') {
  throw new Error('BYOK_RUNTIME_CONTRACT must be qualified or latest; see docs/runtime-contract.md');
}

// Read before the shared globalSetup points TMPDIR at /tmp; see createSandbox.
process.env.BYOK_RUNTIME_CONTRACT_TMP ??= os.tmpdir();

export default mergeConfig(base, defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    include: ['src/__tests__/runtime-contract/*.contract.ts'],
    // One runtime process tree at a time; the files share no state but contend for CPU.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 900_000,
    reporters: ['verbose'],
  },
}));
