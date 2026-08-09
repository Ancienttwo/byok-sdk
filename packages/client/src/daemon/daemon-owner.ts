import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import path from 'node:path';
import { ensureSecureDir } from '../util/secure-dir';

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

// A canonical-path-derived loopback listener is the cross-process mutex for
// the owner/reclaim transition. The listener identifies its store hash to
// another conforming contender: the same hash means "active"; a different
// valid hash means an unrelated store collided on this port and both sides can
// safely use the next deterministic candidate. An unknown/non-responsive
// listener remains fail-closed. Keeping this mutex separate is important:
// probing a stale owner's random liveness port must not observe the
// contender's own transition listener.
// Stay below the host ephemeral-client range used by the test/runtime HTTP and
// WebSocket connections. Candidate negotiation handles collisions between
// BYOK stores inside this reserved deterministic window.
const STORE_MUTEX_PORT_BASE = 10_000;
const STORE_MUTEX_PORT_COUNT = 10_000;
const STORE_MUTEX_PORT_CANDIDATES = 32;
const STORE_MUTEX_ID_PREFIX = 'byok-store-mutex-v1:';
const STORE_MUTEX_PROBE_TIMEOUT_MS = 1_000;

function storeMutexIdentity(canonicalStoreDir: string): string {
  return createHash('sha256').update(canonicalStoreDir).digest('hex');
}

function storeMutexPort(identity: string, attempt: number): number {
  const digest = Buffer.from(identity, 'hex');
  const start = digest.readUInt32BE(0) % STORE_MUTEX_PORT_COUNT;
  const step = 1 + (digest.readUInt32BE(4) % (STORE_MUTEX_PORT_COUNT - 1));
  return STORE_MUTEX_PORT_BASE + ((start + attempt * step) % STORE_MUTEX_PORT_COUNT);
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
  const server: Server = createServer((socket) => socket.end());
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

async function probeStoreMutex(port: number): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    let raw = '';
    const finish = (identity: string | undefined): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(identity);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(STORE_MUTEX_PROBE_TIMEOUT_MS, () => finish(undefined));
    socket.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > STORE_MUTEX_ID_PREFIX.length + 64 + 1) finish(undefined);
    });
    socket.once('end', () => {
      const line = raw.trimEnd();
      const identity = line.startsWith(STORE_MUTEX_ID_PREFIX)
        ? line.slice(STORE_MUTEX_ID_PREFIX.length)
        : undefined;
      finish(identity && /^[a-f0-9]{64}$/.test(identity) ? identity : undefined);
    });
    socket.once('error', () => finish(undefined));
  });
}

async function acquireStoreMutex(canonicalStoreDir: string): Promise<LivenessListener> {
  const identity = storeMutexIdentity(canonicalStoreDir);
  for (let attempt = 0; attempt < STORE_MUTEX_PORT_CANDIDATES; attempt += 1) {
    const server: Server = createServer((socket) => socket.end(`${STORE_MUTEX_ID_PREFIX}${identity}\n`));
    const port = storeMutexPort(identity, attempt);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      const holderIdentity = await probeStoreMutex(port);
      if (holderIdentity === identity || holderIdentity === undefined) {
        throw new DaemonOwnerActiveError('unknown');
      }
      continue;
    }
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
  throw new DaemonOwnerActiveError('unknown');
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
 * Cross-process, fail-closed ownership for store mutations that must never
 * race a daemon. A separate exclusive reclaim file serializes stale-owner recovery so two
 * starters cannot accidentally rename each other's newly-acquired lease.
 */
export async function acquireDaemonOwner(
  storeDir: string,
  role: OwnerRecord['role'],
  clock: () => Date = () => new Date(),
): Promise<DaemonOwnerLease> {
  await ensureSecureDir(storeDir);
  // Resolve aliases before deriving the kernel mutex identity. `ownerPath`
  // may still be reached through the operator-supplied spelling below, but a
  // symlink/junction alias and the canonical directory must contend for the
  // same transition mutex or they could otherwise run two stale-owner
  // reclaim sequences against the same underlying pathnames.
  const canonicalStoreDir = await fs.realpath(storeDir);
  // The mutex closes the stale-owner/reclaim TOCTOU: only one conforming
  // process can inspect, remove and republish these pathnames at a time. It is
  // retained for the full lease so another process cannot pass the pathname
  // checks during the small owner-file publication/release windows.
  const mutex = await acquireStoreMutex(canonicalStoreDir);
  let liveness: LivenessListener | undefined;
  try {
    liveness = await createLivenessListener();
  } catch (err) {
    await mutex.close().catch(() => undefined);
    throw err;
  }
  const ownerPath = path.join(storeDir, DAEMON_OWNER_FILENAME);
  const reclaimPath = path.join(storeDir, RECLAIM_FILENAME);
  const record: OwnerRecord = {
    version: 2,
    pid: process.pid,
    nonce: randomUUID(),
    role,
    acquiredAt: clock().toISOString(),
    processStartedAt: SELF_PROCESS_STARTED_AT,
    livenessPort: liveness.port,
  };

  try {
    for (;;) {
      if (await reclaimExistsAndIsActive(reclaimPath)) {
        throw new Error('store mutation lease is being reclaimed; retry after the current operation finishes');
      }
      await fs.rm(reclaimPath, { force: true });

      if (await createOwner(ownerPath, record)) {
        let released = false;
        return {
          release: async () => {
            if (released) return;
            const current = await readOwner(ownerPath);
            if (current?.nonce !== record.nonce) {
              throw new Error('store mutation lease identity changed before release');
            }
            await fs.rm(ownerPath);
            released = true;
            try {
              await liveness.close();
            } finally {
              await mutex.close();
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
    await liveness.close().catch(() => undefined);
    await mutex.close().catch(() => undefined);
    throw err;
  }
}
