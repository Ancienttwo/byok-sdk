// ==== @byok-sdk/server dist/event-queue.d.ts ====
/**
 * A tiny append-only, multi-reader async queue. `push` never blocks; `close`
 * marks the queue done. Every pushed entry gets a sequence number, strictly
 * increasing within the queue. `entries(after)` returns a fresh async iterator
 * that starts after that sequence, or at the beginning of the queue when none
 * is given, and follows new pushes until the queue closes.
 *
 * Bounded, deliberately (WP3B §3): this queue is a NOTIFICATION relay, not a
 * record of what happened — the durable facts live in the cloud stores a
 * `ByokServer` reads back (`tasks.get`, `TaskHandle.result()`). A consumer that
 * stops iterating must therefore cost bounded memory, not unbounded growth. On
 * overflow the OLDEST entries are dropped. A subscriber whose next wanted entry
 * was dropped receives the caller-supplied `truncationMarker` once for that gap,
 * so a reader can tell a complete feed from a clipped one instead of silently
 * seeing a gap. The marker is not a buffered entry: each subscriber derives it
 * from its own position, so all retained capacity remains available to real
 * events, and it takes the position just before the oldest retained entry.
 *
 * `isPosition` accepts exactly the positions the queue handed out. `subscribe`
 * yields the values only, from the beginning. Both iterators' `return()` also
 * releases a pending `next()`. Members carry no block docs because comments on
 * class members ship in the bundle, which has an exact size budget.
 *
 * Framework-agnostic on purpose (no Node/WS/Hono types here) so it can be
 * unit-tested and reused regardless of transport.
 */
export interface AsyncEventQueueOptions<T> {
    /**
     * Maximum entries retained before drop-oldest engages. Omitted means
     * unbounded — only appropriate for a queue whose producer is itself bounded.
     */
    readonly maxBuffered?: number;
    /**
     * Yielded to a subscriber in place of each run of entries dropped before it
     * read them, so the truncation is observable. Omitted means a bounded queue
     * that drops silently.
     */
    readonly truncationMarker?: T;
}
/** One queue position: a pushed value, or the truncation marker standing just before the oldest retained entry. */
export interface QueueEntry<T> {
    readonly sequence: number;
    readonly value: T;
}
export declare class AsyncEventQueue<T> {
    private readonly buffer;
    private nextSequence;
    private closed;
    private waiters;
    private readonly maxBuffered;
    private readonly truncationMarker;
    constructor(options?: AsyncEventQueueOptions<T>);
    isPosition(sequence: number): boolean;
    push(value: T): QueueEntry<T> | undefined;
    close(): void;
    private enforceBound;
    private wake;
    subscribe(): AsyncIterable<T>;
    entries(after?: number): AsyncIterable<QueueEntry<T>>;
}
// ==== @byok-sdk/server dist/execution-core/canonical.d.ts ====
/**
 * Canonical JSON and its SHA-256 (#884). This entry imports only `node:crypto`, so K8 `rules/` can load it where
 * `node:sqlite` and `node:async_hooks` do not exist, for example Workers with `nodejs_compat`.
 */
export declare function hash(value: unknown): string;
export declare function canonical(value: unknown): string;
// ==== @byok-sdk/server dist/execution-core/core.d.ts ====
import type { ByokServer } from '../index';
import type { CreateByokServerOptions } from '../types';
import type { DueWake } from '../wakes/types';
import { type HostMemoryPage } from './memory';
import { HostLedger, type ApplicationRows } from './ledger';
import { type HostJobHandler, type HostOccurrenceRun, type Intent, type IntentInput, type Json, type LedgerState, type Routine, type RoutineDefinition, type Terminal } from './model';
import { type NextOccurrence } from './schedule';
import { type RoutineCommands } from './routines';
import { type FrozenSubmitPort } from './submit';
export type ExecutionServer = {
    /** `submitSealed` is the sealed lane (#654). Without it, the core fails a sealed intent before any submit. */
    executions: Pick<ByokServer['executions'], 'submit'> & Pick<FrozenSubmitPort, 'submitSealed'>;
    tasks: Pick<ByokServer['tasks'], 'offer' | 'deviceTerminal' | 'attempt' | 'cancel'>;
    wakes: ByokServer['wakes'];
    /** Embedded process-local hints; reads from tasks remain authoritative. */
    events?: ByokServer['events'];
};
export interface OutcomeTransaction {
    readonly intent: Readonly<Intent>;
    readonly terminal: Terminal;
    /** Business state participates in the same SQLite commit. Do not do external I/O here. */
    application: Record<string, Json>;
    publish(id: string, value: Json): void;
    routines: RoutineCommands;
}
export interface OccurrenceTransaction {
    /** Business state participates in the occurrence commit. No external I/O and no core or ledger calls. */
    application: Record<string, Json>;
    publish(id: string, value: Json): void;
}
/** Runs synchronously in the commit of a new `hostOccurrence` occurrence. A throw or a thenable rolls the occurrence back. */
export type OccurrenceHook = (run: HostOccurrenceRun, transaction: OccurrenceTransaction) => void;
export type AgentMessageInput = Parameters<NonNullable<CreateByokServerOptions['agentMessage']>['consume']>[0];
export type MessageDecision = {
    outcome: 'accepted' | 'refused';
    reasonCode?: string;
};
export interface MessageTransaction {
    readonly intent: Readonly<Intent>;
    /** Synchronous business updates share the receipt/projection commit. No external I/O. */
    application: Record<string, Json>;
    /** The application rows of the same commit. The port closes when the hook returns. */
    rows: ApplicationRows;
    publish(id: string, value: Json): void;
}
export interface HostOptions {
    hostJobs?: Readonly<Record<string, HostJobHandler>>;
    /**
     * What a Host job result with `execution` does. `promote` (default) adds its intent to the FIFO. `fail` stores the summary,
     * concludes the occurrence `failed` with no promotion and no retry, and the drain reports `host_job_execution_unsupported`,
     * for a Host that has no owner for such an intent (K8 L).
     */
    hostJobExecution?: 'promote' | 'fail';
    /**
     * Whether this Host runs `execution` routines. `allow` (default) runs them. `refuse`, for a Host that has no owner for an
     * occurrence intent (K8 L), refuses an `execution` definition in `addRoutine`, `updateRoutine` and `OutcomeTransaction.routines`,
     * and the constructor refuses a ledger that holds a routine not completed whose current or pending version is `execution`.
     */
    executionRoutines?: 'allow' | 'refuse';
    occurrenceHooks?: Readonly<Record<string, OccurrenceHook>>;
    memory?: HostMemoryPage;
    now?: () => number;
    reconcileMs?: number;
    nextOccurrence?: NextOccurrence;
    /** Coalesced post-commit hint. May enqueue/flush reentrantly; failures retain projections. */
    onOutbox?: (signal: AbortSignal) => void | Promise<void>;
    applyMessage?: (input: AgentMessageInput, transaction: MessageTransaction) => MessageDecision;
    applyOutcome?: (document: unknown, transaction: OutcomeTransaction) => void;
    /**
     * Submit admission (#957): asked in the transaction that begins a submit, and again in the readback right before the SDK
     * call, with the intent and the ledger state. `false` holds the intent: a queued or backoff intent keeps its phase and
     * generation, and a begun intent is not sent. A held queued or backoff intent arms the scan only for its expiry, so the
     * Host drains after it admits again. A cancel still settles a held intent. Covers every
     * submit of this core, the timer drain and direct `enqueue` calls included. Must be synchronous. Absent: every submit is admitted.
     */
    admitSubmit?: (intent: Readonly<Intent>, state: Readonly<LedgerState>) => boolean;
}
/** One instance per embedded tenant. Only horizon retries use a process-local timer. */
export declare class HostExecutionCore {
    readonly server: ExecutionServer;
    readonly ledger: HostLedger;
    private readonly options;
    private readonly now;
    private readonly nextTime;
    private readonly reconcileMs;
    private draining?;
    private again;
    private stopped;
    private stopMemoryUpdates?;
    private stopMemoryLedgerBinding?;
    private memoryWaking;
    private eventIterator?;
    private eventPump?;
    private eventsActive;
    private readonly liveTasks;
    private liveScanTimer?;
    /** Task ID to used probe ticks and the next probe time (`performance.now()`). Rearming keeps both, so the bound is real. */
    private readonly cancelProbes;
    private cancelProbeTimer?;
    private cancelProbing?;
    private stopOutboxUpdates?;
    private outboxQueued;
    private outboxNotifying?;
    private readonly outboxAbort;
    private readonly outboxContext;
    private scheduleRetryTimer?;
    /** Outbox key of a failed wake call to its used timed retries and its pending timer. Rearming keeps the count. */
    private readonly wakeRetries;
    private readonly hostJobs;
    private readonly occurrenceHooks;
    private readonly jobAbort;
    constructor(server: ExecutionServer, ledger: HostLedger, options?: HostOptions);
    intent(key: string): Intent | undefined;
    /** Install directly as agentMessage.consume; SDK owns payload/schema admission. */
    readonly consumeMessage: (input: AgentMessageInput) => Promise<MessageDecision>;
    enqueue(input: IntentInput): Promise<Intent>;
    addRoutine(definition: RoutineDefinition): Promise<void>;
    /**
     * Stages version `max(current, pending) + 1` with the same destination. An exact replay does nothing.
     * The new version replaces the current one when no occurrence of the routine is unsettled and no old slot is due.
     */
    updateRoutine(definition: RoutineDefinition): Promise<void>;
    /** The one path for routine commands. */
    private routineCommands;
    lifecycle(id: string, lifecycle: Routine['lifecycle']): Promise<void>;
    cancel(key: string): Promise<void>;
    readonly consume: (wake: DueWake, signal: AbortSignal) => Promise<void>;
    /** The hook shares the occurrence commit: both persist, or neither does. */
    private runOccurrenceHook;
    recover(): Promise<void>;
    drain(): Promise<void>;
    close(): Promise<void>;
    private notifyOutbox;
    private watchEvents;
    private armLiveScan;
    /**
     * A cancelled inflight intent has had `tasks.cancel` and waits for its device terminal.
     * Probe that terminal with a backoff per task. A probe never writes the ledger; only a found terminal drains.
     */
    private armCancelProbe;
    private cancelProbeDelay;
    private probeCancelled;
    private assertOpen;
    private scan;
    private runHostJobs;
    /**
     * A settlement can make a staged version due. Check after each settlement path: no wake
     * may follow the last settlement, because the old chain gets no refill while a version waits.
     */
    private switchVersions;
    /**
     * The outbox keeps a failed wake call with `lastError`. Each such row gets its own timer with backoff;
     * a timer runs one drain, which retries every failed row. A row at the limit waits for other drains.
     */
    private armWakeRetry;
    private armScheduleRetry;
    private error;
    private flushWakes;
    private armScan;
    private verifyAttempt;
    /**
     * The SDK calls of one frozen submit. It has `submitSealed` only while the server has one, so `submitFrozen` refuses a
     * sealed input before its readback on every path, the reconcile resubmit included, not only in `begin`.
     */
    private frozenPort;
    private delivered;
    private admits;
    private submit;
    private memoryInstruction;
    private resumeMemory;
    private memoryFailure;
    private begin;
    private reconcile;
    private finish;
    /** Host uploader: at-least-once delivery. The receiver must deduplicate by id. */
    flushProjections(deliver: (id: string, value: Json) => Promise<void>): Promise<void>;
}
// ==== @byok-sdk/server dist/execution-core/index.d.ts ====
export { HostExecutionCore } from './core';
export type { ExecutionServer, HostOptions, OutcomeTransaction, OccurrenceHook, OccurrenceTransaction, AgentMessageInput, MessageDecision, MessageTransaction } from './core';
export { CompactVetoError, HostLedger, OutboxFullError, MIN_TOMBSTONE_RETENTION_MS, RetiredIntentIdentityError } from './ledger';
export type { ApplicationRows, CompactionOptions, CompactionResult, CompactVeto, TombstoneKind, HostLedgerOptions, ProjectionOutboxLimits, ProjectionOutboxUsage, LedgerDump, LedgerDumpMemoryTombstone, LedgerDumpRow, LedgerDumpTombstone } from './ledger';
export { nextIntervalOccurrence } from './schedule';
export type { NextOccurrence } from './schedule';
export { DEFAULT_RETRY, frozenInput, isOccurrenceIntentKey, occurrenceIntentKey, occurrenceOfIntentKey, taskId, validateRetry } from './model';
export type { IntentInput, LedgerIntentInput, Intent, ExecutionTemplate, SealedExecutionTemplate, IntentExecution, SealedAgentExecutionInput, FrozenExecutionInput, RetryPolicy, AgentRoutineDefinition, HostJobRoutineDefinition, HostJobSpec, HostJobRun, HostJobResult, HostJobHandler, HostOccurrenceRoutineDefinition, HostOccurrenceRun, RoutineDefinition, Routine, Occurrence, Conclusion, Json } from './model';
export { HostMemoryPage, MemoryBlockedError, memoryRevision, EMPTY_MEMORY_REVISION, RESIDENT_MEMORY_MAX_BYTES } from './memory';
export type { MemoryApproval, MemoryBinding, MemoryOptions, MemoryContextPack } from './memory';
export { hash, canonical, isSealed, project, time, validateJson } from './model';
export type { LedgerState, IgnoredWakeAudit } from './model';
export { enqueue, agentKey, fifoHeads, queuedExpiry, settle } from './transitions';
export { FrozenOfferMismatchError, SealedDispatchUnavailableError, sameFrozenOffer, submitFrozen } from './submit';
export type { FrozenSubmitPort, FrozenInput, FrozenOffer } from './submit';
export { routineTemplateBinding, sealRoutineTemplate } from './sealed-routine';
export type { RoutineRef, SealRoutineTemplateInput, SealedTaskInput } from './sealed-routine';
export { WAKE_HORIZON_MS, IGNORED_WAKE_AUDIT_LIMIT, parseRoutineWakeKey, routineWakeKey, versionSwitchDue, promoteOccurrence, concludeOccurrence, recordOccurrence, createRoutine, stageVersion, setLifecycle, switchVersion, nextWake, validateRoutineDefinition, occurrenceRun, routineCommands, applyPlan, auditCalendarError, scheduleNext } from './routines';
export type { RoutineValidation, RoutineCommands, RoutineCommandOptions } from './routines';
export type { MemoryRestoreInput, MemoryRestoreResult, MemoryRestoreFileResult } from './memory-restore';
// ==== @byok-sdk/server dist/execution-core/ledger.d.ts ====
import type { MemoryIntentRow } from './memory';
import { type Json, type LedgerState } from './model';
export interface ProjectionOutboxLimits {
    maxCount?: number;
    maxBytes?: number;
}
/**
 * Refuses the compaction of one intent identity with a reason, or allows it with `undefined`.
 * `compact` calls it in its own transaction, before it removes anything, with the state before the compaction.
 * It must not change the state. An application registers it once, so a plain `compact` call cannot skip it.
 */
export type CompactVeto = (state: Readonly<LedgerState>, intentKey: string) => string | undefined;
export interface HostLedgerOptions {
    projectionOutboxLimits?: ProjectionOutboxLimits;
    compactVeto?: CompactVeto;
}
export interface ProjectionOutboxUsage {
    count: number;
    bytes: number;
}
/** Capacity refusal contains no projection identity or payload. */
export declare class OutboxFullError extends Error {
    readonly code: 'outbox_full';
    constructor();
}
/** The registered veto refused one identity. The whole compaction rolls back. */
export declare class CompactVetoError extends Error {
    readonly intentKey: string;
    readonly code: 'compact_vetoed';
    constructor(intentKey: string, reason: string);
}
/**
 * Application rows by stable identity, in the same transaction as the ledger body (#798).
 * The port is open only while `apply` runs. It reads and writes only this tenant's rows.
 * A retired identity stays retired: the port has no way to clear it.
 */
