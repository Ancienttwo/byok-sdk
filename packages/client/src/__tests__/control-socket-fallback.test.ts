import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectControlClient } from '../daemon/control-client';
import { controlSocketPath } from '../daemon/control-protocol';
import { startControlServer, type ControlMethods, type ControlServerHandle } from '../daemon/control-server';

/**
 * `controlSocketPath`'s long-storeDir fallback used to bind under
 * `os.tmpdir()`. That is the same defect PR #64 removed from
 * `daemon-owner.ts`'s store mutex, and it bites the control endpoint for the
 * same two independent reasons:
 *
 * - Reachability: `os.tmpdir()` reads `TMPDIR`, which the caller may have
 *   pointed INSIDE the very tree that made `<storeDir>/control.sock` too long
 *   (the topology `scripts/adapter-task-smoke.mjs` produces under a deep
 *   TMPDIR). The "fallback" is then LONGER than the address it escapes,
 *   `bind()` returns `EINVAL`, and `create-daemon.ts` degrades — the CLI
 *   control path is silently dead ("control socket failed to start
 *   (continuing without it)").
 * - Correctness: an environment-derived address is not one address. A daemon
 *   started by a service manager and a CLI run from an operator shell see
 *   different `TMPDIR` values and derive DIFFERENT sockets for the same
 *   store, so the CLI cannot reach a live daemon at all.
 *
 * These guards hold both sides down (the E/F pair of
 * `daemon-owner-mutex-collision.test.ts`), plus the byte-invariance of the
 * normal short-storeDir path, which must not move at all.
 */

