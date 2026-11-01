import type { InboundCommitted, ByokCloudObserver } from '@byok-sdk/cloud';
import type { RuntimeId, TaskState } from '@byok-sdk/protocol';
import { AsyncEventQueue } from './event-queue';
import type { ByokServerEvent } from './types';

/** Cross-task server events a slow `events.subscribe()` reader leaves buffered before the oldest are dropped. */
const SERVER_EVENT_BUFFER_LIMIT = 1000;

/**
 * Server-event bookkeeping for one task this instance dispatched. Until the
 * kernel accepts the offer, deliveries wait in `early`, so `task.created`
 * precedes the task's first `task.state`. `claimedRuntime` and
 * `claimedHarnessId` are echoed onto `task.state`; the authoritative copies are
 * on `TaskAttempt`. The entry is dropped at the first terminal.
 */
interface DispatchedTask {
  dispatched: boolean;
  terminalSettled: boolean;
  claimedRuntime?: RuntimeId;
  claimedHarnessId?: string;
  readonly early: Array<() => void>;
}

/**
 * Post-commit wake-ups and the cross-task `ByokServerEvent` feed.
 *
 * The relay holds no task content and no history (#1113). Task event readers
 * (`tasks.events`, `TaskHandle.events()`, `TaskHandle.result()`,
 * `tasks.messageDraft`) read the durable stores and use {@link watch} only to
 * learn that something may have changed; a wake may cause an extra read, never
 * a new event. Every committed envelope that names a task, and every Host
 * transition, wakes that task's watchers.
 *
 * A dispatch first {@link provision}s its task id, then {@link noteDispatched}
 * after the kernel accepted its offer, or {@link abort}s. An envelope naming a
 * task this instance did not dispatch allocates nothing.
 *
 * `onInboundCommitted` runs inline on the kernel's request path and must stay
 * synchronous and cheap.
 */
export class TaskEventRelay implements ByokCloudObserver {
  readonly #watchers = new Map<string, Set<() => void>>();
  readonly #tasks = new Map<string, DispatchedTask>();
  readonly #serverEvents = new AsyncEventQueue<ByokServerEvent>({ maxBuffered: SERVER_EVENT_BUFFER_LIMIT });
  #stopped = false;

  serverEvents(): AsyncIterable<ByokServerEvent> {
    return this.#serverEvents.subscribe();
  }

  emitServerEvent(event: ByokServerEvent): void {
    if (this.#stopped) return;
    this.#serverEvents.push(event);
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  watch(taskId: string, wake: () => void): () => void {
    const watchers = this.#watchers.get(taskId) ?? new Set<() => void>();
    watchers.add(wake);
    this.#watchers.set(taskId, watchers);
    return () => {
      watchers.delete(wake);
      if (watchers.size === 0 && this.#watchers.get(taskId) === watchers) this.#watchers.delete(taskId);
    };
  }

  wake(taskId: string): void {
    for (const wake of [...(this.#watchers.get(taskId) ?? [])]) wake();
  }

  provision(taskId: string): void {
    if (this.#stopped || this.#tasks.has(taskId)) return;
    this.#tasks.set(taskId, { dispatched: false, terminalSettled: false, early: [] });
  }

  abort(taskId: string): void {
    if (this.#tasks.get(taskId)?.dispatched === false) this.#tasks.delete(taskId);
  }

  /** `at` is the offer envelope's own timestamp. */
  noteDispatched(taskId: string, at: string): void {
    const task = this.#tasks.get(taskId);
    if (task === undefined || task.dispatched) return;
    task.dispatched = true;
    this.emitServerEvent({ kind: 'task.created', taskId, at });
    for (const deliver of task.early.splice(0)) deliver();
    this.wake(taskId);
  }

  /**
   * Host-side transitions the wire never carries: an accepted cancellation or
   * abandonment, and an approval the Host resolved. The decision is already
   * committed; this only announces it.
   */
  noteHostTransition(taskId: string, state: TaskState, at: string): void {
    this.wake(taskId);
    const task = this.#tasks.get(taskId);
    if (task !== undefined) this.#deliver(task, () => this.#transition(task, taskId, state, at));
  }

  onInboundCommitted(input: InboundCommitted): void {
    if (this.#stopped) return;
    const { envelope } = input;
    const taskId = envelope.task_id;
    if (taskId === undefined) return;
    this.wake(taskId);
    const task = this.#tasks.get(taskId);
    if (task === undefined) return;
    const at = new Date().toISOString();
    this.#deliver(task, () => this.#handleTaskEnvelope(task, taskId, envelope, at));
  }

  #deliver(task: DispatchedTask, deliver: () => void): void {
    if (task.dispatched) deliver();
    else task.early.push(deliver);
  }

  #handleTaskEnvelope(task: DispatchedTask, taskId: string, envelope: InboundCommitted['envelope'], at: string): void {
    switch (envelope.type) {
      case 'task.claim':
        if (envelope.payload.runtime !== undefined) task.claimedRuntime = envelope.payload.runtime;
        if (envelope.payload.harnessId !== undefined) task.claimedHarnessId = envelope.payload.harnessId;
        this.#transition(task, taskId, 'Claimed', at);
        return;
      case 'task.started':
        this.#transition(task, taskId, 'Running', at);
        return;
      case 'task.await_approval':
        this.#transition(task, taskId, 'AwaitApproval', at);
        return;
      case 'task.approval_resolved':
        this.emitServerEvent({
          kind: 'task.approval_resolved',
          taskId,
          at,
          approvalId: envelope.payload.approvalId,
          decision: envelope.payload.decision,
          resolvedBy: envelope.payload.resolvedBy,
        });
        this.#transition(task, taskId, 'Running', at);
        return;
      case 'task.decline':
      case 'task.fail':
        this.#transition(task, taskId, 'Failed', at);
        return;
      case 'task.complete':
        this.#transition(task, taskId, 'Complete', at);
        return;
      case 'task.cancelled':
        this.#transition(task, taskId, 'Cancelled', at);
        return;
      default:
        return;
    }
  }

  #transition(task: DispatchedTask, taskId: string, next: TaskState, at: string): void {
    // First terminal wins, as in the receipt store: a later stale terminal changed no durable fact.
    if (task.terminalSettled) return;
    this.emitServerEvent({
      kind: 'task.state',
      taskId,
      state: next,
      at,
      ...(task.claimedHarnessId === undefined ? {} : { claimedHarnessId: task.claimedHarnessId }),
      ...(task.claimedRuntime === undefined ? {} : { claimedRuntime: task.claimedRuntime }),
    });
    if (next !== 'Complete' && next !== 'Failed' && next !== 'Cancelled') return;
    task.terminalSettled = true;
    if (this.#tasks.get(taskId) === task) this.#tasks.delete(taskId);
  }

  /** Wake every watcher and close the server feed. Safe to call more than once. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#tasks.clear();
    for (const watchers of [...this.#watchers.values()]) for (const wake of [...watchers]) wake();
    this.#watchers.clear();
    this.#serverEvents.close();
  }
}
