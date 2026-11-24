import { EventEmitter } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_COMMAND } from '../recovery/protocol.ts';

let root: string;
const fsRef = vi.hoisted(() => ({ actual: undefined as unknown as typeof import('node:fs/promises') }));

vi.mock('node:fs/promises', async importOriginal => {
  fsRef.actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fsRef.actual,
    cp: vi.fn(fsRef.actual.cp),
    rename: vi.fn(fsRef.actual.rename),
    writeFile: vi.fn(fsRef.actual.writeFile),
  };
});
vi.mock('electron', () => ({ app: {}, autoUpdater: {}, dialog: {} }));
vi.mock('electron-updater', () => ({ default: {} }));

const { MaintenanceBusyError, createBeforeQuitHandler, createMaintenanceLock } = await import('./maintenance-lock.ts');
const { offerInstall, requestQuitAndInstall } = await import('./updater.ts');
const { completeSnapshot, restoreSnapshot, snapshotStores } = await import('../recovery/stores.ts');
const layout = () => ({ storeDir: path.join(root, 'store'), scratchRoot: { path: path.join(root, 'store', 'tmp') }, hostStorageRoot: path.join(root, 'app') });

const write = async (file: string, text: string) => {
  await fsRef.actual.mkdir(path.dirname(file), { recursive: true });
  await fsRef.actual.writeFile(file, text);
};

