#!/usr/bin/env node
// Fails when a command leaves new `byok-*` entries in the original TMPDIR.
//
//   node scripts/ci/check-tmpdir-leaks.mjs snapshot <file>   # before the tests
//   node scripts/ci/check-tmpdir-leaks.mjs verify <file>     # after the tests
//
// Test suites must create scratch directories under the per-run root installed
// by scripts/vitest/tmp-root.mjs. Anything that still lands in the real TMPDIR
// is a leak. Only entries absent from the snapshot count, so pre-existing
// residue never fails a run; removing it is a separate, owner-gated decision.
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export const LEAK_PREFIX = 'byok-';

export function listEntries(directory, prefix = LEAK_PREFIX) {
  return readdirSync(directory).filter(name => name.startsWith(prefix)).sort();
}

export function findNewEntries(baseline, current) {
  const known = new Set(baseline);
  return current.filter(name => !known.has(name));
}

function main(argv) {
  const [mode, file] = argv;
  if ((mode !== 'snapshot' && mode !== 'verify') || !file) {
    console.error('usage: check-tmpdir-leaks.mjs <snapshot|verify> <file>');
    return 2;
  }
  if (mode === 'snapshot') {
    const directory = realpathSync(os.tmpdir());
    const directories = [{ directory, prefix: LEAK_PREFIX }];
    // globalSetup uses /tmp on POSIX to keep socket paths short. Check its
    // run roots too when the caller's original TMPDIR is somewhere else.
    if (process.platform !== 'win32' && realpathSync('/tmp') !== directory) {
      directories.push({ directory: realpathSync('/tmp'), prefix: 'byok-t-' });
    }
    const snapshot = directories.map(({ directory, prefix }) => ({ directory, prefix, entries: listEntries(directory, prefix) }));
    writeFileSync(file, JSON.stringify(snapshot));
    for (const { directory, prefix, entries } of snapshot) {
      console.log(`tmpdir snapshot: ${entries.length} ${prefix}* entries in ${directory}`);
    }
    return 0;
  }
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(snapshot) || snapshot.length === 0) throw new Error('invalid tmpdir snapshot');
  let leaks = 0;
  for (const { directory, prefix, entries } of snapshot) {
    if (typeof directory !== 'string' || typeof prefix !== 'string' || !Array.isArray(entries)
        || !entries.every(name => typeof name === 'string')) throw new Error('invalid tmpdir snapshot');
    const leaked = findNewEntries(entries, listEntries(directory, prefix));
    if (leaked.length === 0) {
      console.log(`tmpdir clean: no new ${prefix}* entries in ${directory}`);
      continue;
    }
    leaks += leaked.length;
    console.error(`tmpdir leak: ${leaked.length} new ${prefix}* entries in ${directory}`);
    for (const name of leaked.slice(0, 20)) console.error(`  ${name}`);
    if (leaked.length > 20) console.error(`  ... and ${leaked.length - 20} more`);
  }
  if (leaks) console.error('Tests must create temp dirs through os.tmpdir() under the per-run root (scripts/vitest/tmp-root.mjs).');
  return leaks ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
