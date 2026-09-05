#!/usr/bin/env node
// The daemon stand-in for the host-exit backstop test.
//
// Spawns a real owned tree — `./process-tree-descendant.mjs`, which spawns a
// grandchild of its own so a group-wide kill is distinguishable from a
// direct-child kill — optionally adopts it through the real
// `adoptOwnedProcessTree` under test, prints the pids, and then exits the one
// way that proves anything here: a real `process.exit(0)` with the tree still
// running and nothing disposed. The registered `exit` listener is the only
// thing that can reap it.
//
// argv: <receiptFile> <adopt 0|1>
//
// Run with `node --import ./ts-source-resolve-hook.mjs`, which is what lets a
// plain Node process import the `.ts` module under test.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adoptOwnedProcessTree, withOwnedProcessTree } from '../../adapters/process-tree.ts';

const DESCENDANT_FIXTURE = fileURLToPath(new URL('./process-tree-descendant.mjs', import.meta.url));
const [receiptFile, adopt] = process.argv.slice(2);

// `withOwnedProcessTree` is what makes the child a POSIX process-group leader,
// i.e. exactly the topology the backstop's single group signal relies on.
// `stdio: 'ignore'` is required, not incidental: an inherited pipe would be
// held open by the surviving tree in the unadopted control run, and the test's
// own `execFile` would never see this process's output close.
const child = spawn(process.execPath, [DESCENDANT_FIXTURE, receiptFile, '0', '0', ''], withOwnedProcessTree({
  stdio: 'ignore',
}));

if (child.pid === undefined) {
  process.stderr.write('host-exit helper: owned root did not receive a pid\n');
  process.exit(1);
}

if (adopt === '1') {
  await adoptOwnedProcessTree({ child, label: 'host-exit-helper' });
}

// The fixture publishes the receipt only once its own grandchild exists, so
// every pid the test polls is genuinely running when this process exits.
const deadline = Date.now() + 5_000;
let receipt;
for (;;) {
  if (existsSync(receiptFile)) {
    try {
      const parsed = JSON.parse(readFileSync(receiptFile, 'utf8'));
      if (parsed.descendantPid > 0 && parsed.grandchildPid > 0) {
        receipt = parsed;
        break;
      }
    } catch {
      // Published by rename, so a torn read is impossible; a missing file is not.
    }
  }
  if (Date.now() >= deadline) {
    process.stderr.write('host-exit helper: owned tree never published a complete receipt\n');
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

process.stdout.write(`${JSON.stringify({ rootPid: child.pid, grandchildPid: receipt.grandchildPid })}\n`);
process.exit(0);
