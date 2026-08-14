#!/usr/bin/env node
// Levels 2 and 3 of the runtime process-tree fixtures' owned tree.
//
// The fake runtime roots (fake-pi/fake-claude/fake-codex) spawn THIS script,
// which in turn spawns a grandchild. Three levels matter because a
// direct-child-only termination and a one-level sweep are indistinguishable
// at two levels: only a grandchild proves the disposal path walked the whole
// tree rather than the root's immediate children.
//
// The receipt is written HERE, not by the root, because only this process
// knows the grandchild's pid. Tests poll the file until all three pids are
// present (see `readReceipt` in ../runtime-process-tree.test.ts).
//
// argv: <receiptFile> <rootPid> <ignoreTerm 0|1> <escapeLogFile|''>
//
// `escapeLogFile`, when non-empty, turns this process into the escape-race
// fixture: it spawns a fresh child every 100ms and appends each pid to that
// log, so a test can assert disposal never resolves while a recorded pid is
// still alive. Escapees self-destruct after 20s so a failed run cannot leave
// processes behind indefinitely.

import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const [receiptFile, rootPid, ignoreTerm, escapeLog] = process.argv.slice(2);

if (ignoreTerm === '1') process.on('SIGTERM', () => {});

const grandchildSource = `${ignoreTerm === '1' ? "process.on('SIGTERM', () => {});" : ''}setTimeout(() => {}, 60_000)`;
const grandchild = spawn(process.execPath, ['-e', grandchildSource], { stdio: 'ignore' });
if (grandchild.pid === undefined) {
  process.stderr.write('process-tree-descendant: grandchild did not receive a pid\n');
  process.exit(1);
}

writeFileSync(receiptFile, JSON.stringify({
  rootPid: Number(rootPid),
  descendantPid: process.pid,
  grandchildPid: grandchild.pid,
}));

if (escapeLog) {
  setInterval(() => {
    const escapee = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20_000)'], { stdio: 'ignore' });
    if (escapee.pid !== undefined) appendFileSync(escapeLog, `${escapee.pid}\n`);
  }, 100);
}

setInterval(() => {}, 1_000);
