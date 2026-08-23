import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AgentContentReceiptPayloadSchema,
  type AgentContentReceiptPayload,
} from '@byok-sdk/protocol';
import type { AgentRef } from '../agent-home';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir } from '../util/secure-dir';
import { type AgentEgressPolicy, type AgentEgressDropReason, eventBytes } from './agent-egress-policy';

export const AGENT_EGRESS_DIRECTORY = path.join('.byok', 'egress');
export const AGENT_RELIABLE_SPOOL_FILENAME = 'reliable-v1.jsonl';

/** A spool row's intended envelope type, never inferred from its payload. */
export const AGENT_RELIABLE_WIRE_TYPES = ['agent.egress.reliable', 'agent.content.receipt'] as const;
export type AgentReliableWireType = (typeof AGENT_RELIABLE_WIRE_TYPES)[number];
type OmitReliableIdentity<T> = T extends unknown ? Omit<T, 'eventId' | 'cursor'> : never;
export type AgentContentReceiptWithoutReliableIdentity = OmitReliableIdentity<AgentContentReceiptPayload>;

export interface AgentReliableEgressRecord {
  readonly schema: 1;
  readonly wireType: AgentReliableWireType;
  readonly agentRef: AgentRef;
  readonly tenantId: string;
  readonly policyRevision: string;
  readonly eventId: string;
  readonly cursor: number;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly byteCount: number;
  readonly createdAt: string;
  readonly sessionRef?: string;
  readonly taskId?: string;
}

export interface AgentReliableAppendInput {
  readonly agentRef: AgentRef;
  readonly tenantId: string;
  readonly policyRevision: string;
  readonly payload: unknown;
  readonly sessionRef?: string;
  readonly taskId?: string;
  readonly eventId?: string;
  readonly createdAt?: string;
}

/**
 * Content receipts use the existing durable spool but retain their own wire
 * type and validated receipt payload. The request id is the stable event id:
 * a retried local read cannot mint a competing receipt identity.
 */
export interface AgentContentReceiptAppendInput {
  readonly agentRef: AgentRef;
  readonly tenantId: string;
  readonly policyRevision: string;
  readonly sessionRef: string;
  readonly payload: AgentContentReceiptWithoutReliableIdentity;
  readonly taskId?: string;
}

export interface AgentReliableAck {
  readonly agentRef: AgentRef;
  readonly tenantId: string;
  readonly sessionRef: string;
  readonly policyRevision: string;
  readonly eventId: string;
  readonly cursor: number;
}

type SpoolEntry =
  | Readonly<{ schema: 1; kind: 'append'; record: AgentReliableEgressRecord }>
  | Readonly<{ schema: 1; kind: 'ack'; ack: AgentReliableAck }>;

export class AgentReliableSpoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentReliableSpoolError';
  }
}

export class AgentReliableQuotaError extends AgentReliableSpoolError {
  constructor(readonly reason: Extract<AgentEgressDropReason, 'quota_exceeded' | 'backpressure'>, message: string) {
    super(message);
    this.name = 'AgentReliableQuotaError';
  }
}

function sameAgentRef(left: AgentRef, right: AgentRef): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}

function stableRecordJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('value is undefined');
    return json;
  } catch (error) {
    throw new AgentReliableSpoolError(
      `reliable egress payload cannot be serialized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function contentHash(json: string): string {
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new AgentReliableSpoolError(`${label} must be a non-empty single-line string`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AgentReliableSpoolError(`${label} must be a positive safe integer`);
  }
}

function assertWireType(value: unknown): asserts value is AgentReliableWireType {
  if (value !== 'agent.egress.reliable' && value !== 'agent.content.receipt') {
    throw new AgentReliableSpoolError('reliable record wireType is invalid');
  }
}

function sameRecord(
  record: AgentReliableEgressRecord,
  candidate: Pick<AgentReliableEgressRecord, 'wireType' | 'agentRef' | 'tenantId' | 'policyRevision' | 'eventId' | 'cursor' | 'payloadHash' | 'byteCount' | 'sessionRef' | 'taskId'>,
): boolean {
  return (
    record.wireType === candidate.wireType &&
    sameAgentRef(record.agentRef, candidate.agentRef) &&
    record.tenantId === candidate.tenantId &&
    record.policyRevision === candidate.policyRevision &&
    record.eventId === candidate.eventId &&
    record.cursor === candidate.cursor &&
    record.payloadHash === candidate.payloadHash &&
    record.byteCount === candidate.byteCount &&
    record.sessionRef === candidate.sessionRef &&
    record.taskId === candidate.taskId
  );
}

function parseEntry(value: unknown): SpoolEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AgentReliableSpoolError('reliable spool entry is not an object');
  const entry = value as Record<string, unknown>;
  if (entry.schema !== 1) throw new AgentReliableSpoolError('reliable spool schema is unsupported');
  if (entry.kind === 'append') {
    const record = entry.record as Partial<AgentReliableEgressRecord> | undefined;
    if (!record || typeof record !== 'object') throw new AgentReliableSpoolError('reliable append record is missing');
    assertNonEmptyString(record.eventId, 'record.eventId');
    assertWireType(record.wireType);
    assertNonEmptyString(record.tenantId, 'record.tenantId');
    assertNonEmptyString(record.policyRevision, 'record.policyRevision');
    assertPositiveInteger(record.cursor, 'record.cursor');
    assertPositiveInteger(record.byteCount, 'record.byteCount');
    if (!record.agentRef || typeof record.agentRef.agentId !== 'string' || typeof record.agentRef.profileRevision !== 'string') {
      throw new AgentReliableSpoolError('record.agentRef is invalid');
    }
    assertNonEmptyString(record.payloadHash, 'record.payloadHash');
    assertNonEmptyString(record.createdAt, 'record.createdAt');
    if (record.wireType === 'agent.content.receipt') {
      let payload: AgentContentReceiptPayload;
      try {
        payload = AgentContentReceiptPayloadSchema.parse(record.payload);
      } catch (error) {
        throw new AgentReliableSpoolError(
          `content receipt spool payload is not protocol-valid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (payload.eventId !== record.eventId || payload.cursor !== record.cursor || payload.sessionRef !== record.sessionRef) {
        throw new AgentReliableSpoolError('content receipt spool identity does not match its record');
      }
    }
    return { schema: 1, kind: 'append', record: record as AgentReliableEgressRecord };
  }
  if (entry.kind === 'ack') {
    const ack = entry.ack as Partial<AgentReliableAck> | undefined;
    if (!ack || typeof ack !== 'object') throw new AgentReliableSpoolError('reliable ack is missing');
    assertNonEmptyString(ack.eventId, 'ack.eventId');
    assertNonEmptyString(ack.tenantId, 'ack.tenantId');
    assertNonEmptyString(ack.sessionRef, 'ack.sessionRef');
    assertNonEmptyString(ack.policyRevision, 'ack.policyRevision');
    assertPositiveInteger(ack.cursor, 'ack.cursor');
    if (!ack.agentRef || typeof ack.agentRef.agentId !== 'string' || typeof ack.agentRef.profileRevision !== 'string') {
      throw new AgentReliableSpoolError('ack.agentRef is invalid');
    }
    return { schema: 1, kind: 'ack', ack: ack as AgentReliableAck };
  }
  throw new AgentReliableSpoolError('reliable spool entry kind is invalid');
}

/**
 * Per-Agent durable append-before-send log. It is deliberately separate from
 * the inbound task journal: its only truth is outbound reliable egress
 * pending/exact-ack state.
 */