export interface ApplicationRows {
    get(namespace: string, id: string): Json | undefined;
    /** `expiresAt`: `expire` may remove the row from that time on. Absent: the row never expires. */
    put(namespace: string, id: string, value: Json, expiresAt?: number): void;
    /** Returns whether a row existed. */
    delete(namespace: string, id: string): boolean;
    /** Removes the rows of a namespace whose `expiresAt` is `now` or earlier. Returns their count. */
    expire(namespace: string, now: number): number;
    retire(namespace: string, id: string): void;
    isRetired(namespace: string, id: string): boolean;
}
export declare const MIN_TOMBSTONE_RETENTION_MS: number;
export type TombstoneKind = 'intent' | 'application' | 'slot';
/** A retired intent key, or a routine occurrence key outside its occurrence, cannot admit new work. */
export declare class RetiredIntentIdentityError extends Error {
    readonly code: 'retired_intent_identity';
    constructor();
}
export interface CompactionOptions {
    /** Explicit acknowledgement that these results may be removed under the Host's retention policy. */
    acknowledgedIntentKeys: readonly string[];
    /** Settled Host job or Host occurrence rows without an intent; promoted occurrences are selected through their intent. */
    acknowledgedOccurrenceKeys?: readonly string[];
    /** Terminal memory intents whose readback the Host has acknowledged. */
    acknowledgedMemoryIntentIds?: readonly string[];
    now: number;
    tombstoneRetentionMs: number;
}
export interface CompactionResult {
    compactedIntents: number;
    alreadyCompactedIntents: number;
    executions: number;
    occurrences: number;
    memoryIntents: number;
    alreadyCompactedMemoryIntents: number;
    expiredTombstones: number;
    beforeBytes: number;
    afterBytes: number;
}
/** A tombstone of `host_retired_identity`. `row` is an application row tombstone (`ApplicationRows.retire`). */
export interface LedgerDumpTombstone {
    kind: TombstoneKind | 'row';
    identity: string;
    expiresAt: number | null;
}
export interface LedgerDumpRow {
    namespace: string;
    id: string;
    value: Json;
    expiresAt: number | null;
}
export interface LedgerDumpMemoryTombstone {
    intentId: string;
    approval: string;
    row: MemoryIntentRow;
    expiresAt: number;
}
/**
 * Every stored row of one tenant, for a topology switch (#975). Each list is ordered by its key, and each expiry is as stored.
 * It carries no tenant id: `loadForSwitch` writes it into another, empty tenant.
 */
export interface LedgerDump {
    version: 1;
    body: LedgerState;
    tombstones: LedgerDumpTombstone[];
    rows: LedgerDumpRow[];
    memoryTombstones: LedgerDumpMemoryTombstone[];
}
/** Small single-owner reference. Keep this database separate from the SDK and Agent home. */
export declare class HostLedger {
    readonly tenant: string;
    private readonly db;
    private readonly outboxListeners;
    /** Post-commit hints for newly inserted projections. The durable outbox is the authority. */
    onOutbox(listener: () => void): () => void;
    private readonly projectionLimits?;
    /** An application checks this identity to prove that its veto guards every compaction. */
    readonly compactVeto?: CompactVeto;
    constructor(filename: string, tenant: string, options?: HostLedgerOptions);
    snapshot(): LedgerState;
    projectionOutboxUsage(): ProjectionOutboxUsage;
    transaction<T>(apply: (state: LedgerState, rows: ApplicationRows) => T): T;
    private rowStatements?;
    /** A port for one transaction. All SQL stays here; the caller gets no database handle. */
    private rows;
    /** Replay evidence is time-bounded. Caller intent identities are permanent; routine occurrence identities expire with their slot. */
    hasTombstone(kind: TombstoneKind, identity: string, now: number): boolean;
    /** A compacted terminal memory row answers replays until it expires. `approval` is the key used in `memory.approvals`. */
    retiredMemoryIntent(by: 'intent' | 'approval', identity: string, now: number): MemoryIntentRow | undefined;
    /** Explicit, transactional removal of acknowledged settled core history. Never runs automatically. */
    compact(options: CompactionOptions): CompactionResult;
    /**
     * Reads every stored row of this tenant in one read transaction (#975): the ledger body, the tombstones and application rows
     * with their expiry as stored, and the retired memory intents. It checks nothing else; the switch preconditions are the
     * caller's. Call it outside `transaction()`.
     */
    dumpForSwitch(): LedgerDump;
    /** The rows of this tenant, inside the caller's transaction: the dump, and the load's read-back. */
    private readDump;
    /**
     * Writes a `dumpForSwitch` result into this tenant in one transaction (#975). The tenant must be empty: the body of a new
     * ledger and no other row. Expiry is kept, never reset. The loaded body passes the intent identity checks of `transaction()`
     * against the dump's own tombstones. The dump must be bound to this tenant: each intent's `agent` is `agentKey(tenant, …)`,
     * a scan wake key names this tenant, and it holds no memory state or retired memory intent. After the writes, in the same
     * transaction, `verify` gets this tenant's rows read back as `dumpForSwitch` reads them; when it throws, nothing is
     * written. Any refusal or write failure rolls the whole load back. It runs before any core is bound to this ledger, so
     * loaded work stays inert until the caller starts one; it sends no outbox hint.
     */
    loadForSwitch(dump: LedgerDump, verify: (readBack: LedgerDump) => void): void;
    /**
     * Deletes every row of this tenant, tombstones included, in one transaction, then closes this ledger (#975). Irreversible.
     * For a tenant that never ran work, such as an aborted switch import; the caller gates it. Refused while a core is bound.
     * Other `HostLedger` instances on the same file stay open, and reopening the tenant id creates an empty tenant.
     */
    discard(): void;
    close(): void;
}
// ==== @byok-sdk/server dist/execution-core/memory-restore.d.ts ====
import { HostLedger } from './ledger';
import { type LedgerState } from './model';
import type { MemoryApproval, MemoryBinding, MemoryIntentRow, MemoryOptions } from './memory';
import { type AgentMemoryExport, type AgentMemoryFile } from '@byok-sdk/protocol/agent-memory';
export interface MemoryRestoreInput extends MemoryBinding {
    restoreId: string;
    files: readonly AgentMemoryFile[];
    mode: 'initial' | 'overwrite';
    /** Exact export the user approved overwriting; never automatically refreshed. */
    observed?: AgentMemoryExport;
    expiresAt: number;
}
export interface MemoryRestoreFileResult {
    path: string;
    operation: 'replace' | 'delete';
    intentId?: string;
    outcome: 'pending' | 'unchanged' | 'applied' | 'conflict' | 'rejected' | 'uncertain';
}
export interface MemoryRestoreResult extends MemoryBinding {
    restoreId: string;
    status: 'preparing' | 'applying' | 'applied' | 'conflict' | 'rejected' | 'uncertain' | 'cancelled';
    files: MemoryRestoreFileResult[];
}
export interface MemoryRestoreRow extends MemoryRestoreResult {
    requestHash: string;
    /** Purged atomically once intent rows own the pending bodies. */
    request?: MemoryRestoreInput;
}
export declare function memoryRestoreBlocked(state: LedgerState, binding: MemoryBinding): boolean;
export declare function recordRestoreTerminal(state: LedgerState, intent: MemoryIntentRow): void;
/** K4-only durable queue exclusion. This is resumable per-file CAS, not a tree transaction. */
export declare class MemoryRestoreCoordinator {
    private readonly ledger;
    private readonly options;
    private readonly prepare;
    constructor(ledger: HostLedger, options: MemoryOptions, prepare: (input: MemoryApproval) => Promise<MemoryIntentRow>);
    private now;
    read(binding: MemoryBinding, restoreId: string): MemoryRestoreResult | undefined;
    restore(input: MemoryRestoreInput): Promise<MemoryRestoreResult>;
    private resume;
    cancel(binding: MemoryBinding, restoreId: string): MemoryRestoreResult;
    recover(): Promise<void>;
}
// ==== @byok-sdk/server dist/execution-core/memory.d.ts ====
import { type AgentMemoryIntentReadback, type AgentMemoryIntentV1, type AgentMemoryProjectionMutation } from '@byok-sdk/protocol';
import { HostLedger } from './ledger';
import { type MemoryRestoreInput, type MemoryRestoreResult, type MemoryRestoreRow } from './memory-restore';
import type { AgentMemoryExport, AgentMemoryIntentTransport, AgentMemoryProjectionPort } from '@byok-sdk/protocol/agent-memory';
export declare class MemoryBlockedError extends Error {
}
export declare const RESIDENT_MEMORY_MAX_BYTES: number;
export declare function memoryRevision(text: string): string;
export declare const EMPTY_MEMORY_REVISION: string;
type AgentRef = AgentMemoryIntentV1['agentRef'];
export interface MemoryBinding {
    deviceId: string;
    agentRef: AgentRef;
}
export interface MemoryApproval extends MemoryBinding {
    approvalRef: string;
    path: string;
    operation: 'replace' | 'delete';
    content?: string;
    /** Omit only after the user authorizes the possible absent-or-empty write. */
    baseRevision?: string;
    expiresAt: number;
}
export interface MemoryIntentRow {
    deviceId: string;
    requestHash: string;
    intent: AgentMemoryIntentV1;
    expiresAt: number;
    noticePending: boolean;
    releasedAt?: string;
    revoked?: true;
    readback?: AgentMemoryIntentReadback;
    restoreId?: string;
}
export interface ResidentProjection {
    mutation: AgentMemoryProjectionMutation;
    projectedAt: string;
    text: string | null;
    /** An applied small replacement invalidates this old display, not its ordering metadata. */
    invalidatedByIntent?: string;
    refreshTaskIds?: string[];
}
export interface MemoryState {
    restores?: Record<string, MemoryRestoreRow>;
    intents: Record<string, MemoryIntentRow>;
    approvals: Record<string, string>;
    projections: Record<string, ResidentProjection>;
}
export interface MemoryContextPack {
    residentMemory?: {
        text: string;
        projectedAt: string;
        mutationId: string;
        policyRevision: string;
    };
}
export interface MemoryOptions {
    /** Trusted device-bound local export. Required only for explicit tree restore; never a redacted projection. */
    exportMemory?(binding: MemoryBinding): Promise<AgentMemoryExport>;
    /** Integer milliseconds, as `Date.now` returns. Pass `HostLedger.compact` the same clock. */
    now?: () => number;
    /** Resolve current placement and profile from trusted Host state on each call. */
    isCurrent(binding: MemoryBinding): boolean;
    /** Call the embedded server or cloud capability-gated enqueueAgentMemoryIntentNotice. Retry is safe. */
    notify(deviceId: string, notice: {
        intentId: string;
        agentRef: AgentRef;
    }): Promise<unknown>;
    /** Validate the task, session, runtime, grant, policy and writer epoch before accepting a projection. */
    authorizeProjection(deviceId: string, mutation: AgentMemoryProjectionMutation): boolean;
}
/** Host memory authority over the execution ledger. Public commands require authenticated Host approval. */
export declare class HostMemoryPage {
    readonly ledger: HostLedger;
    private readonly options;
    private readonly listeners;
    onChange(listener: (binding: MemoryBinding) => Promise<void>): () => void;
    private changed;
    private readonly restores;
    private readonly executionLedgers;
    /** Core composition guard: restore must inspect the very same transactional execution state. */
    bindExecutionLedger(ledger: HostLedger): () => void;
    private assertRestoreLedger;
    constructor(ledger: HostLedger, options: MemoryOptions);
    restore(input: MemoryRestoreInput): Promise<MemoryRestoreResult>;
    restoreResult(binding: MemoryBinding, restoreId: string): MemoryRestoreResult | undefined;
    cancelRestore(binding: MemoryBinding, restoreId: string): Promise<MemoryRestoreResult>;
    /** Call before core.recover at Host startup, then flushNotices; same restore identity resumes safely. */
    recoverRestores(): Promise<void>;
    private now;
    intent(intentId: string): MemoryIntentRow | undefined;
    /** This is a write, including when baseRevision is omitted. It is never a read probe. */
    approve(input: MemoryApproval): Promise<MemoryIntentRow>;
    private prepare;
    revoke(intentId: string): void;
    flushNotices(): Promise<void>;
    /** Bind a new core submission to the pending refresh before the SDK can execute it. */
    refreshExecution(binding: MemoryBinding, taskId: string): void;
    /** Bind this adapter to the authenticated device. Do not take identity from a request body. */
    transport(deviceId: string): AgentMemoryIntentTransport;
    private identity;
    private record;
    /** Host-owned opaque profile: {residentMemory: policyApprovedText | null}. It conveys no edit proof. */
    projectionPort(deviceId: string): AgentMemoryProjectionPort;
    contextPack(binding: MemoryBinding): MemoryContextPack;
}
export {};
// ==== @byok-sdk/server dist/execution-core/model.d.ts ====
import type { MemoryState } from './memory';
import { canonical, hash } from './canonical';
import type { AgentExecutionInput } from '@byok-sdk/cloud';
import type { ByokServer } from '../index';
import type { WakeScheduleInput } from '../wakes/types';
import { type AgentMessageServerContext, type TaskOfferSealedPayload } from '@byok-sdk/protocol';
export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export type ExecutionTemplate = Omit<AgentExecutionInput, 'taskId'>;
/**
 * The input of the cloud's `submitSealedAgentExecution` (#654): a fresh sealed `task.offer` payload
 * with its terminal projection. A routine template rides in `sealed`, with its plaintext `routineRef`.
 */
