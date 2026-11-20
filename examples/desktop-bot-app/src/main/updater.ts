import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { resolveHostLayout } from '@byok-sdk/client/host-layout';
import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import brand from '../../brand.config.ts';
import { hostStoresDir, markSnapshotComplete, moveAll, moveBack, snapshotsDir } from '../recovery/stores.ts';

export interface UpdaterOptions {
  /** Stops the Host; resolves once it has closed its stores. */
  readonly beforeInstall: () => Promise<void>;
}

/**
 * Copies the stores of the running version, after the Host stopped, so a user
 * can go back to this version with the data it wrote: the SDK store directory
 * (without its scratch root) and the Host's own stores (`<hostStorageRoot>/host`,
 * where src/host/compose.ts keeps them). Snapshots live in
 * `<hostStorageRoot>/host/snapshots/<version>`. Each snapshot is staged and
 * marked complete in a sibling temporary directory before swapping into
 * `<version>`, so a failed retry keeps any existing complete snapshot of the
 * same version intact; superseded entries in `snapshots/` are removed only
 * after `<version>` is in place. Returns the snapshot directory.
 */
export async function snapshotStores(version: string): Promise<string> {
  const layout = resolveHostLayout({ productId: brand.productId, productName: brand.productName });
  const hostDir = hostStoresDir(layout);
  const snapshots = snapshotsDir(layout);
  const target = path.join(snapshots, version);
  await mkdir(snapshots, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(snapshots, `.${version}.staging-`));
  try {
    await cp(layout.storeDir, path.join(staging, 'store'), { recursive: true, filter: source => source !== layout.scratchRoot.path });
    // The snapshot directory is inside the directory it copies, so its entries are copied one by one, never `snapshots` itself.
    await mkdir(path.join(staging, 'host'), { mode: 0o700 });
    for (const entry of await readdir(hostDir)) {
      if (entry !== 'snapshots') await cp(path.join(hostDir, entry), path.join(staging, 'host', entry), { recursive: true });
    }
    await markSnapshotComplete(staging, version);
    const previous = path.join(snapshots, `.${version}.previous-${randomUUID()}`);
    const done = await moveAll([{ from: target, to: previous }]);
    try {
      await rename(staging, target);
    } catch (error) {
      await moveBack(done, error);
    }
  } catch (error) {
    try {
      await rm(staging, { recursive: true, force: true, maxRetries: 5 });
    } catch (cleanup) {
      throw new Error(`${(error as Error).message}; the staged snapshot could not be removed: ${(cleanup as Error).message}`, { cause: error });
    }
    throw error;
  }
  for (const entry of await readdir(snapshots)) {
    if (entry !== version) await rm(path.join(snapshots, entry), { recursive: true, force: true, maxRetries: 5 });
  }
  return target;
}

async function offerInstall(version: string, options: UpdaterOptions): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Restart and update', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: `${brand.productName} ${version} is ready to install.`,
    detail: `The app stops, keeps a copy of the data of version ${app.getVersion()}, and restarts on ${version}.`,
  });
  if (response !== 0) return;
  try {
    await options.beforeInstall();
    console.error(`Stores of ${app.getVersion()} copied to ${await snapshotStores(app.getVersion())}`);
  } catch (error) {
    // Nothing is installed without the snapshot; the Host has stopped, so the app restarts on this version.
    console.error(`Update not installed: ${(error as Error).message}`);
    dialog.showErrorBox('Update not installed', (error as Error).message);
    app.relaunch();
    app.quit();
    return;
  }
  electronUpdater.autoUpdater.quitAndInstall();
}

/**
 * Checks the update feed this build was packaged with: electron-builder writes
 * resources/app-update.yml only when BYOK_UPDATE_FEED_URL was set
 * (electron-builder.config.mjs). Dev runs and a build without a feed have no
 * updater. A downloaded update installs only when the user agrees, after the
 * Host stopped and its stores were copied (`snapshotStores`).
 */
export function startUpdater(options: UpdaterOptions): void {
  if (!app.isPackaged) return;
  if (!existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    console.error('Updater off: this build has no update feed');
    return;
  }
  const { autoUpdater } = electronUpdater;
  // A failed check both rejects and emits 'error' with the same error; it is logged once.
  const reported = new WeakSet<Error>();
  const logFailure = (error: Error) => {
    if (reported.has(error)) return;
    reported.add(error);
    console.error(`Update failed: ${error.message}`);
  };
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('error', logFailure);
  autoUpdater.on('update-downloaded', ({ version }: { version: string }) => {
    // The user asked for this install, so a failure in it is shown, not only logged.
    offerInstall(version, options).catch((error: Error) => {
      logFailure(error);
      dialog.showErrorBox('Update not installed', error.message);
    });
  });
  autoUpdater.checkForUpdates().catch(logFailure);
}
