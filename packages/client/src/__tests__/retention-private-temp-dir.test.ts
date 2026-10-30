import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixedBytes = vi.hoisted(() => ({ value: undefined as Buffer | undefined }));
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: (size: number) => fixedBytes.value ?? crypto.randomBytes(size) };
});

const { createDaemonScratch, createPrivateTempDir } = await import('../daemon/retention/scratch');

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-private-temp-')));
});

afterEach(async () => {
  fixedBytes.value = undefined;
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

// #1097: mkdtemp fails with ENOENT on Windows past MAX_PATH; scratch directories come from one exclusive mkdir instead.
describe('createPrivateTempDir', () => {
  it('gives each directory a unique prefix-plus-six-alphanumerics name', async () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const directory = await createPrivateTempDir(root, 'pi-');
      expect(path.dirname(directory)).toBe(root);
      expect(path.basename(directory)).toMatch(/^pi-[A-Za-z0-9]{6}$/u);
      expect((await fs.lstat(directory)).isDirectory()).toBe(true);
      names.add(path.basename(directory));
    }
    expect(names.size).toBe(50);
  });

  it('throws EEXIST for a name that already exists, after one mkdir', async () => {
    fixedBytes.value = Buffer.from([0, 1, 2, 3, 4, 5]);
    const first = await createPrivateTempDir(root, 'pi-');
    expect(path.basename(first)).toBe('pi-ABCDEF');
    const mkdir = vi.spyOn(fs, 'mkdir');
    await expect(createPrivateTempDir(root, 'pi-')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(mkdir).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32')('creates the directory 0700', async () => {
    const directory = await createPrivateTempDir(root, 'pi-');
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('createDaemonScratch names match what the retention sweep collects', async () => {
    for (const kind of ['diag', 'credential', 'prepare'] as const) {
      const directory = await createDaemonScratch(root, kind);
      expect(path.dirname(directory)).toBe(path.join(root, 'tmp', 'daemon'));
      expect(path.basename(directory)).toMatch(/^(?:diag|credential|prepare)-[A-Za-z0-9]{6}$/u);
    }
  });
});
