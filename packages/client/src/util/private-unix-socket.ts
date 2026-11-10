import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const PRIVATE_SOCKET_FALLBACK_ROOT = '/tmp';
export const UNIX_SOCKET_PATH_SOFT_LIMIT = 100;
export const PRIVATE_SOCKET_FALLBACK_PREFIXES = { control: 'byok', storeMutex: 'byok-store-mutex' } as const;
const FALLBACK_LEAF = new RegExp(`^(${Object.values(PRIVATE_SOCKET_FALLBACK_PREFIXES).join('|')})-[0-9a-f]{16}$`);

type PrivateDirectoryRefusalCode = 'private_dir_symlink' | 'private_dir_not_directory' | 'private_dir_foreign_owner' | 'private_dir_mode';

export class PrivateDirectoryRefusedError extends Error {
  constructor(
    public readonly code: PrivateDirectoryRefusalCode,
    public readonly path: string,
    public readonly processUid: number | undefined,
    public readonly ownerUid?: number,
    cause?: unknown,
  ) {
    const reason = code === 'private_dir_symlink' ? 'path is a symlink'
      : code === 'private_dir_not_directory' ? 'path is not a directory'
      : code === 'private_dir_mode' ? 'mode could not be set to 0700'
      : `directory is owned by uid ${ownerUid}, not process uid ${processUid}`;
    super(`refusing private directory "${path}": ${reason}; remove ${path} if no byok process uses it, or shorten storeDir`, cause === undefined ? undefined : { cause });
    this.name = 'PrivateDirectoryRefusedError';
  }
}

export class PrivateSocketPathError extends Error {
  readonly code = 'socket_path_not_socket';
  constructor(public readonly path: string) {
    super(`socket path "${path}" is not a socket; remove ${path} if no byok process uses it`);
    this.name = 'PrivateSocketPathError';
  }
}

export class PrivateSocketInUseError extends Error {
  readonly code = 'socket_in_use';
  constructor(public readonly path: string) {
    super(`socket is in use at "${path}"`);
    this.name = 'PrivateSocketInUseError';
  }
}

export function privateSocketEndpoint(
  kind: keyof typeof PRIVATE_SOCKET_FALLBACK_PREFIXES,
  natural: string,
  identity16: string,
): string {
  if (!/^[0-9a-f]{16}$/.test(identity16)) throw new TypeError('private socket identity must be 16 lowercase hexadecimal digits');
  if (Buffer.byteLength(natural, 'utf8') <= UNIX_SOCKET_PATH_SOFT_LIMIT) return natural;
  return path.join(PRIVATE_SOCKET_FALLBACK_ROOT, `${PRIVATE_SOCKET_FALLBACK_PREFIXES[kind]}-${identity16}`, 'sock');
}

export async function ensureOwnedPrivateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    // Inspect existing non-directories below so they receive a typed refusal.
    if (error.code !== 'EEXIST' && error.code !== 'ENOTDIR') throw error;
  });
  const stat = await fs.lstat(dir);
  const uid = process.getuid?.();
  if (stat.isSymbolicLink()) throw new PrivateDirectoryRefusedError('private_dir_symlink', dir, uid);
  if (!stat.isDirectory()) throw new PrivateDirectoryRefusedError('private_dir_not_directory', dir, uid);
  if (uid !== undefined && stat.uid !== uid) throw new PrivateDirectoryRefusedError('private_dir_foreign_owner', dir, uid, stat.uid);
  // Windows has no uid and no POSIX mode bits; the mode contract is POSIX only.
  if (uid === undefined) return;
  await fs.chmod(dir, 0o700).catch((error: unknown) => {
    throw new PrivateDirectoryRefusedError('private_dir_mode', dir, uid, undefined, error);
  });
  const after = await fs.lstat(dir);
  if (after.isSymbolicLink()) throw new PrivateDirectoryRefusedError('private_dir_symlink', dir, uid);
  if ((after.mode & 0o777) !== 0o700) throw new PrivateDirectoryRefusedError('private_dir_mode', dir, uid);
}

function isFallbackDirectory(dir: string): boolean {
  return path.dirname(dir) === PRIVATE_SOCKET_FALLBACK_ROOT && FALLBACK_LEAF.test(path.basename(dir));
}

/** Only a refused or vanished connection proves absence; every other result refuses the bind. */
function socketIsInUse(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    const finish = (inUse: boolean): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    const timer = setTimeout(() => finish(true), 1000);
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'));
  });
}

async function bindOnce(server: net.Server, endpoint: string, fallbackDir: string | undefined): Promise<void> {
  if (fallbackDir) await ensureOwnedPrivateDirectory(fallbackDir);
  const stat = await fs.lstat(endpoint).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (stat) {
    if (!stat.isSocket()) throw new PrivateSocketPathError(endpoint);
    if (await socketIsInUse(endpoint)) throw new PrivateSocketInUseError(endpoint);
    await fs.unlink(endpoint);
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(error.code === 'EADDRINUSE' ? new PrivateSocketInUseError(endpoint) : error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

/** POSIX only. Owns fallback directory checks, stale recovery, binding and socket permissions. */
export async function listenPrivateUnixSocket(server: net.Server, endpoint: string): Promise<void> {
  const dir = path.dirname(endpoint);
  const fallbackDir = path.basename(endpoint) === 'sock' && isFallbackDirectory(dir) ? dir : undefined;
  try {
    await bindOnce(server, endpoint, fallbackDir);
  } catch (error) {
    // A closing holder may reclaim its directory between mkdir and listen.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await bindOnce(server, endpoint, fallbackDir);
  }
  if (fallbackDir) {
    try {
      await ensureOwnedPrivateDirectory(fallbackDir);
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }
  await fs.chmod(endpoint, 0o600).catch(() => undefined);
}

/** Non-recursive: leave directories containing a successor's socket or any other file alone. */
export async function reclaimPrivateSocketFallbackDirectory(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = path.dirname(endpoint);
  if (!isFallbackDirectory(dir)) return;
  await fs.rmdir(dir).catch(() => undefined);
}
