import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureOwnedPrivateDirectory, listenPrivateUnixSocket, privateSocketEndpoint, PrivateDirectoryRefusedError, PrivateSocketInUseError, reclaimPrivateSocketFallbackDirectory } from '../util/private-unix-socket';

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

describe('private Unix sockets', () => {
  it('uses the UTF-8 byte budget and validates the identity for both endpoint kinds', () => {
    const id = '0123456789abcdef';
    for (const [kind, prefix] of [['control', 'byok'], ['storeMutex', 'byok-store-mutex']] as const) {
      expect(privateSocketEndpoint(kind, 'a'.repeat(100), id)).toBe('a'.repeat(100));
      expect(privateSocketEndpoint(kind, 'é'.repeat(51), id)).toBe(path.join('/tmp', `${prefix}-${id}`, 'sock'));
      for (const invalid of ['', 'ABCDEF0123456789', id + '0', 'z'.repeat(16)]) {
        expect(() => privateSocketEndpoint(kind, '/short', invalid)).toThrow(TypeError);
      }
    }
  });

  it.skipIf(process.platform === 'win32')('types a non-directory refusal with its path and remedy', async () => {
    const { dir, sock } = await fallbackDir();
    await fs.writeFile(sock, 'keep');
    const error = await ensureOwnedPrivateDirectory(sock).catch((error) => error);
    expect(error).toBeInstanceOf(PrivateDirectoryRefusedError);
    expect(error).toMatchObject({ code: 'private_dir_not_directory', path: sock, processUid: process.getuid?.() });
    expect(error.message).toContain('remove ' + sock + ' if no byok process uses it, or shorten storeDir');
    expect(await fs.readFile(sock, 'utf8')).toBe('keep');
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('refuses a directory whose mode cannot be set to 0700', async () => {
    const { dir } = await fallbackDir();
    await fs.chmod(dir, 0o755);
    const failure = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const spy = vi.spyOn(fs, 'chmod').mockRejectedValue(failure);
    try {
      const error = await ensureOwnedPrivateDirectory(dir).catch((error) => error);
      expect(error).toBeInstanceOf(PrivateDirectoryRefusedError);
      expect(error).toMatchObject({ code: 'private_dir_mode', path: dir, cause: failure });
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a natural socket whose mode cannot be set to 0600 and removes it', async () => {
    const { dir } = await fallbackDir();
    const sock = path.join(dir, 'control.sock');
    const server = net.createServer();
    servers.push(server);
    const realLstat = fs.lstat;
    const failure = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (name, ...rest) => {
      const stat = await realLstat(name, ...(rest as []));
      return name === sock && stat.isSocket() ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode: (stat.mode & ~0o777) | 0o644 }) : stat;
    });
    const chmodSpy = vi.spyOn(fs, 'chmod').mockRejectedValue(failure);
    try {
      await expect(listenPrivateUnixSocket(server, sock)).rejects.toMatchObject({ code: 'socket_mode', path: sock, cause: failure });
      expect(server.listening).toBe(false);
      await expect(realLstat(sock)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      lstatSpy.mockRestore();
      chmodSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('never chmods a non-socket swapped in at a natural socket path', async () => {
    const { dir } = await fallbackDir();
    const sock = path.join(dir, 'control.sock');
    const target = path.join(dir, 'target');
    await fs.writeFile(target, 'keep', { mode: 0o644 });
    const server = net.createServer();
    servers.push(server);
    const realLstat = fs.lstat;
    let swapped = false;
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (name, ...rest) => {
      if (name === sock && !swapped && (await realLstat(sock).catch(() => undefined))?.isSocket()) {
        swapped = true;
        await fs.unlink(sock);
        await fs.symlink(target, sock);
      }
      return realLstat(name, ...(rest as []));
    });
    const chmodSpy = vi.spyOn(fs, 'chmod');
    try {
      await expect(listenPrivateUnixSocket(server, sock)).rejects.toMatchObject({ code: 'socket_path_not_socket', path: sock });
      expect(chmodSpy).not.toHaveBeenCalled();
      expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
    } finally {
      lstatSpy.mockRestore();
      chmodSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('closes a bound listener if the fallback ownership changes after listen', async () => {
    const { dir, sock } = await fallbackDir();
    const server = net.createServer();
    servers.push(server);
    const realLstat = fs.lstat;
    let checks = 0;
    const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (name, ...rest) => {
      const stat = await realLstat(name, ...(rest as []));
      if (name === dir && ++checks === 2) return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 });
      return stat;
    });
    try {
      await expect(listenPrivateUnixSocket(server, sock)).rejects.toMatchObject({ code: 'private_dir_foreign_owner', path: dir });
      expect(server.listening).toBe(false);
      await expect(fs.lstat(sock)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('does not assert ownership for a natural path in a store whose name matches a fallback', async () => {
    const { dir } = await fallbackDir();
    const server = net.createServer();
    servers.push(server);
    const realLstat = fs.lstat;
    const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (name, ...rest) => {
      const stat = await realLstat(name, ...(rest as []));
      return name === dir ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 }) : stat;
    });
    try {
      await listenPrivateUnixSocket(server, path.join(dir, 'control.sock'));
      expect(server.listening).toBe(true);
      expect(spy).not.toHaveBeenCalledWith(dir);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['EACCES', 'EIO', 'timeout'])('refuses an uncertain probe (%s) without unlinking the holder', async (code) => {
    if (process.platform === 'win32') return;
    const { sock } = await fallbackDir();
    await bindSock(sock);
    const socket = new net.Socket();
    const spy = vi.spyOn(net, 'createConnection').mockImplementation(() => {
      if (code !== 'timeout') queueMicrotask(() => socket.emit('error', Object.assign(new Error(code), { code })));
      return socket;
    });
    const contender = net.createServer();
    try {
      await expect(listenPrivateUnixSocket(contender, sock)).rejects.toMatchObject({ code: 'socket_in_use', path: sock });
      expect(contender.listening).toBe(false);
      expect((await fs.lstat(sock)).isSocket()).toBe(true);
    } finally {
      spy.mockRestore();
      socket.destroy();
    }
  });

  it.skipIf(process.platform === 'win32')('maps a bind race (EADDRINUSE) to the typed busy error', async () => {
    const { sock } = await fallbackDir();
    await bindSock(sock);
    const realLstat = fs.lstat;
    const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (name, ...rest) => {
      if (name === sock) throw Object.assign(new Error('absent at lstat'), { code: 'ENOENT' });
      return realLstat(name, ...(rest as []));
    });
    try {
      await expect(listenPrivateUnixSocket(net.createServer(), sock)).rejects.toBeInstanceOf(PrivateSocketInUseError);
    } finally {
      spy.mockRestore();
    }
    expect((await fs.lstat(sock)).isSocket()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('verifies the fallback directory on a successful bind', async () => {
    const { dir, sock } = await fallbackDir();
    const server = net.createServer();
    servers.push(server);
    await listenPrivateUnixSocket(server, sock);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    const contender = net.createServer();
    await expect(listenPrivateUnixSocket(contender, sock)).rejects.toBeInstanceOf(PrivateSocketInUseError);
  });
});

describe('reclaimPrivateSocketFallbackDirectory', () => {
  it('removes an emptied fallback directory', async () => {
    if (process.platform === 'win32') return;
    const { dir, sock } = await fallbackDir();
    const server = await bindSock(sock);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(sock, { force: true });

    await reclaimPrivateSocketFallbackDirectory(sock);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a directory whose socket is still bound', async () => {
    if (process.platform === 'win32') return;
    const { dir, sock } = await fallbackDir();
    await bindSock(sock);
    // Not "already closed by us" — a live endpoint another daemon still owns.
    // Recursing here would delete a running daemon's control socket.
    await reclaimPrivateSocketFallbackDirectory(sock);
    await expect(fs.stat(dir)).resolves.toBeDefined();
  });

  it('leaves a directory holding anything besides an emptied socket', async () => {
    if (process.platform === 'win32') return;
    const { dir, sock } = await fallbackDir();
    await fs.writeFile(path.join(dir, 'stray'), 'x');
    await reclaimPrivateSocketFallbackDirectory(sock);
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

    await reclaimPrivateSocketFallbackDirectory(path.join(storeDir, 'control.sock'));
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

    await reclaimPrivateSocketFallbackDirectory(path.join(storeDir, 'mutex.sock'));
    await expect(fs.readFile(path.join(storeDir, 'device.json'), 'utf8')).resolves.toBe('{}');
  });
});
