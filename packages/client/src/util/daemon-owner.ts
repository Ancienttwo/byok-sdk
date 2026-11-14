import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { sameContent } from './file-state.js';
import { ensureSecureStoreRoot } from './secure-dir.js';
import { listenPrivateUnixSocket, privateSocketEndpoint, PrivateSocketInUseError, reclaimPrivateSocketFallbackDirectory } from './private-unix-socket.js';
import { releaseAfterFailure, withRelease } from './with-release.js';
import {
  acquirePathMutationGate,
  PathMutationGateBusyError,
  withGateReleaseFailures,
  type PathMutationGate,
} from '../util/path-mutation-gate.js';

export const DAEMON_OWNER_FILENAME = 'daemon-owner.json';
const RECLAIM_FILENAME = `${DAEMON_OWNER_FILENAME}.reclaim`;
const MAX_OWNER_BYTES = 4096;
const RECLAIM_MALFORMED_GRACE_MS = 30_000;
// Node exposes the current process lifetime without relying on `ps`, procps,
// PowerShell, or another host command. Foreign-PID reuse is distinguished by
// the kernel-owned liveness listener recorded alongside this timestamp.
const SELF_PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();

interface OwnerRecord {
  version: 2;
  pid: number;
  nonce: string;
  /** `installer`: a service installation holding a stopped store across an upgrade, rollback or recover (#1328). */
  role: 'daemon' | 'doctor' | 'installer';
  acquiredAt: string;
  processStartedAt: string;
  livenessPort: number;
}

export interface DaemonOwnerLease {
  release(): Promise<void>;
}

interface LivenessListener {
  port: number;
  close(): Promise<void>;
}

/** The lock endpoint held for a store's whole owner lease — a Unix domain socket on POSIX, a named pipe on win32. */
interface StoreMutexLock {
  endpoint: string;
  close(): Promise<void>;
}

/**
 * These ownership listeners only answer a liveness/identity probe and retain
 * no per-connection state. A probe may close as soon as it has established
 * that the endpoint is bound, before this response reaches the kernel. Node
 * then reports the expected peer reset as `ECONNRESET`/`EPIPE` on the accepted
 * socket; consume it here so it cannot become an uncaught process error.
 */
function endOwnershipProbe(socket: Socket): void {
  socket.on('error', () => {});
  socket.end();
}

// The store-scoped mutex is independent of the random TCP liveness listener:
// probing a stale owner must never observe the contender's own mutex.
const STORE_MUTEX_SOCKET_FILENAME = 'mutex.sock';

function storeMutexIdentity(canonicalStoreDir: string): string {
  return createHash('sha256').update(canonicalStoreDir).digest('hex');
}

/** Store-scoped endpoint, derived from the canonical store alone; pipe names are machine-wide. @internal */
export function storeMutexEndpoint(
  canonicalStoreDir: string,
  identity: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return `\\\\.\\pipe\\byok-store-mutex-${identity.slice(0, 16)}`;
  const candidate = path.join(canonicalStoreDir, STORE_MUTEX_SOCKET_FILENAME);
  return privateSocketEndpoint('storeMutex', candidate, identity.slice(0, 16));
}

export class DaemonOwnerActiveError extends Error {
  constructor(public readonly role: OwnerRecord['role'] | 'unknown', options?: ErrorOptions) {
    super(`store mutation lease is already held by an active ${role} process`, options);
    this.name = 'DaemonOwnerActiveError';
  }
}

/** Another process is reclaiming this store's stale lease; retry once it is done. */
export class DaemonOwnerReclaimingError extends Error {
  constructor(options?: ErrorOptions) {
    super('store mutation lease is being reclaimed; retry after the current operation finishes', options);
    this.name = 'DaemonOwnerReclaimingError';
  }
}

function withOwnerReleaseFailures<T>(error: T, failures: readonly unknown[]): T | Error {
  if (failures.length === 0) return error;
  const cause = new AggregateError([error, ...failures]);
  if (error instanceof DaemonOwnerActiveError) return new DaemonOwnerActiveError(error.role, { cause });
  if (error instanceof DaemonOwnerReclaimingError) return new DaemonOwnerReclaimingError({ cause });
  return withGateReleaseFailures(error, failures) as Error;
}

function isOwnerRecord(value: unknown): value is OwnerRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<OwnerRecord>;
  return (
    candidate.version === 2 &&
    Number.isSafeInteger(candidate.pid) &&
    (candidate.pid ?? 0) > 0 &&
    typeof candidate.nonce === 'string' &&
    candidate.nonce.length === 36 &&
    (candidate.role === 'daemon' || candidate.role === 'doctor' || candidate.role === 'installer') &&
    typeof candidate.acquiredAt === 'string' &&
    Number.isFinite(Date.parse(candidate.acquiredAt)) &&
    typeof candidate.processStartedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.processStartedAt)) &&
    Number.isSafeInteger(candidate.livenessPort) &&
    (candidate.livenessPort ?? 0) > 0 &&
    (candidate.livenessPort ?? 0) <= 65_535
  );
}

