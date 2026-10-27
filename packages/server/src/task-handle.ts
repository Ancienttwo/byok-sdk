import {
  ByokCloudError,
  SteerRejectedError as KernelSteerRejectedError,
  type ByokCloud,
  type SteerRejectionCode,
  type TenantId,
} from '@byok-sdk/cloud';
import type { RuntimeId, TaskState } from '@byok-sdk/protocol';
import type { TaskEventRelay } from './relay';
import { TaskEventsUnavailableError, type ServerTaskEvent, type TaskEventEntry, type TaskHandle, type TaskResult } from './types';

function steerRejectionMessage(
  taskId: string,
  code: SteerRejectionCode,
  state: TaskState,
  runtime: RuntimeId | undefined,
): string {
  switch (code) {
    case 'task_terminal':
      return `cannot steer task ${taskId}: task is already terminal (state ${state})`;
    case 'task_not_running':
      return `cannot steer task ${taskId}: not running (state ${state})`;
    case 'steer_unsupported_runtime':
      return `cannot steer task ${taskId}: claimed runtime ${runtime ?? '(unknown)'} does not support steering`;
  }
}

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
export class SteerRejectedError extends Error {
  readonly taskId: string;
  readonly code: SteerRejectionCode;
  /** The task's state at the moment the steer was refused. */
  readonly state: TaskState;
  /** `TaskSnapshot.claimedRuntime` — `undefined` when nothing was ever recorded, which is itself a reason `steer_unsupported_runtime` can fire. */
  readonly runtime: RuntimeId | undefined;

  constructor(
    taskId: string,
    code: SteerRejectionCode,
    state: TaskState,
    runtime: RuntimeId | undefined,
  ) {
    super(steerRejectionMessage(taskId, code, state, runtime));
    this.name = 'SteerRejectedError';
    this.taskId = taskId;
    this.code = code;
    this.state = state;
    this.runtime = runtime;
  }
}

/** The three states this surface calls terminal — the same set {@link TaskResult} is defined over. */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['Complete', 'Failed', 'Cancelled']);

/**
 * The refusal code for a state THIS surface has already decided.
 *
 * Not a translation of the kernel's `status` — that field is never read here.
 * The kernel's own precedence is "terminal first, so a terminal attempt reports
 * the more specific truth" (`steer-control.ts`), and it applies that rule to its
 * attempt status; this applies the identical rule to the one `TaskState` the
 * façade answers `tasks.get()` with, which is the same value already being put
 * on the error. Without it the two halves of one error contradict each other:
 * an accepted host cancellation is terminal here immediately (`snapshot.ts`
 * gate 1) while the kernel still calls the attempt `cancel_requested` and
 * therefore live, producing `code: 'task_not_running'` on an error whose own
 * `state` says `Cancelled`.
 */
function refusalCode(kernelCode: SteerRejectionCode, state: TaskState): SteerRejectionCode {
  return TERMINAL_STATES.has(state) ? 'task_terminal' : kernelCode;
}

export interface TaskHandleDeps {
  readonly tenant: TenantId;
  readonly cloud: ByokCloud;
  readonly relay: TaskEventRelay;
  /**
   * The task's current `TaskSnapshot.state`, or `undefined` when the attempt is
   * gone. The snapshot projection itself — never a second derivation.
   */
  readonly readState: (taskId: string) => Promise<TaskState | undefined>;
  /** The read-back this handle's `result()` answers with. */
  readonly readResult: (taskId: string) => Promise<TaskResult | undefined>;
}

type ApprovalDeps = Pick<TaskHandleDeps, 'tenant' | 'cloud' | 'relay'>;
type EventDeps = Pick<TaskHandleDeps, 'relay' | 'readState'>;

/**
 * One task's event feed from the relay, shared by `ByokServer.tasks.events`
 * and {@link TaskHandle.events}. Every refusal is thrown by the first `next()`,
 * before any entry; once entries flow, the read only ends (terminal, `signal`,
 * server close).
 *
 * Liveness is judged by the projection `tasks.get` answers with, never by the
 * attempt status: an accepted host cancellation is terminal there at once
 * while the attempt still reads `cancel_requested`, and a feed attached on that
 * basis would wait for a device message that may never come.
 */
