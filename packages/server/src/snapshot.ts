import type { DeviceRecord, PendingApproval, TaskAttempt, TaskAttemptStatus, TaskOfferReadback, TerminalResult } from '@byok-sdk/cloud';
import type { TaskState } from '@byok-sdk/protocol';
import type { TenantReadinessPresence } from '@byok-sdk/core';
import type { MachineInfo, TaskResult, TaskSnapshot } from './types';

/**
 * Projections from the cloud kernel's read model onto this package's public
 * shapes. Pure functions, deliberately: every input is a value the caller has
 * already read from a store, so there is exactly one place the mapping lives
 * and no way for a second copy of it to drift.
 */

/**
 * What this server calls a task the kernel calls a `TaskAttempt`.
 *
 * The order of the gates is the whole contract, and it mirrors the kernel's own
 * (`ByokCloud.readTaskResult`):
 *
 * 1. an accepted host cancellation OUTRANKS everything a runtime reports later.
 *    `cancel()` is authoritative the moment the kernel records it, so the task
 *    reads `Cancelled` immediately and a late `task.complete` — which the wire
 *    still answers as a success — cannot move it;
 * 2. a terminal attempt is its own terminal;
 * 3. an unresolved approval on the task's timeline is `AwaitApproval`. The
 *    kernel has no such attempt STATUS on purpose (ADR-028: no execution state
 *    in the cloud) — the pause is derived from the durable approval timeline,
 *    which is the same single authority `approveTask`'s staleness gate reads;
 * 4. otherwise the attempt's own coarse status.
 */
export function taskStateOf(status: TaskAttemptStatus, cancelled: boolean, awaitingApproval: boolean): TaskState {
  if (cancelled) return 'Cancelled';
  switch (status) {
    case 'complete':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'cancelled':
    case 'cancel_requested':
      return 'Cancelled';
    case 'offered':
      return !awaitingApproval ? 'Offered' : 'AwaitApproval';
    case 'claimed':
      return !awaitingApproval ? 'Claimed' : 'AwaitApproval';
    case 'running':
      return !awaitingApproval ? 'Running' : 'AwaitApproval';
  }
}

/**
 * The kernel's typed terminal read model, narrowed to this package's
 * {@link TaskResult}.
 *
 * Deliberately LOSSY in one direction: `taskId`, `recordedAt`, `agentRef`,
 * `usage` and `terminalCause` exist on `TerminalResult` and have no place here.
 * They are all reachable through the kernel (`readTaskResult`), and copying
 * them into a second shape would make this projection something a caller has to
 * keep in sync rather than a narrowing of one authority.
 */
export function toTaskResult(terminal: TerminalResult | undefined): TaskResult | undefined {
  if (terminal === undefined) return undefined;
  return {
    state: terminal.state === 'complete' ? 'Complete' : terminal.state === 'failed' ? 'Failed' : 'Cancelled',
    summary: terminal.summary,
    ...(terminal.finalMessage === undefined ? {} : { finalMessage: terminal.finalMessage }),
    sessionRef: terminal.sessionRef,
    artifactRefs: terminal.artifactRefs === undefined ? undefined : [...terminal.artifactRefs],
    ...(terminal.document === undefined ? {} : { document: terminal.document }),
    ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
    ...(terminal.code === undefined ? {} : { code: terminal.code }),
    ...(terminal.retryable === undefined ? {} : { retryable: terminal.retryable }),
    ...(terminal.failure === undefined ? {} : { failure: terminal.failure }),
  };
}

/**
 * Dispatch facts come from the immutable executable offer receipt. Its
 * recordedAt is the creation instant, independent of mailbox delivery,
 * terminal transitions and process restarts. No per-task dispatch map or
 * mutation timestamp is needed to reconstruct a dispatched task's facts.
 * An attempt opened before its offer receipt exists retains the existing
 * attempt-only projection; it has no requested session to report.
 */
export function toTaskSnapshot(
  attempt: TaskAttempt,
  pending: PendingApproval | undefined,
  terminal: TerminalResult | undefined,
  offer: TaskOfferReadback | undefined,
): TaskSnapshot {
  const result = toTaskResult(terminal);
  // The terminal's own `sessionRef` wins: a runtime that resumed or minted a
  // session is reporting the one the work actually ran under, which is a
  // stronger fact than whatever the offer asked for.
  const sessionRef = result?.sessionRef ?? (offer?.payload.session.mode === 'resume' ? offer.payload.session.sessionRef : undefined);
  return {
    taskId: attempt.taskId,
    state: taskStateOf(attempt.status, attempt.cancellation !== undefined, pending !== undefined),
    deviceId: attempt.deviceId,
    sessionRef,
    ...(attempt.agentRef === undefined ? {} : { agentRef: attempt.agentRef }),
    createdAt: offer?.recordedAt ?? attempt.updatedAt,
    updatedAt: attempt.updatedAt,
    ...(result === undefined ? {} : { result }),
    ...(pending?.approvalId === undefined ? {} : { pendingApprovalId: pending.approvalId }),
    ...(attempt.claimedHarnessId === undefined ? {} : { claimedHarnessId: attempt.claimedHarnessId }),
    ...(attempt.claimedRuntime === undefined ? {} : { claimedRuntime: attempt.claimedRuntime }),
    ...(attempt.claimedRuntimeCapabilities === undefined
      ? {}
      : { claimedRuntimeCapabilities: attempt.claimedRuntimeCapabilities }),
  };
}

/** Durable identity projected with the kernel's unexpired TTL observation. */
export function toMachineInfo(
  device: Pick<DeviceRecord, 'deviceId' | 'deviceName' | 'harnesses'>,
  presence: TenantReadinessPresence | undefined,
): MachineInfo {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    connected: presence !== undefined,
    lastSeen: presence?.observedAt,
    ...(presence?.clientVersion === undefined ? {} : { clientVersion: presence.clientVersion }),
    runtimes: presence?.runtimes,
    harnesses: device.harnesses,
    configuredToolsets: presence?.configuredToolsets,
  };
}
