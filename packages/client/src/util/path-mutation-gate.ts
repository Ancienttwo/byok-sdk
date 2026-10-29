import { createHash } from 'node:crypto';
import { closeSync, constants, openSync, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { ensureSecureDir } from './secure-dir';

export type PathMutationGateScope = 'store' | 'agent-home-root' | 'skill-pack-store' | 'pi-session-rebinding' | 'pi-session-discovery' | `pi-session-admission:${string}` | `pi-session-writer:${string}`;

export type PathMutationGateInput = {
  readonly scope: Exclude<PathMutationGateScope, 'pi-session-rebinding'>;
  readonly targetPath: string;
} | {
  /** Only mutable Pi setup callbacks need a barrier before their target path is known. */
  readonly scope: 'pi-session-rebinding';
  readonly targetPath?: never;
};

export interface PathMutationGateAcquireOptions {
  /** Bounded wait for another conforming short-lived writer; relocation uses zero. */
  readonly waitMs?: number;
}

export interface PathMutationGate {
  readonly scope: PathMutationGateScope;
  readonly targetPath: string;
  readonly identity: string;
  release(): Promise<void>;
}

export class PathMutationGateBusyError extends Error {
  constructor(
    public readonly scope: PathMutationGateScope,
    public readonly targetPath: string,
  ) {
    super(`${scope} mutation gate is already held for ${targetPath}`);
    this.name = 'PathMutationGateBusyError';
  }
}

/**
 * The gate is a kernel lock that belongs to one open handle (#1149): the OS
 * releases it when the handle closes or its process dies, and no path is ever
 * unlinked, so no process can remove another holder's lock.
 *
 * - darwin: `<POSIX_GATE_ROOT>/<identity>.lock` opened with `O_EXLOCK |
 *   O_NONBLOCK` (`flock` taken by `open(2)`); `EAGAIN` is busy. The raw fd is
 *   kept, never a `FileHandle`, whose collection would close it and drop the
 *   lock. The lock file is never removed.
 * - linux: an abstract unix socket `\0byok-pm-<uid>-<identity>`; bind
 *   `EADDRINUSE` is busy. It has no filesystem entry.
 * - win32: a named pipe; creating a second first instance fails with
 *   `EADDRINUSE`.
 *
 * Every other platform is refused.
 */
// Fixed and environment-independent; holds the darwin lock files.
const POSIX_GATE_ROOT = `/tmp/byok-pm-${process.getuid?.() ?? 'unknown'}`;
// darwin <sys/fcntl.h>; Node and Bun pass open(2) flags through unchanged.
const DARWIN_O_EXLOCK = 0x20;

function assertAbsolutePath(value: string): void {
  if (!path.isAbsolute(value)) throw new Error('path mutation gate target must be absolute');
  if (/[\x00\r\n]/u.test(value)) throw new Error('path mutation gate target must not contain NUL or line breaks');
}

/** Canonicalize through the deepest existing ancestor without creating the target. */
export async function resolvePathWithoutCreate(input: string): Promise<string> {
  assertAbsolutePath(input);
  let cursor = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.resolve(await fs.realpath(cursor), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`no existing ancestor for ${input}`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function gateIdentity(scope: PathMutationGateScope, canonicalTarget: string): string {
  return createHash('sha256').update(`${scope}\0${canonicalTarget}`).digest('hex');
}

async function assertPrivateGateRoot(): Promise<void> {
  await ensureSecureDir(POSIX_GATE_ROOT);
  const stat = await fs.lstat(POSIX_GATE_ROOT);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`path mutation gate root is not a private owned directory: ${POSIX_GATE_ROOT}`);
  }
}

function resolveGateTarget(input: PathMutationGateInput): Promise<string> {
  // One fixed cross-process identity, including on Windows with multiple drives.
  return input.scope === 'pi-session-rebinding' ? Promise.resolve('*') : resolvePathWithoutCreate(input.targetPath);
}

/** Takes the OS lock for `identity`; resolves to the function that drops it, or `undefined` when another handle holds it. */
async function lockIdentity(identity: string): Promise<(() => Promise<void>) | undefined> {
  if (process.platform === 'darwin') {
    await assertPrivateGateRoot();
    let fd: number;
    try {
      fd = openSync(
        path.join(POSIX_GATE_ROOT, `${identity}.lock`),
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | DARWIN_O_EXLOCK | constants.O_NONBLOCK,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return undefined;
      throw error;
    }
    return async () => closeSync(fd);
  }
  let endpoint: string;
  if (process.platform === 'linux') endpoint = `\0byok-pm-${process.getuid?.() ?? 'unknown'}-${identity}`;
  else if (process.platform === 'win32') endpoint = `\\\\.\\pipe\\byok-path-mutation-${identity}`;
  else throw new Error(`path mutation gate is not supported on ${process.platform}`);
  const server: Server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return undefined;
    throw error;
  }
  server.unref();
  return () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function acquireOne(input: PathMutationGateInput): Promise<PathMutationGate> {
  const canonicalTarget = await resolveGateTarget(input);
  const identity = gateIdentity(input.scope, canonicalTarget);
  const unlock = await lockIdentity(identity);
  if (unlock === undefined) throw new PathMutationGateBusyError(input.scope, canonicalTarget);

  try {
    const rechecked = await resolveGateTarget(input);
    if (rechecked !== canonicalTarget) {
      throw new Error(`path mutation gate target changed during acquisition: ${input.targetPath}`);
    }
  } catch (error) {
    await unlock();
    throw error;
  }

  let released = false;
  let releaseAttempt: Promise<void> | undefined;
  return Object.freeze({
    scope: input.scope,
    targetPath: canonicalTarget,
    identity,
    release: () => {
      if (released) return Promise.resolve();
      if (releaseAttempt !== undefined) return releaseAttempt;
      releaseAttempt = unlock().then(() => {
        released = true;
      }, (error: unknown) => {
        releaseAttempt = undefined;
        throw error;
      });
      return releaseAttempt;
    },
  });
}

/** Acquire multiple path gates in one deterministic order to prevent deadlock. */
export async function acquirePathMutationGates(inputs: readonly PathMutationGateInput[]): Promise<readonly PathMutationGate[]> {
  const resolved = await Promise.all(inputs.map(async (input) => {
    const targetPath = await resolveGateTarget(input);
    const canonicalInput: PathMutationGateInput = input.scope === 'pi-session-rebinding' ? input : { ...input, targetPath };
    return { input: canonicalInput, targetPath, identity: gateIdentity(input.scope, targetPath) };
  }));
  const unique = [...new Map(resolved.map((item) => [`${item.input.scope}\0${item.targetPath}`, item])).values()]
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const acquired: PathMutationGate[] = [];
  try {
    for (const item of unique) acquired.push(await acquireOne(item.input));
    return Object.freeze(acquired.slice());
  } catch (error) {
    await Promise.allSettled(acquired.reverse().map((gate) => gate.release()));
    throw error;
  }
}

export async function acquirePathMutationGate(
  input: PathMutationGateInput,
  options: PathMutationGateAcquireOptions = {},
): Promise<PathMutationGate> {
  const waitMs = options.waitMs ?? 0;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
    throw new Error('path mutation gate waitMs must be an integer from 0 through 30000');
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await acquireOne(input);
    } catch (error) {
      if (!(error instanceof PathMutationGateBusyError) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now())));
      });
    }
  }
}
