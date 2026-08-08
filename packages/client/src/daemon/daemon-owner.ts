import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureSecureDir } from '../util/secure-dir';

export const DAEMON_OWNER_FILENAME = 'daemon-owner.json';
const RECLAIM_FILENAME = `${DAEMON_OWNER_FILENAME}.reclaim`;
const MAX_OWNER_BYTES = 4096;

interface OwnerRecord {
  version: 1;
  pid: number;
  nonce: string;
  role: 'daemon' | 'doctor';
  acquiredAt: string;
}

export interface DaemonOwnerLease {
  release(): Promise<void>;
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
    candidate.version === 1 &&
    Number.isSafeInteger(candidate.pid) &&
    (candidate.pid ?? 0) > 0 &&
    typeof candidate.nonce === 'string' &&
    candidate.nonce.length === 36 &&
    (candidate.role === 'daemon' || candidate.role === 'doctor') &&
    typeof candidate.acquiredAt === 'string' &&
    Number.isFinite(Date.parse(candidate.acquiredAt))
  );
}

async function readOwner(filePath: string): Promise<OwnerRecord | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OWNER_BYTES) return undefined;
    const raw = await handle.readFile('utf8');
    const parsed: unknown = JSON.parse(raw);
    return isOwnerRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
  const ownerPath = path.join(storeDir, DAEMON_OWNER_FILENAME);
  const reclaimPath = path.join(storeDir, RECLAIM_FILENAME);
  const record: OwnerRecord = { version: 1, pid: process.pid, nonce: randomUUID(), role, acquiredAt: clock().toISOString() };

  for (;;) {
    try {
      await fs.access(reclaimPath);
      throw new Error('store mutation lease is being reclaimed; retry after the current operation finishes');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (await createOwner(ownerPath, record)) {
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          const current = await readOwner(ownerPath);
          if (current?.nonce !== record.nonce) {
            throw new Error('store mutation lease identity changed before release');
          }
          await fs.rm(ownerPath);
        },
      };
    }

    const existing = await readOwner(ownerPath);
    if (existing && processIsAlive(existing.pid)) throw new DaemonOwnerActiveError(existing.role);

    let reclaim: Awaited<ReturnType<typeof fs.open>>;
    try {
      reclaim = await fs.open(reclaimPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('store mutation lease is being reclaimed; retry after the current operation finishes');
      }
      throw err;
    }
    try {
      await reclaim.writeFile(`${process.pid}\n`, 'utf8');
      await reclaim.sync();
      const rechecked = await readOwner(ownerPath);
      if (rechecked && processIsAlive(rechecked.pid)) throw new DaemonOwnerActiveError(rechecked.role);
      if (rechecked || (await fs.stat(ownerPath).then(() => true, (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      }))) {
        await fs.rm(ownerPath);
      }
    } finally {
      await reclaim.close();
      await fs.rm(reclaimPath, { force: true });
    }
  }
}
