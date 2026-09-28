import { createHash } from 'node:crypto';

import { agentMemoryIntentOperationDigest } from '@byok-sdk/core';
import {
  AGENT_MEMORY_INTENT_REJECTION_CODES,
  AgentHomeProjectionProfileRevisionSchema,
  AgentMemoryIntentApprovalRefSchema,
  AgentMemoryIntentFetchRequestSchema,
  AgentMemoryIntentOperationDigestSchema,
  AgentMemoryIntentPathSchema,
  AgentMemoryIntentReadbackSchema,
  AgentMemoryIntentRevisionSchema,
  agentMemoryIntentFetchResponseSchemaFor,
  type AgentMemoryIntentAvailablePayload,
  type AgentMemoryIntentCompletion,
  type AgentMemoryIntentFetchResponse,
  type AgentMemoryIntentFileObservation,
  type AgentMemoryIntentHostTerminalCode,
  type AgentMemoryIntentOperation,
  type AgentMemoryIntentReadback,
  type AgentMemoryIntentRejectionCode,
  type AgentMemoryIntentReservation,
  type AgentMemoryIntentV1,
  type AgentRef,
} from '@byok-sdk/protocol';

import { AgentHomeBusyError, type AgentHomeBinding, type AgentHomeLease, type AgentHomeManager } from '../agent-home';
import {
  AGENT_MEMORY_MAX_LOCAL_LOG_BYTES,
  AgentMemoryRevisionConflictError,
  AgentMemoryValidationError,
  agentMemoryHomeBinding,
  appendAgentMemoryHomeAudit,
  compareAndSwapAgentMemoryHomeFile,
  observeAgentMemoryHomeFile,
  readAgentMemoryHomeInternalFile,
  replaceAgentMemoryHomeInternalFileStrict,
  validateAgentMemoryPath,
  type AgentMemoryHomeBinding,
} from './agent-memory';
import type { AgentMemoryFilesystem } from './agent-memory-filesystem';
import { openAgentMemoryFilesystemHelper } from './agent-memory-fs-helper';
import { snapshotPlainData } from '../util/plain-data';

/**
 * Host-approved Agent memory intents — the daemon half.
 *
 * `agent.memory.intent.available` names one intent (`{ intentId, agentRef }`).
 * The daemon fetches the immutable intent from the Host through the injected
 * {@link AgentMemoryIntentTransport}, applies it with the existing sha256 CAS
 * AT MOST ONCE, and reports a content-free terminal completion. The device
 * ledger `.byok/agent-memory-intents-v1.json` is the at-most-once authority:
 *
 * - window 1 (home lease): look the intent up; a terminal is re-made durable
 *   (barrier) and re-completed; a leftover `applying` becomes `uncertain` and is
 *   never re-executed; no row reserves a slot (`held`) or cannot (`none`).
 * - fetch (no lease): the Host releases, withholds, terminates or defers.
 * - window 2 (home lease): durable `applying`, then ONE CAS, then a durable
 *   terminal. A release is consumed by exactly this window.
 * - complete (no lease): the completion goes to the Host; the readback must
 *   match it.
 * - window 3 (home lease): the `ackedAt` barrier. Only then does the notice
 *   resolve and the mailbox cursor move.
 *
 * Network I/O never runs while the home lease is held, and every intent of one
 * Agent is processed serially in this process.
 */

/** SDK-internal ledger file under the Agent home's `.byok` directory. */
export const AGENT_MEMORY_INTENT_LEDGER_FILENAME = 'agent-memory-intents-v1.json';
/** Upper bound of one serialized ledger record plus its separating comma (R_MAX). */
export const AGENT_MEMORY_INTENT_LEDGER_RECORD_MAX_BYTES = 2048;
/** Bytes of the empty ledger `{"version":1,"records":[]}` (E). */
export const AGENT_MEMORY_INTENT_LEDGER_ENVELOPE_BYTES = 26;
/** Ledger capacity N = floor((1 MiB − E) / R_MAX) = 511. */
export const AGENT_MEMORY_INTENT_LEDGER_CAPACITY = Math.floor(
  (AGENT_MEMORY_MAX_LOCAL_LOG_BYTES - AGENT_MEMORY_INTENT_LEDGER_ENVELOPE_BYTES) / AGENT_MEMORY_INTENT_LEDGER_RECORD_MAX_BYTES,
);

/** Closed reasons an intent notice is left un-acknowledged (the mailbox row and cursor stay). */
export const AGENT_MEMORY_INTENT_NOTICE_FAILURE_REASONS = [
  'transport_unconfigured',
  'filesystem_unavailable',
  'home_busy',
  'fetch_failed',
  'fetch_invalid',
  'complete_failed',
  'readback_invalid',
  'readback_mismatch',
  'local_io_failed',
  'ledger_full',
  'ledger_invalid',
] as const;
export type AgentMemoryIntentNoticeFailureReason = (typeof AGENT_MEMORY_INTENT_NOTICE_FAILURE_REASONS)[number];

/**
 * The only error the intent processor throws. A fixed message built from a
 * closed reason and the intent id, no `cause`, no own enumerable properties:
 * nothing a Host transport threw or returned, and no memory path or content,
 * reaches the connection manager's log line.
 */
export class AgentMemoryIntentNoticeError extends Error {
  readonly #reason: AgentMemoryIntentNoticeFailureReason;
  readonly #intentId: string;

