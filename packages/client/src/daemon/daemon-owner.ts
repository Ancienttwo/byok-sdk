import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureSecureDir } from '../util/secure-dir';

export const DAEMON_OWNER_FILENAME = 'daemon-owner.json';
const RECLAIM_FILENAME = `${DAEMON_OWNER_FILENAME}.reclaim`;
const MAX_OWNER_BYTES = 4096;
const RECLAIM_MALFORMED_GRACE_MS = 30_000;
const execFileAsync = promisify(execFile);

interface OwnerRecord {
  version: 1;
  pid: number;
  nonce: string;
  role: 'daemon' | 'doctor';
  acquiredAt: string;
  processStartedAt?: string;
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
    Number.isFinite(Date.parse(candidate.acquiredAt)) &&
    (candidate.processStartedAt === undefined ||
      (typeof candidate.processStartedAt === 'string' && Number.isFinite(Date.parse(candidate.processStartedAt))))
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

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function processStartedAt(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 2_000,
        maxBuffer: 16 * 1024,
      });
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

async function processOwnsRecord(record: OwnerRecord): Promise<boolean> {
  if (!pidIsAlive(record.pid)) return false;
  // Legacy records have no process-start token. Preserve their fail-closed
  // behavior while they are live; every newly-created record below carries
  // the token, which lets a recycled PID be distinguished from its owner.
  if (!record.processStartedAt) return true;
  const observed = await processStartedAt(record.pid);
  return observed === undefined || observed === record.processStartedAt;
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
  // Old versions wrote a bare PID. Recover it safely when dead; a fresh
  // malformed marker gets a short fail-closed grace window for an older
  // process that crashed between create and write.
  const raw = await fs.readFile(reclaimPath, 'utf8').catch(() => '');
  const legacyPid = /^\s*(\d+)\s*$/.exec(raw)?.[1];
  if (legacyPid && pidIsAlive(Number(legacyPid))) return true;
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
  const ownerPath = path.join(storeDir, DAEMON_OWNER_FILENAME);
  const reclaimPath = path.join(storeDir, RECLAIM_FILENAME);
  const selfStartedAt = await processStartedAt(process.pid);
  if (!selfStartedAt) throw new Error('could not establish process start identity for the store mutation lease');
  const record: OwnerRecord = {
    version: 1,
    pid: process.pid,
    nonce: randomUUID(),
    role,
    acquiredAt: clock().toISOString(),
    processStartedAt: selfStartedAt,
  };

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
}