async function readOwner(filePath: string): Promise<OwnerRecord | undefined> {
  let namedBefore: import('node:fs').BigIntStats;
  try {
    namedBefore = await fs.lstat(filePath, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) {
    throw new Error('store mutation owner path is not a real regular file');
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    const namedAfterOpen = await fs.lstat(filePath, { bigint: true });
    if (
      !stat.isFile() ||
      !namedAfterOpen.isFile() ||
      namedAfterOpen.isSymbolicLink() ||
      !sameContent(stat, namedBefore) ||
      !sameContent(stat, namedAfterOpen)
    ) {
      throw new Error('store mutation owner path changed before safe open');
    }
    if (stat.size <= 0 || stat.size > MAX_OWNER_BYTES) return undefined;
    const size = Number(stat.size);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    const after = await handle.stat({ bigint: true });
    const namedAfterRead = await fs.lstat(filePath, { bigint: true });
    if (
      bytesRead !== size ||
      !sameContent(after, stat) ||
      !sameContent(namedAfterRead, stat)
    ) {
      throw new Error('store mutation owner path changed during inspection');
    }
    const raw = buffer.toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    return isOwnerRecord(parsed) ? parsed : undefined;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('store mutation owner path changed')) throw err;
    return undefined;
  } finally {
    await handle.close();
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function processOwnsRecord(record: OwnerRecord): Promise<boolean> {
  if (!pidIsAlive(record.pid)) return false;
  if (record.pid === process.pid && record.processStartedAt !== SELF_PROCESS_STARTED_AT) return false;
  // The listener is the kernel-owned liveness authority. A PID can be reused,
  // but the replacement process does not inherit this bound port. Probing by
  // attempting the same exclusive bind therefore distinguishes a real live
  // lease from an unrelated process without `ps`, PowerShell, /proc, or a
  // platform-specific dependency. EADDRINUSE is intentionally fail-closed:
  // an unrelated listener collision may delay recovery, but can never admit
  // two store writers.
  return portIsBound(record.livenessPort);
}

async function portIsBound(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise<boolean>((resolve, reject) => {
    const finish = (result: boolean): void => {
      probe.removeAllListeners();
      resolve(result);
    };
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') finish(true);
      else reject(err);
    });
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close((err) => {
        if (err) reject(err);
        else finish(false);
      });
    });
  });
}

async function createLivenessListener(): Promise<LivenessListener> {
  const server: Server = createServer((socket) => endOwnershipProbe(socket));
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('store mutation liveness listener did not expose a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  server.unref();
  let closed = false;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function acquireStoreMutex(canonicalStoreDir: string): Promise<StoreMutexLock> {
  return acquireStoreMutexOnce(canonicalStoreDir);
}

async function acquireStoreMutexOnce(canonicalStoreDir: string): Promise<StoreMutexLock> {
  const identity = storeMutexIdentity(canonicalStoreDir);
  const endpoint = storeMutexEndpoint(canonicalStoreDir, identity);
  const server: Server = createServer((socket) => endOwnershipProbe(socket));
  try {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } else {
      await listenPrivateUnixSocket(server, endpoint);
    }
  } catch (err) {
    if (err instanceof PrivateSocketInUseError || (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new DaemonOwnerActiveError('unknown');
    }
    throw err;
  }
  server.unref();
  let closed = false;
  return {
    endpoint,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      // Node and Bun remove the Unix socket during listener close. A second
      // unlink after its callback could instead remove a successor's socket.
      // Only reclaim the empty fallback parent: non-recursive rmdir leaves a
      // directory containing a newly bound socket untouched.
      if (process.platform !== 'win32') {
        await reclaimPrivateSocketFallbackDirectory(endpoint);
      }
    },
  };
}

async function reclaimExistsAndIsActive(reclaimPath: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.lstat(reclaimPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!stat.isFile()) throw new Error('store mutation reclaim marker is not a regular file');
  const owner = await readOwner(reclaimPath);
  if (owner) return processOwnsRecord(owner);
  // A marker without the complete PID + process-start identity contract is
  // malformed, never an alternate compatibility authority. Keep only a short
  // fail-closed grace for a creator that may have crashed mid-publication.
  return Date.now() - stat.mtimeMs <= RECLAIM_MALFORMED_GRACE_MS;
}

async function createOwner(filePath: string, record: OwnerRecord): Promise<boolean> {
  const tempPath = `${filePath}.${record.pid}.${record.nonce}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    try {
      await fs.link(tempPath, filePath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Read-only relocation inspection. The caller must already hold this store's
 * path-mutation gate, so a conforming writer cannot publish after this check.
 * Any persisted owner or reclaim object is a refusal; relocation never
 * reclaims crash residue or repairs SDK-private state.
 *
 * @internal Used only by the high-level local-state relocation coordinator.
 */
export async function assertDaemonStoreQuiescent(storeDir: string): Promise<void> {
  const inspect = async (filePath: string, label: string): Promise<void> => {
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${label} is not a real regular file`);
    }
    const record = await readOwner(filePath);
    if (record === undefined) throw new Error(`${label} is corrupt or incomplete`);
    throw new DaemonOwnerActiveError(record.role);
  };

  await inspect(path.join(storeDir, DAEMON_OWNER_FILENAME), 'store mutation owner');
  await inspect(path.join(storeDir, RECLAIM_FILENAME), 'store mutation reclaim marker');
}