export interface SealedAgentExecutionInput {
    taskId: string;
    deviceId: string;
    payload: TaskOfferSealedPayload & {
        session: {
            mode: 'fresh';
        };
        terminalProjection: NonNullable<TaskOfferSealedPayload['terminalProjection']>;
    };
    agentMessageContext?: AgentMessageServerContext;
}
export type SealedExecutionTemplate = Omit<SealedAgentExecutionInput, 'taskId'>;
/** What an intent runs: a plain execution, or a sealed one whose task input only a member and the device can read. */
export type IntentExecution = ExecutionTemplate | SealedExecutionTemplate;
export type FrozenExecutionInput = AgentExecutionInput | SealedAgentExecutionInput;
/** A sealed execution carries the task's `sealing`; a plain one never does (the cloud's plain lane refuses it). */
export declare function isSealed<T extends {
    payload: object;
}>(execution: T): execution is Extract<T, {
    payload: {
        sealing: unknown;
    };
}>;
export type Terminal = NonNullable<Awaited<ReturnType<ByokServer['tasks']['deviceTerminal']>>>;
export type Attempt = NonNullable<Awaited<ReturnType<ByokServer['tasks']['attempt']>>>;
export type Conclusion = 'succeeded' | 'failed' | 'declined' | 'cancelled' | 'expired' | 'superseded';
export interface RetryPolicy {
    maxAttempts: number;
    delaysMs: number[];
    retryFailures: boolean;
}
export declare const DEFAULT_RETRY: RetryPolicy;
export interface IntentInput {
    key: string;
    source: 'user' | 'bot' | 'routine';
    execution: ExecutionTemplate;
    waitUntil: number;
    retry?: RetryPolicy;
}
/** An intent as the ledger takes it: a routine occurrence may also run a sealed template. */
export type LedgerIntentInput = Omit<IntentInput, 'execution'> & {
    execution: IntentExecution;
};
export interface Intent extends LedgerIntentInput {
    id: string;
    agent: string;
    sequence: number;
    retry: RetryPolicy;
    phase: 'queued' | 'inflight' | 'backoff' | 'memory_blocked' | 'settled';
    memoryBlocked?: {
        resume: 'queued' | 'backoff';
        reason: string;
    };
    preparationError?: string;
    generation: number;
    taskId: string;
    notBefore: number;
    attempts: number;
    occurrence?: string;
    retryUntil?: number;
    cancelReason?: 'expired' | 'cancelled';
    conclusion?: Conclusion;
}
export interface Execution {
    input: FrozenExecutionInput;
    submission: 'reserved' | 'uncertain' | 'delivered';
    started: boolean;
    /** At most one acceptance per execution; retained/compacted with its execution. */
    messageReceipt?: {
        messageId: string;
        contentHash: string;
    };
    attempt?: Attempt;
    terminal?: Terminal;
}
interface RoutineSchedule {
    id: string;
    version: number;
    timeZone: string;
    rule: Json;
    waitMs: number;
    lateAfterMs: number;
    retry?: RetryPolicy;
    endAt?: number;
}
export interface HostJobSpec {
    type: string;
    input: Json;
}
export type AgentRoutineDefinition = RoutineSchedule & {
    execution: IntentExecution;
    hostJob?: never;
    hostOccurrence?: never;
};
export type HostJobRoutineDefinition = RoutineSchedule & {
    hostJob: HostJobSpec;
    execution?: never;
    hostOccurrence?: never;
};
/** The registered occurrence hook `type` runs in the occurrence commit. The Host later promotes or concludes the occurrence. */
export type HostOccurrenceRoutineDefinition = RoutineSchedule & {
    hostOccurrence: {
        type: string;
        input: Json;
    };
    execution?: never;
    hostJob?: never;
};
export type RoutineDefinition = AgentRoutineDefinition | HostJobRoutineDefinition | HostOccurrenceRoutineDefinition;
export interface HostJobRun {
    type: string;
    input: Json;
    occurrenceKey: string;
    routineId: string;
    definitionVersion: number;
    trigger: Occurrence['trigger'];
    attempt: number;
    signal: AbortSignal;
}
export interface HostJobResult {
    summary: Json;
    execution?: ExecutionTemplate;
}
export type HostJobHandler = (run: HostJobRun) => HostJobResult | Promise<HostJobResult>;
export type HostOccurrenceRun = Omit<HostJobRun, 'attempt' | 'signal'>;
export interface Routine {
    definition: RoutineDefinition;
    /** The next version from `updateRoutine`. It replaces `definition` when `versionSwitchDue` is true. */
    pending?: RoutineDefinition;
    lifecycle: 'active' | 'paused' | 'completed';
    status: 'ok' | 'schedule_retrying' | 'no_occurrence_within_horizon' | 'calendar_error';
    next: WakeScheduleInput | null;
    scheduleRetryAt?: number;
    scheduleRetryCount?: number;
    /** Last SDK schedule rejection. Retained after recovery. */
    lastError?: {
        code: string;
        message: string;
    };
    calendarErrors?: Array<{
        at: number;
        wakeKey?: string;
        message: string;
    }>;
}
export interface Occurrence {
    key: string;
    routineId: string;
    definitionVersion: number;
    trigger: {
        kind: 'scheduled' | 'catch_up';
        plannedAt: number;
    };
    wakeKey: string;
    recordedAt: number;
    nextAt: number | null;
    intentId?: string;
    job?: {
        attempts: number;
        summary?: Json;
        executionSuperseded?: true;
    };
    /** A `hostOccurrence` occurrence. It stays unsettled until the Host promotes or concludes it. */
    hook?: {
        executionSuperseded?: true;
    };
    attempts: number;
    conclusion?: Conclusion;
    slotReplayCount?: number;
}
export type Outbox = {
    kind: 'host-job';
    occurrenceKey: string;
    lastError?: string;
} | {
    kind: 'intent';
    intentId: string;
    lastError?: string;
} | {
    kind: 'schedule';
    input: WakeScheduleInput;
    lastError?: string;
} | {
    kind: 'cancel-wake';
    key: string;
    lastError?: string;
} | {
    kind: 'projection';
    id: string;
    value: Json;
    lastError?: string;
};
export interface IgnoredWakeAudit {
    at: number;
    reason: 'unknown_key' | 'stale_scan' | 'missing_routine' | 'inactive_routine' | 'reservation_mismatch';
    /** SHA-256 of canonical(dedupKey); raw keys, IDs and payloads are not retained. */
    wakeKeyHash: string;
}
export interface LedgerState {
    version: 1;
    sequence: number;
    scanSequence: number;
    memory?: MemoryState;
    /** Bounded diagnostic history; absent until the first ignored delivery. */
    ignoredWakes?: IgnoredWakeAudit[];
    intents: Record<string, Intent>;
    executions: Record<string, Execution>;
    routines: Record<string, Routine>;
    occurrences: Record<string, Occurrence>;
    slots: Record<string, string>;
    outbox: Record<string, Outbox>;
    applied: Record<string, true>;
    application: Record<string, Json>;
    scanWake: WakeScheduleInput | null;
}
export { canonical, hash };
export declare function taskId(key: string, generation: number): string;
/** The frozen execution input of one generation of an intent: its execution with that generation's task id. */
export declare function frozenInput(execution: IntentExecution, task: string): FrozenExecutionInput;
/** The intent key of a routine occurrence, from its occurrence key (a SHA-256 hex digest). */
export declare function occurrenceIntentKey(occurrenceKey: string): string;
/** Whether an intent key is a routine occurrence's. Any other key is the Host's own. */
export declare function isOccurrenceIntentKey(key: string): boolean;
/** The occurrence key that a routine occurrence's intent key names, or undefined for any other key. */
export declare function occurrenceOfIntentKey(key: string): string | undefined;
export declare function time(value: number): number;
/** Reject values that would change meaning when the ledger serializes them. */
export declare function validateJson(value: unknown, ancestors?: Set<object>): asserts value is Json;
export declare function validateInput(input: LedgerIntentInput): void;
export declare function validateRetry(retry: RetryPolicy): void;
export declare function project(state: LedgerState, id: string, value: Json): void;
// ==== @byok-sdk/server dist/execution-core/routines.d.ts ====
import { type DueWake, type WakeScheduleInput } from '../wakes/types';
import { type Conclusion, type HostOccurrenceRun, type IntentExecution, type IgnoredWakeAudit, type Intent, type LedgerState, type Occurrence, type Routine, type RoutineDefinition } from './model';
import { type NextOccurrence } from './schedule';
export declare const WAKE_HORIZON_MS: number;
/** Retain the newest ignored deliveries without growing the Host JSON ledger indefinitely. */
export declare const IGNORED_WAKE_AUDIT_LIMIT = 128;
export declare function auditIgnoredWake(state: LedgerState, wake: DueWake, now: number, reason: IgnoredWakeAudit['reason']): void;
interface WakePlan {
    next: WakeScheduleInput | null;
    status: Routine['status'];
    completed: boolean;
}
/** The SDK wake dedup key of a routine slot. `parseRoutineWakeKey` reads it back. */
export declare function routineWakeKey(id: string, version: number, at: number): string;
export declare function parseRoutineWakeKey(key: string): {
    id: string;
    version: number;
    at: number;
} | undefined;
export declare function nextWake(definition: RoutineDefinition, after: number, nextTime: NextOccurrence, now: number): WakePlan;
export declare function deferSchedule(state: LedgerState, routine: Routine, now: number): void;
export declare function scheduleNext(state: LedgerState, routine: Routine, now: number): void;
export declare function auditCalendarError(routine: Routine, now: number, error: unknown, wakeKey?: string): void;
export declare function applyPlan(state: LedgerState, routine: Routine, plan: WakePlan, now: number): void;
/**
 * The Host time, and the registered handlers a definition may name: Host job types and occurrence hook types, each mapped to its
 * function. `executionRoutines: 'refuse'` refuses an `execution` definition, for a Host with no owner for its occurrence intent.
 */
export interface RoutineValidation {
    now: number;
    hostJobs: ReadonlyMap<string, unknown>;
    occurrenceHooks: ReadonlyMap<string, unknown>;
    executionRoutines?: 'allow' | 'refuse';
}
/** Refuses a routine definition that the Host cannot run at `now`. Pure: it reads no ledger. */
export declare function validateRoutineDefinition(definition: RoutineDefinition, { now, hostJobs, occurrenceHooks, executionRoutines }: RoutineValidation): void;
/** Routine commands in the caller's transaction. A refused command throws before it changes any state. */
export interface RoutineCommands {
    /** The rules of `addRoutine`. */
    create(definition: RoutineDefinition): void;
    /** The rules of `updateRoutine`. */
    update(definition: RoutineDefinition): void;
    /** The rules of `lifecycle()`. */
    lifecycle(id: string, lifecycle: Routine['lifecycle']): void;
    /** Copies of the routine rows, including changes earlier in this transaction. */
    list(): Routine[];
}
/** The inputs of `routineCommands`: the Host clock and calendar, and the registered handlers a definition may name. */
export interface RoutineCommandOptions extends Omit<RoutineValidation, 'now'> {
    now: () => number;
    nextTime: NextOccurrence;
}
/** The one path for routine commands. Each command validates and plans before it writes, so a caught refusal changes nothing. */
export declare function routineCommands(state: LedgerState, options: RoutineCommandOptions): RoutineCommands;
/** Creates a validated routine. The same definition is idempotent; another definition for the ID throws before any change. */
export declare function createRoutine(state: LedgerState, definition: RoutineDefinition, now: number, nextTime: NextOccurrence): void;
/** A staged version replaces the definition only when no older work can still use it. Pure: it reads no ledger. */
export declare function versionSwitchDue(routine: Readonly<Routine>, occurrences: Iterable<Readonly<Occurrence>>, now: number): boolean;
export declare function switchVersion(state: LedgerState, routine: Routine, now: number, nextTime: NextOccurrence): void;
/** Stages the next version of a validated definition. The Host service assigns versions and keeps their history. */
export declare function stageVersion(state: LedgerState, definition: RoutineDefinition, now: number, nextTime: NextOccurrence): void;
/**
 * Called inside the same transaction that creates the occurrence and its work.
 * Returns the new occurrence; a replay or an ignored wake returns undefined.
 */
export declare function recordOccurrence(state: LedgerState, tenant: string, wake: DueWake, now: number, nextTime: NextOccurrence): Occurrence | undefined;
/** A Host decision joins the existing FIFO atomically. The deadline counts from occurrence admission. */
export declare function promote(state: LedgerState, tenant: string, occurrence: Occurrence, execution: IntentExecution): Intent;
/** The hook input of a `hostOccurrence` occurrence of `routine`. Each call returns fresh copies. */
export declare function occurrenceRun(routine: Readonly<Routine>, occurrence: Readonly<Occurrence>): HostOccurrenceRun;
/**
 * Promotes an open `hostOccurrence` occurrence into the FIFO as intent `occurrence:<key>`.
 * Call it inside `ledger.transaction`, then `drain()`. A newer slot makes the intent settle as superseded at once.
 */
export declare function promoteOccurrence(state: LedgerState, tenant: string, occurrenceKey: string, execution: IntentExecution): Intent;
/** Settles an open `hostOccurrence` occurrence that needs no execution. Call it inside `ledger.transaction`, then `drain()`. */
export declare function concludeOccurrence(state: LedgerState, occurrenceKey: string, conclusion: Conclusion): void;
export declare function setLifecycle(state: LedgerState, id: string, lifecycle: Routine['lifecycle'], now: number, nextTime: NextOccurrence): void;
export {};
// ==== @byok-sdk/server dist/execution-core/schedule.d.ts ====
import { type RoutineDefinition } from './model';
/** The Host can inject its shared cron/time-zone calendar. K4 does not define a cron dialect. */
export type NextOccurrence = (definition: Readonly<RoutineDefinition>, after: number) => number | null;
/** Default example rule: { anchorMs, everyMs, quietHours?: { startMinute, endMinute } }, UTC. */
export declare const nextIntervalOccurrence: NextOccurrence;
// ==== @byok-sdk/server dist/execution-core/sealed-routine.d.ts ====
/**
 * The member side of a sealed routine (#654 E3d-4, design §6.3). A member seals one routine template for one routine
 * version; the Host stores it and puts it, byte for byte, in the `sealed` member of each occurrence's offer, next to the
 * plaintext `routineRef`. The Host never sees the scope key or the instruction.
 */
import { type SealedBinding, type SealedCategory } from '@byok-sdk/core/sealed-payload';
import { type AgentRef, type TaskSealing } from '@byok-sdk/protocol';
import type { SealedExecutionTemplate } from './model';
export type RoutineRef = NonNullable<SealedExecutionTemplate['payload']['routineRef']>;
/** The inline `sealed` member of a sealed offer. */
export type SealedTaskInput = NonNullable<SealedExecutionTemplate['payload']['sealed']>;
/**
 * The binding of a routine template: the routine version in place of a task, no device, and the expiry. The device
 * rebuilds the same binding from the offer's `routineRef`, `agentRef` and `sealing.categories`, so another routine,
 * version, Agent, expiry or category list fails the AEAD. Core exports no binding helper (owner decision 46c); the
 * golden routine lines pin this one.
 */
export declare function routineTemplateBinding(tenantId: string, routineRef: RoutineRef, agentRef: AgentRef, categories: readonly SealedCategory[]): SealedBinding;
export interface SealRoutineTemplateInput {
    /** The Host tenant the device's offer comes from. */
    readonly tenantId: string;
    readonly scopeKey: Uint8Array;
    /** The task sealing the offer will carry. Its epoch is the template's epoch. */
    readonly sealing: TaskSealing;
    /** The member chain head the member verified before sealing, and the member's id. */
    readonly chainHead: {
        readonly seq: number;
        readonly hash: string;
    };
    readonly sender: string;
    readonly routineRef: RoutineRef;
    readonly agentRef: AgentRef;
    readonly instruction: string;
}
/**
 * Seals one routine template, inline. A template above the inline limit throws: between occurrences no task holds a
 * ciphertext blob, so orphan GC could delete it. Seal once and keep the result: a retry must resend these bytes.
 */
export declare function sealRoutineTemplate(input: SealRoutineTemplateInput): Promise<SealedTaskInput>;
// ==== @byok-sdk/server dist/execution-core/submit.d.ts ====
import type { AgentExecutionInput } from '@byok-sdk/cloud';
import type { ByokServer } from '../index';
import { type FrozenExecutionInput, type SealedAgentExecutionInput } from './model';
/**
 * The SDK calls that one frozen submit uses. L binds them to its `ByokServer`; H binds them to its cloud tenant.
 * `submitSealed` is the cloud's `submitSealedAgentExecution`. A port without it cannot dispatch a sealed input.
 */
export interface FrozenSubmitPort {
    submit: ByokServer['executions']['submit'];
    submitSealed?: (input: SealedAgentExecutionInput) => ReturnType<ByokServer['executions']['submit']>;
    offer: ByokServer['tasks']['offer'];
}
/** A plain frozen input. The frozen-submit functions also take a sealed one (`FrozenExecutionInput`). */
export type FrozenInput = AgentExecutionInput;
export type FrozenOffer = NonNullable<Awaited<ReturnType<FrozenSubmitPort['offer']>>>;
/**
 * The recorded offer is the frozen input: the same task, device, offer type and canonical payload. The plain and the
 * sealed lane share the `task.offer` type. A plain offer never
 * matches a sealed input, nor the reverse: the sealed payload carries `sealing`, the plain one does not. The Host resubmits its frozen bytes, so a sealed payload compares exactly.
 */
export declare function sameFrozenOffer(offer: FrozenOffer, input: FrozenExecutionInput): boolean;
/** The recorded offer of the task is not the frozen input. The submit must stop, and an operator must look at it. */
export declare class FrozenOfferMismatchError extends Error {
    readonly code = "frozen_offer_mismatch";
    constructor();
}
/** The input is sealed and the port has no sealed lane (`submitSealed`). Nothing was submitted. */
export declare class SealedDispatchUnavailableError extends Error {
    readonly code = "sealed_dispatch_unavailable";
    constructor();
}
/** Reads the offer of the frozen task back. A different recorded offer throws `FrozenOfferMismatchError`; `delivered: false` is not a proof of no append. */
export declare function frozenDelivered(port: Pick<FrozenSubmitPort, 'offer'>, input: FrozenExecutionInput): Promise<boolean>;
/**
 * Submits one frozen input under its own task id. It reads back first. `beforeSubmit` runs only when the readback
 * is not delivered, and returns false to stop with no submit (for example at `waitUntil`). After a throw, only a
 * delivered readback counts; otherwise the error is thrown again and the submit stays uncertain. A sealed input on a
 * port without `submitSealed` throws `SealedDispatchUnavailableError` before the readback.
 */
