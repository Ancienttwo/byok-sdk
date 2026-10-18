import type { ByokServer, DueWake } from '@byok-sdk/server';
import { HostLedger } from './ledger';
import { canonical, hash, project, taskId, time, validateInput, type Attempt, type Intent, type IntentInput,
  type Json, type LedgerState, type Routine, type RoutineDefinition, type Terminal } from './model';
import { nextIntervalOccurrence, type NextOccurrence } from './schedule';
import { nextWake, recordOccurrence, scheduleNext, setLifecycle } from './routines';
import { cancelWake, enqueue, settle } from './transitions';

export type ExecutionServer = {
  executions: Pick<ByokServer['executions'], 'submit'>;
  tasks: Pick<ByokServer['tasks'], 'offer' | 'deviceTerminal' | 'attempt' | 'cancel'>;
  wakes: ByokServer['wakes'];
};
export interface OutcomeTransaction {
  readonly intent: Readonly<Intent>;
  readonly terminal: Terminal;
  /** Business state participates in the same SQLite commit. Do not do external I/O here. */
  application: Record<string, Json>;
  publish(id: string, value: Json): void;
}
export interface HostOptions {
  now?: () => number;
  reconcileMs?: number;
  nextOccurrence?: NextOccurrence;
  applyOutcome?: (document: unknown, transaction: OutcomeTransaction) => void;
}

