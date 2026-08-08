/**
 * `LocalStoragePolicy`, the watermark state machine, and the classified GC
 * engine (architecture §12.7.2.1).
 *
 * §12.7.2 gives the daemon a database it must not lose. This file is the other
 * half of that promise: a machine that runs out of disk cannot commit an
 * ack-critical transaction, and a daemon that keeps acking mailbox rows it
 * cannot durably record is losing tasks. So local storage stops being an
 * operational afterthought and becomes an admission-control input.
 *
 * Three shapes here are load-bearing:
 *
 * - **The state machine is §12.7.2.1's table, not a threshold check.** Four
 *   states with distinct *behaviours*: `normal` runs unhurried maintenance;
 *   `pressure` alerts and cleans only what can be rebuilt; `hard-pressure`
 *   stops taking NEW work while everything that finishes existing work keeps
 *   running; `emergency` refuses to ack at all. The difference between
 *   `hard-pressure` and `emergency` is the whole design: one declines offers
 *   (a task the dispatcher can place elsewhere), the other freezes the cursor
 *   (a task the mailbox will redeliver). Neither deletes anything to make room.
 * - **Cleanup is ordered and bounded, and it cannot name protected data.**
 *   The order is §12.7.2.1's 1-5, verbatim. The categories are
 *   {@link CleanableCategory}, which has no member for an unacked envelope, a
 *   `Running` task, an unconfirmed terminal, a recovery-marked row, a user
 *   workspace, or quarantine evidence — so no amount of pressure can express
 *   deleting one. Under pressure the order is TRUNCATED to its rebuildable
 *   prefix rather than extended: being short of disk is the worst moment to
 *   start deleting durable records, and the two cheap categories are the ones
 *   that give space back immediately.
 * - **Everything measurable is injected.** Usage comes from the journal, free
 *   space from a provider (`fs.statfs` in production), time from a clock, and
 *   the cadence from a caller-driven `tick()`. There is no wall-clock race
 *   anywhere in this file's behaviour, which is what lets the S3.4 disk-pressure
 *   matrix assert state transitions instead of waiting for them.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  CategoryUsage,
  CleanableCategory,
  CleanupCandidate,
  CleanupResult,
  CompactResult,
  LocalStorageUsage,
  LocalTaskJournal,
  StorageCategory,
} from './journal';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** §12.7.2.1's recommended soft watermark: "达到约 80% budget". */
export const DEFAULT_SOFT_BUDGET_RATIO = 0.8;
/** §12.7.2.1's recommended hard watermark: "达到约 90% budget". */
export const DEFAULT_HARD_BUDGET_RATIO = 0.9;
/**
 * Free bytes below which one ack-critical transaction can no longer be
 * guaranteed, i.e. §12.7.2.1's `emergency` trigger. Sized for a WAL frame
 * batch plus the checkpoint headroom a `synchronous=FULL` commit needs, not
 * for a single row — a commit that cannot grow the WAL fails as surely as one
 * that cannot grow the database.
 */
export const DEFAULT_ACK_CRITICAL_RESERVE_BYTES = 8 * 1024 * 1024;
/** Upper bound on how many candidates one cleanup pass may act on. Bounded so a pass cannot monopolise the journal's single writer. */
export const DEFAULT_CLEANUP_BATCH_LIMIT = 64;
/** Upper bound on freelist pages one compaction pass returns to the filesystem. */
export const DEFAULT_INCREMENTAL_VACUUM_PAGES = 64;
/** Unhurried maintenance cadence while `normal` — §12.7.2.1's "常规低频 GC/compaction". */
export const DEFAULT_NORMAL_COMPACTION_INTERVAL_MS = 60 * 60 * 1000;
/** The accelerated cadence §12.7.2.1 asks for at `pressure` and above ("加快 journal compaction"). */
export const DEFAULT_PRESSURE_COMPACTION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Per-category retention, as milliseconds between something becoming garbage
 * and becoming ELIGIBLE for automatic cleanup (§12.7.5).
 *
 * `confirmed-journal` is deliberately the longest: pruning a journal row also
 * drops its idempotency receipt, so its retention MUST outlast the mailbox
 * redelivery window, or a very late redelivery would re-append an envelope
 * this device already finished. `orphan-artifact` carries §12.7.5's 24-hour
 * grace period, which is the reference scan's safety margin, not a guess.
 */
export const DEFAULT_RETENTION_MS: Readonly<Record<CleanableCategory, number>> = {
  'expired-temp': 60 * 60 * 1000,
  'rotated-log': 7 * 24 * 60 * 60 * 1000,
  'confirmed-journal': 30 * 24 * 60 * 60 * 1000,
  'ephemeral-workspace': 24 * 60 * 60 * 1000,
  'orphan-artifact': 24 * 60 * 60 * 1000,
};

