import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reclaimSocketFallbackDirectory } from '../util/socket-fallback-directory';

/**
 * The two long-path socket fallbacks (`control-protocol.ts`'s
 * `controlSocketPath` and `daemon-owner.ts`'s `storeMutexEndpoint`) both nest a
 * socket one level below a fixed short root, in a directory keyed by the store
 * alone. Unlinking the socket at close left that directory behind, so it
 * accumulated one per store that ever took the branch. These hold down what the
 * reclamation may and may not remove.
 *
 * Scope is the whole point: `rmdir` on a directory one level under /tmp is
 * indistinguishable, structurally, from deleting a store that happens to live
 * there. Every case below is one side or the other of that line.
 */

const dirsToRemove: string[] = [];
const servers: net.Server[] = [];

async function fallbackDir(): Promise<{ dir: string; sock: string }> {
  // The real shape the derivations produce: a prefix plus 16 hex digits. Built
  // literally rather than from `mkdtemp`, whose six-character suffix is not it.
  const dir = path.join('/tmp', `byok-store-mutex-${randomBytes(8).toString('hex')}`);
  await fs.mkdir(dir, { mode: 0o700 });
  dirsToRemove.push(dir);
  return { dir, sock: path.join(dir, 'sock') };
}

async function bindSock(sock: string): Promise<net.Server> {
  const server = net.createServer((socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => resolve());
  });
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirsToRemove.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('reclaimSocketFallbackDirectory', () => {
  it('removes an emptied fallback directory', async () => {
    if (process.platform === 'win32') return;
    const { dir, sock } = await fallbackDir();
    const server = await bindSock(sock);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(sock, { force: true });

    await reclaimSocketFallbackDirectory(sock);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a directory whose socket is still bound', async () => {
    if (process.platform === 'win32') return;
    const { dir, sock } = await fallbackDir();
    await bindSock(sock);
    // Not "already closed by us" — a live endpoint another daemon still owns.
    // Recursing here would delete a running daemon's control socket.
    await reclaimSocketFallbackDirectory(sock);
    await expect(fs.stat(dir)).resolves.toBeDefined();
  });

  it('leaves a directory holding anything besides an emptied socket', async () => {
    if (process.platform === 'win32') return;
    const { dir, sock } = await fallbackDir();
    await fs.writeFile(path.join(dir, 'stray'), 'x');
    await reclaimSocketFallbackDirectory(sock);
    await expect(fs.stat(dir)).resolves.toBeDefined();
  });

  it('refuses a path that only happens to sit one level under /tmp', async () => {
    if (process.platform === 'win32') return;
    // A store the operator put in /tmp: its parent IS the fallback root, but the
    // leaf is not a fallback name. This is the case the name rule exists for —
    // a bare parent check would delete the store on close.
    const storeDir = await fs.mkdtemp('/tmp/my-own-store-');
    dirsToRemove.push(storeDir);
    await fs.writeFile(path.join(storeDir, 'device.json'), '{}');

    await reclaimSocketFallbackDirectory(path.join(storeDir, 'control.sock'));
    await expect(fs.readFile(path.join(storeDir, 'device.json'), 'utf8')).resolves.toBe('{}');
  });

  it('leaves an endpoint inside the store alone', async () => {
    if (process.platform === 'win32') return;
    // The common case: `<storeDir>/mutex.sock`. Its parent is the store, never a
    // fallback directory, whatever the store is called — including a store this
    // sweep has no business touching whose name matches the fallback shape.
    const storeDir = `/tmp/byok-${randomBytes(8).toString('hex')}`;
    await fs.mkdir(storeDir, { mode: 0o700 }); // exclusive: fails rather than reuse a directory that is not ours
    dirsToRemove.push(storeDir);
    await fs.writeFile(path.join(storeDir, 'device.json'), '{}');

    await reclaimSocketFallbackDirectory(path.join(storeDir, 'mutex.sock'));
    await expect(fs.readFile(path.join(storeDir, 'device.json'), 'utf8')).resolves.toBe('{}');
  });
});
