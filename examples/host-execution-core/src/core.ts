import { AsyncLocalStorage } from 'node:async_hooks';
import type { ByokServer, ByokServerEvent, CreateByokServerOptions, DueWake } from '@byok-sdk/server';
import { MemoryBlockedError, type HostMemoryPage, type MemoryBinding } from './memory';
import { HostLedger, OutboxFullError, type ApplicationRows } from './ledger';
import { canonical, hash, isSealed, project, taskId, time, validateJson, type HostJobHandler, type HostOccurrenceRun, type Attempt,
  type Intent, type IntentInput, type Json, type LedgerState, type Occurrence, type Routine, type RoutineDefinition, type SealedAgentExecutionInput, type Terminal } from './model';
import { nextIntervalOccurrence, type NextOccurrence } from './schedule';
import { applyPlan, auditCalendarError, auditIgnoredWake, deferSchedule, nextWake, occurrenceRun, promote, recordOccurrence, routineCommands, scheduleNext,
  switchVersion, versionSwitchDue, WAKE_HORIZON_MS, type RoutineCommands } from './routines';
import { cancelWake, enqueue, fifoHeads, queuedExpiry, settle } from './transitions';
import { frozenDelivered, SealedDispatchUnavailableError, submitFrozen, type FrozenSubmitPort } from './submit';

export type ExecutionServer = {
  /** `submitSealed` is the sealed lane (#654). Without it, the core fails a sealed intent before any submit. */
  executions: Pick<ByokServer['executions'], 'submit'> & Pick<FrozenSubmitPort, 'submitSealed'>;
  tasks: Pick<ByokServer['tasks'], 'offer' | 'deviceTerminal' | 'attempt' | 'cancel'>;
  wakes: ByokServer['wakes'];
  /** Embedded process-local hints; reads from tasks remain authoritative. */
  events?: ByokServer['events'];
};
// The server emits no event when the device terminal of a Host-cancelled task arrives.
// Each task gets this many read-only terminal probes, about 15.6 s in all, then only the `reconcileMs` scans.
const CANCEL_PROBE_TICKS = 20;
const CANCEL_PROBE_FIRST_MS = 25;
const CANCEL_PROBE_MAX_MS = 1000;
// A failed wake call gets this many timed drains, about 5 min in all. Later, only other drains retry it.
const WAKE_RETRY_LIMIT = 10;
const WAKE_RETRY_FIRST_MS = 1000;
const WAKE_RETRY_MAX_MS = 60_000;
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
export type MessageDecision = { outcome: 'accepted' | 'refused'; reasonCode?: string };
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
   * for a Host that has no owner for such an intent (K8 L and H).
   */
  hostJobExecution?: 'promote' | 'fail';
  occurrenceHooks?: Readonly<Record<string, OccurrenceHook>>;
  memory?: HostMemoryPage;
  now?: () => number;
  reconcileMs?: number;
  nextOccurrence?: NextOccurrence;
  /** Coalesced post-commit hint. May enqueue/flush reentrantly; failures retain projections. */
  onOutbox?: (signal: AbortSignal) => void | Promise<void>;
  applyMessage?: (input: AgentMessageInput, transaction: MessageTransaction) => MessageDecision;
  applyOutcome?: (document: unknown, transaction: OutcomeTransaction) => void;
}

