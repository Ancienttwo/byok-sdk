import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// This separate config has one literal include and no shared setup or projects.
// Refuse execution unless both task-owned isolation roots were explicitly supplied.
const isolationRoot = '/workspace/byok-review/p2-isolation';
if (process.env.HOME !== `${isolationRoot}/home` || process.env.TMPDIR !== `${isolationRoot}/tmp`) {
  throw new Error('P2 regression requires its explicit isolated HOME and TMPDIR');
}
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: unknown };
if (typeof manifest.version !== 'string') throw new Error('client manifest must declare a version');

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: false,
  cacheDir: `${isolationRoot}/tmp/vitest-cache`,
  define: { __BYOK_CLIENT_PACKAGE_VERSION__: JSON.stringify(manifest.version) },
  resolve: {
    // Any unexpected native Pi import fails before that package can evaluate.
    alias: [{ find: /^@earendil-works\/.+/, replacement: fileURLToPath(new URL('./src/__tests__/fixtures/p2-forbidden-runtime.ts', import.meta.url)) }],
  },
  test: {
    include: ['src/__tests__/pi-aborted-settlement.test.ts'],
    setupFiles: [],
    globalSetup: [],
    env: { BYOK_TEST_DEVICE_CREDENTIAL_STORE: '1', PI_PROGRAM_STATUS: '0' },
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    watch: false,
    api: false,
    retry: 0,
    testTimeout: 5_000,
  },
});
