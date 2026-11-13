import { copyFileSync, mkdtempSync, rmSync, statSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { HostLedger } from '@byok-sdk/server/execution-core';
import type { StoreCompatibility } from '@byok-sdk/core';
import { wouldDoNeedsMigration } from './commit.js';
import { OldCollaborationStateError, stateOf } from './model.js';

/** Inspect a stopped L ledger on a private copy, including its WAL or rollback journal. */
export function inspectLedger(path: string, tenant: string): StoreCompatibility {
  const file = resolve(path), store = 'bot-collaboration-ledger' as const;
  const stat = statOrUndefined(file);
  if (!stat) return { store, path: file, verdict: 'absent', reason: 'No ledger file at this path' };
  if (!stat.isFile()) return { store, path: file, verdict: 'rejected', reason: 'The ledger path is not a regular file' };
  const directory = mkdtempSync(join(tmpdir(), 'byok-ledger-check-'));
  try {
    const copy = join(directory, basename(file)), suffixes = ['', '-wal', '-journal'];
    const fingerprint = (suffix: string) => { const s = statOrUndefined(file + suffix); return s && `${s.size}:${s.mtimeMs}:${s.ino}`; };
    const before = suffixes.map(fingerprint);
    suffixes.forEach((suffix, i) => { if (before[i] !== undefined) copyFileSync(file + suffix, copy + suffix); });
    if (suffixes.some((suffix, i) => fingerprint(suffix) !== before[i])) throw new Error(`${file} changed while it was being checked; stop its owner and check again`);
    try {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      const db = new DatabaseSync(copy, { readOnly: true });
      try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_ledger'").get()) throw new Error('Not a Host ledger');
      } finally { db.close(); }
      const ledger = new HostLedger(copy, tenant);
      try {
        const state = stateOf(ledger.snapshot().application);
        return wouldDoNeedsMigration(state)
          ? { store, path: file, verdict: 'migration-required', reason: 'Would-do rows lack turnId; run migrateWouldDo before serving' }
          : { store, path: file, verdict: 'accepted', reason: 'This build opens the ledger' };
      } finally { ledger.close(); }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return { store, path: file, verdict: error instanceof OldCollaborationStateError ? 'new-path-repair' : 'rejected',
        ...(typeof code === 'string' ? { code } : {}), reason: error instanceof Error ? error.message : String(error) };
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function statOrUndefined(file: string): Stats | undefined {
  try { return statSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