const handles: ControlServerHandle[] = [];
const dirsToRemove: string[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close().catch(() => undefined);
  for (const dir of dirsToRemove.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function pingMethods(): ControlMethods {
  return { unary: { ping: () => 'pong' }, stream: {} };
}

/** A storeDir long enough that no `control.sock` under it fits the `sun_path` budget — the shape the deep-TMPDIR smoke produces. */
async function tooLongStoreDir(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-ctl-fallback-')));
  dirsToRemove.push(root);
  let storeDir = root;
  while (Buffer.byteLength(path.join(storeDir, 'control.sock'), 'utf8') <= 100) {
    storeDir = path.join(storeDir, 'deeper-store-directory-segment');
  }
  await fs.mkdir(storeDir, { recursive: true, mode: 0o700 });
  return storeDir;
}

async function withTmpdir<T>(tmp: string, fn: () => Promise<T> | T): Promise<T> {
  const original = process.env['TMPDIR'];
  process.env['TMPDIR'] = tmp;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = original;
  }
}

describe('control socket fallback: a fixed root, immune to TMPDIR', () => {
  it('E: a storeDir too long to hold the socket still gets a bindable, actually usable control endpoint under a deep TMPDIR', async () => {
    if (process.platform === 'win32') return; // a pipe name has no length branch
    const storeDir = await tooLongStoreDir();
    // The smoke's own topology: TMPDIR pointed inside the very tree that made
    // the natural path too long. Any derivation reaching for `os.tmpdir()`
    // here yields an address longer than the one it is escaping.
    await withTmpdir(path.join(storeDir, 'tmp'), async () => {
      const endpoint = controlSocketPath(storeDir);
      expect(Buffer.byteLength(endpoint, 'utf8')).toBeLessThanOrEqual(100);
      dirsToRemove.push(path.dirname(endpoint));

      // Bindable is not the claim — REACHABLE is. Stand the real server up and
      // complete a real handshake against it, which is exactly what degraded
      // to nothing when `bind()` returned EINVAL.
      const handle = await startControlServer({ storeDir, productId: 'acme', methods: pingMethods() });
      handles.push(handle);
      expect(handle.endpoint).toBe(endpoint);

      const conn = await connectControlClient({ storeDir, productId: 'acme' });
      expect(conn.ok).toBe(true);
      if (!conn.ok) throw new Error('unreachable');
      await expect(conn.client.request('ping')).resolves.toBe('pong');
      conn.client.close();
    });
  }, 60_000);

  it('F: the control socket address never depends on the environment', async () => {
    if (process.platform === 'win32') return; // a pipe name has no length branch
    const storeDir = await tooLongStoreDir();
    const shortStoreDir = '/Users/me/.byok/acme';
    const [longA, shortA] = await withTmpdir('/tmp', () => [controlSocketPath(storeDir), controlSocketPath(shortStoreDir)] as const);
    const [longB, shortB] = await withTmpdir(path.join(storeDir, 'a-completely-different-temp-root'), () => [
      controlSocketPath(storeDir),
      controlSocketPath(shortStoreDir),
    ] as const);
    expect(longB).toBe(longA); // the branch that used to read os.tmpdir()
    expect(shortB).toBe(shortA);
  }, 60_000);

  it('the normal short-storeDir path is byte-for-byte unchanged', async () => {
    if (process.platform === 'win32') return;
    expect(controlSocketPath('/Users/me/.byok/acme')).toBe('/Users/me/.byok/acme/control.sock');
    await withTmpdir('/some/unrelated/temp/root', () => {
      expect(controlSocketPath('/Users/me/.byok/acme')).toBe('/Users/me/.byok/acme/control.sock');
    });
  });
});

describe('control socket fallback: the directory it binds in does not outlive the daemon', () => {
  it('G: close() removes the fallback directory, not just the socket inside it', async () => {
    if (process.platform === 'win32') return; // a pipe leaves no directory behind
    const storeDir = await tooLongStoreDir();
    const endpoint = controlSocketPath(storeDir);
    const fallbackDir = path.dirname(endpoint);
    expect(fallbackDir).not.toBe(storeDir); // the branch under test actually ran

    const handle = await startControlServer({ storeDir, productId: 'acme', methods: pingMethods() });
    expect(await fs.stat(fallbackDir).then((s) => s.isDirectory())).toBe(true);

    await handle.close();
    // One directory per store used to survive every daemon it ever hosted:
    // unlinking the socket left the 0700 parent behind, keyed by the store, so
    // a machine accumulated one per store that took the long-path branch.
    await expect(fs.stat(fallbackDir)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('I: the directory vanishing before its ownership check is retried, not fatal', async () => {
    if (process.platform === 'win32') return;
    const storeDir = await tooLongStoreDir();
    const fallbackDir = path.dirname(controlSocketPath(storeDir));
    // A closing daemon for this store reclaims the directory right after our
    // mkdir: remove it just before the first ownership lstat sees it.
    const realLstat = fs.lstat.bind(fs);
    let removed = false;
    const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...rest) => {
      if (!removed && target === fallbackDir) {
        removed = true;
        await fs.rm(fallbackDir, { recursive: true, force: true });
      }
      return realLstat(target, ...(rest as []));
    });
    try {
      const handle = await startControlServer({ storeDir, productId: 'acme', methods: pingMethods() });
      expect(removed).toBe(true);
      await handle.close();
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('H: a store that itself lives under /tmp keeps its own directory', async () => {
    if (process.platform === 'win32') return;
    // Reclamation is scoped to a fallback DIRECTORY, not to anything a close
    // happens to see one level under /tmp. A store that lives there itself
    // binds its control socket directly inside it, and ordinary teardown must
    // never turn into store deletion.
    const storeDir = `/tmp/byok-${randomBytes(8).toString('hex')}`;
    await fs.mkdir(storeDir, { mode: 0o700 }); // exclusive: fails rather than reuse a directory that is not ours
    dirsToRemove.push(storeDir);
    const sentinel = path.join(storeDir, 'device.json');
    await fs.writeFile(sentinel, '{}');

    const handle = await startControlServer({ storeDir, productId: 'acme', methods: pingMethods() });
    expect(path.dirname(handle.endpoint)).toBe(storeDir); // short path: no fallback at all
    await handle.close();
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('{}');
  }, 60_000);
});