/**
 * Log rotation parameters (§12.7.2.1 lists them among a `LocalStoragePolicy`'s
 * minimum contents).
 *
 * This SDK does not own the daemon's log writer — the host does. These are
 * therefore the CONTRACT a host's rotator reads, and the reason they live here
 * rather than in host config is that the rotated files they produce become
 * `rotated-log` cleanup candidates governed by the same retention above. Two
 * separate numbers for "when to rotate" and "when to delete" is exactly how a
 * disk fills up with files nobody owns.
 */
export interface LogRotationPolicy {
  /** Rotate the active log once it exceeds this size. */
  readonly maxFileBytes: number;
  /** How many rotated generations to keep before the oldest becomes a `rotated-log` cleanup candidate. */
  readonly keepFiles: number;
}

export const DEFAULT_LOG_ROTATION: LogRotationPolicy = { maxFileBytes: 8 * 1024 * 1024, keepFiles: 5 };

/** Bounded compaction scheduling — see {@link LocalStoragePressureEngine.tick}. */
export interface CompactionPolicy {
  readonly incrementalVacuumPages: number;
  readonly normalIntervalMs: number;
  readonly pressureIntervalMs: number;
}

/**
 * The host-injected policy, resolved and validated (§12.7.2.1: "由 host/daemon
 * config 注入，至少包含 `maxStoreBytes`、`minFreeBytes`、soft/hard watermark、
 * 各数据类别的 retention、workspace policy 与 log rotation").
 */
export interface LocalStoragePolicy {
  /** Total bytes this daemon's store directory may occupy. The budget the soft/hard ratios apply to. */
  readonly maxStoreBytes: number;
  /** Free bytes on the store's filesystem below which this device is at HARD pressure regardless of its own budget. */
  readonly minFreeBytes: number;
  /** Free bytes below which this device is at SOFT pressure. Defaults to twice {@link minFreeBytes}, so pressure engages one doubling before the floor. */
  readonly softMinFreeBytes: number;
  readonly softBudgetRatio: number;
  readonly hardBudgetRatio: number;
  readonly ackCriticalReserveBytes: number;
  readonly retentionMs: Readonly<Record<CleanableCategory, number>>;
  readonly logRotation: LogRotationPolicy;
  readonly cleanupBatchLimit: number;
  readonly compaction: CompactionPolicy;
}

/** What a host actually writes. Everything but the two budget numbers has a §12.7.2.1 default. */
export interface LocalStoragePolicyInput {
  maxStoreBytes: number;
  minFreeBytes: number;
  softMinFreeBytes?: number;
  softBudgetRatio?: number;
  hardBudgetRatio?: number;
  ackCriticalReserveBytes?: number;
  retentionMs?: Partial<Record<CleanableCategory, number>>;
  logRotation?: Partial<LogRotationPolicy>;
  cleanupBatchLimit?: number;
  compaction?: Partial<CompactionPolicy>;
}

/**
 * Thrown when a storage policy is internally inconsistent or out of range.
 *
 * Rejected at CONSTRUCTION, before a daemon exists, for the same reason
 * `JournalUnavailableError` is: a policy whose hard watermark sits below its
 * soft one, or whose budget is zero, produces a daemon that behaves plausibly
 * until the day it matters. There is no clamping and no "closest sensible
 * value" here — a misconfigured durability policy is a configuration bug to
 * fix, not a number to guess at.
 */
export class LocalStoragePolicyError extends Error {
  constructor(field: string, reason: string) {
    super(`DaemonConfig.hostedJournal.storagePolicy.${field} ${reason}`);
    this.name = 'LocalStoragePolicyError';
  }
}

/**
 * Thrown by {@link LocalStoragePressureEngine.assertAckCriticalAllowed} while
 * the device is in `emergency`.
 *
 * Thrown from the daemon's envelope handler, BEFORE the journal append, which
 * is what makes it §12.7.2.1's "fail-closed，不 ack 新 mailbox row": the
 * handler rejects, so `ConnectionManager` records a stall instead of advancing
 * the cursor, so the mailbox keeps the row and redelivers it. The task is not
 * lost — it is left where it is still safe, which is the cloud.
 */
export class LocalStorageEmergencyError extends Error {
  constructor(reason: string) {
    super(
      `local storage is in emergency state and cannot guarantee an ack-critical journal transaction (${reason}); ` +
        'refusing to accept this envelope so the mailbox keeps it and redelivers. No local record was deleted to make room.',
    );
    this.name = 'LocalStorageEmergencyError';
  }
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new LocalStoragePolicyError(field, `must be a positive integer number of bytes — got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireRatio(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new LocalStoragePolicyError(field, `must be a ratio in (0, 1] — got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new LocalStoragePolicyError(field, `must be a non-negative integer — got ${JSON.stringify(value)}`);
  }
  return value;
}

