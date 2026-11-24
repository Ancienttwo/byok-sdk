import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, autoUpdater as electronAutoUpdater, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import brand from '../../brand.config.ts';
import { SNAPSHOT_COMMAND, type SnapshotReceipt } from '../recovery/protocol.ts';
import { askHostCommand, type CommandChild } from './host-command.ts';
import { MaintenanceBusyError, type MaintenanceLock } from './maintenance-lock.ts';

export interface UpdaterOptions {
  /** Stops the Host; resolves once it has closed its stores. */
  readonly beforeInstall: () => Promise<void>;
  /** Spawns the Host executable with these arguments (S1 snapshot). */
  readonly spawnHostCommand: (args: readonly string[]) => CommandChild;
  /** Shared process-wide lock held from Host stop through S1 helper completion and terminal handover. */
  readonly maintenanceLock: MaintenanceLock;
  readonly currentVersion?: () => string;
  readonly confirmInstall?: (version: string, currentVersion: string) => Promise<boolean>;
  readonly quitAndInstall?: () => Promise<boolean> | boolean;
  readonly installHandoverTimeoutMs?: number;
  readonly showError?: (title: string, message: string) => void;
  readonly relaunchAndQuit?: () => void;
}

export interface QuitAndInstallSources {
  readonly autoUpdater: {
    quitAndInstall(): void;
    once(event: 'error', listener: (error: Error) => void): unknown;
    removeListener(event: 'error', listener: (error: Error) => void): unknown;
  };
  readonly nativeUpdater: {
    once(event: 'before-quit-for-update', listener: () => void): unknown;
    removeListener(event: 'before-quit-for-update', listener: () => void): unknown;
  };
  readonly appEvents: {
    once(event: 'before-quit', listener: () => void): unknown;
    removeListener(event: 'before-quit', listener: () => void): unknown;
  };
  readonly timeoutMs: number;
}

/**
 * Invokes `electron-updater`'s `quitAndInstall()` and resolves `true` only
 * when Electron emits `before-quit-for-update` or `before-quit`. Resolves
 * `false` if `quitAndInstall()` returns without scheduling quit within
 * `timeoutMs`, and rejects if `autoUpdater` emits `error` or throws.
 */
export function requestQuitAndInstall(sources: QuitAndInstallSources): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      sources.autoUpdater.removeListener('error', onError);
      sources.nativeUpdater.removeListener('before-quit-for-update', onConfirmed);
      sources.appEvents.removeListener('before-quit', onConfirmed);
    };
    const onConfirmed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    }, sources.timeoutMs);
    timer.unref?.();

    sources.autoUpdater.once('error', onError);
    sources.nativeUpdater.once('before-quit-for-update', onConfirmed);
    sources.appEvents.once('before-quit', onConfirmed);
    try {
      sources.autoUpdater.quitAndInstall();
    } catch (error) {
      onError(error as Error);
    }
  });
}

/**
 * Invokes the Host executable's S1 snapshot command after the Host has stopped
 * and returns the finalized snapshot directory.
 */
export async function requestHostSnapshot(
  spawnHostCommand: (args: readonly string[]) => CommandChild,
  version: string,
): Promise<string> {
  const unknown = (message: string) => new Error(`Snapshot did not report: ${message}`);
  const { receipt, code } = await askHostCommand(spawnHostCommand([SNAPSHOT_COMMAND, version]), '', unknown);
  const answer = receipt as unknown as SnapshotReceipt;
  if (!answer.ok) throw new Error(`Snapshot failed (${answer.code}): ${answer.message}`);
  if (code !== 0) throw unknown(`it exited with code ${code} after its receipt`);
  return answer.target;
}

/**
 * Installs `version` only after user confirmation, confirmed Host shutdown
 * (`beforeInstall`), and successful S1 Host snapshot (`SNAPSHOT_COMMAND`).
 * Aborts without snapshotting, installing, or relaunching when `beforeInstall`
 * fails so original stores remain untouched.
 */
export async function offerInstall(version: string, options: UpdaterOptions): Promise<boolean> {
  const current = (options.currentVersion ?? (() => app.getVersion()))();
  const confirm = options.confirmInstall ?? (async (nextVersion, runningVersion) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `${brand.productName} ${nextVersion} is ready to install.`,
      detail: `The app stops, keeps a copy of the data of version ${runningVersion}, and restarts on ${nextVersion}.`,
    });
    return response === 0;
  });
  const showError = options.showError ?? ((title, message) => dialog.showErrorBox(title, message));
  const relaunchAndQuit = options.relaunchAndQuit ?? (() => {
    app.relaunch();
    app.quit();
  });
  const quitAndInstall = options.quitAndInstall ?? (() => requestQuitAndInstall({
    autoUpdater: electronUpdater.autoUpdater,
    nativeUpdater: electronAutoUpdater,
    appEvents: app,
    timeoutMs: options.installHandoverTimeoutMs ?? (process.platform === 'darwin' ? 15_000 : 2_000),
  }));

  if (!await confirm(version, current)) return false;

  try {
    return await options.maintenanceLock.run(async handover => {
      // Phase 1: Confirm Host stopped before invoking any S1 filesystem command.
      try {
        await options.beforeInstall();
      } catch (error) {
        const message = (error as Error).message;
        console.error(`Host stop failed before update: ${message}`);
        showError('Update not installed', message);
        return false;
      }

      // Phase 2: Host is stopped; snapshot via S1 before quitAndInstall.
      try {
        const target = await requestHostSnapshot(options.spawnHostCommand, current);
        console.error(`Stores of ${current} copied to ${target}`);
      } catch (error) {
        // Nothing is installed without the snapshot; the Host has stopped, so the app restarts on this version.
        const message = (error as Error).message;
        console.error(`Update not installed: ${message}`);
        showError('Update not installed', message);
        if (!options.maintenanceLock.isQuitting()) {
          handover.confirm();
          relaunchAndQuit();
        }
        return false;
      }

      handover.beginPending();
      let takenOver = false;
      let handoverError: string | undefined;
      try {
        takenOver = await quitAndInstall();
      } catch (error) {
        handoverError = (error as Error).message;
      }
      if (takenOver) {
        handover.confirm();
        return true;
      }

      handover.cancelPending();
      const message = handoverError ?? 'Updater did not start installing the update';
      console.error(`Update not installed: ${message}`);
      showError('Update not installed', message);
      if (!options.maintenanceLock.isQuitting()) {
        handover.confirm();
        relaunchAndQuit();
      }
      return false;
    });
  } catch (error) {
    if (error instanceof MaintenanceBusyError) {
      console.error(`Update not installed: ${error.message}`);
      showError('Update not installed', error.message);
      return false;
    }
    throw error;
  }
}

/**
 * Checks the update feed this build was packaged with: electron-builder writes
 * resources/app-update.yml only when BYOK_UPDATE_FEED_URL was set
 * (electron-builder.config.mjs). Dev runs and a build without a feed have no
 * updater. A downloaded update installs only when the user agrees, after the
 * Host stopped and its stores were copied via S1.
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
    void offerInstall(version, options).catch((error: Error) => {
      logFailure(error);
      dialog.showErrorBox('Update not installed', error.message);
    });
  });
  autoUpdater.checkForUpdates().catch(logFailure);
}
