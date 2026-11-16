import { inspectDaemonStores } from '@byok-sdk/client';
import { inspectProviderProfileStore } from '@byok-sdk/keys';
import { inspectSqliteStore } from '@byok-sdk/server';

type StoreCompatibility = Awaited<ReturnType<typeof inspectSqliteStore>>;

/** The stores the Host checks before it opens any of them. */
export interface HostStorePaths {
  readonly storeDir: string;
  readonly serverDb: string;
  readonly keysDb: string;
}

/** A store this build will not open as it is. The Host stops with this reason; nothing repairs the store. */
export class HostStoreRefusedError extends Error {
  readonly store: StoreCompatibility;
  constructor(store: StoreCompatibility) {
    super(`Store ${store.store} at ${store.path} is ${store.verdict}${store.code ? ` (${store.code})` : ''}: ${store.reason}`);
    this.name = 'HostStoreRefusedError';
    this.store = store;
  }
}

/**
 * Runs the SDK store inspectors before any store opens. Every store is checked
 * before any store opens, so a refusal leaves every file as it was. Any
 * verdict other than `accepted` or `absent` refuses.
 */
export async function precheckHostStores(paths: HostStorePaths): Promise<void> {
  const stores = [
    ...await inspectDaemonStores({ storeDir: paths.storeDir }),
    await inspectSqliteStore(paths.serverDb),
    await inspectProviderProfileStore(paths.keysDb),
  ];
  const refused = stores.find(store => store.verdict !== 'accepted' && store.verdict !== 'absent');
  if (refused) throw new HostStoreRefusedError(refused);
}
