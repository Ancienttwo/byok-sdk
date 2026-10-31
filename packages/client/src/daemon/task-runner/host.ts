// The IO half of the #1099 TaskRunner reducer: one host per runner (kept in
// a WeakMap so `TaskRunner`'s private member surface stays byte-identical),
// one strict-FIFO mailbox per taskId, and the effect executor that lets the
// phase adapters keep their IO while the reducer owns the transition.
//
// S3 wires the offer/admission path only. Effects whose IO still lives in the
// staged offer pipeline (and every S4–S6 effect) are recorded as `legacy`
// and not executed here; the phase adapter performs them exactly as before.
import {
  createRunnerState,
  reduce,
  type EffectEnvelope,
  type EffectKind,
  type ReducerEvent,
  type ReducerEventTemplate,
  type ReducerSnapshot,
  type ReduceResult,
  type RunnerStateV1,
  type TaskStateV1,
} from './state';
import type { TaskRunner } from '../task-runner';

/** Mutable per-offer facts the host keeps out of the serializable State. */
export interface HostOfferContext {
  /** Monotonic across the runner's lifetime; events from an older offer drop. */
  generation: number;
  /** Current admission stage, used by an `admission.declined` event. */
  stage: string;
  /** Agent identity for a `send.decline` effect; set once the offer names it. */
  agentRef?: unknown;
  /** #1103 typed cause for the next `send.decline` effect. */
  runtimeUnavailable?: unknown;
  /** The adapter-owned decline send. Called synchronously, exactly once. */
  sendDecline?: (effect: EffectEnvelope, context: HostOfferContext) => void;
}

export interface HostEffectContext {
  readonly taskId: string | undefined;
  readonly event: ReducerEvent;
  readonly snapshot: ReducerSnapshot;
  /** Enqueue a completion event at the tail of this task's mailbox. */
  readonly enqueue: (event: ReducerEventTemplate) => void;
}

export interface HostEffectResult {
  /** Completion event appended at the mailbox tail after the barrier settles. */
  readonly completion?: ReducerEventTemplate;
}

/**
 * A handler may finish synchronously (return nothing) or be a barrier (return
 * a promise). A barrier's completion event is appended at the TAIL of the
 * mailbox, never ahead of an event that arrived while it was in flight.
 */
export type HostEffectHandler = (
  envelope: EffectEnvelope,
  context: HostEffectContext,
) => void | HostEffectResult | Promise<void | HostEffectResult>;

export interface HostAuditEntry {
  readonly taskId: string | undefined;
  readonly effectId: string;
  readonly kind: EffectKind;
  readonly mode: EffectEnvelope['mode'];
  readonly outcome: 'executed' | 'legacy' | 'skipped' | 'completion';
  readonly reason?: string;
}

interface QueuedEvent {
  readonly event: ReducerEvent;
  readonly resolve: (result: ReduceResult) => void;
  readonly reject: (error: unknown) => void;
}

interface Mailbox {
  readonly queue: QueuedEvent[];
  draining: boolean;
}

interface AppliedEvent {
  readonly result: ReduceResult;
  readonly pending?: Promise<void | HostEffectResult>;
}

const GLOBAL_MAILBOX = '\u0000runner';
const MAX_ARCHIVED_TASKS = 128;
const MAX_AUDIT_ENTRIES = 512;

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | undefined)?.then === 'function';
}

function requiresAdmit(snapshot: ReducerSnapshot, envelope: EffectEnvelope): boolean {
  const requires = envelope.requires;
  if (requires === undefined || requires.alwaysRun === true) return true;
  const task = snapshot.task;
  if (requires.phase !== undefined) {
    if (task === undefined || !requires.phase.includes(task.phase)) return false;
  }
  if (requires.claim === 'required' && task?.claim.sent !== true) return false;
  if (requires.claim === 'forbidden' && task?.claim.sent === true) return false;
  if (requires.terminal === 'none' && task?.terminal !== undefined) return false;
  if (requires.terminal === 'selected' && task?.terminal === undefined) return false;
  if (requires.generation !== undefined && task?.generation !== requires.generation) return false;
  return true;
}

/**
 * Per-TaskRunner reducer host. One instance per runner, held by the module
 * WeakMap; the class is internal to the client package and is not exported
 * from any public entry.
 */