/** One instance per embedded tenant. Only horizon retries use a process-local timer. */
export class HostExecutionCore {
  private readonly now: () => number;
  private readonly nextTime: NextOccurrence;
  private readonly reconcileMs: number;
  private draining?: Promise<void>;
  private again = false;
  private stopped = false;
  private stopMemoryUpdates?: () => void;
  private stopMemoryLedgerBinding?: () => void;
  private memoryWaking: Promise<void> = Promise.resolve();
  private eventIterator?: AsyncIterator<ByokServerEvent>;
  private eventPump?: Promise<void>;
  private eventsActive = false;
  private readonly liveTasks = new Set<string>();
  private liveScanTimer?: ReturnType<typeof setTimeout>;
  /** Task ID to used probe ticks and the next probe time (`performance.now()`). Rearming keeps both, so the bound is real. */
  private readonly cancelProbes = new Map<string, { used: number; at: number }>();
  private cancelProbeTimer?: ReturnType<typeof setTimeout>;
  private cancelProbing?: Promise<void>;
  private stopOutboxUpdates?: () => void;
  private outboxQueued = false;
  private outboxNotifying?: Promise<void>;
  private readonly outboxAbort = new AbortController();
  private readonly outboxContext = new AsyncLocalStorage<boolean>();
  private scheduleRetryTimer?: ReturnType<typeof setTimeout>;
  /** Outbox key of a failed wake call to its used timed retries and its pending timer. Rearming keeps the count. */
  private readonly wakeRetries = new Map<string, { used: number; timer?: ReturnType<typeof setTimeout> }>();
  private readonly hostJobs: Map<string, HostJobHandler>;
  private readonly occurrenceHooks: Map<string, OccurrenceHook>;
  private readonly jobAbort = new AbortController();
  constructor(readonly server: ExecutionServer, readonly ledger: HostLedger, private readonly options: HostOptions = {}) {
    this.hostJobs = new Map(Object.entries(options.hostJobs ?? {}));
    if (![undefined, 'promote', 'fail'].includes(options.hostJobExecution)) throw new Error('Invalid hostJobExecution');
    this.occurrenceHooks = new Map(Object.entries(options.occurrenceHooks ?? {}));
    if (options.memory && options.memory.ledger.tenant !== ledger.tenant) throw new Error('Memory tenant must match execution tenant');
    this.now = () => time((options.now ?? Date.now)());
    this.nextTime = options.nextOccurrence ?? nextIntervalOccurrence;
    this.reconcileMs = time(options.reconcileMs ?? 1000);
    if (this.reconcileMs < 1) throw new Error('Reconciliation interval must be positive');
    this.stopMemoryLedgerBinding = options.memory?.bindExecutionLedger(ledger);
    this.stopOutboxUpdates = ledger.onOutbox(() => this.notifyOutbox());
    if (server.events) {
      this.eventIterator = server.events.subscribe()[Symbol.asyncIterator]();
      if (!this.eventIterator.return) { this.stopOutboxUpdates(); this.stopMemoryLedgerBinding?.(); throw new Error('Host event subscription must support return()'); }
      this.eventsActive = true;
      this.eventPump = this.watchEvents();
    }
    this.stopMemoryUpdates = options.memory?.onChange(binding => {
      const wake = this.memoryWaking.then(async () => {
        if (this.stopped) return;
        this.resumeMemory(binding);
        this.switchVersions();
        this.armScan(this.now() + this.reconcileMs);
        const result = await this.flushWakes();
        if (result.failures.length) {
          // The earlier deadline wake may already be cancelled. Make one bounded
          // attempt to restore deadline coverage, without an immediate retry loop.
          const scan = this.ledger.snapshot().scanWake;
          if (scan && result.failedKeys.has(`schedule:${scan.dedupKey}`)) {
            this.ledger.transaction(state => { cancelWake(state, scan.dedupKey); state.scanWake = null; });
            this.armScan(Infinity);
            const fallback = await this.flushWakes(result.failedKeys);
            result.failures.push(...fallback.failures);
          }
          this.armWakeRetry();
          throw new AggregateError(result.failures, 'Memory reconciliation wake failed');
        }
      });
      this.memoryWaking = wake.catch(() => {});
      return wake;
    });
  }
  intent(key: string): Intent | undefined { return this.ledger.snapshot().intents[hash(key)]; }
  /** Install directly as agentMessage.consume; SDK owns payload/schema admission. */
  readonly consumeMessage = async (input: AgentMessageInput): Promise<MessageDecision> => {
    this.assertOpen();
    return this.ledger.transaction((state, rows) => {
      const refuse = (reasonCode: string): MessageDecision => ({ outcome: 'refused', reasonCode });
      const execution = state.executions[input.taskId];
      if (!execution) return refuse('unknown_task');
      const frozen = execution.input;
      if (input.tenant !== this.ledger.tenant || input.deviceId !== frozen.deviceId
        || canonical(input.payload.agentRef) !== canonical(frozen.payload.agentRef)
        || canonical(input.context) !== canonical(frozen.agentMessageContext)) return refuse('binding_mismatch');
      const receipt = execution.messageReceipt;
      if (receipt) return receipt.messageId === input.payload.messageId && receipt.contentHash === input.payload.contentHash
        ? { outcome: 'accepted' } : refuse('message_conflict');
      const intent = Object.values(state.intents).find(row => row.taskId === input.taskId);
      if (!intent) return refuse('stale_generation');
      if (!this.options.applyMessage) return refuse('message_handler_unconfigured');
      let open = true;
      let decision: MessageDecision;
      try {
        decision = this.options.applyMessage(structuredClone(input), {
          intent: structuredClone(intent), application: state.application, rows,
          publish: (id, value) => {
            if (!open) throw new Error('Message transaction is closed');
            project(state, id, value);
          },
        });
        if (decision && typeof (decision as unknown as { then?: unknown }).then === 'function') {
          void Promise.resolve(decision).catch(() => {});
          throw new Error('Message hook must return a synchronous decision');
        }
        if (!decision || !['accepted', 'refused'].includes(decision.outcome)) throw new Error('Message hook must return a synchronous decision');
      } finally { open = false; }
      if (decision.outcome === 'accepted') execution.messageReceipt = {
        messageId: input.payload.messageId, contentHash: input.payload.contentHash,
      };
      return decision;
    });
  };
  async enqueue(input: IntentInput): Promise<Intent> {
    this.assertOpen();
    this.ledger.transaction(state => enqueue(state, this.ledger.tenant, input));
    await this.drain();
    return this.intent(input.key)!;
  }
  async addRoutine(definition: RoutineDefinition): Promise<void> {
    this.assertOpen();
    this.ledger.transaction(state => this.routineCommands(state).create(definition));
    await this.drain();
  }
  /**
   * Stages version `max(current, pending) + 1` with the same destination. An exact replay does nothing.
   * The new version replaces the current one when no occurrence of the routine is unsettled and no old slot is due.
   */
  async updateRoutine(definition: RoutineDefinition): Promise<void> {
    this.assertOpen();
    this.ledger.transaction(state => this.routineCommands(state).update(definition));
    await this.drain();
  }
  /** The one path for routine commands. */
  private routineCommands(state: LedgerState): RoutineCommands {
    return routineCommands(state, { now: this.now, nextTime: this.nextTime, hostJobs: this.hostJobs, occurrenceHooks: this.occurrenceHooks });
  }
  async lifecycle(id: string, lifecycle: Routine['lifecycle']): Promise<void> {
    this.assertOpen();
    this.ledger.transaction(state => this.routineCommands(state).lifecycle(id, lifecycle));
    await this.drain();
  }
  async cancel(key: string): Promise<void> {
    this.assertOpen();
    this.ledger.transaction(state => {
      const intent = state.intents[hash(key)];
      if (!intent) throw new Error('Intent not found');
      if (!intent.conclusion) intent.cancelReason = 'cancelled';
    });
    await this.drain();
  }
  readonly consume = async (wake: DueWake, signal: AbortSignal): Promise<void> => {
    this.assertOpen(); signal.throwIfAborted();
    const replay = this.ledger.transaction(state => {
      if (this.ledger.hasTombstone('slot', wake.dedupKey, this.now())) return true;
      if (state.scanWake?.dedupKey === wake.dedupKey) state.scanWake = null;
      else if (wake.dedupKey.startsWith('host-scan:')) auditIgnoredWake(state, wake, this.now(), 'stale_scan');
      else {
        const occurrence = recordOccurrence(state, this.ledger.tenant, wake, this.now(), this.nextTime);
        if (occurrence?.hook) this.runOccurrenceHook(state, occurrence);
      }
      return false;
    });
    if (replay) return;
    signal.throwIfAborted();
    // Does not wait for execution completion. All unsettled work stays in the outbox.
    await this.drain();
  };
  /** The hook shares the occurrence commit: both persist, or neither does. */
  private runOccurrenceHook(state: LedgerState, occurrence: Occurrence): void {
    const run = occurrenceRun(state.routines[hash(occurrence.routineId)]!, occurrence);
    const hook = this.occurrenceHooks.get(run.type);
    if (typeof hook !== 'function') throw new Error('Occurrence hook not registered');
    let open = true;
    try {
      const result: unknown = hook(run, {
        application: state.application,
        publish: (id, value) => {
          if (!open) throw new Error('Occurrence transaction is closed');
          project(state, id, value);
        },
      });
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => {});
        throw new Error('Occurrence hook must be synchronous');
      }
    } finally { open = false; }
  }
  async recover(): Promise<void> {
    this.assertOpen();
    const pending = new Set((await this.server.wakes.pending()).map(wake => wake.dedupKey));
    this.ledger.transaction(state => {
      if (state.scanWake) cancelWake(state, state.scanWake.dedupKey);
      state.scanWake = null;
      for (const routine of Object.values(state.routines)) {
        if (routine.lifecycle === 'active' && routine.status === 'no_occurrence_within_horizon' && !routine.pending) {
          try { applyPlan(state, routine, nextWake(routine.definition, this.now(), this.nextTime, this.now()), this.now()); }
          catch (error) { auditCalendarError(routine, this.now(), error); }
        } else if (routine.next && !pending.has(routine.next.dedupKey)) scheduleNext(state, routine, this.now());
      }
    });
    this.resumeMemory();
    this.notifyOutbox();
    await this.drain();
  }
  drain(): Promise<void> {
    this.assertOpen();
    this.again = true;
    if (this.draining) return this.draining;
    this.draining = (async () => {
      do { this.again = false; await this.scan(); } while (this.again && !this.stopped);
    })().finally(() => {
      this.draining = undefined;
      this.armScheduleRetry();
      this.armWakeRetry();
      this.armLiveScan();
      this.armCancelProbe();
      if (this.again && !this.stopped) return this.drain();
    });
    return this.draining;
  }
  async close(): Promise<void> {
    this.stopped = true; this.stopMemoryUpdates?.(); this.stopMemoryLedgerBinding?.(); this.stopOutboxUpdates?.();
    clearTimeout(this.scheduleRetryTimer); clearTimeout(this.liveScanTimer); clearTimeout(this.cancelProbeTimer);
    for (const retry of this.wakeRetries.values()) clearTimeout(retry.timer);
    this.outboxAbort.abort(); this.jobAbort.abort();
    await this.eventIterator?.return?.();
    await Promise.all([this.draining, this.memoryWaking, this.eventPump, this.cancelProbing,
      ...(this.outboxContext.getStore() ? [] : [this.outboxNotifying])]);
  }
  private notifyOutbox(): void {
    if (this.stopped || !this.options.onOutbox ||
        !Object.values(this.ledger.snapshot().outbox).some(row => row.kind === 'projection')) return;
    this.outboxQueued = true;
    if (this.outboxNotifying) return;
    this.outboxNotifying = Promise.resolve().then(() => this.outboxContext.run(true, async () => {
      while (this.outboxQueued && !this.stopped) {
        this.outboxQueued = false;
        await this.options.onOutbox!(this.outboxAbort.signal);
      }
    })).catch(error => {
      if (this.stopped) return;
      for (const [key, row] of Object.entries(this.ledger.snapshot().outbox)) if (row.kind === 'projection') this.error(key, error);
    }).finally(() => {
      this.outboxNotifying = undefined;
      if (this.outboxQueued && !this.stopped) this.notifyOutbox();
    });
  }
  private async watchEvents(): Promise<void> {
    try {
      while (!this.stopped) {
        const next = await this.eventIterator!.next();
        if (next.done || this.stopped) break;
        if (next.value.kind !== 'task.state' || !['Complete', 'Failed', 'Cancelled'].includes(next.value.state)) continue;
        const taskId = next.value.taskId;
        if (Object.values(this.ledger.snapshot().intents).some(intent => !intent.conclusion && intent.taskId === taskId)) {
          void this.drain().catch(() => {});
        }
      }
    } catch { /* A failed hint stream falls back to durable scans below. */ }
    finally {
      this.eventsActive = false;
      this.liveTasks.clear();
      if (!this.stopped) void this.drain().catch(() => {});
    }
  }
  private armLiveScan(): void {
    clearTimeout(this.liveScanTimer);
    if (this.stopped || !this.eventsActive) return;
    const state = this.ledger.snapshot();
    const current = new Map(Object.values(state.intents).filter(intent => !intent.conclusion && intent.phase === 'inflight').map(intent => [intent.taskId, intent]));
    for (const taskId of this.liveTasks) if (!current.has(taskId)) this.liveTasks.delete(taskId);
    if (!this.liveTasks.size) return;
    const due = Math.min(...[...this.liveTasks].map(taskId => state.executions[taskId]!.started ? Infinity : current.get(taskId)!.waitUntil));
    // The notification feed is bounded, not lossless. Reconcile locally as a safety net;
    // recovered/uncertain tasks keep durable scans instead of trusting old relay state.
    this.liveScanTimer = setTimeout(() => { if (!this.stopped) void this.drain().catch(() => {}); }, Math.max(1, Math.min(this.reconcileMs, due - this.now(), 2_147_483_647)));
    this.liveScanTimer.unref?.();
  }
  /**
   * A cancelled inflight intent has had `tasks.cancel` and waits for its device terminal.
   * Probe that terminal with a backoff per task. A probe never writes the ledger; only a found terminal drains.
   */
  private armCancelProbe(): void {
    clearTimeout(this.cancelProbeTimer);
    if (this.stopped || this.cancelProbing) return;
    const state = this.ledger.snapshot();
    const waiting = new Set(Object.values(state.intents)
      .filter(intent => !intent.conclusion && intent.cancelReason && intent.phase === 'inflight').map(intent => intent.taskId));
    for (const taskId of this.cancelProbes.keys()) if (!waiting.has(taskId)) this.cancelProbes.delete(taskId);
    for (const taskId of waiting) if (!this.cancelProbes.has(taskId)) this.cancelProbes.set(taskId, { used: 0, at: performance.now() + this.cancelProbeDelay(0) });
    const open = [...this.cancelProbes.values()].filter(probe => probe.used < CANCEL_PROBE_TICKS);
    if (!open.length) return;
    this.cancelProbeTimer = setTimeout(() => {
      // A failed ledger read stops probing until the next drain; the reconcileMs scans remain.
      this.cancelProbing = this.probeCancelled().finally(() => { this.cancelProbing = undefined; this.armCancelProbe(); }).catch(() => {});
    }, Math.max(0, Math.min(...open.map(probe => probe.at)) - performance.now()));
    this.cancelProbeTimer.unref?.();
  }
  private cancelProbeDelay(used: number): number {
    return Math.min(CANCEL_PROBE_FIRST_MS * 2 ** used, CANCEL_PROBE_MAX_MS, this.reconcileMs);
  }
  private async probeCancelled(): Promise<void> {
    let found = false;
    for (const [taskId, probe] of this.cancelProbes) {
      if (this.stopped) return;
      if (probe.used >= CANCEL_PROBE_TICKS || probe.at > performance.now()) continue;
      probe.used++;
      probe.at = performance.now() + this.cancelProbeDelay(probe.used);
      try {
        // One found terminal ends this task's probes. If that drain fails, the normal scans retry it.
        if (await this.server.tasks.deviceTerminal(taskId)) { probe.used = CANCEL_PROBE_TICKS; found = true; }
      } catch { /* A failed read uses its tick. */ }
    }
    if (found && !this.stopped) void this.drain().catch(() => {});
  }
  private assertOpen(): void { if (this.stopped) throw new Error('Host core is closed'); }

  private async scan(): Promise<void> {
    this.ledger.transaction(state => {
      for (const routine of Object.values(state.routines)) {
        if (routine.status === 'schedule_retrying' && (routine.scheduleRetryAt ?? 0) <= this.now()) scheduleNext(state, routine, this.now());
      }
    });
    const first = await this.flushWakes();
    const jobFailures = await this.runHostJobs();
    let capacityFailure: OutboxFullError | undefined;
    try {
      for (let pass = 0; pass < 100 && !this.stopped; pass++) {
        this.ledger.transaction(state => {
          for (const intent of Object.values(state.intents)) {
            if (intent.phase !== 'queued' && intent.phase !== 'memory_blocked' && intent.phase !== 'backoff') continue;
            const conclusion = queuedExpiry(intent, this.now());
            if (conclusion) settle(state, intent, conclusion);
          }
        });
        const state = this.ledger.snapshot();
        const heads = fifoHeads(Object.values(state.outbox).flatMap(row => row.kind === 'intent' ? [state.intents[row.intentId]!] : []));
        let changed = false;
        for (const intent of heads) {
          try { changed = await this.reconcile(intent) || changed; }
          catch (error) { if (error instanceof OutboxFullError) throw error; this.error(`intent:${intent.id}`, error); }
        }
        if (!changed) break;
      }
    } catch (error) {
      if (!(error instanceof OutboxFullError)) throw error;
      capacityFailure = error;
    }
    this.switchVersions();
    // A rejected settlement must still restore the durable scan consumed by this hook.
    this.armScan(undefined, capacityFailure ? this.now() + this.reconcileMs : 0);
    const last = await this.flushWakes(first.failedKeys);
    const failures = [...first.failures, ...jobFailures, ...last.failures];
    if (capacityFailure) {
      if (!failures.length) throw capacityFailure;
      failures.unshift(capacityFailure);
    }
    // Reject after scheduling cleanup, so the SDK retains the hook retry.
    if (failures.length) throw new AggregateError(failures, 'Wake dispatch failed; durable outbox retained');
  }
  private async runHostJobs(): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const [key, row] of Object.entries(this.ledger.snapshot().outbox)) {
      if (this.stopped) break;
      if (row.kind !== 'host-job') continue;
      try {
        const run = this.ledger.transaction(state => {
          const occurrence = state.occurrences[row.occurrenceKey]!;
          const definition = state.routines[hash(occurrence.routineId)]!.definition;
          if (!definition.hostJob || !occurrence.job || occurrence.intentId || occurrence.conclusion) throw new Error('Invalid pending Host job');
          return { ...definition.hostJob, occurrenceKey: occurrence.key, routineId: occurrence.routineId,
            definitionVersion: occurrence.definitionVersion, trigger: occurrence.trigger, attempt: ++occurrence.job.attempts };
        });
        const handler = this.hostJobs.get(run.type);
        if (typeof handler !== 'function') throw new Error('Host job handler not registered');
        const result = await handler({ ...run, signal: this.jobAbort.signal });
        this.jobAbort.signal.throwIfAborted();
        if (!result || !Object.hasOwn(result, 'summary')) throw new Error('Host job result requires a summary');
        validateJson(result.summary);
        const unsupported = result.execution !== undefined && this.options.hostJobExecution === 'fail';
        this.ledger.transaction(state => {
          const occurrence = state.occurrences[row.occurrenceKey]!;
          occurrence.job!.summary = structuredClone(result.summary);
          if (result.execution !== undefined && !unsupported) promote(state, this.ledger.tenant, occurrence, result.execution);
          else occurrence.conclusion = unsupported ? 'failed' : 'succeeded';
          delete state.outbox[key];
        });
        // The occurrence is concluded, so this run's error is reported only by the drain.
        if (unsupported) failures.push(new Error('host_job_execution_unsupported'));
      } catch (error) {
        // Shutdown leaves the occurrence pending for recovery, without turning
        // cooperative cancellation into a dispatch failure. Preserve other errors.
        const signal = this.jobAbort.signal;
        if (signal.aborted && (error === signal.reason
          || error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason)) continue;
        this.error(key, error); failures.push(error);
      }
    }
    return failures;
  }
  /**
   * A settlement can make a staged version due. Check after each settlement path: no wake
   * may follow the last settlement, because the old chain gets no refill while a version waits.
   */
  private switchVersions(): void {
    const due = (state: LedgerState) => Object.values(state.routines)
      .filter(routine => versionSwitchDue(routine, Object.values(state.occurrences), this.now()));
    if (!due(this.ledger.snapshot()).length) return;
    this.ledger.transaction(state => { for (const routine of due(state)) switchVersion(state, routine, this.now(), this.nextTime); });
  }
  /**
   * The outbox keeps a failed wake call with `lastError`. Each such row gets its own timer with backoff;
   * a timer runs one drain, which retries every failed row. A row at the limit waits for other drains.
   */
  private armWakeRetry(): void {
    if (this.stopped) return;
    const failed = new Set(Object.entries(this.ledger.snapshot().outbox)
      .filter(([, row]) => (row.kind === 'schedule' || row.kind === 'cancel-wake') && row.lastError !== undefined).map(([key]) => key));
    for (const [key, retry] of this.wakeRetries) if (!failed.has(key)) { clearTimeout(retry.timer); this.wakeRetries.delete(key); }
    for (const key of failed) {
      const retry = this.wakeRetries.get(key) ?? { used: 0 };
      this.wakeRetries.set(key, retry);
      if (retry.timer || retry.used >= WAKE_RETRY_LIMIT) continue;
      retry.timer = setTimeout(() => {
        retry.timer = undefined; retry.used++;
        if (!this.stopped) void this.drain().catch(() => {});
      }, Math.min(WAKE_RETRY_FIRST_MS * 2 ** retry.used, WAKE_RETRY_MAX_MS));
      retry.timer.unref?.();
    }
  }
  private armScheduleRetry(): void {
    clearTimeout(this.scheduleRetryTimer);
    if (this.stopped) return;
    const retries = Object.values(this.ledger.snapshot().routines)
      .filter(routine => routine.lifecycle === 'active' && routine.status === 'schedule_retrying' && routine.scheduleRetryAt !== undefined);
    if (!retries.length) return;
    const at = Math.min(...retries.map(routine => routine.scheduleRetryAt!));
    // Cap each wait to recheck wall clock after sleep. Attempts use the persisted backoff.
    this.scheduleRetryTimer = setTimeout(() => { if (!this.stopped) void this.drain().catch(() => {}); }, Math.max(1, Math.min(60_000, at - this.now())));
    this.scheduleRetryTimer.unref?.();
  }
  private error(key: string, error: unknown): void {
    this.ledger.transaction(state => {
      const row = state.outbox[key];
      if (row) row.lastError = String(error instanceof Error ? error.message : error).slice(0, 1024);
    });
  }
  private async flushWakes(skip = new Set<string>()): Promise<{ failures: unknown[]; failedKeys: Set<string> }> {
    const failures: unknown[] = [];
    const failedKeys = new Set<string>();
    for (const [key, row] of Object.entries(this.ledger.snapshot().outbox)) {
      if (skip.has(key) || row.kind !== 'schedule' && row.kind !== 'cancel-wake') continue;
      try {
        if (row.kind === 'schedule' && row.input.availableAt - this.now() > WAKE_HORIZON_MS) {
          const deferred = this.ledger.transaction(state => {
            const routine = Object.values(state.routines).find(routine => routine.next?.dedupKey === row.input.dedupKey);
            if (!routine) return false;
            scheduleNext(state, routine, this.now());
            return true;
          });
          if (deferred) continue;
        }
        if (row.kind === 'schedule') await this.server.wakes.schedule(row.input);
        else await this.server.wakes.cancel(row.key);
        this.ledger.transaction(state => { if (canonical(state.outbox[key]) === canonical(row)) delete state.outbox[key]; });
      } catch (error) {
        if (row.kind === 'schedule' && error && typeof error === 'object' && 'code' in error && error.code === 'WAKE_AVAILABLE_AT_INVALID') {
          const lastError = { code: error.code, message: error instanceof Error ? error.message : String(error) };
          const deferred = this.ledger.transaction(state => {
            const routine = Object.values(state.routines).find(routine => routine.lifecycle === 'active' && routine.next?.dedupKey === row.input.dedupKey);
            if (!routine) return false;
            routine.lastError = lastError;
            deferSchedule(state, routine, this.now()); return true;
          });
          if (deferred) continue;
        }
        this.error(key, error); failures.push(error); failedKeys.add(key);
      }
    }
    return { failures, failedKeys };
  }
  private armScan(readyAt = this.now() + 1, notBefore = 0): void {
    this.ledger.transaction(state => {
      const open = Object.values(state.intents).filter(intent => !intent.conclusion);
      if (!open.length) {
        if (state.scanWake) cancelWake(state, state.scanWake.dedupKey);
        state.scanWake = null; return;
      }
      const now = this.now();
      const due = Math.max(now + 1, notBefore, Math.min(...open.map(intent => {
        if (intent.phase === 'memory_blocked') return Math.min(intent.waitUntil, intent.retryUntil ?? Infinity);
        if (intent.phase === 'backoff') return Math.min(intent.notBefore, intent.waitUntil, intent.retryUntil ?? Infinity);
        if (intent.phase === 'queued') return open.some(other => other.agent === intent.agent && other.sequence < intent.sequence) ? intent.waitUntil : Math.min(intent.waitUntil, intent.retryUntil ?? Infinity, readyAt);
        if (this.eventsActive && this.liveTasks.has(intent.taskId)) return Infinity;
        return Math.min(now + this.reconcileMs, state.executions[intent.taskId]!.started ? Infinity : intent.waitUntil);
      })));
      if (!Number.isFinite(due)) {
        if (state.scanWake) cancelWake(state, state.scanWake.dedupKey);
        state.scanWake = null; return;
      }
      if (state.scanWake && state.scanWake.availableAt > now && state.scanWake.availableAt >= notBefore && state.scanWake.availableAt <= due) return;
      if (state.scanWake) cancelWake(state, state.scanWake.dedupKey);
      const input = { dedupKey: `host-scan:${hash(this.ledger.tenant)}:${++state.scanSequence}`, availableAt: due };
      state.scanWake = input;
      state.outbox[`schedule:${input.dedupKey}`] = { kind: 'schedule', input };
    });
  }
  private verifyAttempt(intent: Intent, attempt: Attempt | undefined): void {
    if (attempt && (attempt.taskId !== intent.taskId || attempt.deviceId !== intent.execution.deviceId
      || canonical(attempt.agentRef) !== canonical(intent.execution.payload.agentRef))) throw new Error('Attempt identity conflict');
  }
  /**
   * The SDK calls of one frozen submit. It has `submitSealed` only while the server has one, so `submitFrozen` refuses a
   * sealed input before its readback on every path, the reconcile resubmit included, not only in `begin`.
   */
  private frozenPort(): FrozenSubmitPort {
    const live = <T>(enqueued: T, taskId: string): T => {
      if (this.eventsActive) this.liveTasks.add(taskId);
      return enqueued;
    };
    return {
      submit: async input => live(await this.server.executions.submit(input), input.taskId),
      ...this.server.executions.submitSealed && {
        submitSealed: async (input: SealedAgentExecutionInput) => live(await this.server.executions.submitSealed!(input), input.taskId),
      },
      offer: taskId => this.server.tasks.offer(taskId),
    };
  }
  private delivered(intent: Intent): Promise<boolean> {
    return frozenDelivered({ offer: taskId => this.server.tasks.offer(taskId) }, this.ledger.snapshot().executions[intent.taskId]!.input);
  }
  private async submit(intent: Intent): Promise<void> {
    const input = this.ledger.snapshot().executions[intent.taskId]!.input;
    const outcome = await submitFrozen(this.frozenPort(), input, () => {
      const latest = this.ledger.snapshot().intents[intent.id]!;
      if (latest.conclusion || latest.cancelReason) return false;
      if (this.now() >= latest.waitUntil) {
        this.ledger.transaction(state => { state.intents[intent.id]!.cancelReason = 'expired'; });
        return false;
      }
      this.options.memory?.refreshExecution({ deviceId: input.deviceId, agentRef: input.payload.agentRef }, input.taskId);
      return true;
    });
    if (outcome === 'delivered') this.ledger.transaction(state => { state.executions[intent.taskId]!.submission = 'delivered'; });
  }
  private memoryInstruction(intent: Intent): string | undefined {
    if (!this.options.memory) return undefined;
    // A sealed instruction is member content: the Host neither reads it nor adds plaintext next to it.
    if (isSealed(intent.execution)) throw new Error('A sealed execution takes no Host memory ContextPack');
    const instruction = intent.execution.payload.instruction;
    if (typeof instruction !== 'string') throw new Error('Memory ContextPack requires an inline instruction');
    const pack = this.options.memory.contextPack({ deviceId: intent.execution.deviceId, agentRef: intent.execution.payload.agentRef });
    return pack.residentMemory ? `${instruction}\n\nContextPack (memory data):\n${JSON.stringify(pack)}` : instruction;
  }
  private resumeMemory(binding?: MemoryBinding): boolean {
    return this.ledger.transaction(state => {
      let changed = false;
      for (const intent of Object.values(state.intents)) {
        if (intent.phase !== 'memory_blocked' || binding && (intent.execution.deviceId !== binding.deviceId
          || canonical(intent.execution.payload.agentRef) !== canonical(binding.agentRef))) continue;
        try { this.memoryInstruction(intent); }
        catch (error) {
          this.memoryFailure(state, intent, error);
          changed = intent.phase !== 'memory_blocked' || changed;
          continue;
        }
        intent.phase = intent.memoryBlocked!.resume;
        delete intent.memoryBlocked;
        const outbox = state.outbox[`intent:${intent.id}`];
        if (outbox) delete outbox.lastError;
        changed = true;
      }
      return changed;
    });
  }
  private memoryFailure(state: LedgerState, intent: Intent, error: unknown): void {
    const reason = String(error instanceof Error ? error.message : error).slice(0, 1024);
    if (!(error instanceof MemoryBlockedError)) {
      intent.preparationError = reason;
      delete intent.memoryBlocked;
      settle(state, intent, 'failed');
      return;
    }
    intent.memoryBlocked = { resume: intent.memoryBlocked?.resume ?? (intent.phase === 'backoff' ? 'backoff' : 'queued'), reason };
    intent.phase = 'memory_blocked';
    const outbox = state.outbox[`intent:${intent.id}`];
    if (outbox) outbox.lastError = reason;
  }
  private begin(intent: Intent): Intent | undefined {
    return this.ledger.transaction(state => {
      const row = state.intents[intent.id]!;
      if (row.conclusion || row.cancelReason || this.now() >= row.waitUntil
        || this.now() >= (row.retryUntil ?? Infinity) || row.phase === 'inflight' || row.phase === 'memory_blocked') return undefined;
      if (isSealed(row.execution) && !this.server.executions.submitSealed) {
        // Fail before any submit, as a refused preparation does, so the drain never retries a submit that cannot exist.
        row.preparationError = new SealedDispatchUnavailableError().code;
        settle(state, row, 'failed');
        return undefined;
      }
      let instruction: string | undefined;
      try { instruction = this.memoryInstruction(row); }
      catch (error) {
        this.memoryFailure(state, row, error);
        return undefined;
      }
      if (row.phase === 'backoff') {
        row.generation++;
        row.taskId = taskId(row.key, row.generation);
        state.executions[row.taskId] = { input: { ...structuredClone(row.execution), taskId: row.taskId }, submission: 'reserved', started: false };
      }
      if (instruction !== undefined) state.executions[row.taskId]!.input.payload.instruction = instruction;
      row.phase = 'inflight'; row.attempts++;
      state.executions[row.taskId]!.submission = 'uncertain';
      if (row.occurrence) state.occurrences[row.occurrence]!.attempts = row.attempts;
      return row;
    });
  }
  private async reconcile(intent: Intent): Promise<boolean> {
    if (intent.phase === 'memory_blocked') {
      if (!this.resumeMemory({ deviceId: intent.execution.deviceId, agentRef: intent.execution.payload.agentRef })) return false;
      intent = this.intent(intent.key)!;
      if (intent.conclusion) return true;
    }
    if (intent.phase === 'backoff' && this.now() < intent.notBefore) return false;
    if (intent.phase === 'queued' || intent.phase === 'backoff') {
      const begun = this.begin(intent);
      if (!begun) return !!this.intent(intent.key)?.conclusion;
      intent = begun;
      await this.submit(intent);
      return true;
    }
    const execution = this.ledger.snapshot().executions[intent.taskId]!;
    await this.delivered(intent); // Verify the immutable input before accepting any later evidence.
    let terminal = await this.server.tasks.deviceTerminal(intent.taskId);
    // Only an earlier observed claim removes the waiting deadline. A claim racing
    // this cancellation can be interrupted. This boundary was accepted by the owner.
    if (!terminal && !intent.cancelReason && !execution.started && this.now() >= intent.waitUntil) {
      this.ledger.transaction(state => { state.intents[intent.id]!.cancelReason = 'expired'; });
      intent.cancelReason = 'expired';
    }
    let attempt = await this.server.tasks.attempt(intent.taskId);
    this.verifyAttempt(intent, attempt);
    if (intent.cancelReason && !terminal) {
      if (attempt) {
        await this.server.tasks.cancel(intent.taskId, intent.cancelReason);
        attempt = await this.server.tasks.attempt(intent.taskId);
        this.verifyAttempt(intent, attempt);
        if (!attempt) throw new Error('Attempt disappeared after cancellation');
      } else {
        // No SDK attempt exists. The uncertain submit has finished, and this scan
        // is serialized with every Host submit. Never submit after this decision.
        this.ledger.transaction(state => settle(state, state.intents[intent.id]!, intent.cancelReason === 'expired' ? 'expired' : 'cancelled'));
        return true;
      }
      terminal = await this.server.tasks.deviceTerminal(intent.taskId);
    }
    this.ledger.transaction(state => {
      const row = state.executions[intent.taskId]!;
      if (attempt) row.attempt = attempt;
      if (attempt?.claimedRuntime || attempt?.ownerDeviceId) row.started = true;
    });
    if (attempt?.status === 'cancelled' && !attempt.claimedRuntime && !attempt.ownerDeviceId && !terminal) {
      this.ledger.transaction(state => settle(state, state.intents[intent.id]!, intent.cancelReason === 'expired' ? 'expired' : 'cancelled'));
      return true;
    }
    if (terminal) {
      if (terminal.envelope.task_id !== intent.taskId) throw new Error('Terminal identity conflict');
      // Reread cancellation authority after terminal. Late success must not apply an outcome.
      attempt = await this.server.tasks.attempt(intent.taskId);
      this.verifyAttempt(intent, attempt);
      if (!attempt) throw new Error('Device terminal has no attempt');
      this.finish(intent, terminal, attempt);
      return true;
    }
    if (!attempt?.cancellation && !intent.cancelReason && execution.submission !== 'delivered') await this.submit(intent);
    return false;
  }
  private finish(intent: Intent, terminal: Terminal, attempt: Attempt): void {
    this.ledger.transaction(state => {
      const row = state.intents[intent.id]!;
      if (row.conclusion) return;
      const execution = state.executions[row.taskId]!;
      execution.terminal = terminal; execution.attempt = attempt;
      const envelope = terminal.envelope;
      if (attempt.cancellation || envelope.type === 'task.cancelled') { settle(state, row, 'cancelled'); return; }
      if (envelope.type === 'task.complete') {
        if (!state.applied[row.taskId]) {
          const result = this.options.applyOutcome?.(envelope.payload.document, {
            intent: structuredClone(row), terminal: structuredClone(terminal), application: state.application,
            publish: (id, value) => project(state, id, value), routines: this.routineCommands(state),
          });
          if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Outcome handler must be synchronous');
          state.applied[row.taskId] = true;
        }
        settle(state, row, 'succeeded'); return;
      }
      const busy = envelope.type === 'task.decline'
        && (envelope.payload.code === 'agent_home_writer_busy' || envelope.payload.code === 'agent_home_reader_busy');
      const retryable = busy || envelope.type === 'task.fail' && envelope.payload.retryable !== false && row.retry.retryFailures;
      const retryAt = this.now() + (row.retry.delaysMs[row.attempts - 1] ?? Infinity);
      if (retryable && !row.cancelReason && row.attempts < row.retry.maxAttempts && retryAt < Math.min(row.waitUntil, row.retryUntil ?? Infinity)) {
        row.phase = 'backoff'; row.notBefore = retryAt;
      } else settle(state, row, envelope.type === 'task.decline' ? 'declined' : 'failed');
    });
  }
  /** Host uploader: at-least-once delivery. The receiver must deduplicate by id. */
  async flushProjections(deliver: (id: string, value: Json) => Promise<void>): Promise<void> {
    this.assertOpen();
    for (const [key, row] of Object.entries(this.ledger.snapshot().outbox)) {
      if (row.kind !== 'projection') continue;
      try {
        await deliver(row.id, structuredClone(row.value));
        this.ledger.transaction(state => { if (canonical(state.outbox[key]) === canonical(row)) delete state.outbox[key]; });
      } catch (error) { this.error(key, error); }
    }
  }
}
