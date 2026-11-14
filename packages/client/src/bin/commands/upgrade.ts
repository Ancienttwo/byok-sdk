import path from 'node:path';
import type { StoreCompatibility } from '@byok-sdk/core';
import { readServiceInstallationState, ServiceInstallationError, type ServiceInstallation, type ServiceUpgradeReceipt } from '../../lifecycle/service-installation.js';
import { inspectDaemonStores } from '../../diagnostics/store-compatibility.js';
import { checkUpgradeFrom } from '../../lifecycle/upgrade-from.js';
import { OFFICIAL_LOCAL_AGENT_RELEASE } from '../official-release.js';

/** Exit code when the check ran and at least one store is `new-path-repair` or `rejected`. */
export const UPGRADE_CHECK_REFUSED_EXIT_CODE = 2;

export interface UpgradeStoreCheckOptions {
  readonly storeDir: string;
  readonly json: boolean;
  readonly log?: (line: string) => void;
}

/**
 * `byok-agent upgrade check --store`: run by the candidate build before a
 * switch, it reports per daemon store whether this build accepts it, opens it
 * only after its migration (`migration-required`), needs a new path and
 * pairing (`new-path-repair`), or refuses it (`rejected`). Read-only: every
 * store is opened only as a private temporary copy.
 *
 * Returns the process exit code: {@link UPGRADE_CHECK_REFUSED_EXIT_CODE} when a
 * store is `new-path-repair` or `rejected`, 0 otherwise. A failure to check throws.
 */
export async function runUpgradeStoreCheckCommand(options: UpgradeStoreCheckOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const stores = await inspectDaemonStores({ storeDir: options.storeDir });
  if (options.json) {
    log(JSON.stringify({ version: OFFICIAL_LOCAL_AGENT_RELEASE.version, stores }, null, 2));
  } else {
    log(`byok-agent ${OFFICIAL_LOCAL_AGENT_RELEASE.version} store check`);
    for (const store of stores) log(formatStore(store));
    if (stores.some((store) => store.verdict === 'migration-required')) {
      log('Run this build\'s store migration before it opens a migration-required store.');
    }
  }
  return stores.some((store) => store.verdict === 'new-path-repair' || store.verdict === 'rejected')
    ? UPGRADE_CHECK_REFUSED_EXIT_CODE
    : 0;
}

/**
 * `byok-agent upgrade check --from <version>` (#1316): the breaking manifest
 * entries since `fromVersion` and the train of `@byok-sdk/*` packages that
 * resolve from the working directory. Returns 0 on `pass`,
 * {@link UPGRADE_CHECK_REFUSED_EXIT_CODE} otherwise.
 */
export function runUpgradeFromCheckCommand(options: {
  readonly fromVersion: string; readonly json: boolean; readonly resolveFrom?: string; readonly log?: (line: string) => void;
}): number {
  const log = options.log ?? ((line: string) => console.log(line));
  const report = checkUpgradeFrom(options.fromVersion, options.resolveFrom === undefined ? {} : { resolveFrom: options.resolveFrom });
  if (options.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    log(`byok-agent upgrade check ${report.from} -> ${report.to ?? '(unresolved)'}: ${report.verdict}`);
    if (report.refusal !== undefined) log(`${report.refusal.code} — ${report.refusal.message}`);
    for (const entry of report.breaking) log(`breaking ${entry.release} ${entry.id} — ${entry.summary} — ${entry.migration}`);
    log(`additive entries: ${report.additiveCount}`);
    for (const pkg of report.train.packages) log(`${pkg.version === 'absent' || pkg.version === report.train.version ? 'train' : 'train-mismatch'} ${pkg.name} ${pkg.version}`);
  }
  return report.verdict === 'pass' ? 0 : UPGRADE_CHECK_REFUSED_EXIT_CODE;
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
  const { current, receipt, receiptError } = await readServiceInstallationState(installRoot);
  if (receiptError === undefined) return reportInstallationState(current, receipt, options);
  const { message } = new ServiceInstallationError(receiptError);
  const log = options.log ?? ((line: string) => console.log(line));
  if (options.json) {
    log(JSON.stringify({ current: current ?? null, receipt: null, receiptError: { code: receiptError, message } }, null, 2));
    return;
  }
  log(`current: ${current ?? '(none)'}`);
  log(`receipt: refused code=${receiptError} ${message}`);
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
