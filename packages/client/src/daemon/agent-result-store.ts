import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentRef } from '../agent-home';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir } from '../util/secure-dir';

/** Agent-home directory of staged `submit_result` outcomes, beside `.byok/messages`. */
export const AGENT_RESULT_DIRECTORY = path.join('.byok', 'results');

/** Upper bound on one record file; a staged outcome is at most 64 KiB and a schema 16 KiB. */
const RECORD_MAX_BYTES = 1024 * 1024;

/** A staged record file name. */
export const AGENT_RESULT_RECORD_NAME = /^result-[a-f0-9]{64}\.json$/u;
/** The temp file `atomicWriteFile` leaves when a stage crashes before its rename. */
export const AGENT_RESULT_TEMP_NAME = /^result-[a-f0-9]{64}\.json\.\d+-\d+\.tmp$/u;
/** Records kept per Agent home once the home is idle; at most 64 KiB each. */
export const AGENT_RESULT_MAX_RETAINED = 256;

/**
 * One immutable staged outcome of one task. `outcome` is the canonical
 * snapshot `validateResultOutcome` returned; `contentHash`/`schemaDigest`
 * are SHA-256 over key-sorted JSON, so the same content always has the
 * same hash whatever key order the runtime used.
 */
export interface AgentResultRecord {
  readonly schema: 1;
  readonly taskId: string;
  readonly tenantId: string;
  readonly agentRef: AgentRef;
  readonly contract: string;
  readonly schemaDigest: string;
  readonly outcome: unknown;
  readonly contentHash: string;
  readonly byteCount: number;
  readonly receiptId: string;
  readonly createdAt: string;
}

export type AgentResultStoreErrorCode = 'result_already_staged' | 'result_record_invalid';

export class AgentResultStoreError extends Error {
  constructor(readonly code: AgentResultStoreErrorCode, message: string) {
    super(message);
    this.name = 'AgentResultStoreError';
  }
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`).join(',')}}`;
}

