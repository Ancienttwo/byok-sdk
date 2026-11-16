import { readSqliteFileUnchanged } from '@byok-sdk/core/sqlite-node';
import { loadSqliteModule } from '../../util/sqlite-support.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureSecureDir } from '../../util/secure-dir.js';

/** `<storeDir>/durable-replicas`: the replica root the daemon hands pi-durable. */
export const DURABLE_REPLICA_DIRNAME = 'durable-replicas';
const REPLICA_FILE_PREFIX = 'durable-';
const REPLICA_FILE_SUFFIX = '.sqlite';
const LOCK_OWNER_SCHEMA = 'owner (slot INTEGER PRIMARY KEY CHECK(slot=1), lease_id TEXT NOT NULL)';

/** The lock database `acquireReplicaLock` holds for the replica database `file`. */
export function replicaLockPath(file: string): string {
  return `${file}.lock.sqlite`;
}

/**
 * Every candidate `admitReplica` can produce. Lock names overlap valid task
 * names, so only the database contents can identify a writer lock.
 */
export function durableReplicaFiles(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith(REPLICA_FILE_PREFIX) && name.endsWith(REPLICA_FILE_SUFFIX));
}

/** Inspect an existing private copy and close its read-only handle even on refusal. */
export function inspectReplicaDatabase<T>(file: string, inspect: (db: import('node:sqlite').DatabaseSync) => T): T {
  const { DatabaseSync } = loadSqliteModule();
  const db = new DatabaseSync(file, { readOnly: true });
  try { return inspect(db); } finally { db.close(); }
}

/** `'empty'` for a database with no schema objects, `'lock'` for exactly the writer-lock table, otherwise `'other'`. */
function lockSchema(db: import('node:sqlite').DatabaseSync): 'empty' | 'lock' | 'other' {
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
  if (objects.length === 0) return 'empty';
  const owner = objects[0];
  return objects.length === 1 && owner?.type === 'table' && owner.name === 'owner'
    && owner.tbl_name === 'owner' && owner.sql === `CREATE TABLE ${LOCK_OWNER_SCHEMA}` ? 'lock' : 'other';
}

/**
 * Read a file whose format its main file cannot show, because the schema is
 * still in a WAL that was never checkpointed: on a writable connection, inside
 * a transaction that is rolled back, so nothing is written before the caller
 * decides. Opening still replays the WAL; that is the accepted residual.
 */
export function readInRolledBackTransaction<T>(file: string, read: (db: import('node:sqlite').DatabaseSync) => T): T {
  const { DatabaseSync } = loadSqliteModule();
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    db.exec('BEGIN IMMEDIATE');
    try { return read(db); } finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}

/** Inspect a private copy; database errors must reach the compatibility refusal. */
export function isReplicaWriterLock(file: string): boolean {
  return inspectReplicaDatabase(file, (db) => {
    if (lockSchema(db) !== 'lock') return false;
    const rows = db.prepare('SELECT slot, lease_id FROM owner').all();
    return rows.length === 1 && rows[0]?.slot === 1 && typeof rows[0].lease_id === 'string' && rows[0].lease_id.length > 0;
  });
}

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
  return path.join(directory, `${REPLICA_FILE_PREFIX}${name}${REPLICA_FILE_SUFFIX}`);
}

/** SQLite locking_mode=EXCLUSIVE retains the OS lock until close, including after commit. */
export async function acquireReplicaLock(file: string, leaseId: string): Promise<{ release(): void }> {
  const lockPath = replicaLockPath(file);
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid durable replica lock file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Lock names overlap valid task names, so the lock path can hold another
  // task's replica: it is never written unless it is a lock or empty.
  const OTHER = 'durable replica lock path holds another database';
  if (readSqliteFileUnchanged(lockPath, lockSchema) === 'other') throw new Error(OTHER);
  const { DatabaseSync } = loadSqliteModule();
  const db = new DatabaseSync(lockPath);
  let schema: 'empty' | 'lock' | 'other';
  try {
    // The main file cannot show another replica's schema that is still only in
    // its WAL; this connection can. Decide before the journal mode switch, DDL
    // or owner write.
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    try { schema = lockSchema(db); } finally { db.exec('ROLLBACK'); }
  } catch { db.close(); throw new Error('durable replica is locked or invalid'); }
  if (schema === 'other') { db.close(); throw new Error(OTHER); }
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS ${LOCK_OWNER_SCHEMA}; BEGIN EXCLUSIVE;`);
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