const CLEANABLE_CATEGORIES: readonly CleanableCategory[] = [
  'expired-temp',
  'rotated-log',
  'confirmed-journal',
  'ephemeral-workspace',
  'orphan-artifact',
];

/**
 * Validate and fill in a host's policy. The ONE place a `LocalStoragePolicy`
 * comes into existence, so every consumer downstream can treat its fields as
 * already checked.
 */
export function resolveLocalStoragePolicy(input: LocalStoragePolicyInput): LocalStoragePolicy {
  if (input === null || typeof input !== 'object') {
    throw new LocalStoragePolicyError('', 'must be an object with at least maxStoreBytes and minFreeBytes');
  }
  const maxStoreBytes = requirePositiveInt(input.maxStoreBytes, 'maxStoreBytes');
  const minFreeBytes = requirePositiveInt(input.minFreeBytes, 'minFreeBytes');
  const softMinFreeBytes = requirePositiveInt(input.softMinFreeBytes ?? minFreeBytes * 2, 'softMinFreeBytes');
  const softBudgetRatio = requireRatio(input.softBudgetRatio ?? DEFAULT_SOFT_BUDGET_RATIO, 'softBudgetRatio');
  const hardBudgetRatio = requireRatio(input.hardBudgetRatio ?? DEFAULT_HARD_BUDGET_RATIO, 'hardBudgetRatio');
  if (softBudgetRatio >= hardBudgetRatio) {
    throw new LocalStoragePolicyError(
      'softBudgetRatio',
      `must be strictly below hardBudgetRatio — got soft=${softBudgetRatio}, hard=${hardBudgetRatio}. A soft watermark at or above the hard one means the device would never get a warning state at all.`,
    );
  }
  if (softMinFreeBytes < minFreeBytes) {
    throw new LocalStoragePolicyError(
      'softMinFreeBytes',
      `must be at least minFreeBytes — got soft=${softMinFreeBytes}, min=${minFreeBytes}. A soft free-space floor below the hard one is unreachable.`,
    );
  }
  const ackCriticalReserveBytes = requirePositiveInt(
    input.ackCriticalReserveBytes ?? DEFAULT_ACK_CRITICAL_RESERVE_BYTES,
    'ackCriticalReserveBytes',
  );
  if (ackCriticalReserveBytes > minFreeBytes) {
    throw new LocalStoragePolicyError(
      'ackCriticalReserveBytes',
      `must not exceed minFreeBytes — got reserve=${ackCriticalReserveBytes}, min=${minFreeBytes}. An emergency floor above the hard floor would put the device into emergency without ever passing through hard pressure, skipping the admission decline that is supposed to prevent it.`,
    );
  }

  const retentionMs: Record<CleanableCategory, number> = { ...DEFAULT_RETENTION_MS };
  for (const [key, value] of Object.entries(input.retentionMs ?? {})) {
    if (!CLEANABLE_CATEGORIES.includes(key as CleanableCategory)) {
      throw new LocalStoragePolicyError(
        `retentionMs.${key}`,
        `is not a cleanable category. Retention can only be configured for ${CLEANABLE_CATEGORIES.join(', ')} — protected data (unacked envelopes, live tasks, unconfirmed terminals, recovery-marked records, user workspaces, quarantine evidence) has no retention because it is never auto-deleted (§12.7.2.1).`,
      );
    }
    retentionMs[key as CleanableCategory] = requireNonNegativeInt(value, `retentionMs.${key}`);
  }

  const logRotation: LogRotationPolicy = {
    maxFileBytes: requirePositiveInt(input.logRotation?.maxFileBytes ?? DEFAULT_LOG_ROTATION.maxFileBytes, 'logRotation.maxFileBytes'),
    keepFiles: requireNonNegativeInt(input.logRotation?.keepFiles ?? DEFAULT_LOG_ROTATION.keepFiles, 'logRotation.keepFiles'),
  };

  const compaction: CompactionPolicy = {
    incrementalVacuumPages: requirePositiveInt(
      input.compaction?.incrementalVacuumPages ?? DEFAULT_INCREMENTAL_VACUUM_PAGES,
      'compaction.incrementalVacuumPages',
    ),
    normalIntervalMs: requirePositiveInt(
      input.compaction?.normalIntervalMs ?? DEFAULT_NORMAL_COMPACTION_INTERVAL_MS,
      'compaction.normalIntervalMs',
    ),
    pressureIntervalMs: requirePositiveInt(
      input.compaction?.pressureIntervalMs ?? DEFAULT_PRESSURE_COMPACTION_INTERVAL_MS,
      'compaction.pressureIntervalMs',
    ),
  };
  if (compaction.pressureIntervalMs > compaction.normalIntervalMs) {
    throw new LocalStoragePolicyError(
      'compaction.pressureIntervalMs',
      `must not be longer than compaction.normalIntervalMs — got pressure=${compaction.pressureIntervalMs}, normal=${compaction.normalIntervalMs}. §12.7.2.1 requires compaction to ACCELERATE under pressure.`,
    );
  }

  return {
    maxStoreBytes,
    minFreeBytes,
    softMinFreeBytes,
    softBudgetRatio,
    hardBudgetRatio,
    ackCriticalReserveBytes,
    retentionMs,
    logRotation,
    cleanupBatchLimit: requirePositiveInt(input.cleanupBatchLimit ?? DEFAULT_CLEANUP_BATCH_LIMIT, 'cleanupBatchLimit'),
    compaction,
  };
}

