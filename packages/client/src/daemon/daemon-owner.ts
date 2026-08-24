import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { ensureSecureDir } from '../util/secure-dir';
import {
  acquirePathMutationGate,
  PathMutationGateBusyError,
  type PathMutationGate,
} from './path-mutation-gate';

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
  role: 'daemon' | 'doctor';
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
function endOwnershipProbe(socket: Socket, response?: string): void {
  socket.on('error', () => {});
  if (response === undefined) socket.end();
  else socket.end(response);
}

// A STORE-SCOPED lock endpoint is the cross-process mutex for the
// owner/reclaim transition: a Unix domain socket at a path derived from the
// canonical storeDir (POSIX) or a named pipe whose name is derived from that
// same path's hash (win32) — the identical platform split, and the identical
// conventions (path-length fallback, stale-socket-file cleanup, private
// endpoint directory), that `control-server.ts`/`control-protocol.ts` already
// use for the daemon's control endpoint.
//
// It was previously a listener on a loopback TCP port derived from the same
// hash into a shared band (10000..29999). That namespace is not this SDK's to
// reserve: ordinary third-party software occupying the derived port — WeChat,
// VS Code helpers, cloudflared, `ssh -L`, all accept-then-stay-silent
// listeners — made the identity probe time out, which fails closed and denied
// a store its own lease with no way out (a hash is deterministic, so the
// affected store stayed locked out of `start`/doctor for as long as the
// squatter ran; see this task's `scratchpad/rcp-mutex/13-external-listener-
// classification.txt` for the ten live listeners classified on one machine).
// A store-scoped endpoint is not in any shared namespace, so a foreign
// listener cannot appear on it and the ambiguous "connected but unidentified"
// outcome is unreachable in practice; where it is still representable
// (something planted at this store's own private lock path) it stays
// fail-closed exactly as before, and there is deliberately NO "advance to
// another candidate" branch — advancing is what would reopen the
// stale-owner/reclaim TOCTOU this mutex exists to close.
//
// The holder still presents `STORE_MUTEX_ID_PREFIX + sha256(canonicalStoreDir)`
// on accept, so a contender's probe gets a definitive answer about WHAT is
// holding the endpoint rather than inferring it from the address alone.
// Keeping this mutex separate from the liveness listener still matters:
// probing a stale owner's random liveness port must not observe the
// contender's own transition listener.
const STORE_MUTEX_ID_PREFIX = 'byok-store-mutex-v1:';
const STORE_MUTEX_PROBE_TIMEOUT_MS = 1_000;
const STORE_MUTEX_SOCKET_FILENAME = 'mutex.sock';
/**
 * Same conservative `sockaddr_un.sun_path` budget `control-protocol.ts`'s
 * `controlSocketPath` uses, for the same reason: macOS caps that field at 104
 * bytes including the NUL (Linux 108), and the kernel rejects an over-long
 * address outright — `EINVAL` at `bind()`, not a truncation this code could
 * detect afterwards.
 */
const UNIX_SOCKET_PATH_SOFT_LIMIT = 100;
/**
 * The one fixed root the long-path branch below binds under. Deliberately NOT
 * `os.tmpdir()`, which reads `TMPDIR`/`TMP`/`TEMP`: a mutex address that
 * varies with the environment is not a mutex. A daemon started by a service
 * manager and a doctor run from an operator's shell routinely see different
 * `TMPDIR` values, and would then derive DIFFERENT lock addresses for the same
 * store and both acquire it — the exact failure this whole file exists to
 * prevent. A literal `/tmp` is POSIX-guaranteed, environment-independent, and
 * short enough that this candidate always fits the budget above.
 */
const STORE_MUTEX_FALLBACK_ROOT = '/tmp';

function storeMutexIdentity(canonicalStoreDir: string): string {
  return createHash('sha256').update(canonicalStoreDir).digest('hex');
}