export declare function submitFrozen(port: FrozenSubmitPort, input: FrozenExecutionInput, beforeSubmit: () => boolean | Promise<boolean>): Promise<'delivered' | 'stopped'>;
// ==== @byok-sdk/server dist/execution-core/transitions.d.ts ====
import { type Conclusion, type Intent, type IntentExecution, type IntentInput, type LedgerIntentInput, type LedgerState } from './model';
/**
 * Enqueues a plain intent. A sealed execution enters the ledger only as an occurrence of its routine (`admit`), whose
 * stored definition pins the `routineRef`: here no routine is checked, so `source: 'routine'` would be only a label.
 */
export declare function enqueue(state: LedgerState, tenant: string, input: IntentInput): Intent;
/** Writes one intent. Only the routine transitions admit a sealed execution, after they check its `routineRef`. */
export declare function admit(state: LedgerState, tenant: string, input: LedgerIntentInput): Intent;
/** The FIFO key of an intent: one queue per tenant, device and Agent. */
export declare function agentKey(tenant: string, execution: Pick<IntentExecution, 'deviceId' | 'payload'>): string;
/** The head of each agent queue: the open intent with the lowest `sequence`. Settled intents must not be passed. */
export declare function fifoHeads<T extends Pick<Intent, 'agent' | 'sequence'>>(open: Iterable<T>): T[];
/** The conclusion of an intent that has no submit in flight (queued, memory-blocked or in backoff), or nothing while it can still start. */
export declare function queuedExpiry(intent: Pick<Intent, 'cancelReason' | 'waitUntil' | 'retryUntil'>, now: number): Conclusion | undefined;
export declare function settle(state: LedgerState, intent: Intent, conclusion: Conclusion): void;
export declare function cancelWake(state: LedgerState, key: string): void;
// ==== @byok-sdk/server dist/index.d.ts ====
export { listenLoopback } from './loopback';
export type { LoopbackPortStore, LoopbackHandler, LoopbackListenerOptions, LoopbackListener } from './loopback';
import type { AgentMessageDraftEvent } from './types';
export type { AgentMessageDraftEvent } from './types';
import type { WakeRecord, WakeScheduleInput, WakeScheduleResult } from './wakes/types';
export { WakeHookMissingError, WakeConflictError, WakeInputError, WakeClosedError, WAKE_MAX_FUTURE_MS } from './wakes/types';
export type { DueWake, WakeRecord, WakeScheduleInput, WakeScheduleResult, WakeConsumer, WakeInputErrorCode } from './wakes/types';
import { type MaintenanceReport } from '@byok-sdk/cloud';
export type { AgentExecutionInput } from '@byok-sdk/cloud';
import { Hono } from 'hono';
import { type AgentExecutionInput, type AgentMemoryIntentNoticeInput, type EnqueuedAgentControl, type EnqueuedOffer, type PairingCodeInfo, type TaskAttempt } from '@byok-sdk/cloud';
import { type AgentRef, type AgentMessagePublishPayload, type AgentMessageDispositionPayload } from '@byok-sdk/protocol';
import type { ByokServerEvent, AgentContentReadRequest, AgentHomeProjectionRequest, AgentHomeProjectionStatusReadback, AgentEgressReceipt, CreateByokServerOptions, DispatchInput, HubStats, MachineInfo, TaskEventEntry, TaskHandle, TaskSnapshot } from './types';
export type { ByokServerEvent, AgentContentReadRequest, AgentHomeProjectionRequest, AgentHomeProjectionStatusReadback, AgentEgressReceipt, ByokServerStorage, AgentResumeDispatchInput, CreateByokServerOptions, DispatchInput, HubStats, MachineInfo, ServerTaskEvent, TaskEventEntry, TaskHandle, TaskResult, TaskSnapshot, } from './types';
export { TaskEventsUnavailableError } from './types';
export type { InboundRefusalReason, TaskOfferReadback } from '@byok-sdk/cloud';
/**
 * M5 (approval targeting, docs/protocol.md §5.3): `TaskHandle.approve`/`reject`'s
 * `opts.approvalId` targeting throws this when the id names an approval the
 * task has already superseded, so a caller needs it to `instanceof`-check and
 * inspect the two ids. Re-exported from `@byok-sdk/cloud`, which owns the gate
 * both the embedded and the hosted surface are decided by — one class, one
 * `instanceof` that works across both.
 */
export { StaleApprovalError } from '@byok-sdk/cloud';
/**
 * S0 (GAP-002): `TaskHandle.steer` throws this when the runtime that claimed
 * the task cannot be steered, when the task isn't running, or when it's already
 * terminal. The GATE is the kernel's — it reads the claim-time capability
 * snapshot and nothing else — and so is the `code`. The CLASS is this
 * package's, because it carries `state: TaskState`, the wire vocabulary this
 * surface speaks and the kernel deliberately has no field for. See
 * `task-handle.ts` for the full reasoning and for why `SteerRejectionCode` and
 * {@link StaleApprovalError} stay kernel re-exports.
 */
export { SteerRejectedError } from './task-handle';
export type { SteerRejectionCode } from '@byok-sdk/cloud';
/**
 * Auth v2 types an embedder needs to talk about devices and tokens. All owned
 * by `@byok-sdk/cloud` now — this package no longer has an auth plane of its
 * own to keep in agreement with one.
 */
export type { AccessTokenClaims, DeviceRecord, PairingCodeInfo, TenantId, TokenSigner } from '@byok-sdk/cloud';
export { createHmacTokenSigner } from '@byok-sdk/cloud';
export { SqliteOwnershipError, SqliteSchemaError, SqliteUnavailableError } from './sqlite-support';
export type { SqliteSchemaErrorCode } from './sqlite-support';
export { inspectSqliteStore } from './store-compatibility';
export type { RateLimiterOptions } from './rate-limiter';
export { DEFAULT_TASK_EVENT_BUFFER_LIMIT, DEFAULT_TASK_EVENT_RETENTION_MS } from './relay';
/** Page size `tasks.list()` uses when the caller names none. */
export declare const DEFAULT_TASK_PAGE_LIMIT = 100;
/** Input to {@link ByokServer.pairing.createPairingCode}. */
export interface CreatePairingCodeInput {
    /**
     * The product the redeeming device pairs into. Must be this instance's own
     * `productId`: an embedded server serves exactly one product, and a code for
     * some other product would mint a device every bearer-authed route then
     * refuses (`instanceProductId`, `@byok-sdk/cloud`). Fail closed rather than
     * silently issuing an unusable code.
     *
     * The TENANT is not a parameter: it is derived from `productId` once, at
     * construction (`serverTenantId`, `stores.ts`), because this surface has no
     * second tenant to name.
     */
    readonly productId: string;
    /** Overrides the default single-use code lifetime. */
    readonly ttlMs?: number;
}
/** One bounded page of this server's tasks. */
export interface TaskPage {
    readonly tasks: readonly TaskSnapshot[];
    /**
     * Pass as the next call's `cursor`. ABSENT means the walk is over — a caller
     * stops on absence, not on an empty page, so a page that exactly fills
     * `limit` with nothing after it still terminates.
     */
    readonly nextCursor?: string;
}
/** Query for {@link ByokServer.tasks.list}. */
export interface TaskListQuery {
    /** Maximum snapshots in the page. Defaults to {@link DEFAULT_TASK_PAGE_LIMIT}. */
    readonly limit?: number;
    /** The `nextCursor` from the previous page; absent starts at the beginning. */
    readonly cursor?: string;
}
/** The object `createByokServer` returns — the SaaS-embedder-facing surface. */
export interface ByokServer {
    readonly wakes: {
        schedule(input: WakeScheduleInput): Promise<WakeScheduleResult>;
        /** Deletes only queued wakes. False for an in-flight wake means it was not cancelled; a rejection/deadline still retries it. */
        cancel(dedupKey: string): Promise<boolean>;
        /** Unfinished wakes, ordered by availableAt then wakeId. */
        pending(): Promise<readonly WakeRecord[]>;
    };
    /** Hono app exposing every device route, plus the opt-in `/healthz`. Mount it, or use its `.fetch` with `@hono/node-server`. */
    hono: Hono;
    pairing: {
        /** Mint a single-use pairing code for this server's product and tenant (docs/protocol.md §6.1). */
        createPairingCode(input: CreatePairingCodeInput): Promise<PairingCodeInfo>;
    };
    /** Submit one fresh Agent execution: persist the input first; a delivered taskId conflicts (`agent_task_already_exists`), recover via `tasks.offer`. */
    readonly executions: {
        /** Persist input before submitting; use tasks.offer for exact recovery after a conflict. */
        submit(input: AgentExecutionInput): Promise<EnqueuedOffer>;
    };
    dispatch(input: DispatchInput): Promise<TaskHandle>;
    /** Enqueue one capability-gated, exact-identity content-read request. */
    requestAgentContentRead(input: AgentContentReadRequest): Promise<void>;
    /** Enqueue one task-free, exact-device Agent-home projection. */
    enqueueAgentHomeProjection(input: AgentHomeProjectionRequest): Promise<AgentHomeProjectionStatusReadback>;
    /** Enqueue a content-free, capability-gated memory intent notice for this server's tenant. Approval and completion remain Host-owned. */
    enqueueAgentMemoryIntentNotice(deviceId: string, input: AgentMemoryIntentNoticeInput): Promise<EnqueuedAgentControl>;
    /** Durable desired-state and terminal-outcome readback for one exact device-and-Agent request. */
    readAgentHomeProjection(deviceId: string, agentRef: AgentRef, requestId: string): Promise<AgentHomeProjectionStatusReadback | undefined>;
    /** Wait without polling for durable terminal readback. Unknown requests return undefined; abort or server close rejects. */
    awaitAgentHomeProjection(deviceId: string, agentRef: AgentRef, requestId: string, options?: {
        signal?: AbortSignal;
    }): Promise<AgentHomeProjectionStatusReadback | undefined>;
    tasks: {
        /** Canonical durable attempt, including cancellation intent; not a resource-release observation. */
        attempt(taskId: string): Promise<TaskAttempt | undefined>;
        get(taskId: string): Promise<TaskSnapshot | undefined>;
        /** Actual device terminal, independently of Host cancellation or home release. */
        deviceTerminal(taskId: string): Promise<import('@byok-sdk/cloud').DeviceTerminal | undefined>;
        /** Immutable kernel offer readback for verifying a persisted host binding. No transport seq is inferred. */
        offer(taskId: string): Promise<import('@byok-sdk/cloud').TaskOfferReadback | undefined>;
        /** Stream display-only suffixes through the frozen Agent binding. */
        messageDraft(taskId: string, deviceId: string, agentRef: AgentRef, options?: {
            after?: import('@byok-sdk/cloud').AgentMessageDraftCursor;
            signal?: AbortSignal;
        }): AsyncIterable<AgentMessageDraftEvent>;
        /** Discover the unique message and its pending/final disposition through the frozen Agent binding. */
        agentMessage(taskId: string, deviceId: string, agentRef: AgentRef): Promise<import('@byok-sdk/cloud').TaskAgentMessage | undefined>;
        /** Exact SDK message decision; pending is undefined and corrupt persisted evidence throws. */
        messageDisposition(taskId: string, deviceId: string, payload: AgentMessagePublishPayload): Promise<AgentMessageDispositionPayload | undefined>;
        /** Request cancellation through the kernel without a process-owned TaskHandle. */
        cancel(taskId: string, reason?: string): Promise<void>;
        /** Settle a task no device will finish through the kernel (`ByokCloud.abandonTask`), without a process-owned TaskHandle. */
        abandon(taskId: string, cause: import('@byok-sdk/cloud').TaskAbandonCause): Promise<void>;
        /**
         * Approve the task's pending approval without a process-owned TaskHandle,
         * such as a task `executions.submit` created. The same decision and
         * refusals as {@link TaskHandle.approve}.
         */
        approve(taskId: string, opts?: {
            approvalId?: string;
        }): Promise<void>;
        /** Reject the task's pending approval; the same decision and refusals as {@link TaskHandle.reject}. */
        reject(taskId: string, reason?: string, opts?: {
            approvalId?: string;
        }): Promise<void>;
        /**
         * Follow one task's notifications (state, Agent progress, artifacts,
         * approval requests) in this instance's arrival order. It starts after the
         * entry `after` names; with `from: 'state'`, at the entries where the
         * task's current state began (its latest `state` entry, preceded by the
         * pending `await_approval` request while it awaits approval), which are
         * kept even after the buffer dropped them; otherwise at the start of what
         * is retained. An `events_truncated` entry stands for entries dropped
         * before the reader reached them. Ends after the terminal state, when
         * `signal` aborts, or when the server closes. A notification stream, not a
         * record: read task facts with {@link tasks.get}.
         *
         * A live task this instance did not dispatch (after a restart) gets a feed
         * that starts with its current state read back from the stores, after the
         * pending approval request while it awaits a plaintext one, and no earlier
         * events. Those entries can appear twice when the read saw a commit the
         * feed had not received yet. Once attached, the feed stays until the
         * task's terminal plus `taskEventRetentionMs` however its readers leave,
         * so a reconnecting reader resumes with its cursor, unless the read that
         * attached it finds the task gone or finished; a read stopped before its
         * first store read completed attaches nothing.
         *
         * The first `next()` throws, before any entry: a `TypeError` when both
         * `after` and `from` are given, `ByokCloudError` `task_not_found` for an
         * unknown task, or {@link TaskEventsUnavailableError} when `after` is
         * unknown to this instance's feed or the terminal task's feed is no longer
         * retained.
         */
        events(taskId: string, options?: {
            after?: string;
            from?: 'state';
            signal?: AbortSignal;
        }): AsyncIterable<TaskEventEntry>;
        /**
         * One bounded page, keyset-paged by task id. Paged rather than "all of
         * them" because the underlying store is: an unbounded `list()` would have
         * to walk every page internally and hand back a snapshot that was never
         * consistent at any single instant.
         */
        list(query?: TaskListQuery): Promise<TaskPage>;
    };
    /** Trusted embedder access to committed blob download grants. */
    blobs: {
        getDownloadUrl(blobId: string): Promise<string | undefined>;
    };
    /** Reliable Agent egress receipt readback. */
    egress: {
        get(deviceId: string, agentRef: AgentRef, eventId: string): Promise<AgentEgressReceipt | undefined>;
    };
    machines: {
        list(): Promise<MachineInfo[]>;
    };
    events: {
        subscribe(): AsyncIterable<ByokServerEvent>;
    };
    /**
     * Device revocation (§6.3) — server-side only, no wire message. Revoking a
     * device DELETES its registration, so its next `/byok/challenge`,
     * `/byok/token`, or authed HTTP call gets a 401 — the same answer as for a
     * device id that was never registered — and its only recourse is to re-run
     * `/byok/pair`. The device-scoped state the row owned (outstanding challenge
     * nonces, presence, inbound dedup) is deleted with it; what the device DID
     * (tasks, receipts) is history and survives.
     *
     * DEVICE-ID ONLY. The hosted control plane's own revocation is tenant-first
     * (a tenant may only revoke a device it owns), but an embedded server owns
     * exactly ONE tenant and binds it here itself: `TenantId` is a branded type an
     * embedder cannot mint, and nothing on this surface — `ByokServer`,
     * `MachineInfo`, `PairingCodeInfo` — hands one back, so a tenant-first
     * parameter would make this method uncallable from outside the package rather
     * than safer. The scoping it provided is unchanged, just not the caller's to
     * state: a device id this server does not know resolves to nothing and is a
     * silent no-op.
     */
    devices: {
        revoke(deviceId: string): Promise<void>;
    };
    maintenance: {
        runNow(): Promise<MaintenanceReport>;
    };
    /**
     * Release what this instance holds: the relay's per-task feeds and their
     * reclamation timers, and the connection observations. Call it on shutdown so
     * nothing keeps the process alive or leaks a handle in tests; safe to call
     * more than once. Drain pending store calls before releasing the selected
     * storage authority; await this before opening the SQLite file again.
     */
    close(): Promise<void>;
    /**
     * A plain, serializable snapshot of this server's current state. See
     * {@link HubStats} for the field-by-field contract.
     *
     * One store aggregate, an active-attempt page walk, then one approval read
     * per active attempt. No process-local task counts or startup history scan.
     * This is a multi-read observation, not a transaction snapshot; see HubStats.
     *
     * Deliberately in-process only: never exposed over HTTP by this SDK itself (see
     * `CreateByokServerOptions.healthzRoute`); an embedder that wants any of it
     * surfaced remotely builds its own authenticated route around this method.
     */
    stats(): Promise<HubStats>;
}
/**
 * Embedded reference coordinator: a thin façade over `@byok-sdk/cloud`'s
 * kernel, composed against the explicitly selected embedded stores.
 *
 * What that means concretely — and it is the whole point of WP3B — is that this
 * package owns NO coordination semantics any more. Pairing, tokens, the inbound
 * gate, task ownership, first-terminal-wins, approvals, steering, cancellation,
 * long-poll redelivery and the `cursor_too_old` floor are all the kernel's, and
 * a device cannot tell this from a hosted deployment. What is left here is the
 * embedded shape: one product, one tenant, a `TaskHandle` for hosts that want
 * one, an in-process notification relay, and the observability an embedder used
 * to get from the hub.
 *
 * State is in-memory by default. Explicit SQLite mode persists approval timelines, request receipts, the device directory and six
 * coordination interfaces whose contracts cross a process restart; all other
 * ports remain process-local.
 */