/** `sha256:<hex>` over key-sorted JSON of plain JSON data. */
export function agentResultDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(sortedJson(value), 'utf8').digest('hex')}`;
}

function recordFileName(taskId: string): string {
  return `result-${createHash('sha256').update(taskId, 'utf8').digest('hex')}.json`;
}

function sameAgentRef(left: AgentRef, right: AgentRef): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseRecord(raw: string, taskId: string): AgentResultRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new AgentResultStoreError('result_record_invalid', `staged result for task ${taskId} is not valid JSON`);
  }
  const record = value as Partial<AgentResultRecord> | null;
  if (record === null || typeof record !== 'object' || record.schema !== 1 || record.taskId !== taskId
    || !isString(record.tenantId) || !isString(record.contract) || !isString(record.schemaDigest)
    || !isString(record.contentHash) || !isString(record.receiptId) || !isString(record.createdAt)
    || typeof record.byteCount !== 'number' || !Object.hasOwn(record, 'outcome')
    || record.agentRef === null || typeof record.agentRef !== 'object'
    || !isString(record.agentRef.agentId) || !isString(record.agentRef.profileRevision)
    || agentResultDigest(record.outcome) !== record.contentHash) {
    throw new AgentResultStoreError('result_record_invalid', `staged result for task ${taskId} is malformed`);
  }
  return Object.freeze(record as AgentResultRecord);
}

/**
 * Agent-local stage-before-ack authority for `submit_result`.
 *
 * One file per task under `<home>/.byok/results/`, written atomically and
 * fsynced (file and directory) before {@link stage} resolves, so a receipt the
 * runtime saw always names bytes on disk. Writes are serialized per store, and
 * the Agent-home single-writer lease keeps a second process out of the home.
 *
 * The store is never a terminal or replay authority: only the `turn_end` of
 * the same live task reads it, and a restart, failure or cancel never does —
 * the journal stays the only terminal truth. A record is local audit evidence.
 * That live task holds the home's execution lease for as long as it can read
 * the record, so once the home is idle no reader remains, and retention
 * removes records by {@link pruneAgentResults} under the idle-home lease.
 */
export class AgentResultStore {
  private writeTail: Promise<unknown> = Promise.resolve();

  private constructor(readonly homeDir: string, readonly directory: string) {}

  static async open(homeDir: string): Promise<AgentResultStore> {
    if (!path.isAbsolute(homeDir)) throw new AgentResultStoreError('result_record_invalid', 'Agent result store home must be absolute');
    const directory = path.join(homeDir, AGENT_RESULT_DIRECTORY);
    await ensureSecureDir(directory);
    return new AgentResultStore(homeDir, directory);
  }

  /** The staged record, after any stage already queued on this store. */
  async get(taskId: string): Promise<AgentResultRecord | undefined> {
    return this.exclusive(() => this.read(taskId));
  }

  /**
   * Stage one canonical outcome. The same content (by key-order-insensitive
   * JSON equality) under the same contract, schema and Agent returns the
   * existing record and receipt; anything different is refused.
   */
  async stage(input: {
    readonly taskId: string;
    readonly tenantId: string;
    readonly agentRef: AgentRef;
    readonly contract: string;
    readonly schema: unknown;
    readonly outcome: unknown;
    readonly byteCount: number;
  }): Promise<AgentResultRecord> {
    return this.exclusive(async () => {
      const schemaDigest = agentResultDigest(input.schema);
      const contentHash = agentResultDigest(input.outcome);
      const existing = await this.read(input.taskId);
      if (existing !== undefined) {
        if (existing.tenantId !== input.tenantId || existing.contract !== input.contract
          || existing.schemaDigest !== schemaDigest || !sameAgentRef(existing.agentRef, input.agentRef)
          || existing.contentHash !== contentHash || !isDeepStrictEqual(existing.outcome, input.outcome)) {
          throw new AgentResultStoreError('result_already_staged', 'this task already staged a different result; a staged result is immutable');
        }
        return existing;
      }
      const record: AgentResultRecord = Object.freeze({
        schema: 1,
        taskId: input.taskId,
        tenantId: input.tenantId,
        agentRef: Object.freeze({ ...input.agentRef }),
        contract: input.contract,
        schemaDigest,
        outcome: input.outcome,
        contentHash,
        byteCount: input.byteCount,
        receiptId: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      await atomicWriteFile(path.join(this.directory, recordFileName(input.taskId)), `${JSON.stringify(record)}\n`, { mode: 0o600, fsync: true });
      return record;
    });
  }

  private async read(taskId: string): Promise<AgentResultRecord | undefined> {
    const file = path.join(this.directory, recordFileName(taskId));
    let raw: string;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw new AgentResultStoreError('result_record_invalid', `staged result for task ${taskId} is not a regular file`);
      if (stat.size > RECORD_MAX_BYTES) throw new AgentResultStoreError('result_record_invalid', `staged result for task ${taskId} exceeds its bounded size`);
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return parseRecord(raw, taskId);
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await fn(); } finally { release(); }
  }
}

/**
 * Remove staged records and crashed-stage temps from one idle home's
 * `.byok/results/`. The caller holds the idle-home lease, so no listed file
 * has a reader left; age and count only bound the local audit window.
 *
 * - Records and temps whose mtime is at least `maxAgeMs` old are removed.
 * - Then, while more than `maxRetained` records remain, the oldest is removed.
 *   Temps do not count toward `maxRetained`.
 *
 * Content is never parsed, so a malformed record expires like any other.
 * Other names, directories and symbolic links are left alone. A record is
 * written once, so its mtime is its creation time. Removal stops at the first
 * `remove` that returns false.
 *
 * Expired files are removed while the directory is listed: listing and
 * removal share one budget, so a backlog larger than one pass can list still
 * drains on every pass. Only unexpired records wait for the count step.
 */
export async function pruneAgentResults(input: {
  readonly resultsRoot: string;
  readonly entries: AsyncIterable<Dirent>;
  readonly nowMs: number;
  readonly maxAgeMs: number;
  readonly maxRetained?: number;
  readonly remove: (file: string) => Promise<boolean>;
}): Promise<void> {
  const kept: { readonly file: string; readonly mtimeMs: number }[] = [];
  for await (const entry of input.entries) {
    const record = AGENT_RESULT_RECORD_NAME.test(entry.name);
    if (!entry.isFile() || !(record || AGENT_RESULT_TEMP_NAME.test(entry.name))) continue;
    const file = path.join(input.resultsRoot, entry.name);
    const stat = await fs.lstat(file);
    if (!stat.isFile()) continue;
    if (input.nowMs - stat.mtimeMs >= input.maxAgeMs) { if (!await input.remove(file)) return; }
    else if (record) kept.push({ file, mtimeMs: stat.mtimeMs });
  }
  kept.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (let index = 0; index < kept.length - (input.maxRetained ?? AGENT_RESULT_MAX_RETAINED); index++) {
    if (!await input.remove(kept[index]!.file)) return;
  }
}
