// `handleOffer` stage: hand the started session to an active task
// (see ./support.ts for how a member module runs).
import { AgentMessageDraftPublisher } from '../agent-message-draft';
import { createEnvelope } from '@byok-sdk/protocol';
import type { Session } from '../../types';
import { ExecutionRecordAccumulator } from '../execution-record';
import { ProgressBatcher } from '../progress-batcher';
import type { ActiveTask, OfferPhaseContext } from './support';
import { outboundErrorMessage } from './support';
import type { TaskRunner } from '../task-runner';
import type { AcceptedOfferPayload } from './support';
import type { OfferHeld, OfferManifest, OfferRequest, OfferRuntime, OfferWorkspace } from './offer';

export interface OfferActivationInput
  extends Pick<OfferRequest, 'readerAttempt'>,
    Pick<OfferRuntime, 'pick' | 'scratch'>,
    Pick<OfferWorkspace, 'appliedAgentHomeProjection' | 'readerMemoryBaseline'>,
    Pick<OfferManifest, 'preparedObservation' | 'toolAuthorization'>,
    Pick<OfferWorkspace, 'workspaceDir'> {
  readonly agentBinding: OfferWorkspace['agentBinding'];
  readonly blobAbort: AbortController;
  readonly payload: AcceptedOfferPayload;
  readonly session: Session;
  readonly messageRequirement: ActiveTask['messageRequirement'];
  readonly terminalProjection: ActiveTask['terminalProjection'];
}

/**
 * Moves the started session from startup ownership to an active task: binds
 * the lease to the session, records the Agent handoff, honours a cancel that
 * raced the start, then registers the task and starts its event pump.
 */
