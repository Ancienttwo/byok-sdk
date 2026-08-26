import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AgentMessageDispositionPayloadSchema,
  AgentMessagePublishPayloadSchema,
  type AgentMessageContentType,
  type AgentMessageDispositionPayload,
  type AgentMessageEgressRequirement,
  type AgentMessagePublishPayload,
} from '@byok-sdk/protocol';
import type { AgentRef } from '../agent-home';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir } from '../util/secure-dir';

export const AGENT_MESSAGE_DIRECTORY = path.join('.byok', 'messages');
export const AGENT_MESSAGE_OUTBOX_FILENAME = 'outbox-v1.jsonl';

export interface AgentMessageOutboxRecord {
  readonly schema: 1;
  readonly taskId: string;
  readonly tenantId: string;
  readonly agentRef: AgentRef;
  readonly contract: string;
  readonly messageId: string;
  readonly cursor: number;
  readonly contentType: AgentMessageContentType;
  readonly body: string;
  readonly contentHash: string;
  readonly byteCount: number;
  readonly createdAt: string;
  readonly sessionRef?: string;
}

type OutboxEntry =
  | Readonly<{ schema: 1; kind: 'append'; record: AgentMessageOutboxRecord }>
  | Readonly<{ schema: 1; kind: 'activate'; taskId: string; messageId: string; sessionRef: string }>
  | Readonly<{ schema: 1; kind: 'disposition'; taskId: string; disposition: AgentMessageDispositionPayload }>;

export class AgentMessageOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentMessageOutboxError';
  }
}

function stableJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new AgentMessageOutboxError('message outbox value is not serializable');
  return encoded;
}

function hashBody(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function sameAgentRef(left: AgentRef, right: AgentRef): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}

function exactDisposition(record: AgentMessageOutboxRecord, value: AgentMessageDispositionPayload): boolean {
  return value.messageId === record.messageId
    && value.cursor === record.cursor
    && value.contract === record.contract
    && value.contentHash === record.contentHash
    && value.sessionRef === record.sessionRef
    && sameAgentRef(value.agentRef, record.agentRef);
}

/** Agent-local, append-before-send outbox. Only exact accepted disposition retires bytes. */
export class AgentMessageOutbox {
  private readonly pendingByTask = new Map<string, AgentMessageOutboxRecord>();
  private readonly dispositionByTask = new Map<string, AgentMessageDispositionPayload>();
  private nextCursor = 1;
  private logEntries = 0;
  private writeTail: Promise<unknown> = Promise.resolve();

  private constructor(readonly homeDir: string, readonly outboxPath: string) {}

  static async open(homeDir: string): Promise<AgentMessageOutbox> {
    const directory = path.join(homeDir, AGENT_MESSAGE_DIRECTORY);
    await ensureSecureDir(directory);
    const outbox = new AgentMessageOutbox(homeDir, path.join(directory, AGENT_MESSAGE_OUTBOX_FILENAME));
    await outbox.load();
    return outbox;
  }

