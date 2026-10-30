import path from 'node:path';
import type { StoreCompatibility } from '@byok-sdk/core';
import { readServiceInstallationState, type ServiceInstallation, type ServiceUpgradeReceipt } from '../../lifecycle/service-installation';
import { inspectDaemonStores } from '../../diagnostics/store-compatibility';
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

export const UPGRADE_INSTALLATION_ACTIONS = ['apply', 'rollback', 'recover', 'status'] as const;
export type UpgradeInstallationAction = (typeof UPGRADE_INSTALLATION_ACTIONS)[number];

export interface UpgradeInstallationOptions {
  readonly action: Exclude<UpgradeInstallationAction, 'status'>;
  /** The payload directory, for `apply`. */
  readonly payload?: string;
  readonly json: boolean;
  readonly log?: (line: string) => void;
}

/**
 * `byok-agent upgrade apply <payload>|rollback|recover` (#1097): the payload
 * installation recorded for this store, through the same API an embedded
 * Host calls. A refusal or a failed health check throws
 * `ServiceInstallationError`; its receipt is written first.
 */
export async function runUpgradeInstallationCommand(installation: ServiceInstallation, options: UpgradeInstallationOptions): Promise<void> {
  let receipt: ServiceUpgradeReceipt | undefined;
  switch (options.action) {
    case 'apply':
      receipt = await installation.upgrade(path.resolve(options.payload!));
      break;
    case 'rollback':
      receipt = await installation.rollback();
      break;
    case 'recover':
      receipt = await installation.recover();
      break;
  }
  reportInstallationState(await installation.currentVersion(), receipt, options);
}

/** `byok-agent upgrade status`: reads the install root only, so it takes no service or WinSW inputs. */
export async function runUpgradeStatusCommand(installRoot: string, options: { readonly json: boolean; readonly log?: (line: string) => void }): Promise<void> {
  const { current, receipt } = await readServiceInstallationState(installRoot);
  reportInstallationState(current, receipt, options);
}

function reportInstallationState(
  current: string | undefined, receipt: ServiceUpgradeReceipt | undefined, options: { readonly json: boolean; readonly log?: (line: string) => void },
): void {
  const log = options.log ?? ((line: string) => console.log(line));
  if (options.json) {
    log(JSON.stringify({ current: current ?? null, receipt: receipt ?? null }, null, 2));
    return;
  }
  log(`current: ${current ?? '(none)'}`);
  log(receipt === undefined ? 'receipt: (none)' : `receipt: ${receipt.state} from=${receipt.from} to=${receipt.to} at=${receipt.at}${receipt.code === undefined ? '' : ` code=${receipt.code}`}`);
}