export class TaskRunnerHost {
  private runnerState: RunnerStateV1 = createRunnerState();
  private readonly tasks = new Map<string, TaskStateV1>();
  private readonly archived = new Map<string, TaskStateV1>();
  private readonly mailboxes = new Map<string, Mailbox>();
  private readonly offers = new Map<string, HostOfferContext>();
  private readonly handlers = new Map<EffectKind, HostEffectHandler>();
  private readonly audit: HostAuditEntry[] = [];
  private generation = 0;

  constructor(_runner: TaskRunner) {}

  runnerSnapshot(): RunnerStateV1 {
    return this.runnerState;
  }

  snapshot(taskId: string): ReducerSnapshot {
    const task = this.tasks.get(taskId);
    return {
      runner: this.runnerState,
      ...(task === undefined ? {} : { task }),
    };
  }

  current(taskId: string): TaskStateV1 | undefined {
    return this.tasks.get(taskId);
  }

  archivedTask(taskId: string): TaskStateV1 | undefined {
    return this.archived.get(taskId);
  }

  offerContext(taskId: string): HostOfferContext | undefined {
    return this.offers.get(taskId);
  }

  auditLog(): readonly HostAuditEntry[] {
    return this.audit;
  }

  /** Registers an effect handler; returns the unregister function. */
  registerHandler(kind: EffectKind, handler: HostEffectHandler): () => void {
    this.handlers.set(kind, handler);
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind);
    };
  }

  /**
   * Starts a new offer for `taskId` with a fresh generation. A retained entry
   * from an earlier delivery (ordinary declines are not deduped) is archived
   * first, so the reducer's O1 row always sees a fresh task.
   */
  beginOffer(
    taskId: string,
    options: { readonly stage?: string; readonly sendDecline?: HostOfferContext['sendDecline'] } = {},
  ): HostOfferContext {
    const previous = this.tasks.get(taskId);
    if (previous !== undefined) this.archive(taskId, previous);
    this.tasks.delete(taskId);
    this.generation += 1;
    const context: HostOfferContext = {
      generation: this.generation,
      stage: options.stage ?? 'receive',
      ...(options.sendDecline === undefined ? {} : { sendDecline: options.sendDecline }),
    };
    this.offers.set(taskId, context);
    return context;
  }

  setStage(taskId: string, stage: string): void {
    const context = this.offers.get(taskId);
    if (context !== undefined) context.stage = stage;
  }

  setAgentRef(taskId: string, agentRef: unknown): void {
    const context = this.offers.get(taskId);
    if (context !== undefined) context.agentRef = agentRef;
  }

  setRuntimeUnavailable(taskId: string, runtimeUnavailable: unknown): void {
    const context = this.offers.get(taskId);
    if (context !== undefined) context.runtimeUnavailable = runtimeUnavailable;
  }

  /** Ends an offer that never reached `active`; a retained state is archived. */
  endOffer(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task !== undefined) this.archive(taskId, task);
    this.tasks.delete(taskId);
    this.offers.delete(taskId);
    this.mailboxes.delete(taskId);
  }

  /** Terminal cleanup: the per-task map is bounded even after a claimed task ends. */
  endTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task !== undefined) this.archive(taskId, task);
    this.tasks.delete(taskId);
    this.offers.delete(taskId);
    this.mailboxes.delete(taskId);
  }

  /**
   * Dispatches one event through the task's mailbox. Same-task events are
   * reduced in enqueue order; a barrier completion is appended at the tail.
   */
  dispatch(event: ReducerEvent): Promise<ReduceResult> {
    const mailbox = this.mailboxFor(event.taskId);
    const normalized = this.normalize(event);
    return new Promise<ReduceResult>((resolve, reject) => {
      mailbox.queue.push({ event: normalized, resolve, reject });
      this.drain(mailbox);
    });
  }

  /**
   * Synchronous dispatch for atomic-only events (the offer/admission path).
   * Throws when the mailbox is behind an in-flight barrier: an atomic group
   * must never be interleaved with another event's effects.
   */
  dispatchSync(event: ReducerEvent): ReduceResult {
    const mailbox = this.mailboxFor(event.taskId);
    if (mailbox.draining) {
      throw new Error('TaskRunnerHost: synchronous dispatch cannot queue behind an in-flight barrier');
    }
    // Mark the mailbox busy for the whole atomic group: a dispatch from inside
    // an effect handler queues behind the group instead of re-entering it.
    mailbox.draining = true;
    let result: ReduceResult | undefined;
    try {
      const applied = this.applyEvent(this.normalize(event));
      if (applied.pending !== undefined) {
        throw new Error('TaskRunnerHost: synchronous dispatch produced a barrier effect');
      }
      result = applied.result;
    } finally {
      mailbox.draining = false;
    }
    if (mailbox.queue.length > 0) this.drain(mailbox);
    if (result === undefined) throw new Error('TaskRunnerHost: synchronous dispatch produced no result');
    return result;
  }

  private mailboxFor(taskId: string | undefined): Mailbox {
    const key = taskId ?? GLOBAL_MAILBOX;
    let mailbox = this.mailboxes.get(key);
    if (mailbox === undefined) {
      mailbox = { queue: [], draining: false };
      this.mailboxes.set(key, mailbox);
    }
    return mailbox;
  }

  private normalize(event: ReducerEvent): ReducerEvent {
    const context = event.taskId === undefined ? undefined : this.offers.get(event.taskId);
    const generation = event.generation ?? context?.generation;
    return Object.freeze({
      ...event,
      atMs: event.atMs ?? Date.now(),
      ...(generation === undefined ? {} : { generation }),
    });
  }

  private drain(mailbox: Mailbox): void {
    if (mailbox.draining) return;
    mailbox.draining = true;
    while (mailbox.queue.length > 0) {
      const queued = mailbox.queue[0]!;
      let applied: AppliedEvent;
      try {
        applied = this.applyEvent(queued.event);
      } catch (error) {
        mailbox.queue.shift();
        queued.reject(error);
        continue;
      }
      if (applied.pending === undefined) {
        mailbox.queue.shift();
        queued.resolve(applied.result);
        continue;
      }
      // The barrier is in flight. Later events stay queued behind it; the
      // barrier's completion goes to the tail, never ahead of them.
      mailbox.queue.shift();
      void applied.pending.then(
        (outcome) => {
          if (outcome?.completion !== undefined && queued.event.taskId !== undefined) {
            mailbox.queue.push(this.completionWaiter(queued.event.taskId, outcome.completion));
          }
          queued.resolve(applied.result);
          mailbox.draining = false;
          this.drain(mailbox);
        },
        (error) => {
          queued.reject(error);
          mailbox.draining = false;
          this.drain(mailbox);
        },
      );
      return;
    }
    mailbox.draining = false;
  }

  private completionWaiter(taskId: string, template: ReducerEventTemplate): QueuedEvent {
    const event = this.normalize({
      ...template,
      taskId,
      atMs: Date.now(),
    } as ReducerEvent);
    return {
      event,
      resolve: () => undefined,
      reject: (error) => {
        console.error('[byok/client] TaskRunnerHost completion event failed', error);
      },
    };
  }

  private applyEvent(event: ReducerEvent): AppliedEvent {
    const snapshot = this.snapshot(event.taskId ?? '');
    const result = reduce(snapshot, event);
    this.runnerState = result.runner;
    const taskId = event.taskId;
    if (result.task !== undefined) this.tasks.set(result.task.taskId, result.task);
    else if (taskId !== undefined && event.type === 'offer.sealed_declined') this.tasks.delete(taskId);
    const pending = this.executeEffects(
      result.effects,
      event,
      { runner: result.runner, ...(result.task === undefined ? {} : { task: result.task }) },
    );
    return { result, ...(pending === undefined ? {} : { pending }) };
  }

  private executeEffects(
    effects: readonly EffectEnvelope[],
    event: ReducerEvent,
    snapshot: ReducerSnapshot,
  ): Promise<void | HostEffectResult> | undefined {
    for (const envelope of effects) {
      if (!requiresAdmit(snapshot, envelope)) {
        this.record(envelope, 'skipped', 'requires');
        continue;
      }
      const pending = this.executeEffect(envelope, event, snapshot);
      if (pending !== undefined) return pending;
    }
    return undefined;
  }

  private executeEffect(
    envelope: EffectEnvelope,
    event: ReducerEvent,
    snapshot: ReducerSnapshot,
  ): Promise<void | HostEffectResult> | undefined {
    const taskId = envelope.effect.taskId ?? event.taskId;
    const context: HostEffectContext = {
      taskId,
      event,
      snapshot,
      enqueue: (template) => {
        if (taskId === undefined) return;
        const mailbox = this.mailboxFor(taskId);
        mailbox.queue.push(this.completionWaiter(taskId, template));
        this.drain(mailbox);
      },
    };
    if (envelope.effect.kind === 'send.decline') {
      const offer = taskId === undefined ? undefined : this.offers.get(taskId);
      if (offer?.sendDecline !== undefined) {
        offer.sendDecline(envelope, offer);
        this.record(envelope, 'executed');
        this.completeAtomically(envelope, taskId);
        return undefined;
      }
    }
    if (envelope.effect.kind === 'audit' || envelope.effect.kind === 'log') {
      this.record(envelope, 'executed');
      this.completeAtomically(envelope, taskId);
      return undefined;
    }
    const handler = this.handlers.get(envelope.effect.kind);
    if (handler === undefined) {
      // S3 keeps the staged offer IO in the phase adapters. Anything not
      // registered here is executed by that adapter, in the original order.
      this.record(envelope, 'legacy');
      return undefined;
    }
    let outcome: void | HostEffectResult | Promise<void | HostEffectResult>;
    try {
      outcome = handler(envelope, context);
    } catch (error) {
      this.record(envelope, 'skipped', 'handler-threw');
      throw error;
    }
    this.record(envelope, 'executed');
    if (!isPromise(outcome)) {
      this.completeAtomically(envelope, taskId);
      return undefined;
    }
    // A barrier completion goes to the mailbox tail; an envelope completion
    // is the same contract for a barrier that declares one.
    const declared = envelope.completion;
    return outcome.then((result) => {
      if (result?.completion !== undefined) return result;
      return declared === undefined ? result : { completion: declared };
    });
  }

  /**
   * Executes a synchronous effect's completion event inside the SAME atomic
   * group: no other mailbox event can be reduced between the effect and its
   * completion, and the completion's own effects stay in this turn.
   */
  private completeAtomically(envelope: EffectEnvelope, taskId: string | undefined): void {
    const template = envelope.completion;
    if (template === undefined) return;
    const event = this.normalize({
      ...template,
      ...(taskId === undefined ? {} : { taskId }),
      atMs: Date.now(),
    } as ReducerEvent);
    const applied = this.applyEvent(event);
    if (applied.pending !== undefined) {
      throw new Error('TaskRunnerHost: an atomic completion produced a barrier effect');
    }
    this.audit.push({
      taskId: envelope.effect.taskId,
      effectId: envelope.id,
      kind: envelope.effect.kind,
      mode: envelope.mode,
      outcome: 'completion',
    });
  }

  private archive(taskId: string, task: TaskStateV1): void {
    this.archived.delete(taskId);
    this.archived.set(taskId, task);
    if (this.archived.size > MAX_ARCHIVED_TASKS) {
      const oldest = this.archived.keys().next().value;
      if (oldest !== undefined) this.archived.delete(oldest);
    }
  }

  private record(
    envelope: EffectEnvelope,
    outcome: HostAuditEntry['outcome'],
    reason?: string,
  ): void {
    this.audit.push({
      taskId: envelope.effect.taskId,
      effectId: envelope.id,
      kind: envelope.effect.kind,
      mode: envelope.mode,
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
    if (this.audit.length > MAX_AUDIT_ENTRIES) this.audit.splice(0, this.audit.length - MAX_AUDIT_ENTRIES);
  }
}

const hosts = new WeakMap<TaskRunner, TaskRunnerHost>();

/** The one host for a runner; S3 never adds a TaskRunner private member. */
export function hostFor(runner: TaskRunner): TaskRunnerHost {
  let host = hosts.get(runner);
  if (host === undefined) {
    host = new TaskRunnerHost(runner);
    hosts.set(runner, host);
  }
  return host;
}

/** Test seam: drops the host so a WeakMap entry cannot outlive a fixture. */
export function forgetHost(runner: TaskRunner): void {
  hosts.delete(runner);
}
