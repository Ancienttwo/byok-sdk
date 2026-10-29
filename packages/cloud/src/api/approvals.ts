import type { ByokCloud, ByokCloudOptions, EnqueuedAgentControl, RejectTaskOptions } from '../cloud';
import { type ControlPlanePrincipal, type TenantId } from '@byok-sdk/core';
import { createEnvelope } from '@byok-sdk/protocol';
import { StaleApprovalError, pendingApproval, type PendingApproval } from '../approval-control';
import type { ApprovalTimelineTail } from '../approval-timeline';
import { ByokCloudError } from '../errors';
import { uuidFromSha256 } from '../offer-identity';
import type { TaskAttempt } from '../stores/ports';
import { tenantStoresFor, type CloudRootStores } from '../tenant-stores';
import { isTerminalAttemptStatus, type EnqueuePaths } from './enqueue';

interface Dependencies {
  root: CloudRootStores;
  controlPlane: (tenant: TenantId) => ControlPlanePrincipal;
  options: ByokCloudOptions;
  enqueueAgentControlEnvelope: EnqueuePaths['enqueueAgentControlEnvelope'];
}

export function createApprovalsApi({
  root,
  controlPlane,
  options,
  enqueueAgentControlEnvelope,
}: Dependencies): Pick<ByokCloud,
  | 'approveTask'
  | 'rejectTask'