  constructor(reason: AgentMemoryIntentNoticeFailureReason, intentId: string) {
    super(`agent memory intent notice ${intentId} not acknowledged: ${reason}`);
    this.#reason = reason;
    this.#intentId = intentId;
    Object.defineProperty(this, 'name', {
      value: 'AgentMemoryIntentNoticeError',
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  get reason(): AgentMemoryIntentNoticeFailureReason {
    return this.#reason;
  }

  get intentId(): string {
    return this.#intentId;
  }
}

/** Exactly what the daemon hands the Host transport for one fetch. */
export interface AgentMemoryIntentFetchInput {
  readonly intentId: string;
  readonly agentRef: AgentRef;
  /** `held`: a ledger slot is reserved; `none`: the Host must not release or change state. */
  readonly reservation: AgentMemoryIntentReservation;
}

/**
 * Host-injected transport for Host-approved Agent memory intents. The Host
 * authenticates the device on its own routes; the SDK never sees an assertion.
 *
 * - `fetch` resolves with the Host's fetch answer (release / withheld /
 *   terminal / deferred) for exactly this intent and reservation.
 * - `complete` delivers one terminal completion and resolves with the Host's
 *   DURABLE readback for it.
 *
 * Both answers are copied into inert plain data and strictly parsed. A throw
 * from either is a transport failure: the notice is not acknowledged and a
 * redelivery retries. Neither is ever called while the Agent home is leased.
 */
export interface AgentMemoryIntentTransport {
  fetch(request: AgentMemoryIntentFetchInput): Promise<unknown>;
  complete(completion: AgentMemoryIntentCompletion): Promise<unknown>;
}

/**
 * What one memory filesystem backend has PROVEN. A backend whose proof is
 * missing fails closed: without `strictLedgerBarrier` the processor refuses to
 * run (and the capability is not advertised); without `conflictProvesNoRename`
 * a CAS revision conflict is reported as `uncertain`, never `conflict`.
 */
export interface AgentMemoryIntentBackend {
  /** Omitted for the native Linux descriptor backend. */
  readonly openFilesystem?: (lease: AgentHomeLease) => Promise<AgentMemoryFilesystem>;
  /** A thrown `AgentMemoryRevisionConflictError` proves this attempt renamed nothing. */
  readonly conflictProvesNoRename: boolean;
  /** A successful internal-state write proves temp fsync, rename and directory fsync. */
  readonly strictLedgerBarrier: boolean;
}

/**
 * Native Linux descriptor backend: every CAS conflict is thrown before its
 * rename (`agent-memory.ts` replace/delete), and ledger writes use the strict
 * directory-fsync variant.
 */
export const NATIVE_AGENT_MEMORY_INTENT_BACKEND: AgentMemoryIntentBackend = Object.freeze({
  conflictProvesNoRename: true,
  strictLedgerBarrier: true,
});

/**
 * External macOS helper backend. The helper binary is product-deployed and the
 * SDK cannot prove, in this repository and at runtime, that the configured
 * binary orders its revision conflict before the rename or that its successful
 * `replace` includes a strict directory fsync. Both proofs are therefore
 * absent: this backend never advertises intents, and a conflict on it would be
 * reported as `uncertain`.
 */
export function helperAgentMemoryIntentBackend(helperBin: string): AgentMemoryIntentBackend {
  return Object.freeze({
    openFilesystem: (lease: AgentHomeLease) => openAgentMemoryFilesystemHelper({
      helperBin,
      canonicalHome: lease.canonicalHome,
      homeIdentity: lease.homeIdentity,
    }),
    conflictProvesNoRename: false,
    strictLedgerBarrier: false,
  });
}

export interface AgentMemoryIntentProcessorOptions {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly transport: AgentMemoryIntentTransport | undefined;
  readonly homes: AgentHomeManager | undefined;
  /** `undefined` means no proven backend: every notice fails `filesystem_unavailable`. */
  readonly backend: AgentMemoryIntentBackend | undefined;
  /**
   * Called exactly once per acknowledged notice whose Host readback
   * contradicted the device terminal (`conflict`, or `host_terminal` against a
   * local terminal), after the integrity audit and the `ackedAt` barrier.
   * Metadata only.
   */
  readonly onIntegrity?: (event: Readonly<{ intentId: string; disposition: 'conflict' | 'host_terminal' }>) => void;
}

/** What a processed notice resolved with (metadata only). */
export type AgentMemoryIntentProcessResult =
  | Readonly<{
      kind: 'acknowledged';
      completion: AgentMemoryIntentCompletion;
      readback: AgentMemoryIntentReadback;
      /** The Host fact contradicted the device fact; an integrity audit was recorded. */
      integrity: boolean;
    }>
  | Readonly<{ kind: 'host_terminal'; readback: AgentMemoryIntentReadback }>;

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type AgentMemoryIntentLedgerState = 'applying' | 'applied' | 'conflict' | 'rejected' | 'uncertain';

export interface AgentMemoryIntentLedgerRecord {
  readonly intentId: string;
  /** The notice `agentRef.profileRevision`; the agentId is the ledger's home. */
  readonly profileRevision: string;
  readonly path: string;
  readonly operation: AgentMemoryIntentOperation;
  readonly operationDigest: string;
  readonly baseRevision: string;
  readonly targetRevision: string | null;
  readonly approvalRef: string;
  readonly state: AgentMemoryIntentLedgerState;
  readonly detail: null | AgentMemoryIntentFileObservation | Readonly<{ code: AgentMemoryIntentRejectionCode }>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ackedAt: string | null;
}

const LEDGER_RECORD_KEYS = [
  'intentId', 'profileRevision', 'path', 'operation', 'operationDigest', 'baseRevision', 'targetRevision',
  'approvalRef', 'state', 'detail', 'createdAt', 'updatedAt', 'ackedAt',
] as const;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const EMPTY_REVISION = `sha256:${createHash('sha256').update(new Uint8Array(0)).digest('hex')}`;
const encoder = new TextEncoder();

/**
 * A Host fetch answer or completion readback is shallow JSON; anything deeper
 * is not one. The snapshot (`../util/plain-data`) is JSON-shaped: every throw
 * is caught unbound and mapped to this module's closed failure reason.
 */
const HOST_ANSWER_SNAPSHOT = { maxDepth: 8 } as const;

/** Local sentinel for an unusable ledger; never escapes this module. */
const LEDGER_INVALID: unique symbol = Symbol('agent memory intent ledger invalid');

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalDetail(detail: AgentMemoryIntentLedgerRecord['detail']): AgentMemoryIntentLedgerRecord['detail'] {
  if (detail === null) return null;
  if ('code' in detail) return { code: detail.code };
  return { exists: detail.exists, revision: detail.revision };
}

/** One record in its single canonical key order (a rewrite is byte-identical). */
function canonicalRecord(record: AgentMemoryIntentLedgerRecord): AgentMemoryIntentLedgerRecord {
  return {
    intentId: record.intentId,
    profileRevision: record.profileRevision,
    path: record.path,
    operation: record.operation,
    operationDigest: record.operationDigest,
    baseRevision: record.baseRevision,
    targetRevision: record.targetRevision,
    approvalRef: record.approvalRef,
    state: record.state,
    detail: canonicalDetail(record.detail),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ackedAt: record.ackedAt,
  };
}

/** Serialized byte length of one record (without its separating comma). */
export function agentMemoryIntentLedgerRecordBytes(record: AgentMemoryIntentLedgerRecord): number {
  return encoder.encode(JSON.stringify(canonicalRecord(record))).byteLength;
}

/**
 * The real ledger serializer: compact JSON `{"version":1,"records":[…]}`.
 * Throws when the record count exceeds N or a record plus its separator would
 * exceed R_MAX, which the field bounds make unreachable.
 */
export function serializeAgentMemoryIntentLedger(records: readonly AgentMemoryIntentLedgerRecord[]): string {
  if (records.length > AGENT_MEMORY_INTENT_LEDGER_CAPACITY) throw LEDGER_INVALID;
  for (const record of records) {
    if (agentMemoryIntentLedgerRecordBytes(record) + 1 > AGENT_MEMORY_INTENT_LEDGER_RECORD_MAX_BYTES) throw LEDGER_INVALID;
  }
  return JSON.stringify({ version: 1, records: records.map(canonicalRecord) });
}

/**
 * `applied` is consistent with its operation, from the historical receipt
 * alone (never a re-read of the current file, never provenance from a hash):
 * replace → the target exists at `targetRevision`; delete → the target is
 * missing (empty-bytes revision) and the intent had a null `targetRevision`.
 */
export function agentMemoryIntentAppliedConsistent(
  operation: AgentMemoryIntentOperation,
  targetRevision: string | null,
  result: AgentMemoryIntentFileObservation,
): boolean {
  if (operation === 'replace') return targetRevision !== null && result.exists && result.revision === targetRevision;
  return targetRevision === null && !result.exists && result.revision === EMPTY_REVISION;
}

function observation(value: unknown): AgentMemoryIntentFileObservation {
  if (!isPlainRecord(value) || !exactKeys(value, ['exists', 'revision']) || typeof value.exists !== 'boolean') throw LEDGER_INVALID;
  if (!AgentMemoryIntentRevisionSchema.safeParse(value.revision).success) throw LEDGER_INVALID;
  return { exists: value.exists, revision: value.revision as string };
}

function parseRecord(value: unknown): AgentMemoryIntentLedgerRecord {
  if (!isPlainRecord(value) || !exactKeys(value, LEDGER_RECORD_KEYS)) throw LEDGER_INVALID;
  const {
    intentId, profileRevision, path, operation, operationDigest, baseRevision, targetRevision,
    approvalRef, state, detail, createdAt, updatedAt, ackedAt,
  } = value;
  if (!AgentMemoryIntentFetchRequestSchema.safeParse({ intentId, reservation: 'held' }).success) throw LEDGER_INVALID;
  if (!AgentHomeProjectionProfileRevisionSchema.safeParse(profileRevision).success) throw LEDGER_INVALID;
  if (!AgentMemoryIntentPathSchema.safeParse(path).success) throw LEDGER_INVALID;
  if (operation !== 'replace' && operation !== 'delete') throw LEDGER_INVALID;
  if (!AgentMemoryIntentOperationDigestSchema.safeParse(operationDigest).success) throw LEDGER_INVALID;
  if (!AgentMemoryIntentRevisionSchema.safeParse(baseRevision).success) throw LEDGER_INVALID;
  if (operation === 'delete') {
    if (targetRevision !== null) throw LEDGER_INVALID;
  } else if (!AgentMemoryIntentRevisionSchema.safeParse(targetRevision).success || targetRevision === baseRevision) {
    throw LEDGER_INVALID;
  }
  if (!AgentMemoryIntentApprovalRefSchema.safeParse(approvalRef).success) throw LEDGER_INVALID;
  for (const stamp of [createdAt, updatedAt]) if (typeof stamp !== 'string' || !ISO_MILLIS.test(stamp)) throw LEDGER_INVALID;
  if (ackedAt !== null && (typeof ackedAt !== 'string' || !ISO_MILLIS.test(ackedAt))) throw LEDGER_INVALID;
  let parsedDetail: AgentMemoryIntentLedgerRecord['detail'];
  switch (state) {
    case 'applying':
      // `applying` is never acknowledged: it only ever becomes `uncertain`.
      if (detail !== null || ackedAt !== null) throw LEDGER_INVALID;
      parsedDetail = null;
      break;
    case 'applied':
    case 'conflict':
    case 'uncertain':
      parsedDetail = observation(detail);
      if (state === 'applied' && !agentMemoryIntentAppliedConsistent(operation, targetRevision as string | null, parsedDetail)) throw LEDGER_INVALID;
      break;
    case 'rejected':
      if (!isPlainRecord(detail) || !exactKeys(detail, ['code']) || !(AGENT_MEMORY_INTENT_REJECTION_CODES as readonly unknown[]).includes(detail.code)) throw LEDGER_INVALID;
      parsedDetail = { code: detail.code as AgentMemoryIntentRejectionCode };
      break;
    default:
      throw LEDGER_INVALID;
  }
  return canonicalRecord({
    intentId: intentId as string,
    profileRevision: profileRevision as string,
    path: path as string,
    operation,
    operationDigest: operationDigest as string,
    baseRevision: baseRevision as string,
    targetRevision: targetRevision as string | null,
    approvalRef: approvalRef as string,
    state,
    detail: parsedDetail,
    createdAt: createdAt as string,
    updatedAt: updatedAt as string,
    ackedAt: ackedAt as string | null,
  });
}

/** Strictly parse a ledger body. Throws on anything it cannot vouch for; never resets. */
export function parseAgentMemoryIntentLedger(content: string): readonly AgentMemoryIntentLedgerRecord[] {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw LEDGER_INVALID; }
  if (!isPlainRecord(value) || !exactKeys(value, ['version', 'records']) || value.version !== 1 || !Array.isArray(value.records)) throw LEDGER_INVALID;
  if (value.records.length > AGENT_MEMORY_INTENT_LEDGER_CAPACITY) throw LEDGER_INVALID;
  const records = value.records.map(parseRecord);
  if (new Set(records.map((record) => record.intentId)).size !== records.length) throw LEDGER_INVALID;
  return Object.freeze(records);
}

function unackedCount(records: readonly AgentMemoryIntentLedgerRecord[]): number {
  return records.filter((record) => record.ackedAt === null).length;
}

/**
 * Append one record, pruning ONLY records whose `ackedAt` is persisted, oldest
 * `ackedAt` first, and only as many as the new record needs. Unacknowledged
 * evidence is never evicted: the caller has already checked `unacked < N`.
 */
function appendWithPrune(records: readonly AgentMemoryIntentLedgerRecord[], next: AgentMemoryIntentLedgerRecord): AgentMemoryIntentLedgerRecord[] {
  const kept = [...records];
  const pruneOrder = kept
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.ackedAt !== null)
    .sort((left, right) => (left.record.ackedAt! < right.record.ackedAt! ? -1 : left.record.ackedAt! > right.record.ackedAt! ? 1 : left.index - right.index))
    .map(({ record }) => record.intentId);
  const pruned = new Set<string>();
  while (kept.length - pruned.size + 1 > AGENT_MEMORY_INTENT_LEDGER_CAPACITY) {
    const intentId = pruneOrder[pruned.size];
    if (intentId === undefined) throw LEDGER_INVALID;
    pruned.add(intentId);
  }
  return [...kept.filter((record) => !pruned.has(record.intentId)), next];
}

// ---------------------------------------------------------------------------
// Completion equality
// ---------------------------------------------------------------------------

function completionIdentityKey(completion: AgentMemoryIntentCompletion): string {
  return JSON.stringify([
    completion.intentId,
    completion.agentRef.agentId,
    completion.agentRef.profileRevision,
    completion.path,
    completion.operation,
    completion.operationDigest,
  ]);
}

function completionKey(completion: AgentMemoryIntentCompletion): string {
  const identity = completionIdentityKey(completion);
  switch (completion.outcome) {
    case 'applied': return JSON.stringify([identity, 'applied', completion.result.exists, completion.result.revision]);
    case 'conflict': return JSON.stringify([identity, 'conflict', completion.observed.exists, completion.observed.revision]);
    case 'uncertain': return JSON.stringify([identity, 'uncertain', completion.observed.exists, completion.observed.revision]);
    case 'rejected': return JSON.stringify([identity, 'rejected', completion.code]);
  }
}

function completionOf(agentId: string, record: AgentMemoryIntentLedgerRecord): AgentMemoryIntentCompletion {
  const identity = {
    intentId: record.intentId,
    agentRef: { agentId, profileRevision: record.profileRevision },
    path: record.path,
    operation: record.operation,
    operationDigest: record.operationDigest,
  };
  const detail = record.detail;
  switch (record.state) {
    case 'applied':
      return Object.freeze({ ...identity, outcome: 'applied' as const, result: observation(detail) });
    case 'conflict':
      return Object.freeze({ ...identity, outcome: 'conflict' as const, observed: observation(detail) });
    case 'uncertain':
      return Object.freeze({ ...identity, outcome: 'uncertain' as const, observed: observation(detail) });
    case 'rejected':
      if (detail === null || !('code' in detail)) throw LEDGER_INVALID;
      return Object.freeze({ ...identity, outcome: 'rejected' as const, code: detail.code });
    case 'applying':
      throw LEDGER_INVALID;
  }
}

function sameAgentRef(left: AgentRef, right: AgentRef): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}