/**
 * Where this store's lock lives. Keyed by the CANONICAL storeDir alone — not
 * by product id or OS user — because the store is the resource being
 * serialized: a symlink alias and its target, or two products pointed at one
 * store directory, must contend for the same endpoint (see
 * `acquireDaemonOwner`'s own note on resolving aliases before deriving this).
 *
 * POSIX prefers `<storeDir>/mutex.sock`, keeping the lock beside the store
 * state it guards in a directory `ensureSecureDir` has already made 0700. A
 * storeDir can be long enough that no address under it fits
 * {@link UNIX_SOCKET_PATH_SOFT_LIMIT} — a storeDir alone can exceed the whole
 * `sun_path` budget — so the second candidate drops the storeDir from the path
 * entirely and carries it as a hash under {@link STORE_MUTEX_FALLBACK_ROOT},
 * nested one level deep so that directory can be created 0700 BEFORE anything
 * binds inside it (the nesting convention is `controlSocketPath`'s).
 *
 * `controlSocketPath`'s fallback now binds under its own FIXED `/tmp` root
 * (`control-protocol.ts`'s `CONTROL_SOCKET_FALLBACK_ROOT` — not
 * `os.tmpdir()`); this mutex must not regress to `os.tmpdir()` for the same
 * two independent reasons proven by CI job 94334133652. Correctness:
 * `os.tmpdir()` is environment-derived, and a lock address that differs
 * between two contending processes admits two writers. Reachability: the
 * caller may have pointed `TMPDIR` INSIDE the very tree that made the natural
 * path too long — there, `os.tmpdir()` yields an address LONGER than the one
 * being escaped (152 bytes vs 126 in that job), so the "fallback" cannot bind
 * at all. A fixed short root is immune to both.
 *
 * win32 has no socket file to place; a named pipe lives in one flat
 * machine-wide namespace, so the name carries the store hash to keep two
 * stores from colliding, and no length branch is needed.
 *
 * @internal Exported for the regression guard only (never re-exported from
 * `index.ts`): the crashed-holder recovery path can only be exercised by
 * planting a stale socket file at the exact address this derives, and a test
 * recomputing the derivation itself would prove nothing about this one.
 */
export function storeMutexEndpoint(
  canonicalStoreDir: string,
  identity: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return `\\\\.\\pipe\\byok-store-mutex-${identity.slice(0, 16)}`;
  const candidate = path.join(canonicalStoreDir, STORE_MUTEX_SOCKET_FILENAME);
  if (Buffer.byteLength(candidate, 'utf8') <= UNIX_SOCKET_PATH_SOFT_LIMIT) return candidate;
  return path.join(STORE_MUTEX_FALLBACK_ROOT, `byok-store-mutex-${identity.slice(0, 16)}`, 'sock');
}

