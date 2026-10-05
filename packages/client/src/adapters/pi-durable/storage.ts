import type { Storage } from '@earendil-works/pi-durable';

/** Construction only: backends return pi's native Storage without translating its methods. */
export type DurableStorageFactory<Location> = (location: Location) => Promise<Storage>;

export const openLocalDurableStorage: DurableStorageFactory<string> = async file => {
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
  return openNodeSqliteStorage(file);
};
