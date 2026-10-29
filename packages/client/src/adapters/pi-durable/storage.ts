import type { Storage } from '@earendil-works/pi-durable';
import { inspectReplicaDatabase } from './replica';

/** Construction only: backends return pi's native Storage without translating its methods. */
export type DurableStorageFactory<Location> = (location: Location) => Promise<Storage>;

export const openLocalDurableStorage: DurableStorageFactory<string> = async file => {
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
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
