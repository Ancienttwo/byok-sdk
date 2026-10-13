import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  reapOwnedProcessGroups,
  type OwnedProcessGroupLedger,
  type OwnedProcessGroupReap,
  type OwnedProcessGroupRecord,
} from '../adapters/process-tree';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir } from '../util/secure-dir';

/**
 * #393 / #384 item 3: the durable record of every POSIX runtime process group
 * this store's daemon owns and has not yet disposed.
 *
 * Why a store-level directory of its own, rather than the journal (optional),
 * operational health (fail-open, quarantined by `doctor --fix`, rewritten
 * whole on every write) or the Agent home marker (does not cover Git
 * workspaces): a group the daemon cannot have disposed — because the daemon
 * was SIGKILLed or OOM-killed — is durable state, and the next owner of this
 * store must find it.
 *
 * Opened only under the store's `DaemonOwnerLease`, so every file present when
 * {@link OwnedProcessLedger.reconcile} runs was written by a daemon process
 * that is gone. One file per group, written with fsync before the runtime
 * receives any input; removed once its disposal proved the group gone. A
 * record holds the group id, its root's start time, the boot it was written
 * in and the writing process's pid and start time — never a command line, a
 * cwd or any other path.
 *
 * Operator remedy for a refused start: confirm the recorded group's processes
 * are gone (`ps -o pid,pgid,lstart,command -g <pgid>`), then delete that
 * record file.
 */
export const OWNED_PROCESSES_DIRECTORY = 'owned-processes';

const REMEDY = 'verify the recorded processes are gone, then delete';

interface OwnedProcessLedgerFileV1 {
  version: 1;
  pgid: number;
  rootStart: string;
  bootId: string;
  writerPid: number;
  writerStart: string;
  recordedAt: string;
}

const FILE_KEYS = 'bootId,pgid,recordedAt,rootStart,version,writerPid,writerStart';

export interface OwnedProcessReconciliation extends Omit<OwnedProcessGroupReap, 'ended' | 'survivors'> {
  /** Records found in the ledger. */
  recorded: number;
}

/** A crashed run's group could not be ended; this store must not get a second writer. */
export class OwnedProcessResidueError extends Error {
  constructor(readonly reconciliation: OwnedProcessReconciliation, readonly survivingRecords: readonly string[]) {
    super(
      `${reconciliation.survived} owned runtime process group(s) from the previous daemon run survived SIGKILL; refusing to start a second writer. ` +
      `Verify the processes are gone, then delete: ${survivingRecords.join(', ')}`,
    );
    this.name = 'OwnedProcessResidueError';
  }
}

export class OwnedProcessLedger implements OwnedProcessGroupLedger {
  readonly #dir: string;
  readonly #reap: (groups: readonly OwnedProcessGroupRecord[]) => Promise<OwnedProcessGroupReap>;

  constructor(storeDir: string, options: { reap?: (groups: readonly OwnedProcessGroupRecord[]) => Promise<OwnedProcessGroupReap> } = {}) {
    this.#dir = path.join(storeDir, OWNED_PROCESSES_DIRECTORY);
    this.#reap = options.reap ?? ((groups) => reapOwnedProcessGroups(groups));
  }

  /** A rejection fails the adoption, which terminates the tree and refuses the task. */
  async adopted(record: OwnedProcessGroupRecord): Promise<void> {
    await ensureSecureDir(this.#dir);
    const body: OwnedProcessLedgerFileV1 = {
      version: 1, pgid: record.pgid, rootStart: record.rootStart, bootId: record.bootId,
      writerPid: record.writerPid, writerStart: record.writerStart, recordedAt: new Date().toISOString(),
    };
    await atomicWriteFile(this.#file(record), JSON.stringify(body), { mode: 0o600, fsync: true });
  }

  /** The disposal receipt. A record left behind is safe: a changed start time reads as already ended. */
  async disposed(record: OwnedProcessGroupRecord): Promise<void> {
    await fs.rm(this.#file(record), { force: true });
  }

  /**
   * End every group a crashed run recorded, then drop exactly the records
   * confirmed ended; a live writer's records stay. Any group still holding a
   * process at the deadline throws {@link OwnedProcessResidueError} naming the
   * record files, and leaves every record in place for the next attempt.
   */
  async reconcile(): Promise<OwnedProcessReconciliation> {
    const residue = await this.#residue();
    if (residue.length === 0) return { recorded: 0, found: 0, terminated: 0, survived: 0, liveWriter: 0 };
    const { ended, survivors, ...counts } = await this.#reap(residue.map(({ record }) => record));
    const reconciliation = { recorded: residue.length, ...counts };
    if (survivors.length > 0) throw new OwnedProcessResidueError(reconciliation, survivors.map((record) => this.#file(record)));
    for (const record of ended) await fs.rm(this.#file(record), { force: true });
    return reconciliation;
  }

  async #residue(): Promise<Array<{ file: string; record: OwnedProcessGroupRecord }>> {
    let names: string[];
    try {
      names = await fs.readdir(this.#dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const residue: Array<{ file: string; record: OwnedProcessGroupRecord }> = [];
    for (const name of names.sort()) {
      const file = path.join(this.#dir, name);
      // An interrupted atomic write leaves only its temporary sibling; the
      // record it would have published was never one a runtime was told about.
      if (!/^[0-9a-f]{32}\.json$/u.test(name)) continue;
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw new Error(`owned process record ${file} is not a regular file; ${REMEDY} ${file}`);
      const parsed = parseRecord(await fs.readFile(file, 'utf8'));
      if (parsed === undefined || this.#file(parsed) !== file) throw new Error(`owned process record ${file} is corrupt; ${REMEDY} ${file}`);
      residue.push({ file, record: parsed });
    }
    return residue;
  }

  #file(record: OwnedProcessGroupRecord): string {
    const id = createHash('sha256').update(`${record.bootId}\0${record.pgid}\0${record.rootStart}`).digest('hex').slice(0, 32);
    return path.join(this.#dir, `${id}.json`);
  }
}

function parseRecord(raw: string): OwnedProcessGroupRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const file = value as Partial<OwnedProcessLedgerFileV1>;
  if (Object.keys(file).sort().join(',') !== FILE_KEYS) return undefined;
  if (file.version !== 1 || typeof file.recordedAt !== 'string') return undefined;
  if (!isPid(file.pgid) || !isPid(file.writerPid)) return undefined;
  if (!isIdentity(file.rootStart) || !isIdentity(file.bootId) || !isIdentity(file.writerStart)) return undefined;
  return { pgid: file.pgid, rootStart: file.rootStart, bootId: file.bootId, writerPid: file.writerPid, writerStart: file.writerStart };
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1;
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}