export declare function createByokServer(opts: CreateByokServerOptions): ByokServer;
// ==== @byok-sdk/server dist/loopback.d.ts ====
/** Durable, identity-scoped, immutable port assignment. Implement claim atomically. */
export interface LoopbackPortStore {
    /** null means a genuinely new identity; corrupt or missing existing state must throw. */
    read(): Promise<number | null>;
    /** Insert candidate only if absent, then return the durable winning port. Never overwrite. */
    claim(candidate: number): Promise<number>;
}
export type LoopbackHandler = (request: Request) => Response | Promise<Response>;
export interface LoopbackListenerOptions {
    portStore: LoopbackPortStore;
    /** Called after binding and durable readback. URL is trusted configuration, never request input. */
    createHandler(serverUrl: string): LoopbackHandler | Promise<LoopbackHandler>;
    /** Defaults to [24000, 32768). Applies only to new identities. */
    portRange?: {
        min: number;
        maxExclusive: number;
    };
    /** Maximum actual request bytes, including chunked uploads. Default 2 MiB. */
    maxBodyBytes?: number;
    /**
     * Exact loopback browser origins (http or https; localhost, 127.0.0.1 or [::1]) admitted with CORS.
     * Default none: every Origin is refused. Never grants credentials; Cookie stays refused.
     */
    allowedOrigins?: readonly string[];
    signal?: AbortSignal;
}
export interface LoopbackListener {
    readonly serverUrl: string;
    /** Closes only this listener and its connections, not the SDK or persisted assignment. */
    close(): Promise<void>;
}
/** Own a loopback socket before committing an identity's immutable URL. Never adopts another process's listener. */
export declare function listenLoopback(options: LoopbackListenerOptions): Promise<LoopbackListener>;
// ==== @byok-sdk/server dist/rate-limiter.d.ts ====
/**
 * M4 Phase 4 (part A): per-key token bucket that rate-limits each device's
 * inbound envelopes and authenticated route requests (one shared budget).
 * `stores.ts` composes it into the cloud kernel, which debits it at device
 * route admission (a message batch is charged per envelope). The bucket itself is
 * framework-agnostic on purpose (only the adapter below names the cloud port)
 * so it stays unit-testable in isolation, mirroring `event-queue.ts`'s own
 * transport-agnostic split.
 *
 * Token bucket, not a fixed window: `burst` tokens are available immediately
 * (accommodating a legitimate short spike — e.g. a reconnect's redelivery
 * catch-up), refilling continuously at `messagesPerSecond` tokens/sec up to
 * that same `burst` ceiling. A bucket is created lazily per key on first use
 * and persists for as long as it stays active — deliberately NOT reset when
 * a device reconnects: resetting on reconnect would let a device that just
 * exceeded its budget immediately burst again on reconnect, defeating the
 * limit entirely. It IS dropped once idle long
 * enough that keeping it around would be pointless — see
 * `evictIdleBucketsIfDue`.
 *
 * Construction validates `messagesPerSecond`/`burst` fail-fast (throws
 * `TypeError` on anything non-finite or <= 0) rather than silently building
 * a limiter that either divides into `NaN` token math or (an `Infinity`
 * burst/rate) never actually limits anything.
 *
 * Finding R5 (cross-model re-review — F10 residual): `burst` specifically
 * must be `>= 1`, not merely `> 0`. A `0 < burst < 1` value used to pass
 * the old `<= 0` check cleanly, but `consume()`'s own debit logic
 * (`if (bucket.tokens < 1) return false;`) can NEVER succeed once the
 * bucket's own CEILING (`burst`) is itself below 1 — `Math.min(this.burst,
 * ...)` caps refill there, so `tokens` can never reach 1 no matter how
 * long the bucket sits idle. The old validation let this construct
 * silently — a limiter that rejects every single message, forever, for
 * every key, is not a rate LIMIT, it's a permanent, total block; that
 * should be a construction-time error, not a runtime surprise discovered
 * once real traffic starts getting rejected.
 */
import type { InboundRateLimiter } from '@byok-sdk/cloud';
export interface RateLimiterOptions {
    /** Sustained refill rate, tokens (i.e. messages) per second. Must be a finite number > 0. Default 50. */
    messagesPerSecond?: number;
    /** Bucket capacity — how many messages may arrive back-to-back before the limit engages. Must be a finite number >= 1 (finding R5 — see the module doc comment for why `< 1` can never let a single message through, ever). Default 100. */
    burst?: number;
    /** Hard cap on how many distinct keys (finding R5) this limiter tracks at once — see {@link DEFAULT_MAX_TRACKED_DEVICES}'s own doc comment. Must be a finite number >= 1. Default 10,000. */
    maxTrackedDevices?: number;
}
export declare class RateLimiter {
    private readonly messagesPerSecond;
    private readonly burst;
    private readonly buckets;
    /** Finding R5: hard cap on `buckets.size` — see {@link DEFAULT_MAX_TRACKED_DEVICES}'s own doc comment. */
    private readonly maxTrackedDevices;
    /** Calls to `consume()` since the last sweep — see `EVICTION_SWEEP_EVERY_N_CALLS`. */
    private callsSinceSweep;
    constructor(opts?: RateLimiterOptions);
    /**
     * Charge `cost` tokens to `key`'s bucket, refilling first for however much
     * wall-clock time has elapsed since its last refill. Admits while the bucket
     * holds at least one token and then charges the whole `cost`, even below
     * zero: a message batch larger than `burst` is admissible, and its debt is
     * repaid before the key's next admission. Returns `false` (and charges
     * nothing) when the bucket holds less than one token.
     */
    consume(key: string, cost: number): boolean;
    /**
     * Milliseconds until `key`'s bucket next holds a whole token, as of its last
     * refill — the `Retry-After` of a refusal `consume()` just answered. 0 for a
     * key with a token available or no bucket at all.
     */
    retryAfterMs(key: string): number;
    /**
     * Every `EVICTION_SWEEP_EVERY_N_CALLS` calls to `consume()`, drops every
     * bucket that has been idle long enough to have refilled to `burst`, debt
     * included. Recreating it fresh (tokens = burst) on its next `consume()` is
     * then identical to refilling it in place, so eviction is invisible to the
     * caller. Without this, `buckets` would hold one
     * permanent entry per historical key forever — every device that ever
     * connected, even long after it disconnected for good — growing without
     * bound over a long-lived server's lifetime.
     */
    private evictIdleBucketsIfDue;
    /**
     * Finding R5 (cross-model re-review — F10 residual): called right before
     * inserting a bucket for a genuinely NEW key, evicting the single
     * LEAST-RECENTLY-refilled entry if `buckets` is already at
     * `maxTrackedDevices` — an O(n) scan, but one that only ever runs once
     * the map is already at its hard ceiling (a rare/bounded event under
     * ordinary operation, not a per-call cost), mirroring this codebase's own
     * established "acceptable O(n) for a rare/bounded case" precedent (e.g.
     * `audit-log.ts`'s `compactPreservingLiveTasks` during rotation).
     *
     * Equivalence split (stated explicitly, not left implied):
     * - For any evicted bucket that was ALREADY idle long enough to refill to
     *   `burst` (i.e. `evictIdleBucketsIfDue` would have reclaimed it anyway,
     *   just not yet — sweeps only run every `EVICTION_SWEEP_EVERY_N_CALLS`
     *   calls, not continuously), eviction is PROVABLY equivalent to an
     *   in-place refill: both cap at `burst`, so a caller can never observe the
     *   difference (the same reasoning `evictIdleBucketsIfDue` relies on).
     * - For a bucket evicted EARLY — still within its idle threshold, forced
     *   out only because `buckets` is at capacity (many thousands of
     *   genuinely-distinct, actively-used keys, not a quiet one) — this is
     *   BEST-EFFORT, not equivalence-preserving: whatever partial token debt
     *   that key had is discarded, and its very next `consume()` call starts
     *   completely fresh (`tokens: this.burst`), a strictly MORE permissive
     *   outcome than if it had kept its place. This is an accepted,
     *   deliberately bounded trade-off — it only ever engages under
     *   cardinality far beyond any plausible real deployment — favoring
     *   bounded memory over perfect per-key continuity in that one extreme
     *   case.
     */
    private evictOldestIfAtCapacity;
}
/**
 * The counting `InboundRateLimiter` (`@byok-sdk/cloud`'s store port) this
 * package composes the kernel with.
 *
 * Position matters and is not this adapter's choice: the kernel charges a
 * `POST /byok/messages` batch one `envelope` token per envelope before the
 * first one reaches its inbound gate, and one `request` token when it admits
 * any other authenticated device route. Both spend the same bucket.
 * `envelopesIn` (one per received envelope, admitted or refused) and
 * `rateLimitEvents` (one per REFUSED admission of either unit, never
 * coalesced) are counted here and nowhere else.
 *
 * The `device.rate_limited` embedder event is the one thing that IS coalesced,
 * matching the pre-fold rule: an episode fires exactly one event, and only a
 * subsequent SUCCESSFUL consume by that device re-arms it. So a flood produces
 * one event and N counter increments, and a device that recovers and floods
 * again produces a second, distinct event.
 */
export interface InboundRateLimiterCounters {
    /** Every envelope a `POST /byok/messages` batch carried, whether the batch was admitted or refused and whatever the gate then decided. Device route requests are not envelopes and are not counted. */
    envelopesIn: number;
    /** Admissions the bucket refused: per message batch and per device route request — see the episode rule above. */
    rateLimitEvents: number;
}
export interface CountingInboundRateLimiter {
    /** The port `CloudStores.rateLimiter` is composed with. */
    readonly limiter: InboundRateLimiter;
    readonly counters: InboundRateLimiterCounters;
}
/**
 * Adapt a {@link RateLimiter} to the kernel's `(tenant, deviceId)` port.
 *
 * The bucket key is `${tenant}:${deviceId}` rather than the bare device id: a
 * device id is only unique within its tenant, and a shared key space would let
 * one tenant's flood spend another's budget for a colliding id.
 */
export declare function createCountingInboundRateLimiter(limiter: RateLimiter, onRateLimited: (deviceId: string, at: string) => void): CountingInboundRateLimiter;
// ==== @byok-sdk/server dist/relay.d.ts ====
import type { InboundCommitted, ByokCloudObserver } from '@byok-sdk/cloud';
import type { RuntimeId, TaskState } from '@byok-sdk/protocol';
import { AsyncEventQueue, type QueueEntry } from './event-queue';
import { type ByokServerEvent, type ServerTaskEvent } from './types';
/** Per-task {@link ServerTaskEvent} retention before drop-oldest engages. */
export declare const DEFAULT_TASK_EVENT_BUFFER_LIMIT = 1000;
/** How long a terminal task's relay state is retained before reclamation, ms. */
export declare const DEFAULT_TASK_EVENT_RETENTION_MS: number;
/**
 * Where a feed stands with this instance's dispatch of its task. A dispatch
 * either opens a feed (`dispatching`) or finds one a host event read attached
 * to a task this instance did not dispatch, after a restart
 * (`attached-dispatching`). Until the offer is accepted, both buffer every
 * delivery, so `Offered` is the first entry of a `dispatched` feed. A refused
 * dispatch drops the feed it opened and returns an attached feed to
 * `attached`, delivering what it buffered.
 */
export type TaskFeedPhase = 'dispatching' | 'attached-dispatching' | 'attached' | 'dispatched';
/**
 * One task's delivery plumbing. `current` holds the entries where the task's
 * present state began in this feed: its latest `state` entry, preceded by the
 * pending `await_approval` request while it awaits approval. They are kept
 * apart from the bounded queue, so a reader starting there gets them even after
 * drop-oldest discarded them from the queue.
 */
export interface TaskFeed {
    /** Random per feed, so a cursor from a previous instance or a reclaimed feed is recognizably unknown. */
    readonly feedId: string;
    readonly queue: AsyncEventQueue<ServerTaskEvent>;
    readonly terminal: Promise<void>;
    settleTerminal: () => void;
    terminalSettled: boolean;
    phase: TaskFeedPhase;
    current: ReadonlyArray<QueueEntry<ServerTaskEvent>>;
    readonly early: Array<() => void>;
    claimedRuntime?: RuntimeId;
    claimedHarnessId?: string;
    reclaimTimer?: ReturnType<typeof setTimeout>;
}
export interface TaskEventRelayOptions {
    readonly taskEventBufferLimit?: number;
    readonly taskEventRetentionMs?: number;
}
/**
 * Post-commit fan-out: cloud kernel envelopes -> `ServerTaskEvent` /
 * `ByokServerEvent`.
 *
 * The invariant this file exists to keep (WP3B §3): **the relay holds
 * notifications, never state**. It never answers "what is this task", "what did
 * it produce" or "who owns it" — every one of those is read back from the
 * kernel's durable stores on demand. What it owns is per-task delivery
 * plumbing: a bounded replayable queue, and one promise that settles when the
 * task reaches a terminal so `TaskHandle.result()` has something to await
 * before it reads the answer back.
 *
 * The two small facts it does carry are delivery bookkeeping, not a read model:
 * `terminalSettled` (so the FIRST terminal is the one that settles the promise,
 * matching the store's own first-terminal-wins rule, and a later stale terminal
 * is not announced as a second one) and `claimedRuntime` (echoed onto the
 * `task.state` event stream because the pre-fold feed carried it there; the
 * authoritative copy is `TaskAttempt.claimedRuntime`).
 *
 * Dispatch first {@link provision}s a known task id, then activates it with
 * {@link noteDispatched} after the kernel has accepted its offer, or undoes it
 * with {@link abort}. Deliveries in that interval are buffered, not dropped
 * ({@link TaskFeedPhase}). An envelope
 * naming a task with no feed is folded for nobody and allocates nothing —
 * otherwise a device could grow this map without bound by guessing task ids,
 * and the kernel's gate deliberately treats such an envelope as a harmless
 * store no-op rather than a rejection.
 *
 * Host event reads (`readTaskEvents`) use the rest. `feed` returns the task's
 * current feed and never creates one; `stopped` turns true at {@link stop}.
 * `attach` starts delivering a live task this instance did not dispatch (after
 * a restart) from now on, without reconstructing earlier events; only a host
 * read creates such a feed. Attaching to a feed a dispatch opened for a task
 * that is already stored makes it `attached-dispatching`, so a refused
 * dispatch hands it back to its reader instead of dropping it. `seed` gives an
 * attached feed that no transition has reached yet its starting entries, read
 * back from the durable stores and pushed by the same `#begin` that records a
 * live state's start; once a transition arrived, the feed already says more
 * than they would. A seed waits behind an in-flight dispatch like any
 * delivery, so `Offered` still comes first. `detach` drops an `attached` feed
 * that turned out to have nothing to deliver, and never one a dispatch owns.
 * `entries` reads a feed after a cursor, or from the start of what is
 * retained, and refuses a cursor that names no position of the feed with
 * `cursor_unknown`. Members carry no block docs here because comments on class
 * members ship in the bundle, which has an exact size budget.
 *
 * `onInboundCommitted` runs inline on the kernel's request path and must stay
 * synchronous and cheap.
 */