/**
 * When something that became garbage at `since` becomes eligible for automatic
 * cleanup. The ONE place retention turns into a timestamp, so a producer
 * calling `enqueueCleanupCandidate` and this engine consuming it agree by
 * construction rather than by two matching constants.
 */
export function cleanupEligibleAt(policy: LocalStoragePolicy, category: CleanableCategory, since: Date): string {
  return new Date(since.getTime() + policy.retentionMs[category]).toISOString();
}

// ---------------------------------------------------------------------------
// The watermark state machine (§12.7.2.1's table)
// ---------------------------------------------------------------------------

/**
 * §12.7.2.1's four states, verbatim:
 *
 * | state | trigger | behaviour |
 * | --- | --- | --- |
 * | `normal` | below soft | unhurried GC/compaction |
 * | `pressure` | ≥ soft budget, or free below the soft minimum | alert; clean only rebuildable/expired categories; accelerate compaction |
 * | `hard-pressure` | ≥ hard budget, or free below the hard minimum | stop admitting new ordinary tasks; terminal/truth flush, delete, export and recovery all continue |
 * | `emergency` | one ack-critical transaction can no longer be guaranteed | fail closed: do not ack new mailbox rows; preserve existing recovery evidence |
 */
export type StoragePressureState = 'normal' | 'pressure' | 'hard-pressure' | 'emergency';

export interface StorageMeasurement {
  readonly usage: LocalStorageUsage;
  readonly freeBytes: number;
}

/**
 * The state machine itself — a pure function of policy, measurement, and
 * whether an ack-critical write has already been observed to fail.
 *
 * Evaluated worst-first: `emergency` is not "very bad pressure", it is a
 * different claim (the next commit may not land), so it is decided before any
 * budget arithmetic. `latchedFailure` exists because the cheapest evidence
 * that a transaction cannot complete is one that already did not: a disk-full
 * error from an ack-critical write is a fact, where free-space arithmetic is
 * an estimate.
 */
export function computePressureState(
  policy: LocalStoragePolicy,
  measurement: StorageMeasurement,
  latchedFailure?: string,
): StoragePressureState {
  if (latchedFailure !== undefined) return 'emergency';
  if (measurement.freeBytes < policy.ackCriticalReserveBytes) return 'emergency';
  if (
    measurement.usage.totalBytes >= policy.maxStoreBytes * policy.hardBudgetRatio ||
    measurement.freeBytes < policy.minFreeBytes
  ) {
    return 'hard-pressure';
  }
  if (
    measurement.usage.totalBytes >= policy.maxStoreBytes * policy.softBudgetRatio ||
    measurement.freeBytes < policy.softMinFreeBytes
  ) {
    return 'pressure';
  }
  return 'normal';
}

/**
 * §12.7.2.1's cleanup order, 1-5:
 *
 * 1. expired upload/download temp files and rebuildable caches;
 * 2. rotated logs past their retention;
 * 3. journal rows for tasks whose terminal the cloud confirmed and that carry
 *    no recovery marker — **compact first, then batch delete**;
 * 4. host-marked ephemeral workspaces for tasks already terminal;
 * 5. orphan artifacts, after a reference scan plus grace period.
 *
 * Under pressure the order is TRUNCATED to steps 1-2, not extended. Steps 3-5
 * touch durable records, need a compaction or a reference scan first, and give
 * their space back slowly; steps 1-2 are pure rebuildable garbage and give it
 * back immediately. Deleting durable evidence is exactly the wrong reflex when
 * the disk is nearly full, so it stays on the unhurried `normal` cadence where
 * a mistake is recoverable.
 */
