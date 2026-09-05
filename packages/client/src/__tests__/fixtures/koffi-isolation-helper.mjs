#!/usr/bin/env node
// Proves a non-win32 adoption never resolves `koffi`.
//
// Runs the REAL `adoptOwnedProcessTree` against a real child on a non-win32
// platform, in a real process, with every import specifier recorded by
// `./ts-source-resolve-hook.mjs`. An in-process assertion could not do this:
// vitest's own module graph is already loaded, and `koffi` is reached through a
// dynamic import that a module-registry snapshot taken in the wrong worker
// would miss.
//
// argv: <platform> <useDefaultJobObject 0|1>
//
// The second argument is the control: with the DEFAULT job object and
// `platform=win32`, the same run must record `koffi` in the log (it then fails,
// because kernel32 is not loadable off Windows). Without that control the
// absence of `koffi` on the POSIX run would prove nothing about the recorder.
//
// Run with `node --import ./ts-source-resolve-hook.mjs` and `BYOK_RESOLVE_LOG`.

import { spawn } from 'node:child_process';
import { adoptOwnedProcessTree, withOwnedProcessTree } from '../../adapters/process-tree.ts';

const [platform, useDefaultJobObject] = process.argv.slice(2);

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2_000)'], withOwnedProcessTree({
  stdio: 'ignore',
}));

try {
  await adoptOwnedProcessTree({
    child,
    label: 'koffi-isolation',
    platform,
    // A seam that throws if the non-win32 branch ever reaches for the job
    // object, so the resolve log is corroborated rather than trusted alone.
    ...(useDefaultJobObject === '1' ? {} : {
      jobObject: {
        assign() {
          throw new Error('koffi-isolation: the non-win32 branch reached the job object');
        },
      },
    }),
  });
  process.stdout.write('adopted\n');
} catch (error) {
  process.stdout.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  child.kill('SIGKILL');
}

process.exit(0);