/** One instance per embedded tenant. All runtime timers use the embedded wake queue. */
export class HostExecutionCore {
  private readonly now: () => number;
  private readonly nextTime: NextOccurrence;
  private readonly reconcileMs: number;
  private draining?: Promise<void>;
  private again = false;
  private stopped = false;
  constructor(readonly server: ExecutionServer, readonly ledger: HostLedger, private readonly options: HostOptions = {}) {
    this.now = () => time((options.now ?? Date.now)());
    this.nextTime = options.nextOccurrence ?? nextIntervalOccurrence;
    this.reconcileMs = time(options.reconcileMs ?? 1000);
    if (this.reconcileMs < 1) throw new Error('Reconciliation interval must be positive');
  }
  intent(key: string): Intent | undefined { return this.ledger.snapshot().intents[hash(key)]; }
  async enqueue(input: IntentInput): Promise<Intent> {
    this.assertOpen();
    this.ledger.transaction(state => enqueue(state, this.ledger.tenant, input));
    await this.drain();
    return this.intent(input.key)!;
  }
  async addRoutine(definition: RoutineDefinition): Promise<void> {
    this.assertOpen();
    if (!definition.id.trim() || !Number.isSafeInteger(definition.version) || definition.version < 1
      || definition.waitMs < 1) throw new Error('Invalid routine definition');
    time(definition.waitMs); time(definition.lateAfterMs);
    if (definition.endAt !== undefined) time(definition.endAt);
    validateInput({ key: definition.id, source: 'routine', execution: definition.execution, waitUntil: this.now() + definition.waitMs, retry: definition.retry });
    const next = nextWake(definition, this.now() - 1, this.nextTime);
    this.ledger.transaction(state => {
      const id = hash(definition.id);
      if (state.routines[id]) {
        if (canonical(state.routines[id]!.definition) !== canonical(definition)) throw new Error('Routine definition is immutable; use a new routine id after current work settles');
        return;
      }
      state.routines[id] = { definition: structuredClone(definition), lifecycle: next ? 'active' : 'completed', next };
      scheduleNext(state, state.routines[id]!);
    });
    await this.drain();
  }
  async lifecycle(id: string, lifecycle: Routine['lifecycle']): Promise<void> {
    this.assertOpen();
    this.ledger.transaction(state => setLifecycle(state, id, lifecycle, this.now(), this.nextTime));
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
    this.ledger.transaction(state => {
      if (state.scanWake?.dedupKey === wake.dedupKey) state.scanWake = null;
      else recordOccurrence(state, this.ledger.tenant, wake, this.now(), this.nextTime);
    });
    signal.throwIfAborted();
    // Does not wait for execution completion. All unsettled work stays in the outbox.
    await this.drain();
  };
  async recover(): Promise<void> {
    this.assertOpen();
    const pending = new Set((await this.server.wakes.pending()).map(wake => wake.dedupKey));
    this.ledger.transaction(state => {
      if (state.scanWake) cancelWake(state, state.scanWake.dedupKey);
      state.scanWake = null;
      for (const routine of Object.values(state.routines)) {
        if (routine.next && !pending.has(routine.next.dedupKey)) scheduleNext(state, routine);
      }
    });
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
      if (this.again && !this.stopped) return this.drain();
    });
    return this.draining;
  }
  async close(): Promise<void> { this.stopped = true; await this.draining; }
  private assertOpen(): void { if (this.stopped) throw new Error('Host core is closed'); }

  private async scan(): Promise<void> {
    await this.flushWakes();
    for (let pass = 0; pass < 100 && !this.stopped; pass++) {
      this.ledger.transaction(state => {
        for (const intent of Object.values(state.intents)) {
          if (intent.phase === 'queued' && (intent.cancelReason || this.now() >= intent.waitUntil || this.now() >= (intent.retryUntil ?? Infinity))) {
            settle(state, intent, intent.cancelReason === 'cancelled' ? 'cancelled' : this.now() >= intent.waitUntil ? 'expired' : 'superseded');
          } else if (intent.phase === 'backoff' && (intent.cancelReason || this.now() >= Math.min(intent.waitUntil, intent.retryUntil ?? Infinity))) {
            settle(state, intent, intent.cancelReason === 'cancelled' ? 'cancelled' : this.now() >= intent.waitUntil ? 'expired' : 'superseded');
          }
        }
      });
      const state = this.ledger.snapshot();
      const heads = new Map<string, Intent>();
      for (const row of Object.values(state.outbox)) {
        if (row.kind !== 'intent') continue;
        const intent = state.intents[row.intentId]!;
        if (!heads.has(intent.agent) || heads.get(intent.agent)!.sequence > intent.sequence) heads.set(intent.agent, intent);
      }
      let changed = false;
      for (const intent of heads.values()) {
        try { changed = await this.reconcile(intent) || changed; }
        catch (error) { this.error(`intent:${intent.id}`, error); }
      }
      if (!changed) break;
    }
    this.armScan();
    await this.flushWakes();
  }
  private error(key: string, error: unknown): void {
    this.ledger.transaction(state => {
      const row = state.outbox[key];
      if (row) row.lastError = String(error instanceof Error ? error.message : error).slice(0, 1024);
    });
  }
  private async flushWakes(): Promise<void> {
    for (const [key, row] of Object.entries(this.ledger.snapshot().outbox)) {
      if (row.kind !== 'schedule' && row.kind !== 'cancel-wake') continue;
      try {
        if (row.kind === 'schedule') await this.server.wakes.schedule(row.input);
        else await this.server.wakes.cancel(row.key);
        this.ledger.transaction(state => { if (canonical(state.outbox[key]) === canonical(row)) delete state.outbox[key]; });
      } catch (error) { this.error(key, error); }
    }
  }
  private armScan(): void {
    this.ledger.transaction(state => {
      const open = Object.values(state.intents).filter(intent => !intent.conclusion);
      if (!open.length) {
        if (state.scanWake) cancelWake(state, state.scanWake.dedupKey);
        state.scanWake = null; return;
      }
      const now = this.now();
      const due = Math.max(now + 1, Math.min(...open.map(intent => {
        if (intent.phase === 'backoff') return Math.min(intent.notBefore, intent.waitUntil, intent.retryUntil ?? Infinity);
        if (intent.phase === 'queued') return open.some(other => other.agent === intent.agent && other.sequence < intent.sequence) ? intent.waitUntil : now + 1;
        return Math.min(now + this.reconcileMs, state.executions[intent.taskId]!.started ? Infinity : intent.waitUntil);
      })));
      if (state.scanWake && state.scanWake.availableAt > now && state.scanWake.availableAt <= due) return;
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
  private async delivered(intent: Intent): Promise<boolean> {
    const offer = await this.server.tasks.offer(intent.taskId);
    if (!offer) return false;
    const input = this.ledger.snapshot().executions[intent.taskId]!.input;
    if (offer.taskId !== input.taskId || offer.deviceId !== input.deviceId || offer.type !== 'task.offer_for_agent_with_egress_fresh'
      || canonical(offer.payload) !== canonical(input.payload)) throw new Error('Offer differs from the frozen input');
    return offer.delivered;
  }
  private async submit(intent: Intent): Promise<void> {
    if (!await this.delivered(intent)) {
      const latest = this.ledger.snapshot().intents[intent.id]!;
      if (latest.conclusion || latest.cancelReason) return;
      if (this.now() >= latest.waitUntil) {
        this.ledger.transaction(state => { state.intents[intent.id]!.cancelReason = 'expired'; });
        return;
      }
      const input = this.ledger.snapshot().executions[intent.taskId]!.input;
      try { await this.server.executions.submit(input); }
      catch (error) { if (!await this.delivered(intent)) throw error; }
    }
    this.ledger.transaction(state => { state.executions[intent.taskId]!.submission = 'delivered'; });
  }
  private begin(intent: Intent): Intent | undefined {
    return this.ledger.transaction(state => {
      const row = state.intents[intent.id]!;
      if (row.conclusion || row.cancelReason || this.now() >= row.waitUntil
        || this.now() >= (row.retryUntil ?? Infinity) || row.phase === 'inflight') return undefined;
      if (row.phase === 'backoff') {
        row.generation++;
        row.taskId = taskId(row.key, row.generation);
        state.executions[row.taskId] = { input: { ...structuredClone(row.execution), taskId: row.taskId }, submission: 'reserved', started: false };
      }
      row.phase = 'inflight'; row.attempts++;
      state.executions[row.taskId]!.submission = 'uncertain';
      if (row.occurrence) state.occurrences[row.occurrence]!.attempts = row.attempts;
      return row;
    });
  }
  private async reconcile(intent: Intent): Promise<boolean> {
    if (intent.phase === 'backoff' && this.now() < intent.notBefore) return false;
    if (intent.phase === 'queued' || intent.phase === 'backoff') {
      const begun = this.begin(intent);
      if (!begun) return false;
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
            publish: (id, value) => project(state, id, value),
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
