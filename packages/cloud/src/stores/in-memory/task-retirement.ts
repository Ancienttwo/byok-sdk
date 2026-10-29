/**
 * The in-memory transitions device retirement and task abandonment share.
 *
 * Each attempt moves under its own task mutation chain, and the mailbox moves
 * through `expirePending`, which serializes on the device's own chain: the
 * reference has no cross-store transaction, so it orders the two halves the
 * way the cancellation port does, mailbox first and the attempt write last.
 * The fallible half runs first, so a failed expiry leaves the attempts as
 * they were.
 */
import type { MailboxStore, TenantId } from '@byok-sdk/core';
import {
  TASK_ATTEMPT_UNFINISHED_STATUSES,
  type TaskAbandonCause,
  type TaskAttempt,
} from '../ports';
import type { InMemoryTaskAttemptState } from './task-attempts';

type Retirement = Pick<MailboxStore, 'expirePending' | 'readAfter'>;

function unfinished(attempt: TaskAttempt): boolean {
  return (TASK_ATTEMPT_UNFINISHED_STATUSES as readonly string[]).includes(attempt.status);
}

function abandoned(attempt: TaskAttempt, cause: TaskAbandonCause, now: string): TaskAttempt {
  return {
    ...attempt,
    status: 'cancelled',
    terminalCause: cause,
    terminalAt: attempt.terminalAt ?? now,
    updatedAt: now,
  };
}

/** Device retirement, attempt half: every unfinished attempt the device was offered or owns. Never throws. */
export async function settleDeviceAttempts(
  state: InMemoryTaskAttemptState,
  tenant: TenantId,
  deviceId: string,
  cause: Extract<TaskAbandonCause, 'device_revoked' | 'device_superseded'>,
): Promise<void> {
  const keys = [...state.attempts.entries()]
    .filter(([, attempt]) => attempt.tenantId === tenant &&
      (attempt.deviceId === deviceId || attempt.ownerDeviceId === deviceId))
    .map(([key]) => key);
  for (const key of keys) {
    await state.mutate(key, () => {
      const attempt = state.attempts.get(key);
      if (attempt !== undefined && unfinished(attempt)) state.attempts.set(key, abandoned(attempt, cause, state.now()));
    });
  }
}

/**
 * Task abandonment: the task's pending rows on its target and owner devices
 * that are no longer registered, then the attempt. A registered device keeps
 * its rows pending: expiring one would raise its `recoverableFrom` past rows
 * it has not read yet. It reads and acks them as usual, and the inbound gate
 * refuses its later report for the settled task. A row belongs to the task
 * when its envelope names it in a top-level `task_id`. A terminal attempt is
 * returned as it is.
 */
export function abandonTask(
  state: InMemoryTaskAttemptState,
  mailbox: Retirement,
  tenant: TenantId,
  key: string,
  cause: TaskAbandonCause,
  isRegistered: (deviceId: string) => Promise<boolean>,
): Promise<TaskAttempt | undefined> {
  return state.mutate(key, async () => {
    const attempt = state.attempts.get(key);
    if (attempt === undefined || !unfinished(attempt)) return attempt;
    const devices = attempt.ownerDeviceId === undefined || attempt.ownerDeviceId === attempt.deviceId
      ? [attempt.deviceId]
      : [attempt.deviceId, attempt.ownerDeviceId];
    for (const deviceId of devices) {
      if (await isRegistered(deviceId)) continue;
      const seqs: number[] = [];
      for (let afterSeq = 0, more = true; more;) {
        const page = await mailbox.readAfter(tenant, { deviceId, afterSeq });
        for (const message of page.messages) {
          if (envelopeTaskId(message.body) === attempt.taskId) seqs.push(message.seq);
        }
        afterSeq = page.nextSeq;
        more = page.hasMore;
      }
      await mailbox.expirePending(tenant, { deviceId, seqs });
    }
    const settled = abandoned(attempt, cause, state.now());
    state.attempts.set(key, settled);
    return settled;
  });
}

function envelopeTaskId(body: string): unknown {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === 'object' ? (value as { readonly task_id?: unknown }).task_id : undefined;
  } catch {
    return undefined;
  }
}
