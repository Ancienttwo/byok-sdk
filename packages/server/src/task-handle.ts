import {
  SteerRejectedError as KernelSteerRejectedError,
  type ByokCloud,
  type SteerRejectionCode,
  type TaskAbandonCause,
  type TaskAttempt,
  type TenantId,
} from '@byok-sdk/cloud';
import type { RuntimeId, TaskState } from '@byok-sdk/protocol';
import type { TaskEventRelay } from './relay';
import { readTaskEvents, type TaskEventDeps } from './task-events';
import type { ServerTaskEvent, TaskHandle, TaskResult } from './types';

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

export interface TaskHandleDeps extends TaskEventDeps {
  readonly cloud: ByokCloud;
  /**
   * The task's current `TaskSnapshot.state` and `updatedAt`, or `undefined`
   * when the attempt is gone. The snapshot projection itself — never a second
   * derivation.
   */
  readonly readState: (taskId: string) => Promise<{ readonly state: TaskState; readonly at: string } | undefined>;
  /** The read-back this handle's `result()` answers with. */
  readonly readResult: (taskId: string) => Promise<TaskResult | undefined>;
}

type ApprovalDeps = Pick<TaskHandleDeps, 'tenant' | 'cloud' | 'relay'>;

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
 * Announces the `Cancelled` transition an abandonment recorded. An attempt that
 * was already terminal comes back with its own terminal, so only one settled
 * under this cause is announced; a cancelled task already announced it when
 * its tombstone was written, and the relay keeps the first terminal anyway.
 */
export function noteAbandoned(relay: TaskEventRelay, attempt: TaskAttempt, cause: TaskAbandonCause): void {
  if (attempt.status !== 'cancelled' || attempt.terminalCause !== cause || attempt.terminalAt === undefined) return;
  if (attempt.cancellation !== undefined) return;
  relay.noteHostTransition(attempt.taskId, 'Cancelled', attempt.terminalAt);
}

/**
 * One in-flight task's control surface.
 *
 * The §3 invariant it exists to keep: **the handle is not a second authority.**
 * Every mutation is a kernel call, and `result()` is a READ-BACK of the store,
 * repeated when a wake says the task may have changed, so `handle.result()` and
 * `byok.tasks.get(taskId).result` are physically the same fact rather than two
 * copies that can disagree. Nothing about the task is cached here.
 */
export function createTaskHandle(taskId: string, deps: TaskHandleDeps): TaskHandle {
  return {
    taskId,

    events(): AsyncIterable<ServerTaskEvent> {
      return readTaskEvents(deps, taskId, {}, (entry) => entry.event);
    },

    async cancel(reason?: string): Promise<void> {
      const attempt = await deps.cloud.cancelTask(deps.tenant, taskId, reason);
      // An already-terminal task comes back untouched: there was nothing to
      // cancel, and announcing a `Cancelled` transition would contradict the
      // recorded result.
      if (attempt.cancellation === undefined) return;
      deps.relay.noteHostTransition(taskId, 'Cancelled', attempt.cancellation.requestedAt);
    },

    async abandon(cause: TaskAbandonCause): Promise<void> {
      noteAbandoned(deps.relay, await deps.cloud.abandonTask(deps.tenant, taskId, cause), cause);
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
        const state = (await deps.readState(taskId))?.state;
        // A refused steer is a non-event, so nothing it did could have removed
        // the attempt between the gate and this read. If the attempt is gone
        // anyway, the store lost it: report the kernel's own refusal rather
        // than inventing a `TaskState` for a task that no longer has one.
        if (state === undefined) throw caught;
        throw new SteerRejectedError(taskId, refusalCode(caught.code, state), state, caught.runtime);
      }
    },

    async result(): Promise<TaskResult> {
      // The store is the only answer; a wake only says when to ask again.
      const changes = deps.wake.subscribe(deps.tenant, taskId, deps.shutdown);
      try {
        for (;;) {
          const result = await deps.readResult(taskId);
          if (result !== undefined) return result;
          if (deps.relay.stopped || deps.shutdown.aborted) throw new Error(`server closed before task ${taskId} reached a terminal`);
          await changes.next(Number.MAX_SAFE_INTEGER);
        }
      } finally {
        changes.close();
      }
    },
  };
}