export async function activateOffer(this: TaskRunner, phase: OfferPhaseContext, held: OfferHeld, input: OfferActivationInput): Promise<void> {
  const { taskId } = phase;
  const {
    agentBinding, readerAttempt, pick, scratch, appliedAgentHomeProjection, readerMemoryBaseline, preparedObservation,
    workspaceDir, blobAbort, payload, session, messageRequirement, terminalProjection, toolAuthorization,
  } = input;
  try {
  try {
    await agentBinding.lease.bindSession(session.sessionRef);
  } catch (error) {
    await this['failClaimedAgent'](
      taskId,
      `Agent session execution lease could not bind the runtime session: ${outboundErrorMessage(error)}`,
      false,
      {
        binding: agentBinding,
        runtimeId: pick.descriptor.id,
        sessionRef: session.sessionRef,
      },
    );
    return;
  }

  let active!: ActiveTask;
  active = {
    taskId,
    blobAbort,
    egressEnabled: payload.egressPolicy !== undefined,
    adapter: pick.adapter,
    session,
    scratch,
    workspaceDir,
    toolAuthorization,
    agentBinding,
    agentRef: agentBinding.resolution.agentRef,
    agentHandoff: {
      sessionRef: session.sessionRef,
      runtimeId: pick.descriptor.id,
      home: agentBinding.resolution.canonicalHome,
      cwd: workspaceDir,
      ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
    },
    ...(appliedAgentHomeProjection === undefined ? {} : { appliedAgentHomeProjection }),
    ...(readerMemoryBaseline === undefined ? {} : { readerMemoryBaseline }),
    summaryParts: [],
    finalTextParts: [],
    batcher: new ProgressBatcher(
      (seq, events) => {
        const projected = active.egressEnabled
          ? this['deps'].agentEgress?.projectLatestValue({
              agentRef: active.agentRef,
              taskId,
              events,
            }) ?? []
          : events;
        if (projected.length > 0) this['deps'].send(createEnvelope('task.progress', { seq, events: [...projected] }, { taskId, seq }));
      },
      this['deps'].batcherOptions,
      () => this['ingressBudget'],
    ),
    approvalQueue: [],
    outputBytesSoFar: 0,
    startedAtMs: Date.now(),
    executionRecord: new ExecutionRecordAccumulator(taskId, pick.descriptor.trajectoryEvidence, session),
    ...(preparedObservation === undefined ? {} : { prepared: preparedObservation }),
    ...(messageRequirement === undefined ? {} : {
      messageRequirement,
      messageOutbox: this['pendingMessageTasks'].get(taskId)!.outbox,
    }),
    ...(terminalProjection === undefined ? {} : { terminalProjection }),
    ...(terminalProjection?.mode !== 'result-document' ? {} : { resultStore: this['resultContextByTask'].get(taskId)?.store }),
  };
  // #654 D9: a task with sealing streams no draft (design §6.1, §10.4).
  if (active.messageRequirement !== undefined
    && pick.descriptor.capabilities.messageDraft === true
    && this['deps'].getServerCapabilities?.().includes('agent-message-draft')
    && this['deps'].sealedTasks?.isSealed(taskId) !== true) {
    active.messageDraft = new AgentMessageDraftPublisher({
      taskId,
      agentRef: active.agentRef,
      maxBytes: active.messageRequirement.maxBytes,
      maxCoalesceMs: this['deps'].agentEgressPolicy!.activity.maxCoalesceMs,
      getServerCapabilities: () => this['deps'].getServerCapabilities?.() ?? [],
      send: envelope => this['deps'].send(envelope),
    });
  }

  // A strict Agent handoff is the local restart authority. It is
  // intentionally awaited and fsynced before task.started; an Agent
  // runtime session that has no durable exact-match receipt must never be
  // advertised as resumable.
  try {
    await this['deps'].agentHome!.mutateExecution(agentBinding, () =>
      this['deps'].agentSessionHandoffs!.record({
        agentRef: agentBinding.resolution.agentRef,
        taskId,
        sessionRef: session.sessionRef,
        runtimeId: pick.descriptor.id,
        home: agentBinding.resolution.canonicalHome,
        cwd: workspaceDir,
        ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
        leaseId: agentBinding.lease.leaseId,
      }));
  } catch (error) {
    await this['failClaimedAgent'](
      taskId,
      `Agent session handoff could not be durably written before start: ${outboundErrorMessage(error)}`,
      false,
      {
        binding: agentBinding,
        runtimeId: pick.descriptor.id,
        sessionRef: session.sessionRef,
      },
    );
    return;
  }
  const activatedMessageRecord = active.messageOutbox === undefined
    ? undefined
    : await this['activateAgentMessage'](active.messageOutbox, taskId, session.sessionRef,
      () => !this['pendingCancelled'].has(taskId) && !blobAbort.signal.aborted);

  // Finding F4, checkpoint 2 ("consulted when start() resolves"): a
  // task.cancel arrived while prepared-operation start() was in flight — i.e. AFTER
  // task.claim already went out above, so declining is no longer an
  // option. Tear the just-started session down before it's ever
  // registered as active (this.tasks.set below) or reported task.started,
  // so pump() never begins and no zombie turn runs — then report the
  // outcome exactly like a post-registration cancel would (M1 gap #6:
  // task.cancelled, not task.fail).
  if (this['pendingCancelled'].has(taskId)) {
    const reason = this['pendingCancelled'].get(taskId);
    this['pendingCancelled'].delete(taskId);
    this['startupOwnership'].transferToActive(taskId);
    this['tasks'].set(taskId, active);
    held.owner = 'active';
    await this['settleSemanticTerminal'](active, async () => {
      active.eventPump ??= this['pump'](active);
      await this['interruptBounded'](active);
      await this['persistAgentTerminalEvidence'](active, 'cancelled', reason);
      return createEnvelope('task.cancelled', {
        reason, ...this['terminalInferenceUsagePayload'](active), ...this['agentTerminalPayload'](active),
      }, { taskId });
    });
    return;
  }

  // Claimed -> Running (M1 gap #2): report `task.started` only once the
  // adapter session has actually started — never implied by `task.claim`.
  this['deps'].send(createEnvelope('task.started', {}, { taskId }));

  // This handoff (construct `active` -> register it -> kick off `pump()`)
  // must stay synchronous, with no `await` in between: a `task.cancel`
  // (or `task.steer`/`task.approve`/`task.reject`) for this exact taskId
  // can arrive and be processed by `handleEnvelope` at any `await` point,
  // and every one of those handlers starts with `this.tasks.get(taskId)`
  // — if this task isn't registered yet, they silently no-op (see e.g.
  // `handleCancel`).
  this['inFlightBlobAborts'].delete(taskId);
  this['startupOwnership'].transferToActive(taskId);
  this['tasks'].set(taskId, active);
  held.owner = 'active';
  this['pendingMessageTasks'].delete(taskId);
  if (active.messageOutbox !== undefined && activatedMessageRecord !== undefined) {
    this['sendAgentMessageRecord'](active.messageOutbox, activatedMessageRecord);
  }
  // M5 batch-3 (workstream 2): see `armMaxDurationTimer`'s own doc
  // comment — still inside the synchronous construct -> register -> arm
  // -> pump handoff described just below (no `await` yet).
  if (payload.limits?.maxDurationMs !== undefined) {
    this['armMaxDurationTimer'](active, payload.limits.maxDurationMs);
  }
  active.eventPump = this['pump'](active);
  } catch (error) {
    if (this['tasks'].has(taskId)) throw error;
    const reason = `runtime activation failed: ${outboundErrorMessage(error)}`;
    await this['failClaimedAgent'](taskId, reason, false, {
      binding: agentBinding, runtimeId: pick.descriptor.id, sessionRef: session.sessionRef,
    });
  }
}
