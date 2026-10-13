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
 * record holds the group id and its root's start time — never a command line,
 * a cwd or any other path.
 */
export const OWNED_PROCESSES_DIRECTORY = 'owned-processes';

interface OwnedProcessLedgerFileV1 {
  version: 1;
  pgid: number;
  rootStart: string;
  recordedAt: string;
}

export interface OwnedProcessReconciliation extends OwnedProcessGroupReap {
  /** Records the previous daemon run left. */
  recorded: number;
}

/** A crashed run's group could not be ended; this store must not get a second writer. */
export class OwnedProcessResidueError extends Error {
  constructor(readonly reconciliation: OwnedProcessReconciliation) {
    super(`${reconciliation.survived} owned runtime process group(s) from the previous daemon run survived SIGKILL; refusing to start a second writer`);
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
    const body: OwnedProcessLedgerFileV1 = { version: 1, pgid: record.pgid, rootStart: record.rootStart, recordedAt: new Date().toISOString() };
    await atomicWriteFile(this.#file(record), JSON.stringify(body), { mode: 0o600, fsync: true });
  }

  /** The disposal receipt. A record left behind is safe: a changed start time reads as already ended. */
  async disposed(record: OwnedProcessGroupRecord): Promise<void> {
    await fs.rm(this.#file(record), { force: true });
  }

  /**
   * End every group a previous run recorded, then drop the records. Any group
   * still holding a process at the deadline throws {@link OwnedProcessResidueError}
   * and leaves every record in place for the next attempt.
   */
  async reconcile(): Promise<OwnedProcessReconciliation> {
    const residue = await this.#residue();
    if (residue.length === 0) return { recorded: 0, found: 0, terminated: 0, survived: 0 };
    const reap = await this.#reap(residue.map(({ record }) => record));
    const reconciliation = { recorded: residue.length, ...reap };
    if (reap.survived > 0) throw new OwnedProcessResidueError(reconciliation);
    for (const { file } of residue) await fs.rm(file, { force: true });
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
      if (!stat.isFile()) throw new Error(`owned process record ${name} is not a regular file`);
      const parsed = parseRecord(await fs.readFile(file, 'utf8'));
      if (parsed === undefined || this.#file(parsed) !== file) throw new Error(`owned process record ${name} is corrupt`);
      residue.push({ file, record: parsed });
    }
    return residue;
  }

  #file(record: OwnedProcessGroupRecord): string {
    const id = createHash('sha256').update(`${record.pgid}\0${record.rootStart}`).digest('hex').slice(0, 32);
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
  if (Object.keys(file).sort().join(',') !== 'pgid,recordedAt,rootStart,version') return undefined;
  if (file.version !== 1 || typeof file.recordedAt !== 'string') return undefined;
  if (typeof file.pgid !== 'number' || !Number.isSafeInteger(file.pgid) || file.pgid <= 1) return undefined;
  if (typeof file.rootStart !== 'string' || file.rootStart.length === 0 || file.rootStart.length > 64) return undefined;
  return { pgid: file.pgid, rootStart: file.rootStart };
}
