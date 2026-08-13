import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectControlClient } from '../bin/control-client';
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
