// Shared spawn-and-await for the runtime fixtures' owned process tree.
//
// The receipt is written by the DESCENDANT (only it knows the grandchild's
// pid), but every consumer reads the file as soon as the runtime shows its
// first sign of life:
//
//   - src/__tests__/runtime-process-tree.test.ts polls for it after start.
//   - scripts/adapter-task-smoke.mjs reads it once, with no retry, as soon as
//     the task reports `started`.
//
// So the receipt must be COMPLETE before the fixture emits its first protocol
// frame. That was implicitly true while the root wrote the file itself; with
// the third level it has to be enforced, which is what the bounded wait below
// does. Do not turn this into a fire-and-forget spawn again — the smoke has no
// retry loop, and this is exactly the contract it depends on.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DESCENDANT_FIXTURE = fileURLToPath(new URL('./process-tree-descendant.mjs', import.meta.url));
const RECEIPT_TIMEOUT_MS = 5_000;
const RECEIPT_POLL_MS = 10;

/**
 * Spawns levels 2 and 3 of the owned tree and resolves only once the receipt
 * naming all three pids is on disk.
 *
 * @param {{receiptFile: string, rootPid: number, ignoreTerm?: boolean, escapeLog?: string}} options
 */
export async function spawnProcessTreeDescendant(options) {
  const descendant = spawn(process.execPath, [
    DESCENDANT_FIXTURE,
    options.receiptFile,
    String(options.rootPid),
    options.ignoreTerm ? '1' : '0',
    options.escapeLog ?? '',
  ], { stdio: 'ignore' });

  if (descendant.pid === undefined) {
    process.stderr.write('process-tree fixture: descendant did not receive a pid\n');
    process.exit(1);
  }

  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  for (;;) {
    if (existsSync(options.receiptFile)) {
      try {
        const receipt = JSON.parse(readFileSync(options.receiptFile, 'utf8'));
        if (receipt.rootPid > 0 && receipt.descendantPid > 0 && receipt.grandchildPid > 0) return receipt;
      } catch {
        // Only reachable if the atomic rename is ever relaxed; retry regardless.
      }
    }
    if (Date.now() >= deadline) {
      process.stderr.write('process-tree fixture: descendant never wrote a complete receipt\n');
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }
}