export declare class TaskEventRelay implements ByokCloudObserver {
    #private;
    constructor(options: TaskEventRelayOptions);
    /** The cross-task embedder feed backing `ByokServer.events.subscribe()`. */
    serverEvents(): AsyncIterable<ByokServerEvent>;
    /** Publish one cross-task event (rate-limit episodes, host-side transitions). */
    emitServerEvent(event: ByokServerEvent): void;
    /** Pre-register a task id before its offer enqueue can become observable. */
    provision(taskId: string): void;
    /** Forget an enqueue that failed before it produced an offer. */
    abort(taskId: string): void;
    /**
     * Open the relay for a task this server just dispatched, and publish its
     * `Offered` origin on both feeds. `at` is the offer envelope's own timestamp,
     * so the feed preserves the original delivery time.
     */
    noteDispatched(taskId: string, at: string): void;
    get stopped(): boolean;
    feed(taskId: string): TaskFeed | undefined;
    attach(taskId: string): TaskFeed | undefined;
    seed(feed: TaskFeed, next: TaskState, at: string, request?: ServerTaskEvent): void;
    detach(taskId: string, feed: TaskFeed): void;
    entries(taskId: string, feed: TaskFeed, after?: string): AsyncIterable<QueueEntry<ServerTaskEvent>>;
    /** Settles when this task first reaches a terminal — the barrier `TaskHandle.result()` awaits. */
    terminal(taskId: string): Promise<void>;
    /**
     * Host-side transitions the wire never carries: an accepted cancellation, and
     * an approval the operator resolved through `TaskHandle.approve`/`reject`.
     * Published here so the two feeds report the same task history whichever side
     * moved it, and (for a terminal) so `result()` is not left waiting on a device
     * message that a cancelled task will never send.
     */
    noteHostTransition(taskId: string, state: TaskState, at: string): void;
    /** A wake carries no content and creates no task event queue. */
    onAgentMessageDraft(taskId: string): void;
    watchAgentMessageDraft(taskId: string, wake: () => void): () => void;
    onInboundCommitted(input: InboundCommitted): void;
    /** Close every feed and drop every timer. Safe to call more than once. */
    stop(): void;
}
// ==== @byok-sdk/server dist/sqlite-support.d.ts ====
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';
export type SqliteOpenStep = 'after-open' | 'after-wal';
/** Test-only seam for proving that post-open initialization failures release the native handle. */
export interface SqliteOpenFaultSeam {
    onStep?(step: SqliteOpenStep): void;
    close?(db: DatabaseSync): void;
}
/**
 * Preserve the initialization error after deterministically releasing an
 * already-open SQLite handle. If cleanup itself fails, surface both failures
 * instead of losing the reason construction failed or pretending ownership
 * was returned.
 */
export declare function closeSqliteDatabaseAfterInitializationFailure(db: DatabaseSync, initializationError: unknown, message: string, close?: (db: DatabaseSync) => void): never;
/**
 * Thrown when `node:sqlite` isn't available in the running Node.js binary.
 * `node:sqlite` shipped in Node.js 22.5.0 (https://nodejs.org/api/sqlite.html)
 * and remains marked experimental there (an `ExperimentalWarning` on stderr
 * is expected and harmless — not an error). The SQLite-backed embedded store
 * composition deliberately
 * depend on nothing else — no `better-sqlite3` or other native module —
 * because staying at zero native dependencies is required to keep
 * `@byok-sdk/server` trivially packageable across platforms. The tradeoff is
 * that this composition simply doesn't work below Node 22.5; this error says so
 * clearly and up front, instead of letting a cryptic `Cannot find module
 * 'node:sqlite'` surface from deep inside a query.
 */
export declare class SqliteUnavailableError extends Error {
    constructor(cause: unknown);
}
/**
 * Why a SQLite file was refused at open, so a host can tell the user what to do
 * without parsing the message:
 * - `SQLITE_SCHEMA_UNSUPPORTED`: the stored version is not this build's. An
 *   older file is not adopted (start on a new database); a newer file needs a
 *   newer build.
 * - `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`: pending mailbox rows do not use
 *   the current wire major. Drain with the previous SDK before upgrading.
 * - `SQLITE_SCHEMA_INVALID`: the file contradicts its declared BYOK schema or
 *   is not a BYOK database.
 */
export type SqliteSchemaErrorCode = 'SQLITE_SCHEMA_UNSUPPORTED' | 'SQLITE_SCHEMA_INVALID' | 'SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED';
export declare class SqliteSchemaError extends Error {
    readonly code: SqliteSchemaErrorCode;
    /** The stored `schema_version`; `undefined` when the file has none. */
    readonly foundVersion: string | undefined;
    /** The schema version this build writes. */
    readonly requiredVersion: string;
    constructor(code: SqliteSchemaErrorCode, message: string, foundVersion: string | undefined, requiredVersion: string, options?: ErrorOptions);
}
/**
 * Thrown when a SQLite database file is already owned by another open server —
 * in another process, or another instance in this one. One file has exactly one
 * owning process: token signing keys, presence, the task-event relay and
 * dispatch bookkeeping are process-local, so a second process on the same file
 * would split them. Run several instances only over external stores with a
 * shared `tokenSigner`.
 *
 * Ownership is SQLite's EXCLUSIVE locking mode on the database itself, held
 * for the lifetime of its handle. The kernel releases it when the owner closes or
 * its process exits for any reason, including SIGKILL, so a stale owner never
 * blocks the next open and no pid is ever compared (pid reuse cannot matter).
 */
export declare class SqliteOwnershipError extends Error {
    readonly code = "SQLITE_DATABASE_OWNED";
    /** The database path whose ownership was refused. */
    readonly path: string;
    constructor(path: string, options?: ErrorOptions);
}
/**
 * Whether `nodeVersion` (a `major.minor.patch` string shaped like
 * `process.versions.node`) is new enough to have `node:sqlite` at all.
 * Exported only for this package's own tests to exercise the guard
 * deterministically (this dev/CI machine is already on a qualifying Node,
 * so the real "unavailable" path can't be triggered end-to-end here) — not
 * re-exported from `index.ts`, so not part of the public package API.
 * Unparsable input returns `true` (don't false-negative on a version string
 * shape this hasn't seen before): `loadSqliteModule`'s own `require` call is
 * the real, authoritative gate; this check only exists to turn the common
 * case (a too-old Node) into a clear message instead of a cryptic one.
 *
 * Not a sufficient capability check on its own: `node:sqlite` shipped in
 * Node 22.5.0 behind the `--experimental-sqlite` flag and only became usable
 * unflagged in a later 22.x release (https://nodejs.org/api/sqlite.html), so
 * a runtime that satisfies this version check can still fail to actually
 * load the module. Use {@link isSqliteAvailable} when the question is "can I
 * use `node:sqlite` right now", not "is the Node version new enough for it
 * to exist at all".
 */
export declare function isSqliteCapableNodeVersion(nodeVersion: string): boolean;
/**
 * Synchronously load `node:sqlite` via `process.getBuiltinModule` rather than a dynamic
 * `import()`. Every reference store in this package (`InMemoryTaskStore`,
 * `LocalDiskBlobStore`) constructs synchronously via `new`, and
 * `node:sqlite`'s own API (`DatabaseSync`) is itself fully synchronous — an
 * async factory here would be the odd one out and would leak into every
 * caller (`createByokServer`, the example, tests). `node:sqlite` is a
 * built-in, so loading it needs no file URL or module-resolution anchor,
 * including in CJS bundles and SEA executables. Throws {@link SqliteUnavailableError} (not a
 * raw `MODULE_NOT_FOUND`/version-mismatch trace) when it can't be loaded —
 * checking the Node version first (see {@link isSqliteCapableNodeVersion})
 * gives the common "Node too old" case a specific, actionable message
 * before even attempting the built-in lookup.
 */
export declare function loadSqliteModule(): typeof import('node:sqlite');
/**
 * Whether `node:sqlite` can ACTUALLY be loaded right now — the authoritative
 * capability check, in contrast to {@link isSqliteCapableNodeVersion}'s
 * version-string heuristic. This is what this package's own test suite uses
 * to decide whether to skip the SQLite-backed reference-store tests (rather
 * than fail them), and what anything else should call before assuming a
 * `SqliteTaskStore`/`SqliteBlobStore` can be constructed: it attempts the
 * real built-in lookup (via {@link loadSqliteModule}, memoized) and
 * reports whether that succeeded, so it agrees with reality regardless of
 * whether the current runtime is old, too-new-but-flagged, or fully capable.
 */
export declare function isSqliteAvailable(): boolean;
/**
 * Open (or create) a `node:sqlite` `DatabaseSync` at `path`, applying the
 * pragmas both reference SQLite stores share: EXCLUSIVE locking mode before
 * the first WAL access, with a busy timeout (see {@link DEFAULT_BUSY_TIMEOUT_MS}).
 * The file has one owner until this handle closes; external readers and writers
 * cannot inspect a running owner's database. No sibling ownership file is used.
 * WAL is skipped for
 * `:memory:`, where it's meaningless. For a file-backed path whose parent
 * directory doesn't exist yet, creates it (recursively) at
 * {@link SECURE_DIR_MODE} — mirroring the client-side device store's
 * convention of never leaving a credential directory at a permissive
 * default mode. Throws {@link SqliteUnavailableError} if `node:sqlite`
 * itself can't be loaded (Node <22.5, or a flagged intermediate 22.x — see
 * {@link isSqliteAvailable}) — callers don't need their own guard for that;
 * this is the single choke point.
 */
export declare function openSqliteDatabase(path: string, options?: DatabaseSyncOptions, faults?: SqliteOpenFaultSeam): DatabaseSync;
/**
 * Restrict `dbPath` and its WAL/SHM sibling files (`<path>-wal`,
 * `<path>-shm` — created by SQLite itself once WAL mode is active and a
 * write has happened) to owner-only read/write ({@link SECURE_FILE_MODE}).
 * Both SQLite reference stores hold sensitive bytes on disk with no other
 * access-control layer of their own — `SqliteBlobStore` an HMAC signing
 * secret plus arbitrary uploaded blob content, `SqliteTaskStore` task
 * instructions and device/session refs — so a real (non-`:memory:`)
 * database file must not be left at whatever permissive mode the process'
 * umask would otherwise give it.
 *
 * Call this AFTER the schema has been created against `dbPath` (so the
 * WAL/SHM files, which SQLite creates lazily on first write, already exist)
 * — a sibling file that doesn't exist yet is silently skipped rather than
 * treated as an error. No-op for `:memory:`.
 */
export declare function secureSqliteFilePermissions(dbPath: string): void;
// ==== @byok-sdk/server dist/store-compatibility.d.ts ====
import type { StoreCompatibility } from '@byok-sdk/core';
/**
 * Store compatibility precheck for the embedded server SQLite store (#1102).
 *
 * Reports what this build does when `createByokServer({ storage: { kind:
 * 'sqlite', path } })` opens `path`. The files are copied to a private
 * temporary directory and the server's own open runs on the copy, so the
 * schema rules stay in one place and the original files are only read. Stop
 * the server that owns the file first: a file that changes while it is copied
 * fails the check rather than yielding a verdict about a torn copy.
 *
 * An older `schema_version` is `new-path-repair` (start on a new path and pair
 * the daemons again). A newer version, a file without BYOK metadata, a damaged
 * file, or data this build refuses to adopt is `rejected`.
 */
export declare function inspectSqliteStore(path: string): Promise<StoreCompatibility>;
// ==== @byok-sdk/server dist/task-handle.d.ts ====
import { type ByokCloud, type SteerRejectionCode, type TaskAbandonCause, type TaskAttempt, type TenantId } from '@byok-sdk/cloud';
import type { RuntimeId, TaskState } from '@byok-sdk/protocol';
import type { TaskEventRelay } from './relay';
import { type ServerTaskEvent, type TaskEventEntry, type TaskHandle, type TaskResult } from './types';
/**
 * Thrown by {@link TaskHandle.steer} when the kernel refuses the steer.
 *
 * This package keeps its OWN class rather than re-exporting the kernel's, and
 * that is deliberate rather than a leftover. The two carry the same `taskId`,
 * `code` and `runtime`, and differ in exactly one field: the kernel reports
 * `status: TaskAttemptStatus` — its coarse, execution-free attempt disposition
 * (`running`, `offered`, …) — while this surface reports `state: TaskState`,
 * the WIRE vocabulary every other member of this package speaks
 * (`TaskSnapshot.state`, `ServerTaskEvent`, `HubStats.taskCountsByState`).
 * `AwaitApproval` is the reason they cannot be the same field: it is derived
 * from the durable approval timeline and has no attempt status at all
 * (ADR-028), so a `TaskAttemptStatus -> TaskState` mapping inside the kernel
 * would have to report `Running` for a task this façade calls `AwaitApproval`.
 *
 * So the state here is not translated from the kernel's field — it is READ,
 * through the very projection `byok.tasks.get(taskId)` answers with, at the
 * moment of the refusal. One authority, two readers, no second mapping.
 *
 * Deviation from design packet §1.2, which had this class move to
 * `@byok-sdk/cloud` with the server re-exporting it: the wire `TaskState`
 * vocabulary is host-facing and lives here, so the class that carries it does
 * too. `SteerRejectionCode` and `StaleApprovalError` are unaffected and stay
 * kernel re-exports.
 */
export declare class SteerRejectedError extends Error {
    readonly taskId: string;
    readonly code: SteerRejectionCode;
    /** The task's state at the moment the steer was refused. */
    readonly state: TaskState;
    /** `TaskSnapshot.claimedRuntime` — `undefined` when nothing was ever recorded, which is itself a reason `steer_unsupported_runtime` can fire. */
    readonly runtime: RuntimeId | undefined;
    constructor(taskId: string, code: SteerRejectionCode, state: TaskState, runtime: RuntimeId | undefined);
}
export interface TaskHandleDeps {
    readonly tenant: TenantId;
    readonly cloud: ByokCloud;
    readonly relay: TaskEventRelay;
    /**
     * The task's current `TaskSnapshot.state` and `updatedAt`, or `undefined`
     * when the attempt is gone. The snapshot projection itself — never a second
     * derivation.
     */
    readonly readState: (taskId: string) => Promise<{
        readonly state: TaskState;
        readonly at: string;
    } | undefined>;
    /**
     * The pending approval request as the relay would have announced it: a
     * plaintext request with an `approvalId`. A sealed request, which the relay
     * never announces, reads as none.
     */
    readonly readApprovalRequest: (taskId: string) => Promise<ServerTaskEvent | undefined>;
    /** The read-back this handle's `result()` answers with. */
    readonly readResult: (taskId: string) => Promise<TaskResult | undefined>;
}
type ApprovalDeps = Pick<TaskHandleDeps, 'tenant' | 'cloud' | 'relay'>;
type EventDeps = Pick<TaskHandleDeps, 'relay' | 'readState' | 'readApprovalRequest'>;
/** Where a task event read starts, and what stops it; see `ByokServer.tasks.events`. */
export interface TaskEventReadOptions {
    readonly after?: string;
    readonly from?: 'state';
    readonly signal?: AbortSignal;
}
/**
 * One task's event feed from the relay, shared by `ByokServer.tasks.events`
 * and {@link TaskHandle.events}. Every refusal is thrown by the first `next()`,
 * before any entry; once entries flow, the read only ends (terminal, `signal`,
 * `return()`, server close).
 *
 * `return()` also releases a pending `next()`, as the relay queue's own
 * iterator does. An async generator cannot: it queues `return()` behind the
 * outstanding `next()`, so a reader stopping an idle feed would hang. Here
 * `return()` aborts the read's own signal first, which wakes the queue.
 * `project` shapes each entry: `TaskHandle.events()` yields the event alone.
 */