export function cleanupOrderFor(state: StoragePressureState): readonly CleanableCategory[] {
  return state === 'normal'
    ? (['expired-temp', 'rotated-log', 'confirmed-journal', 'ephemeral-workspace', 'orphan-artifact'] as const)
    : (['expired-temp', 'rotated-log'] as const);
}

// ---------------------------------------------------------------------------
// The cleanup worker seam
// ---------------------------------------------------------------------------

/** What a {@link CleanupExecutor} did with one candidate. Mirrors {@link CleanupResult} minus the bookkeeping the engine fills in. */
export interface CleanupExecution {
  readonly outcome: 'deleted' | 'skipped' | 'failed';
  readonly bytesReclaimed?: number;
  readonly error?: string;
}

/**
 * Performs one candidate's actual deletion.
 *
 * A seam rather than a method because the journal owns metadata and the
 * filesystem owns bytes, and the crash window BETWEEN them (delete the file,
 * die before marking; mark, die before deleting) is S3.4 point 12. Keeping
 * them separate is what lets that window be tested at all.
 *
 * It receives a {@link CleanupCandidate}, whose `category` is a
 * {@link CleanableCategory} — so an executor cannot be handed protected data
 * even by a caller trying to.
 */
export type CleanupExecutor = (candidate: CleanupCandidate) => Promise<CleanupExecution>;

/** `confirmed-journal` candidates address a journal task, not a path. This prefix is that distinction, spelled out. */
export const JOURNAL_TASK_REF_PREFIX = 'task:';

async function pathBytes(target: string): Promise<number> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) total += await pathBytes(join(target, entry.name));
  return total;
}

/**
 * The default cleanup worker: filesystem removal for the four path-addressed
 * categories, and a delegated journal prune for `confirmed-journal`.
 *
 * Two deliberate behaviours:
 *
 * - **A missing path is `deleted`, not `failed`.** That is S3.4 point 12's
 *   first order (file gone, metadata not yet marked) converging on retry: the
 *   retry finds nothing to do and says so, rather than looping forever on a
 *   candidate whose work is already done.
 * - **A relative `ref` is refused.** Cleanup resolves paths against nothing —
 *   a relative ref would delete whatever the daemon's cwd happens to make it,
 *   which is not a bug worth having once.
 */