export class DaemonOwnerActiveError extends Error {
  constructor(public readonly role: OwnerRecord['role'] | 'unknown') {
    super(`store mutation lease is already held by an active ${role} process`);
    this.name = 'DaemonOwnerActiveError';
  }
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
    (candidate.role === 'daemon' || candidate.role === 'doctor') &&
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
      stat.dev !== namedBefore.dev ||
      stat.ino !== namedBefore.ino ||
      stat.size !== namedBefore.size ||
      stat.mtimeNs !== namedBefore.mtimeNs ||
      stat.ctimeNs !== namedBefore.ctimeNs ||
      stat.dev !== namedAfterOpen.dev ||
      stat.ino !== namedAfterOpen.ino ||
      stat.size !== namedAfterOpen.size ||
      stat.mtimeNs !== namedAfterOpen.mtimeNs ||
      stat.ctimeNs !== namedAfterOpen.ctimeNs
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
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs ||
      namedAfterRead.dev !== stat.dev ||
      namedAfterRead.ino !== stat.ino ||
      namedAfterRead.size !== stat.size ||
      namedAfterRead.mtimeNs !== stat.mtimeNs ||
      namedAfterRead.ctimeNs !== stat.ctimeNs
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

type StoreMutexProbe =
  /** Nothing is listening behind this name — on POSIX, a socket FILE left by a holder that died without closing it. */
  | { kind: 'unbound' }
  /** Presented this store's identity line: a proven, conforming holder of THIS store's lease. */
  | { kind: 'holder' }
  /** Answered the connect but never presented the contract (or went silent). Not proven to be anything; never proven absent either. */
  | { kind: 'occupied' };

async function probeStoreMutex(endpoint: string, identity: string): Promise<StoreMutexProbe> {
  return new Promise<StoreMutexProbe>((resolve) => {
    const socket = createConnection(endpoint);
    let settled = false;
    let raw = '';
    const finish = (result: StoreMutexProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    // A conforming holder writes its identity immediately after accept. A
    // connection that stays open without doing so is ambiguous rather than
    // proven absent: a conforming same-store process may have accepted the
    // socket and then had its event loop starved. Bound rather than left to
    // the socket's own inactivity timer so a slow drip cannot extend it.
    const timer = setTimeout(() => finish({ kind: 'occupied' }), STORE_MUTEX_PROBE_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > STORE_MUTEX_ID_PREFIX.length + 64 + 1) finish({ kind: 'occupied' });
    });
    socket.once('end', () => finish(raw.trimEnd() === `${STORE_MUTEX_ID_PREFIX}${identity}` ? { kind: 'holder' } : { kind: 'occupied' }));
    // `ECONNREFUSED`/`ENOENT` is the one positive proof of absence POSIX
    // offers: the name resolves to no listening socket. Every other errno
    // (`EACCES`, `ENOTSOCK`, a reset mid-handshake) leaves the endpoint's real
    // state unknown, which this treats as occupied — the same "unknown state
    // is unsafe" convention `control-server.ts`'s `probeUnixSocketAlive` uses.
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish(err.code === 'ECONNREFUSED' || err.code === 'ENOENT' ? { kind: 'unbound' } : { kind: 'occupied' }),
    );
  });
}

/**
 * POSIX only. The lock's socket FILE outlives a holder that died without
 * closing it (crash, `kill -9`), and is then indistinguishable on disk from
 * one a live holder is bound to — so a real connect decides, exactly as
 * `control-server.ts`'s `handleStaleUnixSocket` does for the control socket.
 * Only a proven-unbound name is unlinked; anything answering keeps the lease
 * refused. A path that is not a socket at all is refused rather than removed:
 * an unexpected object at this store's own lock path is an unknown state, and
 * unlinking it would be this code destroying something it cannot identify.
 */
async function clearStaleStoreMutexSocket(endpoint: string, identity: string): Promise<void> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(endpoint);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!stat.isSocket()) throw new Error('store mutation lock path exists but is not a socket');
  if ((await probeStoreMutex(endpoint, identity)).kind !== 'unbound') throw new DaemonOwnerActiveError('unknown');
  await fs.rm(endpoint, { force: true });
}

/**
 * Mirrors `control-server.ts`'s `assertOwnedPrivateDir` (private to that
 * module) for this lock's own {@link STORE_MUTEX_FALLBACK_ROOT} directory,
 * which matters more here than there: `/tmp` is world-writable, `fs.mkdir` is
 * a silent no-op against a directory that already exists and never fixes its
 * ownership, and the fallback name is fully predictable from `storeDir` alone,
 * so another user on the same machine can pre-create it — as a symlink, or
 * simply owned by a different uid — and control what may be planted at the
 * exact path this process is about to bind. `lstat` (never `stat`, which
 * follows a symlink) fails closed on both properties.
 */
async function assertOwnedPrivateDir(dir: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || stat.uid !== uid) {
    throw new Error(`refusing to bind the store mutation lock under "${dir}": not a real directory owned by this process's own uid`);
  }
}