describe('snapshotStores', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'updater-'));
    await write(path.join(root, 'store', 'device.json'), 'store');
    await write(path.join(root, 'app', 'host', 'settings.json'), 'host');
  });
  afterEach(async () => {
    vi.mocked(cp).mockImplementation(fsRef.actual.cp);
    vi.mocked(rename).mockImplementation(fsRef.actual.rename);
    vi.mocked(writeFile).mockImplementation(fsRef.actual.writeFile);
    await rm(root, { recursive: true, force: true });
  });

  it('copies the host stores without the snapshots directory and keeps only the latest', async () => {
    const snapshots = path.join(root, 'app', 'host', 'snapshots');
    await write(path.join(snapshots, '1.0.0', 'host', 'old.json'), 'old');
    const target = await snapshotStores(layout(), '2.0.0');
    expect(target).toBe(path.join(snapshots, '2.0.0'));
    expect(await readdir(path.join(target, 'host'))).toEqual(['settings.json']);
    expect(await readFile(path.join(target, 'store', 'device.json'), 'utf8')).toBe('store');
    expect(await readdir(snapshots)).toEqual(['2.0.0']);
    expect(await completeSnapshot(layout(), '2.0.0')).toBe(target);
  });

  it('prunes nothing when the snapshot fails', async () => {
    const snapshots = path.join(root, 'app', 'host', 'snapshots');
    const prior = await snapshotStores(layout(), '1.0.0');
    await rm(path.join(root, 'store'), { recursive: true });
    await expect(snapshotStores(layout(), '2.0.0')).rejects.toThrow();
    expect(await completeSnapshot(layout(), '1.0.0')).toBe(prior);
    expect(await readdir(snapshots)).toEqual(['1.0.0']);
    expect(await completeSnapshot(layout(), '2.0.0')).toBeUndefined();
    await expect(restoreSnapshot(layout(), '2.0.0', 's')).rejects.toThrow('No complete snapshot');
  });

  it.each(['store', 'host'] as const)('keeps the prior complete snapshot of the same version when retry fails copying %s', async failingCopy => {
    const snapshots = path.join(root, 'app', 'host', 'snapshots');
    const target = await snapshotStores(layout(), '2.0.0');
    await write(path.join(root, 'store', 'device.json'), 'newer-store');
    await write(path.join(root, 'app', 'host', 'settings.json'), 'newer-host');

    vi.mocked(cp).mockImplementation(async (source, destination, options) => {
      if (String(destination).endsWith(failingCopy === 'store' ? `${path.sep}store` : path.join('host', 'settings.json'))) {
        throw new Error(`${failingCopy} copy failed`);
      }
      return fsRef.actual.cp(source, destination, options);
    });

    await expect(snapshotStores(layout(), '2.0.0')).rejects.toThrow(`${failingCopy} copy failed`);
    expect(await completeSnapshot(layout(), '2.0.0')).toBe(target);
    expect(await readFile(path.join(target, 'store', 'device.json'), 'utf8')).toBe('store');
    expect(await readFile(path.join(target, 'host', 'settings.json'), 'utf8')).toBe('host');
    expect(await readdir(snapshots)).toEqual(['2.0.0']);
  });

  it('keeps the prior complete snapshot of the same version when retry fails writing complete.json', async () => {
    const snapshots = path.join(root, 'app', 'host', 'snapshots');
    const target = await snapshotStores(layout(), '2.0.0');
    await write(path.join(root, 'store', 'device.json'), 'newer-store');
    await write(path.join(root, 'app', 'host', 'settings.json'), 'newer-host');

    vi.mocked(writeFile).mockImplementation(async (file, data, options) => {
      if (String(file).endsWith(`${path.sep}complete.json`)) throw new Error('marker write failed');
      return fsRef.actual.writeFile(file, data, options);
    });

    await expect(snapshotStores(layout(), '2.0.0')).rejects.toThrow('marker write failed');
    expect(await completeSnapshot(layout(), '2.0.0')).toBe(target);
    expect(await readFile(path.join(target, 'store', 'device.json'), 'utf8')).toBe('store');
    expect(await readFile(path.join(target, 'host', 'settings.json'), 'utf8')).toBe('host');
    expect(await readdir(snapshots)).toEqual(['2.0.0']);
  });

  it.each(['aside', 'swap'] as const)('keeps the prior complete snapshot when retry fails during the %s handoff rename', async step => {
    const snapshots = path.join(root, 'app', 'host', 'snapshots');
    const target = await snapshotStores(layout(), '2.0.0');
    await write(path.join(root, 'store', 'device.json'), 'newer-store');
    await write(path.join(root, 'app', 'host', 'settings.json'), 'newer-host');

    let handoffFailed = false;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (!handoffFailed && (step === 'aside' ? from === target : to === target)) {
        handoffFailed = true;
        throw new Error(`${step} rename failed`);
      }
      return fsRef.actual.rename(from, to);
    });

    await expect(snapshotStores(layout(), '2.0.0')).rejects.toThrow(`${step} rename failed`);
    expect(handoffFailed).toBe(true);
    expect(await completeSnapshot(layout(), '2.0.0')).toBe(target);
    expect(await readFile(path.join(target, 'store', 'device.json'), 'utf8')).toBe('store');
    expect(await readFile(path.join(target, 'host', 'settings.json'), 'utf8')).toBe('host');
    expect(await readdir(snapshots)).toEqual(['2.0.0']);
  });

  it('replaces the prior complete snapshot of the same version and prunes temporary entries when retry succeeds', async () => {
    const snapshots = path.join(root, 'app', 'host', 'snapshots');
    await snapshotStores(layout(), '1.0.0');
    const target = await snapshotStores(layout(), '2.0.0');
    await write(path.join(root, 'store', 'device.json'), 'newer-store');
    await write(path.join(root, 'app', 'host', 'settings.json'), 'newer-host');

    expect(await snapshotStores(layout(), '2.0.0')).toBe(target);
    expect(await completeSnapshot(layout(), '2.0.0')).toBe(target);
    expect(await readFile(path.join(target, 'store', 'device.json'), 'utf8')).toBe('newer-store');
    expect(await readFile(path.join(target, 'host', 'settings.json'), 'utf8')).toBe('newer-host');
    expect(await readdir(snapshots)).toEqual(['2.0.0']);
  });

  it('restores a complete snapshot: the current stores move aside and the snapshots stay', async () => {
    await snapshotStores(layout(), '2.0.0');
    await write(path.join(root, 'store', 'device.json'), 'newer');
    await write(path.join(root, 'app', 'host', 'settings.json'), 'newer');

    const aside = await restoreSnapshot(layout(), '2.0.0', 's');
    expect(await readFile(path.join(root, 'store', 'device.json'), 'utf8')).toBe('store');
    expect(await readFile(path.join(root, 'app', 'host', 'settings.json'), 'utf8')).toBe('host');
    expect(await readFile(path.join(root, 'store.aside-s', 'device.json'), 'utf8')).toBe('newer');
    expect(await readFile(path.join(aside, 'settings.json'), 'utf8')).toBe('newer');
    expect(await completeSnapshot(layout(), '2.0.0')).toBe(path.join(root, 'app', 'host', 'snapshots', '2.0.0'));
  });

  it('moves everything back when the restore cannot finish', async () => {
    await snapshotStores(layout(), '2.0.0');
    await write(path.join(root, 'store', 'device.json'), 'newer');
    // An existing aside name refuses the second move, after the first one happened.
    await mkdir(path.join(root, 'app', 'host.aside-s'));
    await expect(restoreSnapshot(layout(), '2.0.0', 's')).rejects.toThrow('already exists');
    expect(await readFile(path.join(root, 'store', 'device.json'), 'utf8')).toBe('newer');
    expect(await readdir(root)).toEqual(['app', 'store']);
  });

  it('moves everything back when the last rename fails after the staged copies took their places', async () => {
    const target = await snapshotStores(layout(), '2.0.0');
    // A snapshot whose host copy holds a non-empty snapshots directory blocks moving the real snapshots back in.
    await write(path.join(target, 'host', 'snapshots', 'stray'), 'x');
    await write(path.join(root, 'store', 'device.json'), 'newer');
    await expect(restoreSnapshot(layout(), '2.0.0', 's')).rejects.toThrow();
    expect(await readFile(path.join(root, 'store', 'device.json'), 'utf8')).toBe('newer');
    expect(await readFile(path.join(root, 'app', 'host', 'settings.json'), 'utf8')).toBe('host');
    expect(await completeSnapshot(layout(), '2.0.0')).toBe(target);
    expect((await readdir(root)).sort()).toEqual(['app', 'store']);
    expect((await readdir(path.join(root, 'app'))).sort()).toEqual(['host']);
  });
});

