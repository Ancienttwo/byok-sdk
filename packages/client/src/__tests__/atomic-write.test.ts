import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteFile } from '../util/atomic-write';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * `atomic-write.ts` is the shared helper extracted from
 * `session-workspace-store.ts`'s own (already atomic) save pattern, so that
 * `store.ts` (device.json — device keys/JWT, 0600) and `cursor-store.ts`
 * (redelivery cursor persistence) stop using a plain, non-atomic
 * `fs.writeFile` — which truncates the target in place before writing the
 * new bytes, so a concurrent reader can observe a torn/partial file and a
 * crash mid-write can corrupt the existing one.
 */
describe('atomicWriteFile', () => {
  let dir: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('a concurrent reader never observes a torn/partial file across many concurrent writes to the same path', async () => {
    dir = await tmpDir('byok-atomic-write-torn-read-');
    const target = path.join(dir, 'data.json');
    await atomicWriteFile(target, JSON.stringify({ n: -1, padding: 'x'.repeat(256) }));

    const N = 150;
    let stop = false;
    const parseFailures: Array<{ raw: string; message: string }> = [];

    // Tight read loop, no artificial delay — real disk I/O racing the
    // writes below exactly like `session-workspace-store.test.ts`'s own
    // concurrency tests. Any read that succeeds must parse as valid JSON;
    // ENOENT can only happen if the OS ever let the target not exist
    // (never true here, since it's created above before the loop starts,
    // and every write goes to a private temp path first).
    const reader = (async () => {
      while (!stop) {
        const raw = await fs.readFile(target, 'utf8');
        try {
          JSON.parse(raw);
        } catch (err) {
          parseFailures.push({ raw, message: (err as Error).message });
        }
      }
    })();

    await Promise.all(
      Array.from({ length: N }, (_, i) => atomicWriteFile(target, JSON.stringify({ n: i, padding: 'x'.repeat(256) }))),
    );
    stop = true;
    await reader;

    expect(parseFailures).toEqual([]);

    // The file must land in some fully-written state (whichever write's
    // rename landed last) — never left mid-write or missing.
    const final = JSON.parse(await fs.readFile(target, 'utf8')) as { n: number };
    expect(final.n).toBeGreaterThanOrEqual(0);
    expect(final.n).toBeLessThan(N);
  });

  it('leaves no leftover temp file behind after a successful write', async () => {
    dir = await tmpDir('byok-atomic-write-cleanup-');
    const target = path.join(dir, 'data.json');
    await atomicWriteFile(target, JSON.stringify({ ok: true }));

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['data.json']);
  });

  it('sets the requested mode on the target file, including when replacing an existing file that had a different mode', async () => {
    dir = await tmpDir('byok-atomic-write-mode-');
    const target = path.join(dir, 'device.json');
    // Pre-existing file with a permissive mode, simulating a file that
    // predates the mode being load-bearing (or a permissive umask). A plain
    // `fs.writeFile({ mode })` would NOT fix this retroactively — `mode` on
    // `open()` only governs permissions at creation time, and the file
    // already exists — which is exactly the bug `DeviceStore.save`'s own
    // (pre-existing) defensive chmod call worked around.
    await fs.writeFile(target, '{}', { mode: 0o644 });
    const before = await fs.stat(target);
    expect(before.mode & 0o777).toBe(0o644);

    await atomicWriteFile(target, JSON.stringify({ ok: true }), { mode: 0o600 });

    const after = await fs.stat(target);
    expect(after.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ ok: true });
  });

  it('falls back to unlink-then-rename when fs.rename throws EPERM once (Windows: rename onto an existing, momentarily-locked target)', async () => {
    dir = await tmpDir('byok-atomic-write-eperm-');
    const target = path.join(dir, 'data.json');
    await atomicWriteFile(target, JSON.stringify({ n: 0 }));

    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename');
    let calls = 0;
    renameSpy.mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      calls++;
      if (calls === 1) {
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realRename(...args);
    });

    await atomicWriteFile(target, JSON.stringify({ n: 1 }));

    // The first (mocked, throwing) call plus the fallback's retry — proves
    // the EPERM branch actually ran, not just that the write happened to
    // succeed some other way.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ n: 1 });

    // No leftover temp file after the fallback path either.
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['data.json']);
  });

  it('falls back to unlink-then-rename when fs.rename throws EEXIST once', async () => {
    dir = await tmpDir('byok-atomic-write-eexist-');
    const target = path.join(dir, 'data.json');
    await atomicWriteFile(target, JSON.stringify({ n: 0 }));

    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename');
    let calls = 0;
    renameSpy.mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      calls++;
      if (calls === 1) {
        const err = new Error('EEXIST: file already exists, rename') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      return realRename(...args);
    });

    await atomicWriteFile(target, JSON.stringify({ n: 1 }));
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ n: 1 });
  });

  it('propagates a rename error that is not EPERM/EEXIST, and cleans up the temp file', async () => {
    dir = await tmpDir('byok-atomic-write-other-err-');
    const target = path.join(dir, 'data.json');

    const renameSpy = vi.spyOn(fs, 'rename');
    renameSpy.mockImplementationOnce(async () => {
      const err = new Error('EIO: i/o error, rename') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });

    await expect(atomicWriteFile(target, JSON.stringify({ n: 1 }))).rejects.toMatchObject({ code: 'EIO' });

    // Target was never created, and the temp file was cleaned up.
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
  });
});
