import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;

vi.mock('electron', () => ({ app: {}, dialog: {} }));
vi.mock('electron-updater', () => ({ default: {} }));
vi.mock('@byok-sdk/client', () => ({
  resolveHostLayout: () => ({
    storeDir: path.join(root, 'store'),
    scratchRoot: { path: path.join(root, 'store', 'tmp') },
    hostStorageRoot: path.join(root, 'app'),
  }),
}));

const { snapshotStores } = await import('./updater.ts');
const { completeSnapshot, restoreSnapshot } = await import('../recovery/stores.ts');
const layout = () => ({ storeDir: path.join(root, 'store'), scratchRoot: { path: path.join(root, 'store', 'tmp') }, hostStorageRoot: path.join(root, 'app') });

const write = async (file: string, text: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};

describe('snapshotStores', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'updater-'));
    await write(path.join(root, 'store', 'device.json'), 'store');
    await write(path.join(root, 'app', 'host', 'settings.json'), 'host');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('copies the host stores without the snapshots directory and keeps only the latest', async () => {
    const snapshots = path.join(root, 'app', 'host', 'snapshots');
    await write(path.join(snapshots, '1.0.0', 'host', 'old.json'), 'old');
    const target = await snapshotStores('2.0.0');
    expect(target).toBe(path.join(snapshots, '2.0.0'));
    expect(await readdir(path.join(target, 'host'))).toEqual(['settings.json']);
    expect(await readFile(path.join(target, 'store', 'device.json'), 'utf8')).toBe('store');
    expect(await readdir(snapshots)).toEqual(['2.0.0']);
    expect(await completeSnapshot(layout(), '2.0.0')).toBe(target);
  });

  it('prunes nothing when the snapshot fails', async () => {
    const snapshots = path.join(root, 'app', 'host', 'snapshots');
    await write(path.join(snapshots, '1.0.0', 'host', 'old.json'), 'old');
    await rm(path.join(root, 'store'), { recursive: true });
    await expect(snapshotStores('2.0.0')).rejects.toThrow();
    expect(await readdir(snapshots)).toContain('1.0.0');
    // The partial 2.0.0 has no marker, so restore never offers it.
    expect(await readdir(snapshots)).toContain('2.0.0');
    expect(await completeSnapshot(layout(), '2.0.0')).toBeUndefined();
    await expect(restoreSnapshot(layout(), '2.0.0', 's')).rejects.toThrow('No complete snapshot');
  });

  it('restores a complete snapshot: the current stores move aside and the snapshots stay', async () => {
    await snapshotStores('2.0.0');
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
    await snapshotStores('2.0.0');
    await write(path.join(root, 'store', 'device.json'), 'newer');
    // An existing aside name refuses the second move, after the first one happened.
    await mkdir(path.join(root, 'app', 'host.aside-s'));
    await expect(restoreSnapshot(layout(), '2.0.0', 's')).rejects.toThrow('already exists');
    expect(await readFile(path.join(root, 'store', 'device.json'), 'utf8')).toBe('newer');
    expect(await readdir(root)).toEqual(['app', 'store']);
  });
});
