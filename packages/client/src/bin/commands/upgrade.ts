import type { StoreCompatibility } from '@byok-sdk/core';
import { inspectDaemonStores } from '../../upgrade-check/store-compatibility';
import { OFFICIAL_LOCAL_AGENT_RELEASE } from '../official-release';

/** Exit code when the check ran and at least one store would not be opened as it is. */
export const UPGRADE_CHECK_REFUSED_EXIT_CODE = 2;

export interface UpgradeStoreCheckOptions {
  readonly storeDir: string;
  readonly json: boolean;
  readonly log?: (line: string) => void;
}

/**
 * `byok-agent upgrade check --store`: run by the candidate build before a
 * switch, it reports per daemon store whether this build accepts it, needs a
 * new path and pairing (`new-path-repair`), or refuses it (`rejected`).
 * Read-only: every store is opened only as a private temporary copy.
 *
 * Returns the process exit code: 0 when every store is `accepted` or `absent`,
 * {@link UPGRADE_CHECK_REFUSED_EXIT_CODE} otherwise. A failure to check throws.
 */
export async function runUpgradeStoreCheckCommand(options: UpgradeStoreCheckOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const stores = await inspectDaemonStores({ storeDir: options.storeDir });
  if (options.json) {
    log(JSON.stringify({ version: OFFICIAL_LOCAL_AGENT_RELEASE.version, stores }, null, 2));
  } else {
    log(`byok-agent ${OFFICIAL_LOCAL_AGENT_RELEASE.version} store check`);
    for (const store of stores) log(formatStore(store));
  }
  return stores.every((store) => store.verdict === 'accepted' || store.verdict === 'absent')
    ? 0
    : UPGRADE_CHECK_REFUSED_EXIT_CODE;
}

function formatStore(store: StoreCompatibility): string {
  const code = store.code === undefined ? '' : ` code=${store.code}`;
  return `${store.verdict} ${store.store} ${store.path}${code} — ${store.reason}`;
}
