import type { Storage } from '@earendil-works/pi-durable';
import { readSqliteFileUnchanged } from '@byok-sdk/core/sqlite-node';
import { existsSync } from 'node:fs';
import { inspectReplicaDatabase, readInRolledBackTransaction } from './replica.js';

/** Construction only: backends return pi's native Storage without translating its methods. */
export type DurableStorageFactory<Location> = (location: Location) => Promise<Storage>;

/** A replica written in a pi-durable schema version other than the pinned one. The file is left as it is. */
export class DurableReplicaFormatError extends Error {
  readonly code = 'DURABLE_REPLICA_FORMAT';
  constructor(file: string, found: string, current: number) {
    super(`durable replica ${file} has ${found}; this build reads pi-durable schema ${current} and does not migrate replicas`);
    this.name = 'DurableReplicaFormatError';
  }
}

/**
 * pi-durable migrates an older replica forward when it opens it, so the
 * schema version is decided before pi-durable sees the file: on the unchanged
 * main file, and, when the main file holds no schema while a WAL exists (a
 * replica that crashed before its first checkpoint), on a writable connection
 * in a rolled-back transaction that is closed before pi-durable opens the file.
 */
export const openLocalDurableStorage: DurableStorageFactory<string> = async file => {
  const [{ openNodeSqliteStorage }, { CURRENT_SQLITE_SCHEMA_VERSION }] = await Promise.all([
    import('@earendil-works/pi-durable/storage/sqlite/node'),
    import('@earendil-works/pi-durable/storage/sqlite'),
  ]);
  const assertCurrent = (db: import('node:sqlite').DatabaseSync): 'empty' | 'current' => {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get() === undefined) return 'empty';
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'durable_schema'").get();
    const row = table === undefined ? undefined : db.prepare('SELECT version FROM durable_schema WHERE singleton = 1').get() as { version: unknown } | undefined;
    if (row?.version !== CURRENT_SQLITE_SCHEMA_VERSION) {
      throw new DurableReplicaFormatError(file, row === undefined ? 'no durable_schema version' : `schema ${String(row.version)}`, CURRENT_SQLITE_SCHEMA_VERSION);
    }
    return 'current';
  };
  if (readSqliteFileUnchanged(file, assertCurrent) === 'empty' && existsSync(`${file}-wal`)) readInRolledBackTransaction(file, assertCurrent);
  return openNodeSqliteStorage(file);
};

/** Compatibility inspection must not initialize a candidate that was never a replica. */
export const openExistingLocalDurableStorage: DurableStorageFactory<string> = async file => {
  inspectReplicaDatabase(file, (db) => {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'durable_schema'").get() === undefined) {
      throw new Error('Existing durable replica has no durable_schema table');
    }
  });
  return openLocalDurableStorage(file);
};
