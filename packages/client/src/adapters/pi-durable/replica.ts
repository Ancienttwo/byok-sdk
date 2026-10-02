import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureSecureDir } from '../../util/secure-dir';

export interface DurableReplicaBinding {
  readonly agentRef: Readonly<{ tenantId: string; agentId: string; profileRevision: string }>;
  readonly taskId: string;
  readonly leaseId: string;
  readonly canonicalHome: string;
}
const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
export function assertReplicaDisjoint(root: string, home: string): void {
  if (within(path.resolve(root), path.resolve(home)) || within(path.resolve(home), path.resolve(root))) {
    throw new Error('durable replica root overlaps canonical Agent home');
  }
}
export async function admitReplica(root: string, binding: DurableReplicaBinding): Promise<string> {
  if (!path.isAbsolute(root) || !path.isAbsolute(binding.canonicalHome) || !binding.taskId || !binding.leaseId) throw new Error('invalid durable replica authority');
  assertReplicaDisjoint(root, binding.canonicalHome);
  // Reject aliases before permission hardening or directory creation can touch the workspace.
  try { if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('durable replica root is a symlink'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = await fs.realpath(path.dirname(root));
  assertReplicaDisjoint(path.join(parent, path.basename(root)), await fs.realpath(binding.canonicalHome));
  await ensureSecureDir(root);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('durable replica root is not a regular private directory');
  const canonicalRoot = await fs.realpath(root), canonicalHome = await fs.realpath(binding.canonicalHome);
  assertReplicaDisjoint(canonicalRoot, canonicalHome);
  const agent = createHash('sha256').update(JSON.stringify([binding.agentRef.tenantId, binding.agentRef.agentId, binding.agentRef.profileRevision])).digest('hex');
  const directory = path.join(canonicalRoot, agent);
  await ensureSecureDir(directory);
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error('durable replica binding directory drift');
  // taskId remains the request identity; percent encoding is only a filename representation.
  const name = encodeURIComponent(binding.taskId);
  if (Buffer.byteLength(name) > 180) throw new Error('durable task id exceeds filename budget');
  return path.join(directory, `durable-${name}.sqlite`);
}

/** SQLite locking_mode=EXCLUSIVE retains the OS lock until close, including after commit. */
export async function acquireReplicaLock(file: string, leaseId: string): Promise<{ release(): void }> {
  const lockPath = `${file}.lock.sqlite`;
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid durable replica lock file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(lockPath);
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (slot INTEGER PRIMARY KEY CHECK(slot=1), lease_id TEXT NOT NULL); BEGIN EXCLUSIVE;');
    db.prepare('INSERT OR REPLACE INTO owner(slot,lease_id) VALUES(1,?)').run(leaseId);
    db.exec('COMMIT');
  } catch { db.close(); throw new Error('durable replica is locked or invalid'); }
  let released = false;
  return { release() { if (!released) { db.close(); released = true; } } };
}

/** Called under the replica lock BEFORE Harness.open on a new execution. */
export async function resetReplica(file: string): Promise<void> {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('untrusted durable replica pathname');
      await fs.unlink(candidate);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