export async function* readTaskEvents(
  deps: EventDeps,
  taskId: string,
  options: { after?: string; signal?: AbortSignal } = {},
): AsyncGenerator<TaskEventEntry, void, undefined> {
  const { relay, readState } = deps;
  const { signal } = options;
  if (relay.stopped || signal?.aborted) return;
  let feed = relay.feed(taskId);
  let state = await readState(taskId);
  if (feed === undefined) {
    // Refuse before attaching, so a read of a reclaimed or unknown task never
    // recreates relay state for it.
    if (state === undefined) throw taskNotFound(taskId);
    if (TERMINAL_STATES.has(state)) throw new TaskEventsUnavailableError(taskId, 'feed_expired');
    feed = relay.attach(taskId);
    if (feed === undefined) return;
    // A terminal committed between the read and the attach never reached the
    // new feed, which would then never end: read again now that it listens.
    state = await readState(taskId);
  }
  if (state === undefined) {
    relay.detach(taskId, feed);
    throw taskNotFound(taskId);
  }
  if (TERMINAL_STATES.has(state) && !feed.dispatched && !feed.terminalSettled) {
    relay.detach(taskId, feed);
    throw new TaskEventsUnavailableError(taskId, 'feed_expired');
  }
  const entries = relay.entries(taskId, feed, options.after)[Symbol.asyncIterator]();
  // The queue's own return() also releases a pending next(), which this
  // generator's return() could not do while it is suspended in one.
  const stop = () => { void entries.return?.(); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted) return;
    for (let next = await entries.next(); !next.done; next = await entries.next()) {
      yield { cursor: `${feed.feedId}.${next.value.sequence}`, event: next.value.value };
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    await entries.return?.();
  }
}

function taskNotFound(taskId: string): ByokCloudError {
  return new ByokCloudError('task_not_found', `Task ${taskId} was not found for this tenant.`);
}

/**
 * The host's approval decision, shared by {@link TaskHandle.approve} and
 * `ByokServer.tasks.approve`. Cloud atomically records it in the one approval
 * timeline before this notification is enqueued; the relay remains a
 * notification projection, never a second writer for that authority.
 */
export async function approvePendingApproval(deps: ApprovalDeps, taskId: string, opts?: { approvalId?: string }): Promise<void> {
  await deps.cloud.approveTask(deps.tenant, taskId, opts);
  deps.relay.noteHostTransition(taskId, 'Running', new Date().toISOString());
}

/** The rejection counterpart of {@link approvePendingApproval}. */
export async function rejectPendingApproval(
  deps: ApprovalDeps,
  taskId: string,
  reason?: string,
  opts?: { approvalId?: string },
): Promise<void> {
  await deps.cloud.rejectTask(deps.tenant, taskId, {
    ...(opts?.approvalId === undefined ? {} : { approvalId: opts.approvalId }),
    ...(reason === undefined ? {} : { reason }),
  });
  deps.relay.noteHostTransition(taskId, 'Running', new Date().toISOString());
}

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
export function createTaskHandle(taskId: string, deps: TaskHandleDeps): TaskHandle {
  // Captured once, at construction. Looking the barrier up later would resurrect
  // relay state for a task whose terminal was already reclaimed, and then wait
  // on a promise nothing is left to settle.
  const terminal = deps.relay.terminal(taskId);

  return {
    taskId,

    events(): AsyncIterable<ServerTaskEvent> {
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<ServerTaskEvent> {
          for await (const entry of readTaskEvents(deps, taskId)) yield entry.event;
        },
      };
    },

    async cancel(reason?: string): Promise<void> {
      const attempt = await deps.cloud.cancelTask(deps.tenant, taskId, reason);
      // An already-terminal task comes back untouched: there was nothing to
      // cancel, its terminal already settled the barrier, and announcing a
      // `Cancelled` transition would contradict the recorded result.
      if (attempt.cancellation === undefined) return;
      deps.relay.noteHostTransition(taskId, 'Cancelled', attempt.cancellation.requestedAt);
    },

    approve(opts?: { approvalId?: string }): Promise<void> {
      return approvePendingApproval(deps, taskId, opts);
    },

    reject(reason?: string, opts?: { approvalId?: string }): Promise<void> {
      return rejectPendingApproval(deps, taskId, reason, opts);
    },

    async steer(text: string): Promise<void> {
      try {
        await deps.cloud.steerTask(deps.tenant, taskId, { text });
      } catch (caught) {
        if (!(caught instanceof KernelSteerRejectedError)) throw caught;
        const state = await deps.readState(taskId);
        // A refused steer is a non-event, so nothing it did could have removed
        // the attempt between the gate and this read. If the attempt is gone
        // anyway, the store lost it: report the kernel's own refusal rather
        // than inventing a `TaskState` for a task that no longer has one.
        if (state === undefined) throw caught;
        throw new SteerRejectedError(taskId, refusalCode(caught.code, state), state, caught.runtime);
      }
    },

    async result(): Promise<TaskResult> {
      // Notification delivery is not terminal liveness authority. A terminal
      // can be durable before a TaskHandle is constructed (or after relay
      // reclamation), so always ask the durable projection before waiting.
      const alreadyRecorded = await deps.readResult(taskId);
      if (alreadyRecorded !== undefined) return alreadyRecorded;
      await terminal;
      const result = await deps.readResult(taskId);
      if (result === undefined) {
        // The barrier only settles on a fact the store wrote, so an absent
        // read-back means the store lost it. Fail loudly rather than inventing
        // a terminal the task never reached.
        throw new Error(`task ${taskId} reached a terminal with no recorded result`);
      }
      return result;
    },
  };
}
