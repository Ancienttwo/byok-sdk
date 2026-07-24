import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir } from '../util/secure-dir';
import type { GitErrorCategory, GitWorkspaceObservation } from './git-workspace';

export type GitWorkspacePhase = 'preparing' | 'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'salvage';

export interface GitWorkspaceLedgerRecord {
  workspaceId: string;
  taskId: string;
  workspaceDir: string;
  sessionRef?: string;
  phase: GitWorkspacePhase;
  baseline?: string;
  current?: string;
  commitsSinceBaseline: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  createdAt: string;
  updatedAt: string;
  errorCategory?: GitErrorCategory;
}

export interface GitWorkspaceLedger {
  version: 1;
  records: GitWorkspaceLedgerRecord[];
}

const FILE_NAME = 'git-workspaces.json';
const MAX_RECORDS = 500;
const PHASES = new Set<GitWorkspacePhase>(['preparing', 'active', 'completed', 'failed', 'cancelled', 'interrupted', 'salvage']);

function isRecord(value: unknown): value is GitWorkspaceLedgerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<GitWorkspaceLedgerRecord>;
  return typeof candidate.workspaceId === 'string' &&
    typeof candidate.taskId === 'string' &&
    typeof candidate.workspaceDir === 'string' &&
    (candidate.sessionRef === undefined || typeof candidate.sessionRef === 'string') &&
    typeof candidate.phase === 'string' && PHASES.has(candidate.phase as GitWorkspacePhase) &&
    ['commitsSinceBaseline', 'staged', 'unstaged', 'untracked', 'conflicted'].every((key) => typeof candidate[key as keyof GitWorkspaceLedgerRecord] === 'number') &&
    typeof candidate.createdAt === 'string' && typeof candidate.updatedAt === 'string';
}

function isLedger(value: unknown): value is GitWorkspaceLedger {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (value as Partial<GitWorkspaceLedger>).version === 1 &&
    Array.isArray((value as Partial<GitWorkspaceLedger>).records) &&
    (value as Partial<GitWorkspaceLedger>).records!.every(isRecord);
}

function isActive(record: GitWorkspaceLedgerRecord): boolean {
  return record.phase === 'preparing' || record.phase === 'active' || record.phase === 'interrupted';
}

function isProtected(record: GitWorkspaceLedgerRecord): boolean {
  return isActive(record) || record.phase === 'salvage';
}

/** Private, versioned, serialized recovery ledger for local Git workspaces. */
export class GitWorkspaceStore {
  readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly maxRecords: number;

  constructor(
    readonly storeDir: string,
    options: { maxRecords?: number } = {},
  ) {
    this.filePath = path.join(storeDir, FILE_NAME);
    this.maxRecords = Math.max(1, Math.floor(options.maxRecords ?? MAX_RECORDS));
  }

  async initialize(): Promise<void> {
    await ensureSecureDir(this.storeDir);
    await this.enqueue(async () => { await this.load(); });
  }

  async list(): Promise<GitWorkspaceLedgerRecord[]> {
    return this.enqueue(async () => (await this.load()).records.map((record) => ({ ...record })));
  }

  async get(workspaceId: string): Promise<GitWorkspaceLedgerRecord | undefined> {
    return this.enqueue(async () => {
      const record = (await this.load()).records.find((entry) => entry.workspaceId === workspaceId);
      return record ? { ...record } : undefined;
    });
  }

  async findBySession(sessionRef: string): Promise<GitWorkspaceLedgerRecord | undefined> {
    return this.enqueue(async () => {
      const record = (await this.load()).records.find((entry) => entry.sessionRef === sessionRef);
      return record ? { ...record } : undefined;
    });
  }

  async findBySessionAnyPhase(sessionRef: string): Promise<GitWorkspaceLedgerRecord | undefined> {
    return this.enqueue(async () => {
      const record = (await this.load()).records.find((entry) => entry.sessionRef === sessionRef);
      return record ? { ...record } : undefined;
    });
  }

  async attachSession(workspaceId: string, sessionRef: string): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.load();
      const index = ledger.records.findIndex((entry) => entry.workspaceId === workspaceId);
      if (index < 0) return;
      ledger.records[index] = {
        ...ledger.records[index]!,
        sessionRef,
        updatedAt: new Date().toISOString(),
      };
      await this.save(this.prune(ledger));
    });
  }

  async upsert(record: GitWorkspaceLedgerRecord): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.load();
      const now = new Date().toISOString();
      const next = { ...record, updatedAt: now };
      const index = ledger.records.findIndex((entry) => entry.workspaceId === record.workspaceId);
      if (index >= 0) ledger.records[index] = next;
      else ledger.records.push({ ...next, createdAt: record.createdAt || now });
      await this.save(this.prune(ledger));
    });
  }

  async updateObservation(workspaceId: string, observation: GitWorkspaceObservation, phase?: GitWorkspacePhase, errorCategory?: GitErrorCategory): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.load();
      const index = ledger.records.findIndex((entry) => entry.workspaceId === workspaceId);
      if (index < 0) return;
      const record = ledger.records[index]!;
      ledger.records[index] = {
        ...record,
        phase: phase ?? record.phase,
        current: observation.head,
        commitsSinceBaseline: observation.commitsSinceBaseline,
        staged: observation.staged,
        unstaged: observation.unstaged,
        untracked: observation.untracked,
        conflicted: observation.conflicted,
        updatedAt: new Date().toISOString(),
        ...(errorCategory ? { errorCategory } : {}),
      };
      await this.save(this.prune(ledger));
    });
  }

  /** Marks old preparation/active records interrupted without reviving protocol tasks. */
  async reconcile(validate?: (record: GitWorkspaceLedgerRecord) => Promise<boolean>): Promise<void> {
    await this.enqueue(async () => {
      const ledger = await this.load();
      let changed = false;
      for (const record of ledger.records) {
        if (!isActive(record)) continue;
        const valid = validate ? await validate(record) : true;
        if (!valid) continue;
        record.phase = 'interrupted';
        record.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) await this.save(this.prune(ledger));
    });
  }

  private prune(ledger: GitWorkspaceLedger): GitWorkspaceLedger {
    if (ledger.records.length <= this.maxRecords) return ledger;
    const retained = ledger.records.filter(isProtected);
    const rest = ledger.records.filter((record) => !isProtected(record)).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || (a.phase === 'salvage' ? 1 : 0) - (b.phase === 'salvage' ? 1 : 0),
    );
    return { version: 1, records: [...retained, ...rest.slice(0, Math.max(0, this.maxRecords - retained.length))] };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<GitWorkspaceLedger> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('git workspace ledger is corrupt'); }
    if (!isLedger(parsed)) throw new Error('git workspace ledger version is unsupported or invalid');
    return { version: 1, records: parsed.records.map((record) => ({ ...record })) };
  }

  private async save(ledger: GitWorkspaceLedger): Promise<void> {
    await ensureSecureDir(this.storeDir);
    await atomicWriteFile(this.filePath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  }
}

export const GIT_WORKSPACE_LEDGER_FILE = FILE_NAME;
export const GIT_WORKSPACE_LEDGER_MAX_RECORDS = MAX_RECORDS;