export declare function readTaskEvents<T = TaskEventEntry>(deps: EventDeps, taskId: string, options?: TaskEventReadOptions, project?: (entry: TaskEventEntry) => T): AsyncIterable<T>;
/**
 * The host's approval decision, shared by {@link TaskHandle.approve} and
 * `ByokServer.tasks.approve`. Cloud atomically records it in the one approval
 * timeline before this notification is enqueued; the relay remains a
 * notification projection, never a second writer for that authority.
 */
export declare function approvePendingApproval(deps: ApprovalDeps, taskId: string, opts?: {
    approvalId?: string;
}): Promise<void>;
/** The rejection counterpart of {@link approvePendingApproval}. */
export declare function rejectPendingApproval(deps: ApprovalDeps, taskId: string, reason?: string, opts?: {
    approvalId?: string;
}): Promise<void>;
/**
 * One in-flight task's control surface.
 *
 * The §3 invariant it exists to keep: **the handle is not a second authority.**
 * Every mutation is a kernel call, and `result()` is a READ-BACK — it waits for
 * the relay's terminal barrier and then asks the store what the terminal was,
 * so `handle.result()` and `byok.tasks.get(taskId).result` are physically the
 * same fact rather than two copies that can disagree. Nothing about the task is
 * cached here.
 */
/**
 * Announces the `Cancelled` transition an abandonment recorded. An attempt that
 * was already terminal comes back with its own terminal, so only one settled
 * under this cause is announced; a cancelled task already announced it when
 * its tombstone was written, and the relay keeps the first terminal anyway.
 */
export declare function noteAbandoned(relay: TaskEventRelay, attempt: TaskAttempt, cause: TaskAbandonCause): void;
export declare function createTaskHandle(taskId: string, deps: TaskHandleDeps): TaskHandle;
export {};
// ==== @byok-sdk/server dist/types.d.ts ====
import type { HarnessInfo } from '@byok-sdk/protocol';
import type { AgentContentReadPayload, AgentHomeProjectionPayload, AgentHomeProjectionReadback, AgentEventOrUnknown, AgentEgressPolicy, AgentEgressReliablePayload, AgentMessageEgressRequirement, AgentMessageServerContext, AgentMessagePublishPayload, AgentRef, BlobRef, DispatchSelection, RuntimeCapabilities, RuntimeId, TaskApprovalResolvedPayload, TaskArtifactPayload, TaskDeclineCodeReading, TaskFailureReading, TaskState, ToolsetId, TerminalProjectionSelection, AgentHomeAccess, AgentMemorySelection } from '@byok-sdk/protocol';
import type { InboundRefusalReason, MaintenanceReport, RetentionPolicy, TaskAbandonCause, TenantId, TokenSigner } from '@byok-sdk/cloud';
import type { PresenceRuntimeFact } from '@byok-sdk/core';
import type { WakeConsumer } from './wakes/types';
import type { RateLimiterOptions } from './rate-limiter';
/** Mutually-exclusive storage authority for the embedded reference server. */
export type ByokServerStorage = {
    readonly kind: 'memory';
} | {
    readonly kind: 'sqlite';
    /** File-backed SQLite database. `:memory:` is accepted for tests only. */
    readonly path: string;
    /** Lifetime of signed blob upload/download URLs. Default 15 minutes. */
    readonly urlTtlMs?: number;
};
/** Options for {@link createByokServer}. */
export interface CreateByokServerOptions {
    maintenance?: {
        readonly policy?: Partial<RetentionPolicy>;
        readonly intervalMs?: number;
        readonly limit?: number;
    };
    /**
     * Identifies which product this server instance serves. Checked against the
     * `productId` a daemon announces in `conn.hello` — one daemon process is
     * always scoped to one product (see plan: "一产品一 daemon 进程"), so a
     * mismatched daemon is rejected at handshake time.
     */
    productId: string;
    /**
     * Embedded storage authority. Defaults to process-local memory. SQLite is
     * selected explicitly and fails closed if it cannot be opened; it never
     * falls back to memory.
     */
    storage?: ByokServerStorage;
    /** Device-side one-shot wakes, at least once. Host must durably deduplicate even overlapping retries. */
    wake?: WakeConsumer;
    /** How long `GET /byok/events` holds an empty poll open before returning, ms (§8). Default ~50s; override for tests. */
    longPollHoldMs?: number;
    /**
     * Presence lease, ms: a device is connected while its last observation
     * (`conn.hello`, any accepted envelope, or the start of a `GET /byok/events`
     * poll) is at most this old. Default `longPollHoldMs + 15_000`. Must exceed
     * `longPollHoldMs`, because a held poll does not renew the lease; construction
     * throws otherwise. Presence is discovery only; dispatch never reads it.
     */
    presenceTtlMs?: number;
    /** Per-product blob size ceiling in bytes (§7). Default 100MB. */
    maxBlobSizeBytes?: number;
    /** Override the reference {@link TokenSigner} (e.g. an org-wide/KMS-backed signer). */
    tokenSigner?: TokenSigner;
    /**
     * How many {@link ServerTaskEvent}s one task's event feed (`tasks.events`,
     * `TaskHandle.events()`) retains before the OLDEST are dropped. A reader
     * whose next entry was dropped receives one
     * `{ kind: 'error', reason: 'events_truncated' }` marker in its place. The
     * feed is a notification relay, not a second record of what happened — the
     * durable facts stay in the cloud stores (`tasks.get`, `result()`) — so a
     * consumer that stops reading costs bounded memory rather than unbounded
     * growth. Default 1000.
     */
    taskEventBufferLimit?: number;
    /**
     * How long after a task reaches a terminal its relay buffer and terminal
     * promise are RETAINED before being reclaimed, ms. A late event reader
     * within this window still replays the retained feed; past it, new event
     * reads throw {@link TaskEventsUnavailableError} (`feed_expired`). Use the
     * durable read model (`tasks.get`, `result()`) for terminal facts after
     * expiry. Default 5 minutes.
     *
     * Retention never decides when a feed ENDS: an event read completes at the
     * terminal event itself, whenever that happens, so a `for await` over it is
     * never left waiting on this timer.
     *
     * A positive integer of at most `2_147_483_647` (the largest delay one
     * timer can hold, ~24.8 days); a larger value is refused at construction.
     */
    taskEventRetentionMs?: number;
    /**
     * M4 Phase 4 (part A): the one per-device token bucket. The cloud kernel
     * charges a `POST /byok/messages` batch one token per envelope before the
     * first one reaches its inbound gate, so a flood of garbage-typed envelopes
     * costs the same budget as a flood of well-formed ones and a refused batch
     * applies nothing, and one token per authenticated device route request
     * (each `GET /byok/events` poll, presence, board, blob grant, ...). An
     * admission needs one token and then charges its whole count, so a batch
     * larger than `burst` overdraws the bucket rather than never fitting.
     * Defaults: 50 tokens/s sustained, burst 100 (see `rate-limiter.ts`).
     *
     * Exceeding it never drops silently: the occurrence counts in
     * {@link HubStats.rateLimitEvents} (per REFUSED admission), and the first
     * refusal of an episode emits a `device.rate_limited`
     * {@link ByokServerEvent} — coalesced per episode, re-armed only by a later
     * successful consume by the same device. Enforcement on the wire is a
     * whole-request `429` with `Retry-After` (seconds until the bucket holds a
     * token again). The presigned blob content routes carry no device principal
     * and are not on this bucket.
     */
    rateLimit?: RateLimiterOptions;
    /**
     * M4 Phase 4 (part B.2): opt-in `GET /healthz` liveness route layered on the
     * Hono app in front of the kernel — deliberately unauthenticated (no bearer
     * check) and carrying no sensitive data (no device ids, no counts), just
     * `{ok:true, uptimeMs}`, because a container orchestrator's liveness probe
     * must not need a device credential. Server-local rather than a kernel route
     * because it reports deployment liveness, not coordination. Default `false`
     * (no route mounted at all). `ByokServer.stats()` (richer detail) is never
     * exposed over HTTP by this SDK regardless of this flag — an embedder that
     * wants that surfaced remotely builds its own authenticated route around
     * it.
     */
    healthzRoute?: boolean;
    /**
     * Product-owned, authenticated task destination consumer.
     *
     * The cloud kernel's admission shape verbatim (`ByokCloudOptions.agentMessage`,
     * `@byok-sdk/cloud`): async, and carrying the tenant the message was
     * authenticated under. This façade forwards the hook to the kernel unchanged
     * rather than wrapping a second shape around it — one contract, documented in
     * one place. Delivery is at least once: the product must durably deduplicate
     * exact message identity and return its original decision on replay, including
     * concurrent calls and retries after an uncertain commit.
     * A one-shot break for embedders (WP3B §6); there is no adapter.
     */
    agentMessage?: {
        consume(input: {
            readonly tenant: TenantId;
            readonly deviceId: string;
            readonly taskId: string;
            readonly context: AgentMessageServerContext;
            readonly payload: AgentMessagePublishPayload;
        }): Promise<{
            readonly outcome: 'accepted' | 'held' | 'refused';
            readonly reasonCode?: string;
        }>;
    };
}
/** Fields shared by every {@link DispatchInput} variant. */
interface DispatchInputBase {
    /** Pre-persisted execution identity. Requires explicit deviceId; retries may report a kernel conflict. */
    taskId?: string;
    instruction: string;
    /**
     * Authoritative web-selected target. When present, `runtime` is derived
     * from `runtimeId`; supplying a different `runtime` is rejected.
     */
    dispatchSelection?: DispatchSelection;
    runtime?: RuntimeId;
    harnessId?: string;
    /** Explicit target; registered offline devices may receive queued work. */
    deviceId: string;
    /** Logical device-local MCP toolsets required for this task; never executable definitions. */
    requiredToolsets?: ToolsetId[];
    /**
     * An explicit, consumed Agent egress policy. It travels on the distinct
     * egress-aware Agent offer.
     */
    egressPolicy?: AgentEgressPolicy;
    /** Distinct user-visible message lane; independent of activity egress. */
    messageEgress?: AgentMessageEgressRequirement;
    /** Exact offer-scoped terminal projection authority. */
    terminalProjection?: TerminalProjectionSelection;
    /**
     * `memory-reader` runs this Agent task in its own run directory beside
     * other readers and at most one writer. Requires `agentRef` and a device
     * that advertises `agent-home-readers`; the kernel refuses it otherwise,
     * before the task exists. Absent means a writer.
     */
    homeAccess?: AgentHomeAccess;
    /**
     * The Agent memory of this one task: `none`, `read`, `read-write`,
     * `read-if-admitted` (`read` when the daemon admits the memory MCP, else
     * `none`; the device must also advertise `agent-memory-read-if-admitted`) or
     * `read-write-if-admitted` (`read-write` when admitted, else `none`; the
     * device must also advertise `agent-memory-read-write-if-admitted`).
     * Requires `agentRef` and a device that advertises `agent-memory-selection`;
     * the kernel refuses it otherwise, before the task exists. `read-write` or
     * `read-write-if-admitted` with `homeAccess: 'memory-reader'` is refused
     * before the task exists. Absent keeps the daemon admission.
     */
    agentMemory?: AgentMemorySelection;
    /** Host-only product destination/freshness authority; never serialized to the daemon. */
    agentMessageContext?: AgentMessageServerContext;
}
/**
 * Agent resume dispatch: an explicit durable Agent identity plus the exact
 * session being resumed, sent as a `task.offer` with `session.mode: 'resume'`.
 * A fresh Agent execution is not a dispatch; it has the single authority
 * `executions.submit`. The runtime refuses a missing `sessionRef` regardless of
 * the static type.
 */
export interface AgentResumeDispatchInput extends DispatchInputBase {
    agentRef: AgentRef;
    sessionRef: string;
}
/** Input to {@link ByokServer.dispatch}. */
export type DispatchInput = AgentResumeDispatchInput;
/** Host control-plane input for one exact content-read request. */
export interface AgentContentReadRequest {
    readonly deviceId: string;
    readonly payload: AgentContentReadPayload;
}
/** Host control-plane input for one exact task-free Agent-home projection. */
export interface AgentHomeProjectionRequest {
    readonly deviceId: string;
    readonly payload: AgentHomeProjectionPayload;
}
/** Reference-server readback. The default implementation is process-local only. */
export type AgentHomeProjectionStatusReadback = AgentHomeProjectionReadback;
/** First-write-wins reference-server readback for a reliable Agent egress item. */
export interface AgentEgressReceipt {
    readonly deviceId: string;
    readonly payload: AgentEgressReliablePayload;
    readonly receiptId: string;
    readonly recordedAt: string;
}
/** Outcome of a task that reached a terminal state. */
export interface TaskResult {
    state: Extract<TaskState, 'Complete' | 'Failed' | 'Cancelled'>;
    /** Every `progress` text of the task, joined with no separator. */
    summary?: string;
    /**
     * The runtime's closing reply, projected verbatim from
     * `task.complete.finalMessage`: the assistant text after the last tool
     * interaction, or the last whole message for Codex. Read the task's final
     * answer here; `summary` also holds commentary. Absent when the run ended
     * with no closing text, or when the daemon build predates the field.
     */
    finalMessage?: string;
    sessionRef?: string;
    artifactRefs?: BlobRef[];
    reason?: string;
    /**
     * The decline code (`agent_home_writer_busy` / `agent_home_reader_busy`).
     * Classify busy by this field; `reason` is display text only. A code this
     * version does not know reads as `unknown`, its raw token in `reportedCode`
     * (#1121). Absent on every other terminal.
     */
    code?: TaskDeclineCodeReading['code'];
    reportedCode?: string;
    retryable?: boolean;
    /**
     * The machine-readable runtime failure class of a failed task, read from
     * `task.fail.failure`: `class` (`unknown` when the runtime gave no
     * structured evidence, or when the class is one this version does not know,
     * its raw token then in `reportedClass` — #1121) and, on `quota`,
     * `resetsAt` when the runtime reported it. Classify failures by this field;
     * `reason` is display text only. Absent when the daemon predates the field.
     */
    failure?: TaskFailureReading;
    /**
     * The task's structured terminal result, projected verbatim from
     * `task.complete.document` (`@byok-sdk/protocol`'s `messages.ts`) — the
     * product's own JSON output, as opposed to `summary` (prose for a human)
     * or `artifactRefs` (files). `unknown` deliberately: the document's shape
     * is the offer's frozen `terminalProjection.schema`, which the daemon
     * validated the runtime's `submit_result` outcome against before staging
     * it. The wire schema enforced plain JSON within `RESULT_DOCUMENT_MAX_BYTES`
     * before this value ever reached the hub, so the projection neither
     * re-validates nor re-measures it.
     *
     * Absent whenever the daemon sent none: on every non-complete terminal, and
     * on a completion whose offer selected no `result-document` terminal
     * projection.
     *
     * Not stored by this package at all: the durable fact is the first terminal
     * receipt the kernel recorded (`readTerminalReceipt`/`readTaskResult`,
     * `@byok-sdk/cloud`), and every field here is projected off it on demand, so
     * there is no second authority for it to drift from.
     */
    document?: unknown;
}
/**
 * Normalized event stream for a dispatched task: incoming `task.progress`
 * AgentEvents, state transitions, and artifacts, folded into one feed so a
 * consumer only has to read one `events()` iterable per task.
 *
 * `event` is {@link AgentEventOrUnknown}, not the narrower `AgentEvent`
 * (pre-freeze tolerance, `@byok-sdk/protocol`'s `agent-event.ts`): an
 * unknown-type event — one a newer daemon/runtime-adapter minor version
 * produced that this build doesn't recognize — is forwarded here as-is
 * rather than dropped. It's still observability data a newer embedder UI
 * may understand even if this server doesn't; the reference server's job is
 * to tolerate and forward, not to decide what's renderable. Use the
 * exported `isKnownAgentEvent`/`partitionAgentEvents` helpers if a consumer
 * needs to distinguish the two.
 */