async function acquireStoreMutex(canonicalStoreDir: string): Promise<StoreMutexLock> {
  const identity = storeMutexIdentity(canonicalStoreDir);
  const endpoint = storeMutexEndpoint(canonicalStoreDir, identity);
  const isPipe = process.platform === 'win32';
  if (!isPipe) {
    const endpointDir = path.dirname(endpoint);
    // A no-op for the common `<storeDir>/mutex.sock` case (the caller
    // already ran `ensureSecureDir` on it); real work only for the fixed
    // `/tmp` fallback (see STORE_MUTEX_FALLBACK_ROOT — not `os.tmpdir()`),
    // whose subdirectory does not exist the first time a given store lands
    // there.
    if (endpointDir !== canonicalStoreDir) {
      await ensureSecureDir(endpointDir);
      await assertOwnedPrivateDir(endpointDir);
    }
    await clearStaleStoreMutexSocket(endpoint, identity);
  }
  const server: Server = createServer((socket) => endOwnershipProbe(socket, `${STORE_MUTEX_ID_PREFIX}${identity}\n`));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (err) {
    // Someone else owns this store's endpoint: a live holder, or the loser's
    // half of a race against the stale-socket unlink just above. Either way
    // this store already has a contender that got there first — refuse, and
    // never walk to a second address, which is what would let two processes
    // run the stale-owner/reclaim sequence against the same pathnames.
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new DaemonOwnerActiveError('unknown');
    throw err;
  }
  // The socket file's own mode, on top of the 0700 directory that already
  // gates traversal to it — same post-bind tightening `bindControlEndpoint`
  // does, and best-effort for the same reason (a mode change this process
  // does not own is `EPERM`, not a safety failure).
  if (!isPipe) await fs.chmod(endpoint, 0o600).catch(() => undefined);
  server.unref();
  let closed = false;
  return {
    endpoint,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      // A pipe has no file to remove; a Unix socket does, and leaving it
      // behind would cost the next acquire a probe round-trip to prove stale.
      if (!isPipe) await fs.rm(endpoint, { force: true }).catch(() => undefined);
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
    pathGate = await acquirePathMutationGate({ scope: 'store', targetPath: storeDir });
  } catch (error) {
    if (error instanceof PathMutationGateBusyError) throw new DaemonOwnerActiveError('unknown');
    throw error;
  }
  let mutex: StoreMutexLock | undefined;
  let liveness: LivenessListener | undefined;
  try {
    // No target path is created until the fixed OS-temp path gate is held.
    // Relocation uses the same gate and therefore cannot pass inspection
    // between this directory creation and owner publication.
    await ensureSecureDir(storeDir);
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
        throw new Error('store mutation lease is being reclaimed; retry after the current operation finishes');
      }
      await fs.rm(reclaimPath, { force: true });

      if (await createOwner(ownerPath, record)) {
        try {
          await pathGate.release();
          pathGate = undefined;
        } catch (error) {
          await fs.rm(ownerPath, { force: true }).catch(() => undefined);
          throw error;
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
            });
            try {
              const current = await readOwner(ownerPath);
              if (current?.nonce !== record.nonce) {
                throw new Error('store mutation lease identity changed before release');
              }
              await ownedLiveness.close();
              await ownedMutex.close();
              await fs.rm(ownerPath);
              released = true;
            } finally {
              await releaseGate.release();
            }
          },
        };
      }

      const existing = await readOwner(ownerPath);
      if (existing && (await processOwnsRecord(existing))) throw new DaemonOwnerActiveError(existing.role);

      if (!(await createOwner(reclaimPath, record))) {
        throw new Error('store mutation lease is being reclaimed; retry after the current operation finishes');
      }
      try {
        const rechecked = await readOwner(ownerPath);
        if (rechecked && (await processOwnsRecord(rechecked))) throw new DaemonOwnerActiveError(rechecked.role);
        if (rechecked || (await fs.stat(ownerPath).then(() => true, (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return false;
          throw err;
        }))) {
          await fs.rm(ownerPath);
        }
      } finally {
        const currentReclaim = await readOwner(reclaimPath);
        if (currentReclaim?.nonce === record.nonce) await fs.rm(reclaimPath, { force: true });
      }
    }
  } catch (err) {
    await liveness?.close().catch(() => undefined);
    await mutex?.close().catch(() => undefined);
    await pathGate?.release().catch(() => undefined);
    throw err;
  }
}
