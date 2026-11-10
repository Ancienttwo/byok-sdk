import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { setPosixGateRootForTests } from '../util/path-mutation-gate';

// Each test file takes its darwin gate locks in its own root under the run's
// temp dir, so the suite does not grow the real /tmp/byok-pm-<uid>. The gate
// asserts the root is an owned private directory when it first takes a lock.
if (process.platform === 'darwin') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'byok-pm-'));
  setPosixGateRootForTests(root);
  afterAll(() => {
    setPosixGateRootForTests(undefined);
    rmSync(root, { recursive: true, force: true });
  });
}
