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
  });

  it('prunes nothing when the snapshot fails', async () => {
    const snapshots = path.join(root, 'app', 'host', 'snapshots');
    await write(path.join(snapshots, '1.0.0', 'host', 'old.json'), 'old');
    await rm(path.join(root, 'store'), { recursive: true });
    await expect(snapshotStores('2.0.0')).rejects.toThrow();
    expect(await readdir(snapshots)).toContain('1.0.0');
  });
});