describe('offerInstall orchestration (#2459 S1 Host-stopped ordering)', () => {
  const receiptChild = (line: string, code: number) => {
    const stdout = new PassThrough();
    const events = new PassThrough();
    const child = {
      stdin: new PassThrough(),
      stdout,
      once: (event: string, listener: (...args: unknown[]) => void) => { events.once(event, listener); return child; },
    };
    child.stdin.on('finish', () => { stdout.end(`${line}\n`); events.emit('exit', code); });
    return child as never;
  };

  it('awaits Host stop confirmation before spawning S1 snapshot and installing', async () => {
    const events: string[] = [];
    let hostStopped = false;
    const installed = await offerInstall('2.0.0', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => { events.push('confirm'); return true; },
      beforeInstall: async () => {
        await Promise.resolve();
        hostStopped = true;
        events.push('beforeInstall');
      },
      spawnHostCommand: args => {
        expect(hostStopped).toBe(true);
        events.push(args.join(' '));
        return receiptChild(JSON.stringify({ ok: true, target: '/snap/1.0.0' }), 0);
      },
      showError: (title, msg) => { events.push(`error:${title}:${msg}`); },
      relaunchAndQuit: () => { events.push('relaunchAndQuit'); },
      quitAndInstall: () => { events.push('quitAndInstall'); return { status: 'confirmed' as const }; },
      maintenanceLock: createMaintenanceLock(),
    });

    expect(installed).toBe(true);
    expect(events).toEqual(['confirm', 'beforeInstall', `${SNAPSHOT_COMMAND} 1.0.0`, 'quitAndInstall']);
  });

  it('aborts without spawning S1 snapshot, installing, or relaunching when Host stop fails', async () => {
    const events: string[] = [];
    const maintenanceLock = createMaintenanceLock();
    const spawnHostCommand = vi.fn(() => {
      events.push('spawn');
      return receiptChild(JSON.stringify({ ok: true, target: '/snap/1.0.0' }), 0);
    });
    const installed = await offerInstall('2.0.0', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => { events.push('confirm'); return true; },
      beforeInstall: async () => {
        events.push('beforeInstall-fail');
        throw new Error('Host did not shut down within 10000 ms');
      },
      spawnHostCommand,
      showError: (title, msg) => { events.push(`error:${title}:${msg}`); },
      relaunchAndQuit: () => { events.push('relaunchAndQuit'); },
      quitAndInstall: () => { events.push('quitAndInstall'); return { status: 'confirmed' as const }; },
      maintenanceLock,
    });

    expect(installed).toBe(false);
    expect(spawnHostCommand).not.toHaveBeenCalled();
    expect(events).toEqual(['confirm', 'beforeInstall-fail', 'error:Update not installed:Host did not shut down within 10000 ms']);
    await expect(maintenanceLock.run(async () => 'retry-ok')).resolves.toBe('retry-ok');
  });

  it('relaunches without installing when Host stopped cleanly but S1 snapshot fails', async () => {
    const events: string[] = [];
    const installed = await offerInstall('2.0.0', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => true,
      beforeInstall: async () => { events.push('stopped'); },
      spawnHostCommand: args => {
        events.push(args.join(' '));
        return receiptChild(JSON.stringify({ ok: false, code: 'snapshot_failed', message: 'disk full' }), 1);
      },
      showError: (title, msg) => { events.push(`error:${title}:${msg}`); },
      relaunchAndQuit: () => { events.push('relaunchAndQuit'); },
      quitAndInstall: () => { events.push('quitAndInstall'); return { status: 'confirmed' as const }; },
      maintenanceLock: createMaintenanceLock(),
    });

    expect(installed).toBe(false);
    expect(events).toEqual([
      'stopped',
      `${SNAPSHOT_COMMAND} 1.0.0`,
      'error:Update not installed:Snapshot failed (snapshot_failed): disk full',
      'relaunchAndQuit',
    ]);
  });

  it('recovers via relaunchAndQuit when quitAndInstall returns void without scheduling quit or emits error', async () => {
    // Case 1: BaseUpdater.quitAndInstall() returns void without scheduling quit (install() === false).
    const lock1 = createMaintenanceLock();
    const events1: string[] = [];
    let markQuitCalled!: () => void;
    const quitStarted = new Promise<void>(resolve => { markQuitCalled = resolve; });
    const autoUpdater1 = new EventEmitter() as EventEmitter & { quitAndInstall(): void };
    autoUpdater1.quitAndInstall = () => { markQuitCalled(); };
    const nativeUpdater1 = new EventEmitter();

    const pendingVoid = offerInstall('2.0.0', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => true,
      beforeInstall: async () => { events1.push('stopped'); },
      spawnHostCommand: () => receiptChild(JSON.stringify({ ok: true, target: '/snap/1.0.0' }), 0),
      showError: (title, msg) => { events1.push(`error:${title}:${msg}`); },
      relaunchAndQuit: () => { events1.push('relaunchAndQuit'); },
      quitAndInstall: onConfirmed => requestQuitAndInstall({
        autoUpdater: autoUpdater1,
        nativeUpdater: nativeUpdater1,
        onConfirmed,
        onQuitRequested: l => lock1.onQuitRequested(l),
        canInferFailureOnTimeout: true,
        timeoutMs: 40,
      }),
      maintenanceLock: lock1,
    });

    await quitStarted;
    // While pending handover, confirmation has not occurred yet, and concurrent maintenance stays rejected.
    expect(lock1.isHandedOver()).toBe(false);
    await expect(lock1.run(async () => 'overlap')).rejects.toBeInstanceOf(MaintenanceBusyError);

    await expect(pendingVoid).resolves.toBe(false);
    expect(events1).toEqual([
      'stopped',
      'error:Update not installed:Updater did not start installing the update',
      'relaunchAndQuit',
    ]);
    expect(lock1.isHandedOver()).toBe(true);

    // Case 2: autoUpdater emits 'error' synchronously -> fails promptly without waiting for timeout.
    const lock2 = createMaintenanceLock();
    const events2: string[] = [];
    const autoUpdater2 = new EventEmitter() as EventEmitter & { quitAndInstall(): void };
    autoUpdater2.quitAndInstall = () => {
      autoUpdater2.emit('error', new Error('No update filepath provided'));
    };
    const installedErr = await offerInstall('2.0.0', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => true,
      beforeInstall: async () => { events2.push('stopped'); },
      spawnHostCommand: () => receiptChild(JSON.stringify({ ok: true, target: '/snap/1.0.0' }), 0),
      showError: (title, msg) => { events2.push(`error:${title}:${msg}`); },
      relaunchAndQuit: () => { events2.push('relaunchAndQuit'); },
      quitAndInstall: onConfirmed => requestQuitAndInstall({
        autoUpdater: autoUpdater2,
        nativeUpdater: new EventEmitter(),
        onConfirmed,
        onQuitRequested: l => lock2.onQuitRequested(l),
        canInferFailureOnTimeout: true,
        timeoutMs: 5_000,
      }),
      maintenanceLock: lock2,
    });

    expect(installedErr).toBe(false);
    expect(events2).toEqual([
      'stopped',
      'error:Update not installed:No update filepath provided',
      'relaunchAndQuit',
    ]);
  });

  it('confirms pending handover when quitAndInstall schedules before-quit-for-update / before-quit via setImmediate', async () => {
    const maintenanceLock = createMaintenanceLock();
    const autoUpdater = new EventEmitter() as EventEmitter & { quitAndInstall(): void };
    const nativeUpdater = new EventEmitter();
    const appEvents = new EventEmitter();
    const quitEvent = { preventDefault: vi.fn() };
    const showError = vi.fn();
    const relaunchAndQuit = vi.fn();

    appEvents.on('before-quit', createBeforeQuitHandler({
      maintenanceLock,
      stopHost: vi.fn(async () => {}),
      exit: vi.fn(),
      logError: vi.fn(),
    }));

    autoUpdater.quitAndInstall = () => {
      setImmediate(() => {
        nativeUpdater.emit('before-quit-for-update');
        appEvents.emit('before-quit', quitEvent);
      });
    };

    const installed = await offerInstall('2.0.0', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => true,
      beforeInstall: async () => {},
      spawnHostCommand: () => receiptChild(JSON.stringify({ ok: true, target: '/snap/1.0.0' }), 0),
      showError,
      relaunchAndQuit,
      quitAndInstall: onConfirmed => requestQuitAndInstall({
        autoUpdater,
        nativeUpdater,
        onConfirmed,
        onQuitRequested: l => maintenanceLock.onQuitRequested(l),
        canInferFailureOnTimeout: true,
        timeoutMs: 2_000,
      }),
      maintenanceLock,
    });

    expect(installed).toBe(true);
    expect(quitEvent.preventDefault).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
    expect(relaunchAndQuit).not.toHaveBeenCalled();
    expect(maintenanceLock.isHandedOver()).toBe(true);
  });

  it('keeps macOS updater handover pending past timeout without competing relaunch until native update finishes', async () => {
    const maintenanceLock = createMaintenanceLock();
    const autoUpdater = new EventEmitter() as EventEmitter & { quitAndInstall(): void };
    const nativeUpdater = new EventEmitter();
    const appEvents = new EventEmitter();
    const quitEvent = { preventDefault: vi.fn() };
    const showError = vi.fn();
    const relaunchAndQuit = vi.fn();
    let markTimeout!: () => void;
    const timeoutFired = new Promise<void>(resolve => { markTimeout = resolve; });

    appEvents.on('before-quit', createBeforeQuitHandler({
      maintenanceLock,
      stopHost: vi.fn(async () => {}),
      exit: vi.fn(),
      logError: vi.fn(),
    }));

    // MacUpdater.quitAndInstall() registers update-downloaded and returns while Squirrel still downloads.
    autoUpdater.quitAndInstall = () => {};

    const pendingInstall = offerInstall('2.0.0', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => true,
      beforeInstall: async () => {},
      spawnHostCommand: () => receiptChild(JSON.stringify({ ok: true, target: '/snap/1.0.0' }), 0),
      showError,
      relaunchAndQuit,
      quitAndInstall: onConfirmed => requestQuitAndInstall({
        autoUpdater,
        nativeUpdater,
        onConfirmed,
        onQuitRequested: l => maintenanceLock.onQuitRequested(l),
        canInferFailureOnTimeout: false,
        timeoutMs: 20,
        onPendingTimeout: () => { markTimeout(); },
      }),
      maintenanceLock,
    });

    // Even after timeoutMs fires, macOS leaves handover pending (no competing relaunchAndQuit).
    await timeoutFired;
    expect(relaunchAndQuit).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
    expect(maintenanceLock.isHandedOver()).toBe(false);
    await expect(maintenanceLock.run(async () => 'overlap')).rejects.toBeInstanceOf(MaintenanceBusyError);

    // Late Squirrel completion emits before-quit-for-update then before-quit -> confirmed cleanly.
    nativeUpdater.emit('before-quit-for-update');
    appEvents.emit('before-quit', quitEvent);

    await expect(pendingInstall).resolves.toBe(true);
    expect(quitEvent.preventDefault).not.toHaveBeenCalled();
    expect(relaunchAndQuit).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
    expect(maintenanceLock.isHandedOver()).toBe(true);
  });

  it('does not treat ordinary tray before-quit during pending handover as install success', async () => {
    const maintenanceLock = createMaintenanceLock();
    const autoUpdater = new EventEmitter() as EventEmitter & { quitAndInstall(): void };
    const nativeUpdater = new EventEmitter();
    const appEvents = new EventEmitter();
    const trayQuitEvent = { preventDefault: vi.fn() };
    const showError = vi.fn();
    const relaunchAndQuit = vi.fn();
    const quitStopHost = vi.fn(async () => {});
    const exit = vi.fn();
    let markQuitStarted!: () => void;
    const quitStarted = new Promise<void>(resolve => { markQuitStarted = resolve; });

    appEvents.on('before-quit', createBeforeQuitHandler({
      maintenanceLock,
      stopHost: quitStopHost,
      exit,
      logError: vi.fn(),
    }));

    autoUpdater.quitAndInstall = () => { markQuitStarted(); };

    const pendingInstall = offerInstall('2.0.0', {
      currentVersion: () => '1.0.0',
      confirmInstall: async () => true,
      beforeInstall: async () => {},
      spawnHostCommand: () => receiptChild(JSON.stringify({ ok: true, target: '/snap/1.0.0' }), 0),
      showError,
      relaunchAndQuit,
      quitAndInstall: onConfirmed => requestQuitAndInstall({
        autoUpdater,
        nativeUpdater,
        onConfirmed,
        onQuitRequested: l => maintenanceLock.onQuitRequested(l),
        canInferFailureOnTimeout: false,
        timeoutMs: 5_000,
      }),
      maintenanceLock,
    });

    await quitStarted;

    // User chooses Quit from tray/window before before-quit-for-update ever fires.
    appEvents.emit('before-quit', trayQuitEvent);
    expect(trayQuitEvent.preventDefault).toHaveBeenCalledTimes(1);

    await expect(pendingInstall).resolves.toBe(false);
    expect(relaunchAndQuit).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
    expect(maintenanceLock.isHandedOver()).toBe(false);

    await vi.waitFor(() => {
      expect(quitStopHost).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    });
  });
});