function sha256Revision(content: string): string {
  return `sha256:${createHash('sha256').update(encoder.encode(content)).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

type RecordIdentity = Pick<
  AgentMemoryIntentLedgerRecord,
  'intentId' | 'profileRevision' | 'path' | 'operation' | 'operationDigest' | 'baseRevision' | 'targetRevision' | 'approvalRef'
>;

type FetchDecision =
  | Readonly<{ kind: 'apply'; identity: RecordIdentity; content: string | undefined }>
  | Readonly<{ kind: 'reject'; identity: RecordIdentity; code: AgentMemoryIntentRejectionCode }>
  | Readonly<{ kind: 'host_terminal'; readback: AgentMemoryIntentReadback }>;

interface HomeWindow {
  readonly binding: AgentHomeBinding;
  readonly home: AgentMemoryHomeBinding;
}

interface LoadedLedger {
  readonly fileRevision: string;
  readonly records: readonly AgentMemoryIntentLedgerRecord[];
}

const NO_ROW_HOST_TERMINAL_DISPOSITIONS: ReadonlySet<string> = new Set(['host_terminal', 'recorded', 'idempotent']);

/**
 * Build the `agent.memory.intent.available` processor. It resolves only after
 * the terminal completion was durable before `complete`, the Host readback
 * matched it, and the `ackedAt` barrier succeeded (or, for an intent with no
 * local row, after a validated Host terminal). Every other end throws one
 * {@link AgentMemoryIntentNoticeError}, which keeps the mailbox row.
 */
export function createAgentMemoryIntentProcessor(
  options: AgentMemoryIntentProcessorOptions,
): (payload: AgentMemoryIntentAvailablePayload) => Promise<AgentMemoryIntentProcessResult> {
  const { tenantId, deviceId, transport, homes, backend, onIntegrity } = options;
  const agentQueues = new Map<string, Promise<void>>();

  async function serial<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = agentQueues.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    agentQueues.set(agentId, next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (agentQueues.get(agentId) === next) agentQueues.delete(agentId);
    }
  }

  return async (payload) => {
    // `payload` already passed the strict protocol schema.
    const intentId = payload.intentId;
    if (transport === undefined) throw new AgentMemoryIntentNoticeError('transport_unconfigured', intentId);
    if (homes === undefined || backend === undefined || !backend.strictLedgerBarrier) {
      throw new AgentMemoryIntentNoticeError('filesystem_unavailable', intentId);
    }
    const notice: AgentMemoryIntentAvailablePayload = Object.freeze({
      intentId,
      agentRef: Object.freeze({ agentId: payload.agentRef.agentId, profileRevision: payload.agentRef.profileRevision }),
    });
    return serial(notice.agentRef.agentId, () => run(notice, transport, homes, backend));
  };

  function fail(reason: AgentMemoryIntentNoticeFailureReason, intentId: string): never {
    throw new AgentMemoryIntentNoticeError(reason, intentId);
  }

  async function withHome<T>(
    homes: AgentHomeManager,
    backend: AgentMemoryIntentBackend,
    notice: AgentMemoryIntentAvailablePayload,
    fn: (window: HomeWindow) => Promise<T>,
  ): Promise<T> {
    let binding: AgentHomeBinding;
    try {
      binding = await homes.acquire(notice.agentRef);
    } catch (error) {
      // Busy means only: this window makes no new write. It never says the
      // target was never written.
      if (error instanceof AgentHomeBusyError) fail('home_busy', notice.intentId);
      fail('local_io_failed', notice.intentId);
    }
    let filesystem: AgentMemoryFilesystem | undefined;
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      if (backend.openFilesystem !== undefined) {
        try { filesystem = await backend.openFilesystem(binding.lease); } catch { fail('local_io_failed', notice.intentId); }
      }
      const home = agentMemoryHomeBinding({
        canonicalHome: binding.lease.canonicalHome,
        homeIdentity: binding.lease.homeIdentity,
        ...(filesystem === undefined ? {} : { filesystem }),
      });
      outcome = { ok: true, value: await fn(Object.freeze({ binding, home })) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    await filesystem?.close().catch(() => {});
    try {
      await binding.lease.release();
    } catch {
      // Writer ownership is uncertain: nothing after this window may run.
      if (outcome.ok) outcome = { ok: false, error: new AgentMemoryIntentNoticeError('local_io_failed', notice.intentId) };
    }
    if (outcome.ok) return outcome.value;
    if (outcome.error instanceof AgentMemoryIntentNoticeError) throw outcome.error;
    if (outcome.error === LEDGER_INVALID) fail('ledger_invalid', notice.intentId);
    fail('local_io_failed', notice.intentId);
  }

  async function readLedger(home: AgentMemoryHomeBinding, intentId: string): Promise<LoadedLedger> {
    let state;
    try {
      state = await readAgentMemoryHomeInternalFile(home, AGENT_MEMORY_INTENT_LEDGER_FILENAME);
    } catch (error) {
      if (error instanceof AgentMemoryValidationError) fail('ledger_invalid', intentId);
      fail('local_io_failed', intentId);
    }
    if (!state.exists) return Object.freeze({ fileRevision: state.revision, records: Object.freeze([]) });
    let records: readonly AgentMemoryIntentLedgerRecord[];
    try {
      records = parseAgentMemoryIntentLedger(state.content);
    } catch {
      fail('ledger_invalid', intentId);
    }
    return Object.freeze({ fileRevision: state.revision, records });
  }

  /**
   * The durable barrier: a strict whole-ledger rewrite under the lease whose
   * success covers temp fsync, rename and directory fsync. A write that throws
   * — even after its rename became visible — is not a barrier.
   */
  async function writeLedger(
    home: AgentMemoryHomeBinding,
    ledger: LoadedLedger,
    records: readonly AgentMemoryIntentLedgerRecord[],
    intentId: string,
  ): Promise<LoadedLedger> {
    let content: string;
    try { content = serializeAgentMemoryIntentLedger(records); } catch { fail('ledger_invalid', intentId); }
    try {
      const written = await replaceAgentMemoryHomeInternalFileStrict(home, AGENT_MEMORY_INTENT_LEDGER_FILENAME, ledger.fileRevision, content);
      return Object.freeze({ fileRevision: written.revision, records: Object.freeze([...records]) });
    } catch {
      fail('local_io_failed', intentId);
    }
  }

  async function observe(home: AgentMemoryHomeBinding, relativePath: string, intentId: string): Promise<AgentMemoryIntentFileObservation> {
    // Byte-level observation: an oversized or non-UTF-8 target is still an
    // exact revision. Only a structurally unobservable target (see
    // `observeAgentMemoryHomeFile`) stays `local_io_failed`.
    try {
      return await observeAgentMemoryHomeFile(home, relativePath);
    } catch {
      fail('local_io_failed', intentId);
    }
  }

  async function auditBestEffort(home: AgentMemoryHomeBinding, agentRef: AgentRef, record: AgentMemoryIntentLedgerRecord): Promise<void> {
    try {
      await appendAgentMemoryHomeAudit(home, {
        kind: 'intent',
        intentId: record.intentId,
        agentRef,
        path: record.path,
        operation: record.operation,
        state: record.state,
        detail: record.detail,
      });
    } catch {
      // Metadata-only observation; the ledger terminal is the authority.
    }
  }

  /**
   * A row found at a window entry. `applying` is never re-executed: it becomes
   * `uncertain` with the current observation (that write is the barrier). A
   * terminal is re-made durable by a barrier rewrite before anything completes
   * it — its mere presence proves nothing about durability.
   */
  async function settleExistingRow(
    home: AgentMemoryHomeBinding,
    ledger: LoadedLedger,
    row: AgentMemoryIntentLedgerRecord,
    intentId: string,
  ): Promise<AgentMemoryIntentLedgerRecord> {
    if (row.state !== 'applying') {
      await writeLedger(home, ledger, ledger.records, intentId);
      return row;
    }
    const observed = await observe(home, row.path, intentId);
    const uncertain: AgentMemoryIntentLedgerRecord = { ...row, state: 'uncertain', detail: observed, updatedAt: new Date().toISOString() };
    await writeLedger(home, ledger, ledger.records.map((record) => (record.intentId === row.intentId ? uncertain : record)), intentId);
    return uncertain;
  }

  function identityOf(notice: AgentMemoryIntentAvailablePayload, intent: AgentMemoryIntentV1): RecordIdentity {
    return {
      intentId: intent.intentId,
      profileRevision: notice.agentRef.profileRevision,
      path: intent.path,
      operation: intent.operation,
      operationDigest: intent.operationDigest,
      baseRevision: intent.baseRevision,
      targetRevision: intent.targetRevision,
      approvalRef: intent.approvalRef,
    };
  }

  async function recomputedDigest(intent: AgentMemoryIntentV1): Promise<string> {
    return agentMemoryIntentOperationDigest({
      tenantId,
      deviceId,
      intentId: intent.intentId,
      agentRef: intent.agentRef,
      path: intent.path,
      operation: intent.operation,
      baseRevision: intent.baseRevision,
      targetRevision: intent.targetRevision,
      approvalRef: intent.approvalRef,
    });
  }

  /**
   * A `release` whose ONLY defect is its content (over 256 KiB, not
   * well-formed Unicode, or absent on a replace) is a typed `content_invalid`
   * rejection. Everything else that fails the schema is a Host protocol
   * violation (`fetch_invalid`).
   */
  function contentOnlyDefect(snapshot: unknown, reservation: AgentMemoryIntentReservation): AgentMemoryIntentV1 | undefined {
    if (reservation !== 'held' || !isPlainRecord(snapshot) || !exactKeys(snapshot, ['disposition', 'intent'])) return undefined;
    if (snapshot.disposition !== 'release' || !isPlainRecord(snapshot.intent) || snapshot.intent.operation !== 'replace') return undefined;
    const substituted = { disposition: 'release', intent: { ...snapshot.intent, content: '' } };
    const parsed = agentMemoryIntentFetchResponseSchemaFor('held').safeParse(substituted);
    if (!parsed.success || parsed.data.disposition !== 'release') return undefined;
    const { content: _placeholder, ...identity } = parsed.data.intent;
    return identity as AgentMemoryIntentV1;
  }

  async function validateHostTerminal(
    notice: AgentMemoryIntentAvailablePayload,
    response: Extract<AgentMemoryIntentFetchResponse, { disposition: 'terminal' }>,
  ): Promise<FetchDecision> {
    const { intent, readback } = response;
    // No local row: nothing device-side to persist. Accept only a Host
    // terminal that is exactly this tenant, device, intent, Agent and digest,
    // and only a disposition that states a durable Host fact for it. A
    // `conflict` readback here has no local fact to be in conflict WITH, so it
    // is not acceptable evidence (distinct from a stored `conflict` outcome).
    if (
      readback.tenantId !== tenantId ||
      readback.deviceId !== deviceId ||
      readback.intentId !== notice.intentId ||
      !sameAgentRef(readback.completion.agentRef, notice.agentRef) ||
      readback.completion.operationDigest !== (await recomputedDigest(intent)) ||
      !NO_ROW_HOST_TERMINAL_DISPOSITIONS.has(readback.disposition)
    ) {
      fail('readback_invalid', notice.intentId);
    }
    if (
      readback.completion.outcome === 'applied' &&
      !agentMemoryIntentAppliedConsistent(intent.operation, intent.targetRevision, readback.completion.result)
    ) {
      fail('readback_invalid', notice.intentId);
    }
    return Object.freeze({ kind: 'host_terminal', readback });
  }

  /**
   * The identity binding gate, first for every released or withheld intent:
   * only an intent bound to THIS notice (same agentId and profileRevision) and
   * to THIS enrollment (its operationDigest recomputes with the local tenant
   * and device) may ever produce a durable device completion. Anything else is
   * a Host protocol violation, `fetch_invalid`: zero ledger writes, zero CAS,
   * no completion, no resolve. A completion that mixed the notice's Agent with
   * another binding's digest could never be stored consistently by a strict
   * Host nor replayed through a terminal fetch.
   */
  async function requireBoundIntent(notice: AgentMemoryIntentAvailablePayload, intent: AgentMemoryIntentV1): Promise<void> {
    if (!sameAgentRef(intent.agentRef, notice.agentRef) || (await recomputedDigest(intent)) !== intent.operationDigest) {
      fail('fetch_invalid', notice.intentId);
    }
  }

  async function validateRelease(
    notice: AgentMemoryIntentAvailablePayload,
    intent: AgentMemoryIntentV1,
    contentDefect: boolean,
  ): Promise<FetchDecision> {
    // Before any body check: a bad body must not mask a wrong binding.
    await requireBoundIntent(notice, intent);
    const identity = identityOf(notice, intent);
    const reject = (code: AgentMemoryIntentRejectionCode): FetchDecision => Object.freeze({ kind: 'reject', identity, code });
    if (contentDefect) return reject('content_invalid');
    try {
      validateAgentMemoryPath(intent.path);
    } catch (error) {
      if (error instanceof AgentMemoryValidationError) return reject('path_invalid');
      throw error;
    }
    if (intent.operation === 'delete' && intent.path === 'MEMORY.md') return reject('memory_md_not_deletable');
    // The body digest is checked before anything durable happens: the CAS is
    // never handed bytes the owner did not approve.
    if (intent.operation === 'replace' && (intent.content === undefined || sha256Revision(intent.content) !== intent.targetRevision)) {
      return reject('content_invalid');
    }
    return Object.freeze({ kind: 'apply', identity, content: intent.operation === 'replace' ? intent.content : undefined });
  }

  async function validateWithheld(
    notice: AgentMemoryIntentAvailablePayload,
    intent: AgentMemoryIntentV1,
    code: AgentMemoryIntentHostTerminalCode,
  ): Promise<FetchDecision> {
    await requireBoundIntent(notice, intent);
    return Object.freeze({ kind: 'reject', identity: identityOf(notice, intent), code });
  }

  async function fetchDecision(
    transport: AgentMemoryIntentTransport,
    notice: AgentMemoryIntentAvailablePayload,
    reservation: AgentMemoryIntentReservation,
  ): Promise<FetchDecision> {
    let raw: unknown;
    try {
      raw = await transport.fetch(Object.freeze({ intentId: notice.intentId, agentRef: notice.agentRef, reservation }));
    } catch {
      // Deliberately unbound: nothing the transport threw is read or kept.
      fail('fetch_failed', notice.intentId);
    }
    let response: AgentMemoryIntentFetchResponse;
    let contentDefect = false;
    try {
      const snapshot = snapshotPlainData(raw, HOST_ANSWER_SNAPSHOT);
      const parsed = agentMemoryIntentFetchResponseSchemaFor(reservation).safeParse(snapshot);
      if (parsed.success) {
        response = parsed.data;
      } else {
        const intent = contentOnlyDefect(snapshot, reservation);
        if (intent === undefined) throw LEDGER_INVALID;
        response = { disposition: 'release', intent };
        contentDefect = true;
      }
    } catch {
      fail('fetch_invalid', notice.intentId);
    }
    if (response.intent.intentId !== notice.intentId) fail('fetch_invalid', notice.intentId);
    switch (response.disposition) {
      case 'deferred':
        // Only for `none`: the Host changed nothing and released nothing.
        fail('ledger_full', notice.intentId);
      case 'terminal':
        return validateHostTerminal(notice, response);
      case 'withheld':
        return validateWithheld(notice, response.intent, response.code);
      case 'release':
        return validateRelease(notice, response.intent, contentDefect);
    }
  }

  async function window2(
    homes: AgentHomeManager,
    backend: AgentMemoryIntentBackend,
    notice: AgentMemoryIntentAvailablePayload,
    decision: Extract<FetchDecision, { kind: 'apply' | 'reject' }>,
  ): Promise<AgentMemoryIntentLedgerRecord> {
    const intentId = notice.intentId;
    return withHome(homes, backend, notice, async ({ binding, home }) => {
      let ledger = await readLedger(home, intentId);
      const existing = ledger.records.find((record) => record.intentId === intentId);
      // The release is consumed by exactly this window; a row here means an
      // earlier attempt already owns the intent, so the release is discarded.
      if (existing !== undefined) return settleExistingRow(home, ledger, existing, intentId);
      if (unackedCount(ledger.records) >= AGENT_MEMORY_INTENT_LEDGER_CAPACITY) fail('ledger_full', intentId);
      const createdAt = new Date().toISOString();
      const base = { ...decision.identity, createdAt, updatedAt: createdAt, ackedAt: null };
      if (decision.kind === 'reject') {
        // Zero memory writes: no `applying`, no CAS. The rejection itself is
        // a terminal and is made durable before it can be completed.
        const rejected: AgentMemoryIntentLedgerRecord = { ...base, state: 'rejected', detail: { code: decision.code } };
        await writeLedger(home, ledger, appendWithPrune(ledger.records, rejected), intentId);
        await auditBestEffort(home, notice.agentRef, rejected);
        return rejected;
      }
      try {
        await homes.initializeTaskFree(binding);
      } catch {
        fail('local_io_failed', intentId);
      }
      // At most once: `applying` is durable BEFORE the one CAS; if this write
      // throws, the CAS never runs.
      const applying: AgentMemoryIntentLedgerRecord = { ...base, state: 'applying', detail: null };
      ledger = await writeLedger(home, ledger, appendWithPrune(ledger.records, applying), intentId);
      const identity = decision.identity;
      let terminal: AgentMemoryIntentLedgerRecord;
      try {
        const after = await compareAndSwapAgentMemoryHomeFile(home, {
          operation: identity.operation,
          path: identity.path,
          expectedRevision: identity.baseRevision,
          ...(identity.operation === 'replace' ? { content: decision.content } : {}),
        });
        const result = Object.freeze({ exists: after.exists, revision: after.revision });
        terminal = agentMemoryIntentAppliedConsistent(identity.operation, identity.targetRevision, result)
          ? { ...applying, state: 'applied', detail: result, updatedAt: new Date().toISOString() }
          : { ...applying, state: 'uncertain', detail: result, updatedAt: new Date().toISOString() };
      } catch (error) {
        const observed = await observe(home, identity.path, intentId);
        // `conflict` only when this backend proves a conflict renamed nothing;
        // every other failure is `uncertain` with only a current observation.
        const conflict = error instanceof AgentMemoryRevisionConflictError && backend.conflictProvesNoRename;
        terminal = { ...applying, state: conflict ? 'conflict' : 'uncertain', detail: observed, updatedAt: new Date().toISOString() };
      }
      // Terminal barrier: this write returning is what licenses `complete`.
      await writeLedger(home, ledger, ledger.records.map((record) => (record.intentId === intentId ? terminal : record)), intentId);
      await auditBestEffort(home, notice.agentRef, terminal);
      return terminal;
    });
  }

  async function completeAndAcknowledge(
    transport: AgentMemoryIntentTransport,
    homes: AgentHomeManager,
    backend: AgentMemoryIntentBackend,
    notice: AgentMemoryIntentAvailablePayload,
    record: AgentMemoryIntentLedgerRecord,
  ): Promise<AgentMemoryIntentProcessResult> {
    const intentId = notice.intentId;
    let completion: AgentMemoryIntentCompletion;
    try { completion = completionOf(notice.agentRef.agentId, record); } catch { fail('ledger_invalid', intentId); }
    let raw: unknown;
    try {
      raw = await transport.complete(completion);
    } catch {
      fail('complete_failed', intentId);
    }
    let readback: AgentMemoryIntentReadback;
    try {
      const parsed = AgentMemoryIntentReadbackSchema.safeParse(snapshotPlainData(raw, HOST_ANSWER_SNAPSHOT));
      if (!parsed.success) throw LEDGER_INVALID;
      readback = parsed.data;
    } catch {
      fail('readback_invalid', intentId);
    }
    if (
      readback.tenantId !== tenantId ||
      readback.deviceId !== deviceId ||
      readback.intentId !== intentId ||
      completionIdentityKey(readback.completion) !== completionIdentityKey(completion)
    ) {
      fail('readback_invalid', intentId);
    }
    // `recorded` / `idempotent` must carry exactly what was submitted. A
    // `conflict` disposition (a DIFFERENT stored completion) or a
    // `host_terminal` against a local terminal contradicts the device fact:
    // integrity audit, then the `ackedAt` barrier, then resolve.
    const integrity = readback.disposition === 'conflict' || readback.disposition === 'host_terminal';
    if (!integrity && completionKey(readback.completion) !== completionKey(completion)) fail('readback_mismatch', intentId);
    await withHome(homes, backend, notice, async ({ home }) => {
      const ledger = await readLedger(home, intentId);
      const row = ledger.records.find((candidate) => candidate.intentId === intentId);
      if (row === undefined || row.state === 'applying' || completionKey(completionOf(notice.agentRef.agentId, row)) !== completionKey(completion)) {
        fail('ledger_invalid', intentId);
      }
      if (integrity) {
        try {
          await appendAgentMemoryHomeAudit(home, {
            kind: 'intent_integrity',
            intentId,
            agentRef: notice.agentRef,
            disposition: readback.disposition,
            device: outcomeSummary(completion),
            host: outcomeSummary(readback.completion),
          });
        } catch {
          fail('local_io_failed', intentId);
        }
      }
      // `ackedAt` barrier: always a whole rewrite, even when `ackedAt` is
      // already present (its presence proves nothing about durability).
      const acked: AgentMemoryIntentLedgerRecord = { ...row, ackedAt: row.ackedAt ?? new Date().toISOString() };
      await writeLedger(home, ledger, ledger.records.map((candidate) => (candidate.intentId === intentId ? acked : candidate)), intentId);
    });
    if (integrity) {
      const disposition = readback.disposition === 'conflict' ? 'conflict' : 'host_terminal';
      try {
        onIntegrity?.(Object.freeze({ intentId, disposition }));
      } catch {
        // Observation only: the durable audit and the `ackedAt` barrier already
        // hold; a failing observer never un-acknowledges the notice.
      }
    }
    return Object.freeze({ kind: 'acknowledged', completion, readback, integrity });
  }

  async function run(
    notice: AgentMemoryIntentAvailablePayload,
    transport: AgentMemoryIntentTransport,
    homes: AgentHomeManager,
    backend: AgentMemoryIntentBackend,
  ): Promise<AgentMemoryIntentProcessResult> {
    const intentId = notice.intentId;
    const entry = await withHome(homes, backend, notice, async ({ home }) => {
      const ledger = await readLedger(home, intentId);
      const row = ledger.records.find((record) => record.intentId === intentId);
      if (row !== undefined) return { kind: 'row' as const, record: await settleExistingRow(home, ledger, row, intentId) };
      const reservation: AgentMemoryIntentReservation =
        unackedCount(ledger.records) < AGENT_MEMORY_INTENT_LEDGER_CAPACITY ? 'held' : 'none';
      return { kind: 'fetch' as const, reservation };
    });
    if (entry.kind === 'row') return completeAndAcknowledge(transport, homes, backend, notice, entry.record);
    const decision = await fetchDecision(transport, notice, entry.reservation);
    if (decision.kind === 'host_terminal') return Object.freeze({ kind: 'host_terminal', readback: decision.readback });
    const terminal = await window2(homes, backend, notice, decision);
    return completeAndAcknowledge(transport, homes, backend, notice, terminal);
  }
}

function outcomeSummary(completion: AgentMemoryIntentCompletion): Readonly<Record<string, unknown>> {
  switch (completion.outcome) {
    case 'applied': return { outcome: 'applied', exists: completion.result.exists, revision: completion.result.revision };
    case 'conflict': return { outcome: 'conflict', exists: completion.observed.exists, revision: completion.observed.revision };
    case 'uncertain': return { outcome: 'uncertain', exists: completion.observed.exists, revision: completion.observed.revision };
    case 'rejected': return { outcome: 'rejected', code: completion.code };
  }
}
