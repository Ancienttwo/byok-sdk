/**
 * GAP-2: why a `cloud.steerTask` call was refused, and the one input that
 * decides it.
 *
 * The reference server (`ConnectionHub.steerTask`, `packages/server/src/hub.ts`)
 * reaches this decision from `TaskSnapshot.claimedRuntimeCapabilities` — the
 * capability block the CLAIMING adapter reported for itself on its own
 * `task.claim`, frozen at the `Offered -> Claimed` transition. Cloud keeps the
 * same single source: {@link TaskAttempt.claimedRuntimeCapabilities}, written by
 * the claim that wins the ownership CAS (`stores/ports.ts`) and never again.
 *
 * The gap this closes is not cosmetic: only pi's adapter implements steering,
 * and Claude's and Codex's THROW on receiving `task.steer`, which stalls that
 * device's redelivery cursor at that seq forever. So the refusal has to happen
 * before an envelope exists, from a fact that shares a lifecycle with the
 * task-to-runtime binding.
 *
 * Fail-closed on unknown, deliberately: `steer_unsupported_runtime` covers both
 * "the claiming adapter reported `steer: false`" and "this attempt carries no
 * capability snapshot at all" (a daemon whose claim predates the field, an
 * attempt claimed before migration `0018`). Refusing an unknown is a
 * recoverable, operator-visible error; guessing "supported" reintroduces the
 * permanent cursor stall this gate exists to prevent. There is deliberately NO
 * runtime-id allow-list here either — a table mapping `pi -> steerable` would be
 * a second capability authority in the coordination plane, drifting the moment a
 * runtime gains or loses the feature, and the daemon already reports the truth.
 *
 * SINGLE SOURCE, deliberately: the gate reads the claim snapshot and NOTHING
 * from the connection layer. Cloud's connection-level equivalent is
 * `DeviceRecord.capabilities`, written from a bearer-authenticated `conn.hello`
 * (`inbound.ts`) — discovery data describing a device BUILD, not the adapter
 * that took this task. A device can reconnect later with a different adapter
 * set; a task already running must keep being judged against what was true when
 * it was claimed. Same pin the reference server holds in
 * `packages/server/src/__tests__/steer-runtime-capability-gate.test.ts`.
 */
import type { RuntimeId } from '@byok-sdk/protocol';
import type { TaskAttemptStatus } from './stores/ports';

/**
 * Stable strings a caller switches on (an operator UI, an HTTP surface mapping
 * this to a status code) rather than matching error text. Byte-identical to the
 * reference server's `SteerRejectionCode` (`packages/server/src/hub.ts`), so a
 * host that moves from the embedded server to the hosted kernel keeps its own
 * mapping unchanged.
 *
 * - `task_terminal` — the attempt already reached `complete`/`failed`/
 *   `cancelled`. Checked FIRST, so a terminal attempt that is also (obviously)
 *   not running reports the more specific truth, and a steer racing a terminal
 *   transition always resolves terminal-first.
 * - `task_not_running` — the attempt exists and is live, but is `offered`/
 *   `claimed`/`cancel_requested`; there is no running turn to steer yet.
 * - `steer_unsupported_runtime` — the runtime that CLAIMED this attempt cannot
 *   be steered, per the claim-time capability snapshot. A MISSING snapshot
 *   rejects under this same code: unknown is not supported.
 */
export type SteerRejectionCode = 'steer_unsupported_runtime' | 'task_not_running' | 'task_terminal';

function steerRejectionMessage(
  taskId: string,
  code: SteerRejectionCode,
  status: TaskAttemptStatus,
  runtime: RuntimeId | undefined,
): string {
  switch (code) {
    case 'task_terminal':
      return `cannot steer task ${taskId}: task is already terminal (status ${status})`;
    case 'task_not_running':
      return `cannot steer task ${taskId}: not running (status ${status})`;
    case 'steer_unsupported_runtime':
      return `cannot steer task ${taskId}: claimed runtime ${runtime ?? '(unknown)'} does not support steering`;
  }
}

/**
 * Thrown by `ByokCloud.steerTask` instead of a generic `Error`, so a caller can
 * tell WHY a steer was refused without matching on message text — the same
 * typed-error idiom as `StaleApprovalError` (`approval-control.ts`).
 *
 * A distinct class rather than a `CloudErrorCode`, for the same reason as
 * `StaleApprovalError`: it carries the state and the runtime the caller needs to
 * explain the refusal, and a code alone cannot.
 *
 * Thrown before any mailbox row is allocated — a refused steer is a NON-EVENT,
 * exactly like a refused approval.
 */
export class SteerRejectedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly code: SteerRejectionCode,
    /** The attempt's status at the moment the steer was refused. */
    public readonly status: TaskAttemptStatus,
    /** {@link TaskAttempt.claimedRuntime} — `undefined` when nothing was ever recorded, which is itself a reason `steer_unsupported_runtime` can fire. */
    public readonly runtime: RuntimeId | undefined,
  ) {
    super(steerRejectionMessage(taskId, code, status, runtime));
    this.name = 'SteerRejectedError';
  }
}
