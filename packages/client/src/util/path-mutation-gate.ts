import { createHash } from 'node:crypto';
import { closeSync, constants, openSync, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { resolveExistingAncestor } from './existing-ancestor.js';
import { ensureOwnedPrivateDirectory } from './private-unix-socket.js';

export type PathMutationGateScope = 'store' | 'agent-home-root' | 'skill-pack-store' | 'pi-session-rebinding' | 'service-lifecycle' | 'pi-session-discovery' | `agy-session:${string}` | `pi-session-admission:${string}` | `pi-session-writer:${string}`;

/**
 * Scopes with one fixed identity and no target path.
 * - `pi-session-rebinding`: mutable Pi setup callbacks need a barrier before
 *   their target path is known.
 * - `service-lifecycle`: the OS service manager's per-user namespace (#1097).
 *   An owner-record change or a managed install/repair/uninstall holds it,
 *   and local-state relocation takes it before any store gate.
 */
type PathlessScope = 'pi-session-rebinding' | 'service-lifecycle';

export type PathMutationGateInput = {
  readonly scope: Exclude<PathMutationGateScope, PathlessScope>;
  readonly targetPath: string;
} | {
  readonly scope: PathlessScope;
  readonly targetPath?: never;
};

function isPathless(input: PathMutationGateInput): input is Extract<PathMutationGateInput, { readonly scope: PathlessScope }> {
  return input.scope === 'pi-session-rebinding' || input.scope === 'service-lifecycle';
}

export interface PathMutationGateAcquireOptions {
  /** Bounded wait for another conforming short-lived writer; relocation uses zero. */
  readonly waitMs?: number;
  /**
   * darwin only: the directory that holds the lock files instead of
   * {@link POSIX_GATE_ROOT}. It is checked like the default root. Holders
   * exclude each other only when they lock in the same root. Linux and
   * Windows ignore it: their gate has no filesystem root.
   */
  readonly gateRoot?: string;
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
/**
 * The gate's interprocess protocol: SDK processes of one release exclude each
 * other only when they lock the same way. Bump it with any change to how a
 * gate is taken, so the upgrade manifest records the break (#1149).
 */
export const PATH_MUTATION_GATE_PROTOCOL = 2;

// Fixed and environment-independent; holds the darwin lock files.
export const POSIX_GATE_ROOT = `/tmp/byok-pm-${process.getuid?.() ?? 'unknown'}`;
// Read at acquire time. Only the client test setup replaces it, so test runs do
// not leave one never-unlinked lock per temp path in the real root. Not exported
// from the package entry.
let posixGateRoot = POSIX_GATE_ROOT;

/** Internal test seam: `undefined` restores the production root. */
export function setPosixGateRootForTests(root: string | undefined): void {
  posixGateRoot = root ?? POSIX_GATE_ROOT;
}
// darwin <sys/fcntl.h>; Node and Bun pass open(2) flags through unchanged.
const DARWIN_O_EXLOCK = 0x20;

function assertAbsolutePath(value: string): void {
  if (!path.isAbsolute(value)) throw new Error('path mutation gate target must be absolute');
  if (/[\x00\r\n]/u.test(value)) throw new Error('path mutation gate target must not contain NUL or line breaks');
}

/** Canonicalize through the deepest existing ancestor without creating the target. */
export async function resolvePathWithoutCreate(input: string): Promise<string> {
  assertAbsolutePath(input);
  const ancestor = await resolveExistingAncestor(input);
  if (!ancestor) throw new Error(`no existing ancestor for ${input}`);
  return path.resolve(ancestor.canonical, ...ancestor.tail);
}

function gateIdentity(scope: PathMutationGateScope, canonicalTarget: string): string {
  return createHash('sha256').update(`${scope}\0${canonicalTarget}`).digest('hex');
}

async function assertPrivateGateRoot(root: string): Promise<void> {
  if (!path.isAbsolute(root)) throw new Error('path mutation gate root must be absolute');
  await ensureOwnedPrivateDirectory(root);
}

function resolveGateTarget(input: PathMutationGateInput): Promise<string> {
  // One fixed cross-process identity, including on Windows with multiple drives.
  return isPathless(input) ? Promise.resolve('*') : resolvePathWithoutCreate(input.targetPath);
}

/** Takes the OS lock for `identity`; resolves to the function that drops it, or `undefined` when another handle holds it. */
async function lockIdentity(identity: string, gateRoot: string | undefined): Promise<(() => Promise<void>) | undefined> {
  if (process.platform === 'darwin') {
    const root = gateRoot ?? posixGateRoot;
    await assertPrivateGateRoot(root);
    let fd: number;
    try {
      fd = openSync(
        path.join(root, `${identity}.lock`),
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

async function acquireOne(input: PathMutationGateInput, gateRoot: string | undefined): Promise<PathMutationGate> {
  const canonicalTarget = await resolveGateTarget(input);
  const identity = gateIdentity(input.scope, canonicalTarget);
  const unlock = await lockIdentity(identity, gateRoot);
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

/**
 * Acquire multiple path gates in one deterministic order to prevent deadlock.
 * `waitMs` bounds the whole acquisition, as {@link acquirePathMutationGate}'s does for one gate.
 */
export async function acquirePathMutationGates(
  inputs: readonly PathMutationGateInput[],
  options: PathMutationGateAcquireOptions = {},
): Promise<readonly PathMutationGate[]> {
  const deadline = waitDeadline(options);
  const resolved = await Promise.all(inputs.map(async (input) => {
    const targetPath = await resolveGateTarget(input);
    const canonicalInput: PathMutationGateInput = isPathless(input) ? input : { ...input, targetPath };
    return { input: canonicalInput, targetPath, identity: gateIdentity(input.scope, targetPath) };
  }));
  const unique = [...new Map(resolved.map((item) => [`${item.input.scope}\0${item.targetPath}`, item])).values()]
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const acquired: PathMutationGate[] = [];
  try {
    for (const item of unique) acquired.push(await acquireBefore(item.input, deadline, options.gateRoot));
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
  return acquireBefore(input, waitDeadline(options), options.gateRoot);
}

function waitDeadline(options: PathMutationGateAcquireOptions): number {
  const waitMs = options.waitMs ?? 0;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
    throw new Error('path mutation gate waitMs must be an integer from 0 through 30000');
  }
  return Date.now() + waitMs;
}

async function acquireBefore(input: PathMutationGateInput, deadline: number, gateRoot: string | undefined): Promise<PathMutationGate> {
  for (;;) {
    try {
      return await acquireOne(input, gateRoot);
    } catch (error) {
      if (!(error instanceof PathMutationGateBusyError) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now())));
      });
    }
  }
}