export class AgentReliableSpool {
  private readonly pending = new Map<string, AgentReliableEgressRecord>();
  private nextCursor = 1;
  private logEntries = 0;
  private writeTail: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly homeDir: string,
    readonly spoolPath: string,
  ) {}

  static async open(homeDir: string): Promise<AgentReliableSpool> {
    const directory = path.join(homeDir, AGENT_EGRESS_DIRECTORY);
    await ensureSecureDir(directory);
    const spool = new AgentReliableSpool(homeDir, path.join(directory, AGENT_RELIABLE_SPOOL_FILENAME));
    await spool.load();
    return spool;
  }

  get pendingEvents(): number {
    return this.pending.size;
  }

  get pendingBytes(): number {
    return [...this.pending.values()].reduce((total, record) => total + record.byteCount, 0);
  }

  records(): readonly AgentReliableEgressRecord[] {
    return Object.freeze([...this.pending.values()].sort((left, right) => left.cursor - right.cursor));
  }

  async append(input: AgentReliableAppendInput, policy: Readonly<AgentEgressPolicy>, tenantPendingBytes: number): Promise<AgentReliableEgressRecord> {
    return this.exclusive(async () => {
      assertNonEmptyString(input.tenantId, 'tenantId');
      assertNonEmptyString(input.policyRevision, 'policyRevision');
      if (input.policyRevision !== policy.policyRevision) throw new AgentReliableSpoolError('reliable record policy revision does not match consumed policy');
      const payloadJson = stableRecordJson(input.payload);
      const byteCount = Buffer.byteLength(payloadJson, 'utf8');
      if (byteCount <= 0) throw new AgentReliableSpoolError('reliable payload must have positive serialized bytes');
      if (this.pending.size >= policy.reliable.maxPendingEventsPerAgent) {
        throw new AgentReliableQuotaError('quota_exceeded', 'reliable per-Agent event quota is exhausted');
      }
      if (this.pendingBytes + byteCount > policy.reliable.maxPendingBytesPerAgent) {
        throw new AgentReliableQuotaError('quota_exceeded', 'reliable per-Agent byte quota is exhausted');
      }
      if (tenantPendingBytes + byteCount > policy.reliable.maxPendingBytesPerTenant) {
        throw new AgentReliableQuotaError('quota_exceeded', 'reliable tenant byte quota is exhausted');
      }
      const eventId = input.eventId ?? randomUUID();
      if (this.pending.has(eventId)) throw new AgentReliableSpoolError(`reliable eventId ${eventId} already exists`);
      const record: AgentReliableEgressRecord = Object.freeze({
        schema: 1,
        wireType: 'agent.egress.reliable',
        agentRef: Object.freeze({ ...input.agentRef }),
        tenantId: input.tenantId,
        policyRevision: input.policyRevision,
        eventId,
        cursor: this.nextCursor++,
        payload: JSON.parse(payloadJson),
        payloadHash: contentHash(payloadJson),
        byteCount,
        createdAt: input.createdAt ?? new Date().toISOString(),
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      });
      await this.appendEntry({ schema: 1, kind: 'append', record });
      this.pending.set(record.eventId, record);
      return record;
    });
  }

  /**
   * Append one complete, protocol-validated content receipt before its first
   * send. `eventId` is fixed to `requestId`; the durable spool alone allocates
   * the positive cursor, then validates the final payload before fsync.
   */
  async appendContentReceipt(
    input: AgentContentReceiptAppendInput,
    policy: Readonly<AgentEgressPolicy>,
    tenantPendingBytes: number,
  ): Promise<AgentReliableEgressRecord> {
    return this.exclusive(async () => {
      assertNonEmptyString(input.tenantId, 'tenantId');
      assertNonEmptyString(input.policyRevision, 'policyRevision');
      assertNonEmptyString(input.sessionRef, 'sessionRef');
      if (input.policyRevision !== policy.policyRevision) {
        throw new AgentReliableSpoolError('content receipt policy revision does not match consumed policy');
      }
      const eventId = input.payload.requestId;
      assertNonEmptyString(eventId, 'content receipt requestId');
      const existing = this.pending.get(eventId);
      const cursor = existing?.cursor ?? this.nextCursor;
      let payload: AgentContentReceiptPayload;
      try {
        payload = AgentContentReceiptPayloadSchema.parse({ ...input.payload, eventId, cursor });
      } catch (error) {
        throw new AgentReliableSpoolError(
          `content receipt payload is not protocol-valid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const payloadJson = stableRecordJson(payload);
      const byteCount = Buffer.byteLength(payloadJson, 'utf8');
      const candidate = {
        wireType: 'agent.content.receipt' as const,
        agentRef: input.agentRef,
        tenantId: input.tenantId,
        policyRevision: input.policyRevision,
        eventId,
        cursor,
        payloadHash: contentHash(payloadJson),
        byteCount,
        sessionRef: input.sessionRef,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      };
      if (existing !== undefined) {
        if (!sameRecord(existing, candidate) || stableRecordJson(existing.payload) !== payloadJson) {
          throw new AgentReliableSpoolError(`content receipt ${eventId} differs from its existing reliable record`);
        }
        return existing;
      }
      if (this.pending.size >= policy.reliable.maxPendingEventsPerAgent) {
        throw new AgentReliableQuotaError('quota_exceeded', 'reliable per-Agent event quota is exhausted');
      }
      if (this.pendingBytes + byteCount > policy.reliable.maxPendingBytesPerAgent) {
        throw new AgentReliableQuotaError('quota_exceeded', 'reliable per-Agent byte quota is exhausted');
      }
      if (tenantPendingBytes + byteCount > policy.reliable.maxPendingBytesPerTenant) {
        throw new AgentReliableQuotaError('quota_exceeded', 'reliable tenant byte quota is exhausted');
      }
      const record: AgentReliableEgressRecord = Object.freeze({
        schema: 1,
        ...candidate,
        payload: JSON.parse(payloadJson),
        createdAt: new Date().toISOString(),
      });
      this.nextCursor += 1;
      await this.appendEntry({ schema: 1, kind: 'append', record });
      this.pending.set(record.eventId, record);
      return record;
    });
  }

  /** Exact matching ack is the only transition which retires a record. */
  async acknowledge(ack: AgentReliableAck): Promise<boolean> {
    return this.exclusive(async () => {
      const record = this.pending.get(ack.eventId);
      if (!record) return false;
      if (
        record.cursor !== ack.cursor ||
        record.tenantId !== ack.tenantId ||
        record.sessionRef !== ack.sessionRef ||
        record.policyRevision !== ack.policyRevision ||
        !sameAgentRef(record.agentRef, ack.agentRef)
      ) return false;
      await this.appendEntry({ schema: 1, kind: 'ack', ack: Object.freeze({ ...ack, agentRef: { ...ack.agentRef } }) });
      this.pending.delete(record.eventId);
      if (this.logEntries >= 512) await this.compact();
      return true;
    });
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      const stat = await fs.stat(this.spoolPath);
      if (stat.size > 64 * 1024 * 1024) throw new AgentReliableSpoolError('reliable spool exceeds its bounded on-disk size');
      raw = await fs.readFile(this.spoolPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let entry: SpoolEntry;
      try {
        entry = parseEntry(JSON.parse(line));
      } catch (error) {
        throw new AgentReliableSpoolError(`reliable spool is corrupt: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.logEntries += 1;
      if (entry.kind === 'append') {
        if (this.pending.has(entry.record.eventId)) throw new AgentReliableSpoolError('reliable spool contains a duplicate eventId');
        this.pending.set(entry.record.eventId, entry.record);
        this.nextCursor = Math.max(this.nextCursor, entry.record.cursor + 1);
      } else {
        const record = this.pending.get(entry.ack.eventId);
        if (!record) throw new AgentReliableSpoolError('reliable spool acknowledges an unknown event');
        if (
          record.cursor !== entry.ack.cursor ||
          record.tenantId !== entry.ack.tenantId ||
          record.sessionRef !== entry.ack.sessionRef ||
          record.policyRevision !== entry.ack.policyRevision ||
          !sameAgentRef(record.agentRef, entry.ack.agentRef)
        ) throw new AgentReliableSpoolError('reliable spool contains a mismatched ack');
        this.pending.delete(record.eventId);
      }
    }
  }

  private async appendEntry(entry: SpoolEntry): Promise<void> {
    const handle = await fs.open(this.spoolPath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.write(`${stableRecordJson(entry)}\n`, undefined, 'utf8');
      await handle.sync();
      this.logEntries += 1;
    } finally {
      await handle.close();
    }
  }

  private async compact(): Promise<void> {
    const entries = this.records().map((record): SpoolEntry => ({ schema: 1, kind: 'append', record }));
    await atomicWriteFile(this.spoolPath, entries.map((entry) => stableRecordJson(entry)).join(entries.length > 0 ? '\n' : ''), { mode: 0o600 });
    this.logEntries = entries.length;
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface LatestValueRecord {
  readonly agentRef: AgentRef;
  readonly tenantId: string;
  readonly event: import('@byok-sdk/protocol').AgentEvent;
  readonly byteCount: number;
  readonly updatedAt: string;
}

/** In-memory latest-value state; it is never replayed as durable history. */
export class AgentLatestValueState {
  private readonly recordsByAgent = new Map<string, LatestValueRecord>();

  offer(record: Omit<LatestValueRecord, 'byteCount' | 'updatedAt'>, policy: Readonly<AgentEgressPolicy>):
    | Readonly<{ accepted: true; replaced: boolean; record: LatestValueRecord }>
    | Readonly<{ accepted: false; reason: Extract<AgentEgressDropReason, 'quota_exceeded' | 'backpressure'> }> {
    const key = `${record.tenantId}\u0000${record.agentRef.agentId}\u0000${record.agentRef.profileRevision}`;
    const byteCount = eventBytes(record.event);
    const eventLimit = policy.activity.mode === 'contentful-trajectory'
      ? policy.activity.maxEventBytes
      : Math.min(policy.reliable.maxPendingBytesPerAgent, 64 * 1024);
    if (byteCount > eventLimit) return { accepted: false, reason: 'backpressure' };
    const prior = this.recordsByAgent.get(key);
    const tenantRecords = [...this.recordsByAgent.values()].filter((entry) => entry.tenantId === record.tenantId);
    const tenantBytes = tenantRecords.reduce((total, entry) => total + entry.byteCount, 0) - (prior?.byteCount ?? 0);
    if (tenantBytes + byteCount > policy.reliable.maxPendingBytesPerTenant || byteCount > policy.reliable.maxPendingBytesPerAgent) {
      return { accepted: false, reason: 'quota_exceeded' };
    }
    const accepted: LatestValueRecord = Object.freeze({
      ...record,
      agentRef: Object.freeze({ ...record.agentRef }),
      byteCount,
      updatedAt: new Date().toISOString(),
    });
    this.recordsByAgent.set(key, accepted);
    return { accepted: true, replaced: prior !== undefined, record: accepted };
  }

  get pendingEvents(): number { return this.recordsByAgent.size; }
  get pendingBytes(): number { return [...this.recordsByAgent.values()].reduce((total, record) => total + record.byteCount, 0); }
}