/**
 * Cross-process, fail-closed ownership for store mutations that must never
 * race a daemon. A separate exclusive reclaim file serializes stale-owner recovery so two
 * starters cannot accidentally rename each other's newly-acquired lease.
 */
export async function acquireDaemonOwner(
  storeDir: string,
  role: OwnerRecord['role'],
  clock: () => Date = () => new Date(),
): Promise<DaemonOwnerLease> {
  let pathGate: PathMutationGate | undefined;
  try {
    pathGate = await acquirePathMutationGate({ scope: 'store', targetPath: storeDir }, { waitMs: 1_000 });
  } catch (error) {
    if (error instanceof PathMutationGateBusyError) throw new DaemonOwnerActiveError('unknown');
    throw error;
  }
  let mutex: StoreMutexLock | undefined;
  let liveness: LivenessListener | undefined;
  const failures: unknown[] = [];
  try {
    // No target path is created until the fixed OS-temp path gate is held.
    // Relocation uses the same gate and therefore cannot pass inspection
    // between this directory creation and owner publication.
    await ensureSecureStoreRoot(storeDir);
    const canonicalStoreDir = await fs.realpath(storeDir);
    // The retained store mutex still owns stale-owner recovery and the full
    // daemon lifetime. The path gate is narrower: publication only.
    mutex = await acquireStoreMutex(canonicalStoreDir);
    liveness = await createLivenessListener();
    const ownerPath = path.join(canonicalStoreDir, DAEMON_OWNER_FILENAME);
    const reclaimPath = path.join(canonicalStoreDir, RECLAIM_FILENAME);
    const record: OwnerRecord = {
      version: 2,
      pid: process.pid,
      nonce: randomUUID(),
      role,
      acquiredAt: clock().toISOString(),
      processStartedAt: SELF_PROCESS_STARTED_AT,
      livenessPort: liveness.port,
    };

    for (;;) {
      if (await reclaimExistsAndIsActive(reclaimPath)) {
        throw new DaemonOwnerReclaimingError();
      }
      await fs.rm(reclaimPath, { force: true });

      if (await createOwner(ownerPath, record)) {
        try {
          await pathGate.release();
          pathGate = undefined;
        } catch (error) {
          return await releaseAfterFailure(error, () => fs.rm(ownerPath, { force: true }), (primary, errors) => { failures.push(...errors); return primary; });
        }
        const ownedLiveness = liveness;
        const ownedMutex = mutex;
        let released = false;
        return {
          release: async () => {
            if (released) return;
            const releaseGate = await acquirePathMutationGate({
              scope: 'store',
              targetPath: canonicalStoreDir,
            }, { waitMs: 2_000 });
            await withRelease(async () => {
              const current = await readOwner(ownerPath);
              if (current?.nonce !== record.nonce) {
                throw new Error('store mutation lease identity changed before release');
              }
              await ownedLiveness.close();
              await ownedMutex.close();
              await fs.rm(ownerPath);
              released = true;
            }, () => releaseGate.release(), withOwnerReleaseFailures);
          },
        };
      }

      const existing = await readOwner(ownerPath);
      if (existing && (await processOwnsRecord(existing))) throw new DaemonOwnerActiveError(existing.role);

      if (!(await createOwner(reclaimPath, record))) {
        throw new DaemonOwnerReclaimingError();
      }
      await withRelease(async () => {
        const rechecked = await readOwner(ownerPath);
        if (rechecked && (await processOwnsRecord(rechecked))) throw new DaemonOwnerActiveError(rechecked.role);
        if (rechecked || (await fs.stat(ownerPath).then(() => true, (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return false;
          throw err;
        }))) {
          await fs.rm(ownerPath);
        }
      }, async () => {
        const currentReclaim = await readOwner(reclaimPath);
        if (currentReclaim?.nonce === record.nonce) await fs.rm(reclaimPath, { force: true });
      }, (error, errors) => { failures.push(...errors); return error; });
    }
  } catch (err) {
    for (const close of [() => liveness?.close(), () => mutex?.close(), () => pathGate?.release()]) {
      try { await close(); } catch (failure) { failures.push(failure); }
    }
    throw withOwnerReleaseFailures(err, failures);
  }
}