export type ServerTaskEvent = {
    kind: 'state';
    state: TaskState;
    at: string;
} | {
    kind: 'agent';
    event: AgentEventOrUnknown;
} | {
    kind: 'artifact';
    artifact: Extract<TaskArtifactPayload, {
        sealed?: undefined;
    }>;
} | {
    kind: 'await_approval';
    summary: string;
    approvalId: string;
} | {
    kind: 'error';
    reason: string;
    retryable?: boolean;
};
/**
 * One notification of a task's event feed, and the position to resume after
 * it. The feed is a notification stream, not a record: task facts stay with
 * `ByokServer.tasks.get` and `TaskHandle.result()`.
 */
export interface TaskEventEntry {
    /**
     * Opaque. Pass it as `after` to resume after this entry. Valid only for this
     * server instance's current feed of this task: a restart or a reclaimed feed
     * makes it unknown.
     */
    readonly cursor: string;
    readonly event: ServerTaskEvent;
}
/**
 * Thrown by the first `next()` of `ByokServer.tasks.events` or
 * {@link TaskHandle.events}, before any entry, when the read cannot continue
 * from where the caller asked. Read the task's current facts with
 * `ByokServer.tasks.get` instead.
 *
 * - `cursor_unknown`: `after` names no position in this instance's current
 *   feed of the task (a restart, another task's cursor, or a malformed one).
 * - `feed_expired`: the task is terminal and this instance retains no feed for
 *   it, because retention reclaimed it or the task ended before this instance
 *   started.
 */
export declare class TaskEventsUnavailableError extends Error {
    readonly taskId: string;
    readonly reason: 'cursor_unknown' | 'feed_expired';
    constructor(taskId: string, reason: 'cursor_unknown' | 'feed_expired');
}
/** Handle returned by {@link ByokServer.dispatch} for one in-flight task. */
export interface TaskHandle {
    readonly taskId: string;
    /**
     * Replay retained notifications and follow live updates until terminal: the
     * events of `ByokServer.tasks.events(taskId)`, without cursors. A read after
     * terminal retention expires throws {@link TaskEventsUnavailableError}
     * (`feed_expired`) on its first `next()`; a read after the server stops
     * completes empty. Durable terminal facts remain available through
     * `result()` and `ByokServer.tasks.get`.
     */
    events(): AsyncIterable<ServerTaskEvent>;
    cancel(reason?: string): Promise<void>;
    /** Settle this task as one no device will finish (`ByokCloud.abandonTask`); a terminal task is left as it is. */
    abandon(cause: TaskAbandonCause): Promise<void>;
    /**
     * M5 (approval targeting, docs/protocol.md §5.3): `opts.approvalId`
     * targets a SPECIFIC pending approval rather than "whichever one is
     * currently pending" (the default when `opts` is omitted: the decision then
     * names the pending approval's own id). Thin wrapper over `ByokCloud.approveTask` (`@byok-sdk/cloud`) —
     * see that method's own doc comment for the full targeting/staleness
     * semantics, including when this throws `StaleApprovalError` (re-exported
     * from this package's index for a caller to catch/inspect). The host's
     * decision is authoritative immediately: it is recorded on the task's
     * durable approval timeline, so the task reads `Running` again without
     * waiting for the runtime to report back.
     */
    approve(opts?: {
        approvalId?: string;
    }): Promise<void>;
    /** M5: same `opts.approvalId` targeting semantics as {@link approve} above. */
    reject(reason?: string, opts?: {
        approvalId?: string;
    }): Promise<void>;
    steer(text: string): Promise<void>;
    result(): Promise<TaskResult>;
}
/** Durable device identity plus its optional, unexpired presence lease. */
export interface MachineInfo {
    deviceId: string;
    deviceName: string;
    /** True exactly while the single TTL observation is unexpired; never an admission gate. */
    connected: boolean;
    /** Most recent live observation. Omitted when the lease is absent or expired. */
    lastSeen?: string;
    clientVersion?: string;
    runtimes?: readonly PresenceRuntimeFact[];
    harnesses?: readonly HarnessInfo[];
    configuredToolsets?: readonly string[];
}
/**
 * Projection of one task, read back from the cloud kernel's durable authority
 * (`TaskAttempt` plus its terminal receipt and approval timeline,
 * `@byok-sdk/cloud`) on every call — never a mirrored record this package
 * maintains alongside it.
 *
 * Deliberately smaller than it used to be: `instruction`, `runtime` and
 * `requiredToolsets` were DISPATCH INPUT the host already holds and the
 * kernel does not persist (ADR-028 — an attempt records ownership and
 * disposition, not the request that produced it). A host that wants them back
 * keeps its own map keyed by `taskId`; this snapshot never re-derives them.
 */
export interface TaskSnapshot {
    taskId: string;
    /**
     * The wire {@link TaskState} this attempt projects to. Derived, in this
     * order: an accepted host cancellation is `Cancelled` whatever the runtime
     * later says; a terminal attempt is its own terminal; otherwise an
     * unresolved approval on the task's timeline is `AwaitApproval`; otherwise
     * the attempt's own coarse status.
     */
    state: TaskState;
    deviceId?: string;
    sessionRef?: string;
    /** Exact Agent identity for an Agent-bound task; absent for legacy tasks. */
    agentRef?: AgentRef;
    /**
     * Creation time from the immutable offer receipt, preserved after terminal
     * transitions and SQLite restart. Independent of mailbox delivery time.
     */
    createdAt: string;
    updatedAt: string;
    result?: TaskResult;
    /**
     * M5 (approval targeting, docs/protocol.md §5.3): the daemon-reported
     * `approvalId` for the CURRENT `AwaitApproval` cycle, if one is pending —
     * `undefined` whenever the task isn't currently awaiting approval.
     *
     * DERIVED, not stored: it is `pendingApproval()`'s fold over the task's
     * durable approval timeline (`@byok-sdk/cloud`), the same single authority
     * the kernel's `approveTask`/`rejectTask` staleness gate reads. A resolution
     * — reported by the daemon, or recorded by this façade when the host
     * resolves one — clears the slot there, so a later `AwaitApproval` cycle can
     * never inherit a stale id and this projection can never disagree with the
     * gate.
     */
    pendingApprovalId?: string;
    /**
     * M5 (claimed runtime, docs/protocol.md §3.1): the ACTUAL adapter the
     * daemon reports having selected for this task (`task.claim.runtime`,
     * snapshotted by the kernel's inbound gate at the `offered -> claimed`
     * ownership CAS) — covers both the explicit-runtime
     * path (echoes {@link runtime}) and the auto-select/pi-first path (a value
     * where {@link runtime} is `undefined`, since no preference was ever
     * requested). `undefined` until the first `task.claim` for this task
     * arrives, and forever after for a legacy daemon that predates this field
     * (an old daemon's `task.claim` simply omits it). Set exactly once, at the
     * `Offered -> Claimed` transition, and never modified again afterward — a
     * retried/idempotent claim from the same device is a no-op that never
     * reaches `onClaim`'s patch at all (see `onClaim`'s own doc comment), so
     * this can never be silently overwritten by a redelivered claim. Read
     * straight off `TaskAttempt.claimedRuntime` (`@byok-sdk/cloud`).
     */
    claimedRuntime?: RuntimeId;
    claimedHarnessId?: string;
    /**
     * S0/D-4 (runtime-honest control surface): the capability block the
     * CLAIMING adapter reported for itself on its own `task.claim`
     * (`TaskClaimPayload.capabilities`, `@byok-sdk/protocol`), snapshotted at the
     * exact moment of the `Offered -> Claimed` transition and read straight off
     * `TaskAttempt.claimedRuntimeCapabilities` (`@byok-sdk/cloud`).
     *
     * Sourced from the claim and from nothing else. The connection-level
     * `conn.hello.runtimes[].capabilities` is discovery data — it describes a
     * device rather than the adapter that claimed this task — so it is never
     * read here or by the gate; see `SteerRejectedError`
     * (`@byok-sdk/cloud`'s `steer-control.ts`) for the full argument.
     *
     * A SNAPSHOT, deliberately — not a live read of anything: the same device
     * can reconnect later with a different adapter set (a runtime upgraded,
     * removed, or newly installed mid-task), and a task that is already running
     * must keep being judged against what was true when it was claimed.
     * `ByokCloud.steerTask` is the consumer: it fails closed with a
     * `SteerRejectedError` unless this snapshot says `steer === true`, BEFORE
     * any `task.steer` envelope exists.
     *
     * `undefined` means "this server does not know" — never "supported" and
     * never "unsupported as a fact". It stays `undefined` when the claim carried
     * no `capabilities` (a pre-D-4 daemon; the wire field is optional) and for
     * every task record written before S0 existed. Both are treated as a refusal
     * by the steer gate rather than filled in with a guessed default.
     *
     * Written exactly once, alongside {@link claimedRuntime}, on the first
     * real claim — a retried/idempotent claim returns from `onClaim` before
     * the patch, so this can never be silently rewritten later.
     */
    claimedRuntimeCapabilities?: RuntimeCapabilities;
}
/**
 * Cross-cutting server event feed (task creation/state changes, approval
 * resolutions, rate-limit episodes) — the "event hub" from the plan's
 * 服务端参考实现 section, as opposed to `TaskHandle.events()` which is scoped
 * to one task. Not part of the pinned wire contract; a server-embedder-facing
 * convenience.
 *
 * `device.connected` / `device.disconnected` are deliberately GONE (WP3B §1.2
 * option A). Both were edges of a live WebSocket registration; over the
 * long-poll transport the only honest connection signals are a device's own
 * `conn.hello` and its polling, and synthesising edges out of a TTL would
 * publish transitions no device ever made. `machines.list()` reports the
 * observation itself instead.
 */
/** A failed event has a report for step failures, or errorCode for a pass fault. */
export type ByokServerEvent = {
    readonly kind: 'maintenance.completed';
    readonly report: MaintenanceReport;
} | {
    readonly kind: 'maintenance.failed';
    readonly report: MaintenanceReport;
} | {
    readonly kind: 'maintenance.failed';
    readonly errorCode: string;
} | {
    kind: 'task.created';
    taskId: string;
    at: string;
} | {
    kind: 'task.state';
    taskId: string;
    state: TaskState;
    at: string;
    /**
     * M5 (claimed runtime): mirrors {@link TaskSnapshot.claimedRuntime} at
     * the moment of this transition — `undefined` until (and unless) the
     * daemon's `task.claim` reported one, so it first appears on the
     * `Offered -> Claimed` event and stays whatever value it had from then
     * on for every later transition of the same task. See that field's own
     * doc comment for the requested-vs-claimed distinction
     * (docs/protocol.md §3.1).
     */
    claimedRuntime?: RuntimeId;
    claimedHarnessId?: string;
}
/**
 * The daemon reported a locally-resolved approval with the wire
 * `task.approval_resolved` message. Carries the `approvalId`/`decision`/
 * `resolvedBy` the daemon reported, so an embedder can render or audit
 * exactly what was resolved. `resolvedBy` is currently always `'local'`
 * (`@byok-sdk/protocol`'s `TaskApprovalResolvedPayloadSchema`). This report
 * is the only way the server learns of a local resolution; it does not
 * infer one from later task traffic.
 */
 | ({
    kind: 'task.approval_resolved';
    taskId: string;
    at: string;
} & Pick<TaskApprovalResolvedPayload, 'approvalId' | 'decision' | 'resolvedBy'>)
/**
 * M4 Phase 4 (part A): `deviceId` exceeded its rate limit
 * (`CreateByokServerOptions.rateLimit`, enforced at the cloud kernel's
 * device route admission) — fired ONCE PER EPISODE, not once per refused
 * admission: the first refusal emits it, and only a later successful consume
 * by the same device re-arms it, so a flood is one event and a device that
 * recovers and floods again is a second, distinct one. Never a silent drop
 * either way: every refused admission counts in
 * {@link HubStats.rateLimitEvents}, and its request is answered `429`.
 */
 | {
    kind: 'device.rate_limited';
    deviceId: string;
    at: string;
};
/**
 * Plain, serializable snapshot returned by `ByokServer.stats()` — M4 Phase 4
 * (part B.1).
 *
 * `envelopesOut` went with the in-process outbox that produced it: server ->
 * daemon envelopes are durable mailbox rows owned by the cloud kernel now, and
 * a counter here would be a second, weaker authority over a fact the mailbox
 * already holds exactly.
 *
 * Deliberately
 * NOT exposed over HTTP by this SDK (see `CreateByokServerOptions.healthzRoute`'s
 * doc comment): an embedder that wants any of this surfaced remotely builds
 * its own authenticated route around `ByokServer.stats()`.
 */
export interface HubStats {
    /** Devices whose presence lease is live right now — see {@link MachineInfo.connected}. */
    connectedDeviceCount: number;
    /**
     * Store-aggregated settled counts plus active task/approval projections.
     * Exact at quiescence; a task settling between reads can be temporarily absent.
     * This is not a transaction snapshot. SQLite persists attempts, cancellation
     * and approval timelines; unexpired approvals survive reopen without extending TTL.
     */
    taskCountsByState: Record<TaskState, number>;
    /** Total inbound daemon->server envelopes since this server instance was created (every outcome, including rejected and rate-limited batches), counted at batch admission. Resets on SQLite reopen. */
    envelopesIn: number;
    /** Inbound dedup hits since this server instance was created; a no-op wire-level success. Resets on SQLite reopen. */
    dedupDrops: number;
    /** Refused rate-limit admissions since this server instance was created: rate-limited message batches plus rate-limited device route requests — see `device.rate_limited` on {@link ByokServerEvent}. Resets on SQLite reopen. */
    rateLimitEvents: number;
    /** Every closed refusal reason, zero-filled; counted since this server instance was created. Rate limiting is separate. */
    inboundRefusals: Record<InboundRefusalReason, number>;
    /** Milliseconds since `createByokServer` returned this instance. */
    uptimeMs: number;
}
/** Display-only draft notifications. The accepted message stays authoritative. */
export type AgentMessageDraftEvent = {
    readonly kind: 'append';
    readonly revision: number;
    readonly offset: number;
    readonly text: string;
} | {
    readonly kind: 'overflow';
    readonly revision: number;
    readonly byteCount: number;
} | {
    readonly kind: 'gap';
    readonly revision: number;
} | {
    readonly kind: 'ended';
} | {
    readonly kind: 'discarded';
};
export {};
// ==== @byok-sdk/server dist/wakes/types.d.ts ====
/** One Host-owned, one-shot wall-clock wake. Periodic rules remain in the Host. */
export interface WakeScheduleInput {
    dedupKey: string;
    availableAt: number;
    payload?: string;
}
export interface WakeScheduleResult {
    wakeId: string;
    accepted: boolean;
}
export interface DueWake {
    wakeId: string;
    dedupKey: string;
    availableAt: number;
    deliveredAt: number;
    delivery: number;
    payload?: string;
}
export interface WakeRecord {
    wakeId: string;
    dedupKey: string;
    availableAt: number;
    state: 'queued' | 'delivering';
    deliveries: number;
    lastError?: string;
    retryAt?: number;
    payload?: string;
}
export interface WakeConsumer {
    consume(wake: DueWake, signal: AbortSignal): Promise<void>;
}
export declare class WakeHookMissingError extends Error {
    constructor();
}
export declare class WakeConflictError extends Error {
    constructor();
}
export type WakeInputErrorCode = 'WAKE_DEDUP_KEY_INVALID' | 'WAKE_AVAILABLE_AT_INVALID' | 'WAKE_PAYLOAD_TOO_LARGE';
export declare class WakeInputError extends Error {
    readonly code: WakeInputErrorCode;
    constructor(code: WakeInputErrorCode);
}
export declare class WakeClosedError extends Error {
    constructor();
}
export declare const WAKE_WAIT_MS = 60000;
export declare const WAKE_RETENTION_MS: number;
/** Maximum allowed delay from the current time for a scheduled wake. */
export declare const WAKE_MAX_FUTURE_MS: number;
export declare function validateWakeKey(key: unknown): asserts key is string;
export declare function validateWakeInput(input: WakeScheduleInput, now: number): WakeScheduleInput;
