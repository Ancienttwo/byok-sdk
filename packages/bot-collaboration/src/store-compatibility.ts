import { statSync, type Stats } from 'node:fs';
import { resolve } from 'node:path';
import { readSqliteSnapshot, SqliteSnapshotError } from '@byok-sdk/core/sqlite-node';
import { HostLedger } from '@byok-sdk/server/execution-core';
import type { StoreCompatibility } from '@byok-sdk/client';
import { botLedgerOptions } from './compaction.js';
import { stateOf } from './model.js';
import { refuseUnmigratedWouldDo } from './rules/autonomy.js';
import { checkTopology } from './topology.js';
import { checkSwitchRecords } from './switch.js';

/** Inspect a stopped L ledger on a private copy, including its WAL or rollback journal. */
export function inspectLedger(path: string, tenant: string): StoreCompatibility {
  const file = resolve(path), store = 'bot-collaboration-ledger' as const;
  const stat = statOrUndefined(file);
  if (!stat) return { store, path: file, verdict: 'absent', reason: 'No ledger file at this path' };
  if (!stat.isFile()) return { store, path: file, verdict: 'rejected', reason: 'The ledger path is not a regular file' };
  try {
    return readSqliteSnapshot(file, (db, copy) => {
      try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_ledger'").get()) throw new Error('Not a Host ledger');
        const ledger = new HostLedger(copy, tenant, botLedgerOptions);
        try {
          const state = stateOf(ledger.snapshot().application);
          refuseUnmigratedWouldDo(state);
          checkTopology(state); checkSwitchRecords(state);
          return { store, path: file, verdict: 'accepted' as const, reason: 'This build opens the ledger' };
        } finally { ledger.close(); }
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        return { store, path: file, verdict: 'rejected' as const, ...(typeof code === 'string' ? { code } : {}),
          reason: error instanceof Error ? error.message : String(error) };
      }
    }) ?? { store, path: file, verdict: 'rejected', reason: 'Not a Host ledger' };
  } catch (error) {
    if (error instanceof SqliteSnapshotError && error.reason === 'changed') throw error;
    return { store, path: file, verdict: 'rejected', reason: error instanceof Error ? error.message : String(error) };
  }
}

function statOrUndefined(file: string): Stats | undefined {
  try { return statSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