  /** Re-open every existing Agent-local message outbox without following Agent-home symlinks. */
  static async recover(agentsRoot: string, tenantId: string): Promise<readonly AgentMessageOutbox[]> {
    if (!path.isAbsolute(agentsRoot)) throw new AgentMessageOutboxError('message outbox recovery root must be absolute');
    let canonicalRoot: string;
    try { canonicalRoot = await fs.realpath(agentsRoot); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const recovered: AgentMessageOutbox[] = [];
    for (const entry of await fs.readdir(canonicalRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const home = path.join(canonicalRoot, entry.name);
      const canonicalHome = await fs.realpath(home);
      if (path.relative(canonicalRoot, canonicalHome) !== entry.name) {
        throw new AgentMessageOutboxError(`message outbox recovery home escaped the canonical agents root: ${entry.name}`);
      }
      try { await fs.lstat(path.join(canonicalHome, AGENT_MESSAGE_DIRECTORY, AGENT_MESSAGE_OUTBOX_FILENAME)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const outbox = await AgentMessageOutbox.open(canonicalHome);
      if (outbox.records().some((record) => record.agentRef.agentId !== entry.name)) {
        throw new AgentMessageOutboxError(`message outbox in ${entry.name} claims a different Agent`);
      }
      if (outbox.records().some((record) => record.tenantId !== tenantId)) {
        throw new AgentMessageOutboxError(`message outbox in ${entry.name} claims a different authenticated tenant`);
      }
      recovered.push(outbox);
    }
    return Object.freeze(recovered);
  }

  records(): readonly AgentMessageOutboxRecord[] {
    return Object.freeze([...this.pendingByTask.values()].sort((a, b) => a.cursor - b.cursor));
  }

  /** Activated records with no exact disposition yet; only these may be transport-replayed. */
  retryableRecords(): readonly AgentMessageOutboxRecord[] {
    return Object.freeze(this.records().filter((record) => !this.dispositionByTask.has(record.taskId)));
  }

  get(taskId: string): AgentMessageOutboxRecord | undefined {
    return this.pendingByTask.get(taskId);
  }

  async appendDraft(input: {
    readonly taskId: string;
    readonly tenantId: string;
    readonly agentRef: AgentRef;
    readonly requirement: AgentMessageEgressRequirement;
    readonly contentType: AgentMessageContentType;
    readonly body: string;
    readonly sessionRef?: string;
    readonly maxPendingEvents: number;
    readonly maxPendingBytes: number;
  }): Promise<AgentMessageOutboxRecord> {
    return this.exclusive(async () => {
      if (input.contentType !== input.requirement.contentType) throw new AgentMessageOutboxError('message contentType does not match the offer contract');
      const byteCount = Buffer.byteLength(input.body, 'utf8');
      if (byteCount < 1 || byteCount > input.requirement.maxBytes) throw new AgentMessageOutboxError('message body exceeds the offer byte contract');
      const existing = this.pendingByTask.get(input.taskId);
      if (existing !== undefined) {
        if (existing.tenantId !== input.tenantId || existing.contentType !== input.contentType || existing.body !== input.body || existing.contract !== input.requirement.contract || !sameAgentRef(existing.agentRef, input.agentRef)) {
          throw new AgentMessageOutboxError('required-message task already has a different immutable draft');
        }
        return existing;
      }
      if (this.pendingByTask.size >= input.maxPendingEvents) throw new AgentMessageOutboxError('message outbox event quota is exhausted');
      const pendingBytes = this.records().reduce((sum, record) => sum + record.byteCount, 0);
      if (pendingBytes + byteCount > input.maxPendingBytes) throw new AgentMessageOutboxError('message outbox byte quota is exhausted');
      const record: AgentMessageOutboxRecord = Object.freeze({
        schema: 1,
        taskId: input.taskId,
        tenantId: input.tenantId,
        agentRef: Object.freeze({ ...input.agentRef }),
        contract: input.requirement.contract,
        messageId: randomUUID(),
        cursor: this.nextCursor++,
        contentType: input.contentType,
        body: input.body,
        contentHash: hashBody(input.body),
        byteCount,
        createdAt: new Date().toISOString(),
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
      });
      await this.appendEntry({ schema: 1, kind: 'append', record });
      this.pendingByTask.set(record.taskId, record);
      return record;
    });
  }

  async activate(taskId: string, sessionRef: string): Promise<AgentMessageOutboxRecord | undefined> {
    return this.exclusive(async () => {
      const record = this.pendingByTask.get(taskId);
      if (record === undefined) return undefined;
      if (record.sessionRef !== undefined) {
        if (record.sessionRef !== sessionRef) throw new AgentMessageOutboxError('message draft is already bound to a different session');
        return record;
      }
      await this.appendEntry({ schema: 1, kind: 'activate', taskId, messageId: record.messageId, sessionRef });
      const activated = Object.freeze({ ...record, sessionRef });
      this.pendingByTask.set(taskId, activated);
      return activated;
    });
  }

  publishPayload(record: AgentMessageOutboxRecord): AgentMessagePublishPayload {
    if (record.sessionRef === undefined) throw new AgentMessageOutboxError('message draft is not bound to a durable session');
    return AgentMessagePublishPayloadSchema.parse({
      agentRef: record.agentRef,
      sessionRef: record.sessionRef,
      contract: record.contract,
      messageId: record.messageId,
      cursor: record.cursor,
      contentType: record.contentType,
      body: record.body,
      contentHash: record.contentHash,
      byteCount: record.byteCount,
    });
  }

  async applyDisposition(taskId: string, input: unknown): Promise<'accepted' | 'held' | 'refused' | 'mismatch' | 'unknown'> {
    return this.exclusive(async () => {
      const disposition = AgentMessageDispositionPayloadSchema.parse(input);
      const record = this.pendingByTask.get(taskId);
      if (record === undefined) return 'unknown';
      if (!exactDisposition(record, disposition)) return 'mismatch';
      await this.appendEntry({ schema: 1, kind: 'disposition', taskId, disposition });
      if (disposition.outcome === 'accepted') {
        this.pendingByTask.delete(taskId);
        this.dispositionByTask.delete(taskId);
      } else {
        this.dispositionByTask.set(taskId, disposition);
      }
      if (this.logEntries >= 512) await this.compact();
      return disposition.outcome;
    });
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      const stat = await fs.stat(this.outboxPath);
      if (stat.size > 64 * 1024 * 1024) throw new AgentMessageOutboxError('message outbox exceeds its bounded on-disk size');
      raw = await fs.readFile(this.outboxPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      const entry = JSON.parse(line) as OutboxEntry;
      this.logEntries += 1;
      if (entry.schema !== 1) throw new AgentMessageOutboxError('message outbox schema is unsupported');
      if (entry.kind === 'append') {
        if (this.pendingByTask.has(entry.record.taskId)) throw new AgentMessageOutboxError('message outbox contains duplicate task draft');
        this.pendingByTask.set(entry.record.taskId, Object.freeze(entry.record));
        this.nextCursor = Math.max(this.nextCursor, entry.record.cursor + 1);
      } else if (entry.kind === 'activate') {
        const record = this.pendingByTask.get(entry.taskId);
        if (record === undefined || record.messageId !== entry.messageId) throw new AgentMessageOutboxError('message activation has no exact draft');
        if (record.sessionRef !== undefined && record.sessionRef !== entry.sessionRef) throw new AgentMessageOutboxError('message activation session conflicts');
        this.pendingByTask.set(entry.taskId, Object.freeze({ ...record, sessionRef: entry.sessionRef }));
      } else if (entry.kind === 'disposition') {
        const record = this.pendingByTask.get(entry.taskId);
        if (record === undefined || !exactDisposition(record, entry.disposition)) throw new AgentMessageOutboxError('message outbox contains a mismatched disposition');
        if (entry.disposition.outcome === 'accepted') {
          this.pendingByTask.delete(entry.taskId);
          this.dispositionByTask.delete(entry.taskId);
        } else {
          this.dispositionByTask.set(entry.taskId, entry.disposition);
        }
      } else {
        throw new AgentMessageOutboxError('message outbox entry kind is invalid');
      }
    }
  }

  private async appendEntry(entry: OutboxEntry): Promise<void> {
    const handle = await fs.open(this.outboxPath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.write(`${stableJson(entry)}\n`, undefined, 'utf8');
      await handle.sync();
      this.logEntries += 1;
    } finally {
      await handle.close();
    }
  }

  private async compact(): Promise<void> {
    const entries = this.records().flatMap((record): OutboxEntry[] => {
      const append: OutboxEntry = { schema: 1, kind: 'append', record };
      const disposition = this.dispositionByTask.get(record.taskId);
      return disposition === undefined ? [append] : [append, { schema: 1, kind: 'disposition', taskId: record.taskId, disposition }];
    });
    await atomicWriteFile(this.outboxPath, entries.map(stableJson).join(entries.length === 0 ? '' : '\n'), { mode: 0o600 });
    this.logEntries = entries.length;
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await fn(); } finally { release(); }
  }
}