> {
  async function approvalDecisionSource(
    tenant: TenantId,
    taskId: string,
    attempt: TaskAttempt,
    pending: PendingApproval,
    decision: 'approve' | 'reject',
  ): Promise<string> {
    const agent = attempt.agentRef;
    return uuidFromSha256(
      await options.crypto.sha256(
        new TextEncoder().encode(
          JSON.stringify({
            domain: 'byok:approval-decision',
            tenant,
            taskId,
            deviceId: attempt.deviceId,
            ownerDeviceId: attempt.ownerDeviceId,
            agentRef: agent,
            requestSourceEnvelopeId: pending.sourceEnvelopeId,
            requestRevision: pending.revision,
            decision,
          }),
        ),
      ),
    );
  }

  function latestApprovalRequest(tail: ApprovalTimelineTail | undefined): PendingApproval | undefined {
    if (tail === undefined) return undefined;
    for (let index = tail.entries.length - 1; index >= 0; index -= 1) {
      const entry = tail.entries[index]!;
      if (entry.event.type !== 'approval_requested') continue;
      return {
        sourceEnvelopeId: entry.sourceEnvelopeId,
        revision: entry.revision,
        ...(entry.event.approvalId === undefined ? {} : { approvalId: entry.event.approvalId }),
      };
    }
    return undefined;
  }

  async function recordedHostDecision(
    tenant: TenantId,
    taskId: string,
    attempt: TaskAttempt,
    tail: ApprovalTimelineTail | undefined,
    request: PendingApproval,
  ): Promise<
    | { readonly decision: 'approve'; readonly approvalId?: string }
    | { readonly decision: 'reject'; readonly approvalId?: string; readonly reason: string | null }
    | undefined
  > {
    for (const decision of ['approve', 'reject'] as const) {
      const sourceEnvelopeId = await approvalDecisionSource(tenant, taskId, attempt, request, decision);
      const index = tail?.entries.findIndex((candidate) => candidate.sourceEnvelopeId === sourceEnvelopeId) ?? -1;
      const entry = index < 0 ? undefined : tail!.entries[index];
      if (entry?.event.type !== 'approval_resolved' || entry.event.resolvedBy !== 'host') continue;
      const laterResolution = tail!.entries.slice(index + 1).some(
        (candidate) =>
          candidate.event.type === 'approval_resolved' &&
          (request.approvalId === undefined || candidate.event.approvalId === request.approvalId),
      );
      if (!laterResolution) {
        if (entry.event.decision === 'reject') {
          return {
            decision: 'reject',
            ...(entry.event.approvalId === undefined ? {} : { approvalId: entry.event.approvalId }),
            reason: entry.event.reason,
          };
        }
        return {
          decision: 'approve',
          ...(entry.event.approvalId === undefined ? {} : { approvalId: entry.event.approvalId }),
        };
      }
    }
    return undefined;
  }

  /**
   * Wire v4 names every approval, so a decision cannot reach a request that
   * has no `approvalId`. Only a request recorded before v4 lacks one; the
   * upgrade drains those executions first.
   */
  function unnamedApproval(taskId: string, decision: 'approve' | 'reject'): ByokCloudError {
    return new ByokCloudError('task_not_awaiting_approval', `Task ${taskId} has no named pending approval to ${decision}.`);
  }

  /**
   * The shared body of `approveTask`/`rejectTask` — one gate order, two
   * decisions, so the two host calls cannot drift apart. See
   * {@link ByokCloud.approveTask} for what each gate refuses and why the whole
   * gate runs before any durable allocation.
   */
  async function resolveApproval(
    tenant: TenantId,
    taskId: string,
    decision: 'approve' | 'reject',
    opts: RejectTaskOptions | undefined,
  ): Promise<EnqueuedAgentControl> {
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const attempt = await stores.tasks.get(taskId);
    if (attempt === undefined) {
      throw new ByokCloudError('task_not_found', `Task ${taskId} was not found for this tenant.`);
    }
    if (isTerminalAttemptStatus(attempt.status)) {
      throw new ByokCloudError(
        'task_not_awaiting_approval',
        `Task ${taskId} already reached ${attempt.status}; there is no approval left to ${decision}.`,
      );
    }
    const tail = await stores.approvals.read(taskId);
    const pending = pendingApproval(tail);
    const latestRequest = latestApprovalRequest(tail);
    if (pending === undefined) {
      // A response may have been lost after the conditional timeline commit or
      // after mailbox append.  Re-read the stable decision source and replay
      // the exact logical outcome; an opposite decision remains fail-closed.
      if (latestRequest !== undefined) {
        const recorded = await recordedHostDecision(tenant, taskId, attempt, tail, latestRequest);
        if (recorded !== undefined) {
          if (opts?.approvalId !== undefined && opts.approvalId !== recorded.approvalId) {
            throw new ByokCloudError(
              'coordination_input_invalid',
              `Task ${taskId} already has a host approval decision for a different approval.`,
            );
          }
          if (recorded.decision !== decision) {
            throw new ByokCloudError(
              'coordination_input_invalid',
              `Task ${taskId} already has the opposite host approval decision.`,
            );
          }
          if (recorded.decision === 'reject' && recorded.reason !== (opts?.reason ?? null)) {
            throw new ByokCloudError(
              'coordination_input_invalid',
              `Task ${taskId} already has a host rejection with a different immutable reason.`,
            );
          }
          const ownerDeviceId = attempt.ownerDeviceId;
          if (ownerDeviceId === undefined) {
            throw new ByokCloudError(
              'task_not_awaiting_approval',
              `Task ${taskId} has no owning device to receive its recorded ${decision}.`,
            );
          }
          if (recorded.approvalId === undefined) throw unnamedApproval(taskId, decision);
          const messageId = await approvalDecisionSource(tenant, taskId, attempt, latestRequest, decision);
          const targeting = { approvalId: recorded.approvalId };
          const recordedReason = recorded.decision === 'reject' ? recorded.reason : undefined;
          return enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
            decision === 'approve'
              ? createEnvelope('task.approve', targeting, { id: messageId, taskId, seq })
              : createEnvelope(
                  'task.reject',
                  { ...targeting, ...(recordedReason === null || recordedReason === undefined ? {} : { reason: recordedReason }) },
                  { id: messageId, taskId, seq },
                ),
          );
        }
      }
      throw new ByokCloudError(
        'task_not_awaiting_approval',
        `Task ${taskId} has no pending approval to ${decision}.`,
      );
    }
    if (pending.approvalId === undefined) throw unnamedApproval(taskId, decision);
    if (opts?.approvalId !== undefined && opts.approvalId !== pending.approvalId) {
      throw new StaleApprovalError(taskId, opts.approvalId, pending.approvalId);
    }
    // The claiming device, not the offered one: an approval belongs to the
    // runtime that is actually paused on it.
    const ownerDeviceId = attempt.ownerDeviceId;
    if (ownerDeviceId === undefined) {
      throw new ByokCloudError(
        'task_not_awaiting_approval',
        `Task ${taskId} has no owning device; no runtime is paused on an approval to ${decision}.`,
      );
    }
    const approvalId = pending.approvalId;
    const messageId = await approvalDecisionSource(tenant, taskId, attempt, pending, decision);
    const event =
      decision === 'reject'
        ? {
            type: 'approval_resolved' as const,
            approvalId,
            decision: 'reject' as const,
            resolvedBy: 'host' as const,
            reason: opts?.reason ?? null,
            at: new Date().toISOString(),
          }
        : {
            type: 'approval_resolved' as const,
            approvalId,
            decision: 'approve' as const,
            resolvedBy: 'host' as const,
            at: new Date().toISOString(),
          };
    const resolved = await root.cloud.approvals.resolvePending(tenant, {
      taskId,
      sourceEnvelopeId: messageId,
      expectedSourceEnvelopeId: pending.sourceEnvelopeId,
      expectedRevision: pending.revision,
      event,
    });
    let deliveredReason: string | null | undefined = decision === 'reject' ? opts?.reason ?? null : undefined;
    if (resolved.status === 'conflict' || resolved.status === 'superseded' || resolved.status === 'absent') {
      const currentTail = resolved.tail ?? (await stores.approvals.read(taskId));
      const currentPending = pendingApproval(currentTail);
      const recorded = await recordedHostDecision(tenant, taskId, attempt, currentTail, pending);
      if (recorded?.decision === decision) {
        // A concurrent identical resolver won first. Its event timestamp is
        // intentionally not a competing identity; the stable decision source
        // is, and mailbox append below replays that source exactly once.
        if (recorded.decision === 'reject') {
          if (recorded.reason !== deliveredReason) {
            throw new ByokCloudError(
              'coordination_input_invalid',
              `Task ${taskId} already has a host rejection with a different immutable reason.`,
            );
          }
          deliveredReason = recorded.reason;
        }
      } else if (recorded !== undefined) {
        throw new ByokCloudError(
          'coordination_input_invalid',
          `Task ${taskId} already has the opposite host approval decision.`,
        );
      } else if (
        currentPending !== undefined &&
        opts?.approvalId !== undefined &&
        currentPending.approvalId !== opts.approvalId
      ) {
        throw new StaleApprovalError(taskId, opts.approvalId, currentPending.approvalId);
      } else {
        throw new ByokCloudError(
          'task_not_awaiting_approval',
          `Task ${taskId} no longer has the pending approval to ${decision}.`,
        );
      }
    }
    const targeting = { approvalId };
    return enqueueAgentControlEnvelope(tenant, ownerDeviceId, messageId, (seq) =>
      decision === 'approve'
        ? createEnvelope('task.approve', targeting, { id: messageId, taskId, seq })
        : createEnvelope(
            'task.reject',
            { ...targeting, ...(deliveredReason === null || deliveredReason === undefined ? {} : { reason: deliveredReason }) },
            { id: messageId, taskId, seq },
          ),
    );
  }

  return {
    approveTask(tenant, taskId, opts) {
      return resolveApproval(tenant, taskId, 'approve', opts);
    },

    rejectTask(tenant, taskId, opts) {
      return resolveApproval(tenant, taskId, 'reject', opts);
    },
  };
}