export function createFilesystemCleanupExecutor(
  options: { readonly pruneJournalTask?: (taskId: string) => Promise<boolean> } = {},
): CleanupExecutor {
  return async (candidate) => {
    if (candidate.category === 'confirmed-journal') {
      if (!candidate.ref.startsWith(JOURNAL_TASK_REF_PREFIX)) {
        return { outcome: 'failed', error: `a confirmed-journal candidate's ref must be "${JOURNAL_TASK_REF_PREFIX}<taskId>" — got ${JSON.stringify(candidate.ref)}` };
      }
      if (options.pruneJournalTask === undefined) {
        return { outcome: 'skipped', error: 'no journal prune hook is wired; journal rows are never removed by the filesystem worker' };
      }
      const taskId = candidate.ref.slice(JOURNAL_TASK_REF_PREFIX.length);
      const pruned = await options.pruneJournalTask(taskId);
      // Not pruned means the guard refused: the terminal is unconfirmed, or a
      // recovery marker appeared since this candidate was enqueued. `skipped`
      // resolves it without deleting anything, which is the correct outcome —
      // a protected row is not a failure to retry.
      return pruned ? { outcome: 'deleted' } : { outcome: 'skipped', error: 'the journal refused to prune this task (unconfirmed terminal, or a recovery marker)' };
    }
    if (!isAbsolute(candidate.ref)) {
      return { outcome: 'failed', error: `cleanup ref must be an absolute path — got ${JSON.stringify(candidate.ref)}` };
    }
    const bytes = await pathBytes(candidate.ref);
    try {
      await fs.rm(candidate.ref, { recursive: true, force: true });
    } catch (err) {
      return { outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
    return { outcome: 'deleted', bytesReclaimed: bytes };
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** What the status surface renders, and what a `tick()` hands back. */
export interface StorageStatusSnapshot {
  readonly state: StoragePressureState;
  readonly measuredAt: string;
  readonly budgetBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
  readonly categories: Readonly<Record<StorageCategory, CategoryUsage>>;
  readonly lastCompaction?: CompactResult & { readonly at: string };
}

export type StoragePressureEvent =
  /** §12.7.2.1's "发出告警" — emitted on every transition, including back down to `normal`. */
  | { readonly kind: 'state-changed'; readonly from: StoragePressureState; readonly to: StoragePressureState; readonly snapshot: StorageStatusSnapshot }
  | { readonly kind: 'cleanup'; readonly result: CleanupResult; readonly category: CleanableCategory }
  | { readonly kind: 'compaction'; readonly result: CompactResult };

export interface StorageTickResult {
  readonly state: StoragePressureState;
  readonly snapshot: StorageStatusSnapshot;
  readonly cleaned: readonly CleanupResult[];
  readonly compaction?: CompactResult;
}

export interface TimerLike {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LocalStoragePressureEngineOptions {
  readonly policy: LocalStoragePolicy | LocalStoragePolicyInput;
  readonly journal: LocalTaskJournal;
  /** Free bytes on the store's filesystem. `fs.statfs` in production (see {@link createStatfsFreeBytesProvider}); a fixed number under test. */
  readonly freeBytesProvider: () => number | Promise<number>;
  /** Performs deletions. Defaults to {@link createFilesystemCleanupExecutor}. */
  readonly executor?: CleanupExecutor;
  readonly clock?: () => Date;
  readonly onEvent?: (event: StoragePressureEvent) => void;
  /** Reports only the scheduler's own maintenance pass outcome; never includes task-domain failures. */
  readonly onMaintenanceOutcome?: (outcome: 'success' | 'failure') => void;
  /** Injected so `start()`'s periodic driver is substitutable; the matrix never uses it and drives {@link LocalStoragePressureEngine.tick} directly. */
  readonly timers?: TimerLike;
}

/**
 * Drives §12.7.2.1: measure, decide the state, clean in order, compact within
 * bounds — and answer the two questions the rest of the daemon asks
 * ({@link admissionGuard}, {@link assertAckCriticalAllowed}).
 *
 * The cadence is a caller-driven {@link tick}. `start()` merely arranges for
 * something to call it periodically, so a host with its own scheduler can skip
 * it entirely, and the disk-pressure matrix can advance state deterministically
 * with no timer at all. Nothing here runs on the envelope or task hot path:
 * the only two things the hot path calls are the two synchronous questions,
 * both of which read a field.
 */
export class LocalStoragePressureEngine {
  readonly policy: LocalStoragePolicy;
  readonly #journal: LocalTaskJournal;
  readonly #freeBytesProvider: () => number | Promise<number>;
  readonly #executor: CleanupExecutor;
  readonly #clock: () => Date;
  readonly #onEvent: ((event: StoragePressureEvent) => void) | undefined;
  readonly #onMaintenanceOutcome: ((outcome: 'success' | 'failure') => void) | undefined;
  readonly #timers: TimerLike;

  #state: StoragePressureState = 'normal';
  #snapshot: StorageStatusSnapshot | undefined;
  #latchedFailure: string | undefined;
  #lastCompaction: (CompactResult & { at: string }) | undefined;
  #nextCompactionAtMs = 0;
  #timer: unknown;
  #timerIntervalMs = 0;

  constructor(options: LocalStoragePressureEngineOptions) {
    // Resolved unconditionally, not "resolved if it looks unresolved": an
    // already-resolved policy is a valid input and comes back out unchanged, so
    // there is no shape-sniffing to get wrong, and an engine a host builds
    // directly gets the same up-front rejection `createDaemon` gives.
    this.policy = resolveLocalStoragePolicy(options.policy);
    this.#journal = options.journal;
    this.#freeBytesProvider = options.freeBytesProvider;
    this.#executor = options.executor ?? createFilesystemCleanupExecutor();
    this.#clock = options.clock ?? (() => new Date());
    this.#onEvent = options.onEvent;
    this.#onMaintenanceOutcome = options.onMaintenanceOutcome;
    this.#timers = options.timers ?? {
      setInterval: (handler, ms) => {
        const timer = setInterval(handler, ms);
        timer.unref?.();
        return timer;
      },
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    };
  }

  get state(): StoragePressureState {
    return this.#state;
  }

  /** The last measured snapshot, or `undefined` before the first {@link tick}. */
  snapshot(): StorageStatusSnapshot | undefined {
    return this.#snapshot;
  }

  /**
   * §12.7.2.1's hard-pressure row, as a `TaskRunnerDeps.admissionGuard`:
   * "停止接收新的普通 task；仍允许 terminal/truth flush、删除、导出、doctor 与
   * 恢复操作".
   *
   * The decline is RETRYABLE because pressure is a property of this device at
   * this moment — a dispatcher re-routing the task to another device genuinely
   * helps, and the same device may take it in a minute. Nothing in this method
   * touches the disk; it reads the state the last tick computed, so an offer
   * arriving between ticks is answered instantly.
   */
  admissionGuard(): { readonly admit: true } | { readonly admit: false; readonly reason: string; readonly retryable: boolean } {
    if (this.#state === 'hard-pressure') {
      return { admit: false, reason: 'local storage hard pressure', retryable: true };
    }
    if (this.#state === 'emergency') {
      return { admit: false, reason: 'local storage emergency: cannot guarantee an ack-critical journal transaction', retryable: true };
    }
    return { admit: true };
  }

  /** Throws {@link LocalStorageEmergencyError} while in `emergency`. Called immediately before every ack-critical journal append. */
  assertAckCriticalAllowed(): void {
    if (this.#state !== 'emergency') return;
    throw new LocalStorageEmergencyError(
      this.#latchedFailure ??
        `free space is below the ${this.policy.ackCriticalReserveBytes}-byte ack-critical reserve`,
    );
  }

  /**
   * Latch `emergency` from an ack-critical write that ACTUALLY failed.
   *
   * A commit that returned `SQLITE_FULL` is stronger evidence than any free-space
   * estimate, and it must not be forgotten on the next tick just because the
   * arithmetic happens to look survivable. The latch clears only when a tick
   * measures a genuinely `normal` device — not `pressure`, not `hard-pressure`:
   * coming back from "the disk refused a write" requires actual headroom, not a
   * borderline reading.
   */
  noteAckCriticalFailure(reason: string): void {
    this.#latchedFailure = reason;
    this.#transitionTo('emergency', this.#snapshot);
  }

  /**
   * One maintenance pass: measure, transition, clean in order, compact if due.
   *
   * Ordered this way on purpose — the cleanup pass acts on the state THIS
   * measurement produced, so a device that just crossed into pressure cleans on
   * the same tick it alerts, rather than one cadence later.
   */
  async tick(): Promise<StorageTickResult> {
    const usage = await this.#journal.measureUsage();
    const freeBytes = await this.#freeBytesProvider();
    const measurement: StorageMeasurement = { usage, freeBytes };

    // The latch clears only against a genuinely `normal` reading — see
    // `noteAckCriticalFailure` for why a borderline one is not enough.
    if (this.#latchedFailure !== undefined && computePressureState(this.policy, measurement) === 'normal') {
      this.#latchedFailure = undefined;
    }
    const state = computePressureState(this.policy, measurement, this.#latchedFailure);

    const snapshot: StorageStatusSnapshot = {
      state,
      measuredAt: usage.measuredAt,
      budgetBytes: this.policy.maxStoreBytes,
      usedBytes: usage.totalBytes,
      freeBytes,
      categories: usage.categories,
      ...(this.#lastCompaction ? { lastCompaction: this.#lastCompaction } : {}),
    };
    this.#snapshot = snapshot;
    if (state !== this.#state) this.#transitionTo(state, snapshot);

    const cleaned = await this.#runCleanupPass(state);
    const compaction = await this.#compactIfDue(state);

    // A compaction result that landed during THIS tick belongs to this tick's
    // snapshot; recomputing it here (rather than waiting for the next tick)
    // keeps `status` from reporting a stale "last compaction" immediately after
    // one ran.
    const finalSnapshot: StorageStatusSnapshot = this.#lastCompaction
      ? { ...snapshot, lastCompaction: this.#lastCompaction }
      : snapshot;
    this.#snapshot = finalSnapshot;

    return { state, snapshot: finalSnapshot, cleaned, ...(compaction ? { compaction } : {}) };
  }

  /** Begin periodic ticking. A host with its own scheduler need never call this. */
  start(): void {
    this.#arm(this.#intervalMs());
  }

  stop(): void {
    if (this.#timer !== undefined) this.#timers.clearInterval(this.#timer);
    this.#timer = undefined;
    this.#timerIntervalMs = 0;
  }

  #intervalMs(): number {
    return this.#state === 'normal' ? this.policy.compaction.normalIntervalMs : this.policy.compaction.pressureIntervalMs;
  }

  #arm(intervalMs: number): void {
    if (this.#timer !== undefined && this.#timerIntervalMs === intervalMs) return;
    if (this.#timer !== undefined) this.#timers.clearInterval(this.#timer);
    this.#timerIntervalMs = intervalMs;
    this.#timer = this.#timers.setInterval(() => {
      // A maintenance pass that throws (an unreadable journal, a filesystem
      // that will not answer statfs) must not take the process down from a
      // timer callback with no caller to reject to. The state simply does not
      // advance, which leaves the last known one in force — and the last known
      // one erring toward MORE restriction is the safe direction.
      void this.tick().then(
        () => this.#onMaintenanceOutcome?.('success'),
        (err: unknown) => {
          this.#onMaintenanceOutcome?.('failure');
          console.warn(
            `[byok/client] local storage maintenance pass failed (state stays "${this.#state}"): ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
    }, intervalMs);
  }

  #transitionTo(state: StoragePressureState, snapshot: StorageStatusSnapshot | undefined): void {
    if (state === this.#state) return;
    const from = this.#state;
    this.#state = state;
    if (this.#timer !== undefined) this.#arm(this.#intervalMs());
    if (snapshot !== undefined) {
      this.#onEvent?.({ kind: 'state-changed', from, to: state, snapshot: { ...snapshot, state } });
    }
  }

  /**
   * §12.7.2.1's ordered, bounded cleanup.
   *
   * One bounded batch is read from the journal and then walked in CATEGORY
   * order rather than the eligibility order the query returns — the order in
   * the spec is a priority, not a schedule, and a batch full of orphan
   * artifacts must not push the cheap rebuildable categories out of the pass.
   * The batch limit bounds the whole pass, not each category, so the total work
   * per tick is what the policy says it is.
   */
  async #runCleanupPass(state: StoragePressureState): Promise<CleanupResult[]> {
    const allowed = cleanupOrderFor(state);
    const now = this.#clock();
    const candidates = await this.#journal.listCleanupCandidates(now, this.policy.cleanupBatchLimit);
    const results: CleanupResult[] = [];

    for (const category of allowed) {
      const group = candidates.filter((candidate) => candidate.category === category);
      if (group.length === 0) continue;
      // §12.7.2.1 step 3, verbatim: "先 compact 再 batch delete". Pruning rows
      // out of a database whose WAL has not been applied yet just moves the
      // pages around; compacting first is what makes the delete actually
      // return space.
      if (category === 'confirmed-journal') await this.#compact(state);
      for (const candidate of group) {
        const result = await this.#execute(candidate);
        results.push(result);
        this.#onEvent?.({ kind: 'cleanup', result, category });
      }
    }
    return results;
  }

  async #execute(candidate: CleanupCandidate): Promise<CleanupResult> {
    let execution: CleanupExecution;
    try {
      execution = await this.#executor(candidate);
    } catch (err) {
      // The executor crashed mid-candidate — S3.4 point 12's first order. The
      // candidate stays UNRESOLVED (`failed` does not set `resolved_at`, see
      // `markCleanupResult`), so the next pass retries it; the retry finds the
      // work already done and converges.
      execution = { outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
    const result: CleanupResult = {
      candidateId: candidate.candidateId,
      outcome: execution.outcome,
      ...(execution.bytesReclaimed === undefined ? {} : { bytesReclaimed: execution.bytesReclaimed }),
      ...(execution.error === undefined ? {} : { error: execution.error }),
      at: this.#clock().toISOString(),
    };
    await this.#journal.markCleanupResult(result);
    return result;
  }

  async #compactIfDue(state: StoragePressureState): Promise<CompactResult | undefined> {
    const nowMs = this.#clock().getTime();
    if (nowMs < this.#nextCompactionAtMs) return undefined;
    return this.#compact(state);
  }

  /**
   * A bounded WAL checkpoint plus incremental vacuum.
   *
   * `truncate` above `normal` because that is the mode that actually returns
   * the WAL file's space; `passive` while normal because it never blocks a
   * reader and there is no hurry. Both are bounded by
   * `incrementalVacuumPages`, and both go through the journal's own
   * single-writer queue — so a compaction can never interleave with an
   * ack-critical append, and can never hold the queue for longer than that
   * page bound allows.
   */
  async #compact(state: StoragePressureState): Promise<CompactResult> {
    const result = await this.#journal.compact({
      checkpoint: state === 'normal' ? 'passive' : 'truncate',
      incrementalVacuumPages: this.policy.compaction.incrementalVacuumPages,
    });
    this.#lastCompaction = { ...result, at: this.#clock().toISOString() };
    this.#nextCompactionAtMs =
      this.#clock().getTime() +
      (state === 'normal' ? this.policy.compaction.normalIntervalMs : this.policy.compaction.pressureIntervalMs);
    this.#onEvent?.({ kind: 'compaction', result });
    return result;
  }
}

/**
 * Production free-space provider: bytes available to an unprivileged process
 * on the filesystem holding `dir`.
 *
 * `bavail`, not `bfree` — the reserved blocks `bfree` includes are not space
 * this daemon can write into, and treating them as headroom is how a device
 * discovers it is out of disk at commit time instead of at measurement time.
 */
export function createStatfsFreeBytesProvider(dir: string): () => Promise<number> {
  return async () => {
    const stats = await fs.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  };
}
