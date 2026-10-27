// `TaskRunner.handleOffer`: one offer from redelivery guard to active task
// (see ./support.ts for how a member module runs).
import type { ExecutionScratch } from '../retention/scratch';
import { PreparedAgentMemoryModeSchema, type PreparedAgentMemoryMode, type TaskDeclinePayload } from '@byok-sdk/protocol';
import { type AgentHomeExecutionBinding, type AgentRef } from '../../agent-home';
import type { OfferPhaseContext } from './support';
import { offeredPreparation, sameEgressPolicy, offeredAgentRef, offeredSessionRef, offeredHomeAccess, errorMessage, outboundErrorMessage } from './support';
import type { TaskRunner } from '../task-runner';
import type { AcceptedOfferPayload } from './support';
import { bindOfferWorkspace } from './offer-workspace';
import { sealOfferManifest, claimOffer, startOfferRuntime } from './offer-launch';
import type { OfferAdmissionTiming } from './offer-admission-timing';

/** What the offer's `finally` releases. The stage that acquires a lease records it here at once, so a throw still releases it. */
export interface OfferHeld {
  owner: 'offer' | 'startup' | 'active';
  agentBinding?: AgentHomeExecutionBinding;
}
export type OfferRequest = NonNullable<ReturnType<typeof readOfferRequest>>;
export type OfferLimits = NonNullable<ReturnType<TaskRunner['admitOfferLimits']>>;
export type OfferRuntime = NonNullable<Awaited<ReturnType<TaskRunner['prepareOfferRuntime']>>>;
export type OfferWorkspace = NonNullable<Awaited<ReturnType<typeof bindOfferWorkspace>>>;
export type OfferManifest = NonNullable<Awaited<ReturnType<typeof sealOfferManifest>>>;
export type OfferClaim = NonNullable<Awaited<ReturnType<typeof claimOffer>>>;

export async function handleOffer(
  this: TaskRunner,
  taskId: string,
  payload: AcceptedOfferPayload,
  admission: OfferAdmissionTiming,
): Promise<void> {
  // Finding P2, Fix 2c (redelivered offer for an already-active/finished
  // task): checked first, ahead of everything below — a redelivered
  // offer for a taskId this device already claimed/started, or
  // already finished, can never be "the first time" for it, so there is
  // nothing left to decide. Without this, the stalled-cursor long-poll
  // re-pull (see `ConnectionManager.dedupWatermark`) redelivering this
  // same offer while its first prepared operation is still in flight (or
  // well after it already succeeded) would start a SECOND adapter session
  // for the same task, orphaning the first.
  if (this['tasks'].has(taskId) || this['startupOwnership'].has(taskId) || this['inFlightOffers'].has(taskId) || this['finishedTaskIds'].has(taskId) || this['strictDeclinedTaskIds'].has(taskId)) {
    return;
  }

  const request = readOfferRequest.call(this, taskId, payload, admission);
  if (request === undefined) return;
  const {
    agentRef, decline, sessionRef, homeAccess, readerAttempt, homeBusyCode, preparation, agentMemory,
    preparedMemorySelected, ordinaryMemoryMode, ordinaryMemoryMcp,
  } = request;
  const preparationLane = this['deps'].inputPreparationLane;
  if (preparation !== undefined) {
    if (preparationLane === undefined) {
      // By name, not by reinterpretation. A daemon with no input-preparation
      // section holds no record this reference could mean, and running the
      // offer some other way would be running an Execution nobody counted.
      this['decline'](taskId, admission, 'preparation_lane_unconfigured: this daemon is not configured for input preparation', false, agentRef);
      return;
    }
    // BEFORE the first read. A restarted daemon reaches this line with a
    // store that nothing has opened yet, and an unopened store is not an
    // empty one — `get` refuses rather than answering `undefined`, so this
    // await is what turns a durable record back into a visible one.
    //
    // The redelivery guard above must hold across this await too. Without
    // the marker here, a second delivery of this offer under a new seq
    // passes the guard while this one waits, and then acts on a task this
    // delivery claims, starts or declines. The marker is released on both
    // exits and added again below, with no await in between.
    this['inFlightOffers'].add(taskId);
    try {
      await preparationLane.open();
    } catch (error) {
      this['decline'](
        taskId,
        admission,
        `preparation_store_unavailable: the preparation store could not be opened: ${outboundErrorMessage(error)}`,
        false,
        agentRef,
      );
      return;
    } finally {
      this['inFlightOffers'].delete(taskId);
    }
    if (preparationLane.store.get(preparation.reference) === undefined) {
      this['decline'](taskId, admission, 'preparation_not_found: no preparation record under this reference on this device', false, agentRef);
      return;
    }
  }
  const messageRequirement = payload.messageEgress;
  const terminalProjection = payload.terminalProjection;
  if (payload.egressPolicy !== undefined) {
    if (this['deps'].agentEgressPolicy === undefined || !sameEgressPolicy(this['deps'].agentEgressPolicy, payload.egressPolicy)) {
      decline('Agent egress offer policy is not exactly enabled by this daemon', false);
      return;
    }
  }
  if (messageRequirement !== undefined && ((preparation === undefined && this['deps'].agentMessageMcpBin === undefined) || this['deps'].tenantId === undefined)) {
    decline('required Agent message egress is unavailable on this daemon', false);
    return;
  }
  if (terminalProjection?.mode === 'result-document') {
    if (this['deps'].tenantId === undefined || this['deps'].agentResultMcpBin === undefined) {
      decline('offer requires a result document but this daemon cannot host the submit_result channel: it needs an Agent offer, an enrolled tenant and the SDK result helper', false);
      return;
    }
  }

  // Finding #5: mark this taskId as "in-flight" for the entire remainder
  // of this call — `evictPendingCancelled` must never remove a
  // `pendingCancelled` entry for a taskId in this set (see its own doc
  // comment and `inFlightOffers`'s class-level doc comment for the exact
  // counterexample this closes). The `finally` below clears it on every
  // exit path (decline, fail, the checkpoint-2 cancel-teardown, or
  // successful registration) — never leaked past this one call.
  this['inFlightOffers'].add(taskId);
  const blobAbort = new AbortController();
  const startupDeadline = Date.now() + (this['deps'].startupTimeoutMs ?? 30_000);
  const startupTimer = setTimeout(() => blobAbort.abort(new Error('runtime startup deadline exceeded during admission/start')),
    this['deps'].startupTimeoutMs ?? 30_000);
  startupTimer.unref?.();
  const admissionWithdrawn = (): boolean => {
    if (!blobAbort.signal.aborted) return false;
    const cancelled = this['pendingCancelled'].has(taskId);
    decline(cancelled ? 'cancelled before claim' : this['stoppingOffers'] ? 'daemon is shutting down' : 'runtime startup deadline exceeded', !cancelled);
    return true;
  };
  this['inFlightBlobAborts'].set(taskId, blobAbort);
  // The one owner of the offer's leases, pin, and contexts at each moment.
  // Each change of owner happens on the same synchronous path as the
  // startup registration or the active handoff it names.
  const held: OfferHeld = { owner: 'offer' };
  let executionScratch: ExecutionScratch | undefined;
  let reservedHome: string | undefined;
  const releaseReservation = (): void => {
    if (reservedHome === undefined) return;
    const remaining = this['homeReservations'].get(reservedHome)! - 1;
    if (remaining === 0) this['homeReservations'].delete(reservedHome);
    else this['homeReservations'].set(reservedHome, remaining);
    reservedHome = undefined;
  };
  const reserveHome = (reservationKey: string): void => {
    this['homeReservations'].set(reservationKey, (this['homeReservations'].get(reservationKey) ?? 0) + 1);
    reservedHome = reservationKey;
  };
  const phase: OfferPhaseContext = {
    taskId, decline, admissionWithdrawn, admissionSignal: blobAbort.signal, releaseReservation, reserveHome, admission,
  };
  try {
    if (this['admitOffer'](phase) === undefined) return;

    if (await this['reserveOfferHome'](phase, agentRef, readerAttempt, sessionRef, homeAccess) === undefined) return;

    const offerLimits = this['admitOfferLimits'](phase, payload);
    if (offerLimits === undefined) return;
    const { requiredToolsets, resolvedMcp } = offerLimits;
    const runtime = await this['prepareOfferRuntime'](phase, {
      acquireScratch: async () => {
        const scratch = await this['deps'].scratchRoot.create();
        executionScratch = scratch;
        return scratch;
      },
      payload, agentRef, preparation, preparedMemorySelected, ordinaryMemoryMode, ordinaryMemoryMcp, messageRequirement, terminalProjection,
      readerAttempt, requiredToolsets, resolvedMcp, blobAbort,
    });
    if (runtime === undefined) return;
    const { scratch, offered, pick, env, mcpEnv, mcpToolsetTools, mcpToolApprovals, prepared } = runtime;
    let taskMcpServers = runtime.taskMcpServers;

    const workspace = await bindOfferWorkspace.call(this, phase, held, {
      agentRef, readerAttempt, sessionRef, homeAccess, homeBusyCode, pick, messageRequirement, terminalProjection,
    });
    if (workspace === undefined) return;
    const { agentBinding, workspaceDir, appliedAgentHomeProjection, readerMemoryBaseline } = workspace;

    const sealed = await sealOfferManifest.call(this, phase, {
      agentBinding, agentRef, agentMemory, preparation, preparedMemorySelected, readerAttempt, sessionRef, env, mcpEnv,
      mcpToolsetTools, offered, pick, prepared, scratch, requiredToolsets, resolvedMcp, workspaceDir, blobAbort,
      preparationLane, terminalProjection,
    });
    if (sealed === undefined) return;
    const { runtimeLaunch, manifest, preparedLaunch, preparedObservation } = sealed;

    const claimed = await claimOffer.call(this, phase, {
      agentBinding, agentRef, pick, manifest, preparedLaunch, blobAbort, payload, taskMcpServers,
    });
    if (claimed === undefined) return;
    const { resolvedInstruction } = claimed;
    ({ taskMcpServers } = claimed);

    await startOfferRuntime.call(this, phase, held, {
      agentBinding, ordinaryMemoryMode, readerAttempt, env, mcpEnv, mcpToolsetTools, mcpToolApprovals, pick, prepared, scratch, manifest,
      preparedLaunch, runtimeLaunch, resolvedInstruction, taskMcpServers, blobAbort, startupDeadline,
    }, {
      agentBinding, readerAttempt, pick, scratch, appliedAgentHomeProjection, readerMemoryBaseline, preparedObservation,
      workspaceDir, blobAbort, payload, messageRequirement, terminalProjection,
    });
  } finally {
    clearTimeout(startupTimer);
    releaseReservation();
    try {
      if (held.owner === 'startup') {
        // Startup release must succeed. The startup owner releases the
        // leases and the preparation pin only after the disposal receipt
        // and the terminal commit. A failed release keeps the owner, and
        // StartupOwnership retries it.
        await this['startupOwnership'].dispose(taskId);
      }
      if (held.owner === 'offer') {
        // Offer release is best effort. The offer never became an
        // Execution: it declined, failed, threw, or was cancelled before
        // `start()` published a session. Each early exit already released
        // its leases before it declined or failed; these calls only cover
        // a throw, and each release is idempotent. The nonces minted for
        // its would-be children die with it.
        this['pendingMessageTasks'].delete(taskId);
        this['revokeAgentMessageContext'](taskId);
        this['revokeAgentResultContext'](taskId);
        this['revokeAgentMemoryContext'](taskId);
        this['deleteHostToolsetContexts'](taskId);
        await held.agentBinding?.lease.release().catch(() => {});
        await this['releasePreparationPin'](taskId);
      }
      // An active task's Session owns the runtime launch. The projection
      // holds env or IPC references, not the key, so removing it does not
      // revoke a credential. Its cleanup timing for a retained startup
      // stays unchanged here.
      if (held.owner === 'offer' && executionScratch !== undefined) {
        try { await executionScratch.release(); }
        catch (error) {
          this['deps'].scratchRoot?.abandon(executionScratch.token);
          this['deps'].onRuntimeDisposalFailure?.({ taskId, runtimeId: 'scratch', stage: 'cleanup', reason: 'offer scratch disposal did not complete' });
          throw error;
        }
      }
    } finally {
      this['inFlightBlobAborts'].delete(taskId);
      this['inFlightOffers'].delete(taskId);
      this['claimedHarnesses'].delete(taskId);
    }
  }
}

function readOfferRequest(this: TaskRunner, taskId: string, payload: AcceptedOfferPayload, admission: OfferAdmissionTiming) {
  let offeredRef: AgentRef | undefined;
  try {
    offeredRef = offeredAgentRef(payload);
  } catch (error) {
    this['decline'](taskId, admission, `invalid AgentRef: ${errorMessage(error)}`, false);
    return;
  }
  if (offeredRef === undefined || this['deps'].agentHome === undefined || this['deps'].agentSessionHandoffs === undefined) {
    this['decline'](
      taskId,
      admission,
      'Agent offer requires the SDK-owned agent-home-contract layout and handoff store',
      false,
      offeredRef,
    );
    return;
  }
  // Every offer past this point is bound to exactly one Agent.
  const agentRef: AgentRef = offeredRef;
  const decline = (reason: string, retryable: boolean, code?: TaskDeclinePayload['code']): void => {
    this['decline'](taskId, admission, reason, retryable, agentRef, code);
  };
  const sessionRef = offeredSessionRef(payload);
  const homeAccess = offeredHomeAccess(payload);
  const readerAttempt = homeAccess === 'memory-reader';
  const homeBusyCode = readerAttempt ? 'agent_home_reader_busy' : 'agent_home_writer_busy';
  // The prepared lane is selected by the presence of this value and nothing
  // else. Absent for every ordinary offer, so every branch below that does
  // not mention it behaves exactly as it did before this lane existed.
  const preparation = offeredPreparation(payload);
  const offeredMemory = payload.agentMemory;
  if (preparation !== undefined && !PreparedAgentMemoryModeSchema.safeParse(offeredMemory).success) {
    decline('agent_memory_selection_invalid: prepared offers require an explicit memory selection', false);
    return;
  }
  // The prepared lane refused both `*-if-admitted` values above, so this view is exact there.
  const agentMemory = offeredMemory === 'read-if-admitted' || offeredMemory === 'read-write-if-admitted'
    ? undefined
    : offeredMemory;
  const preparedMemorySelected = preparation !== undefined && agentMemory !== 'none';
  // An ordinary Agent offer may select its own memory (#614). Absent keeps the
  // daemon admission: a writer `read-write`, a reader `read`, and `off` none.
  // An explicit selection is never changed to a smaller one, except
  // `read-if-admitted` and `read-write-if-admitted`, which run as `read` and
  // `read-write` when admitted and else `none` (#815, #833). Admission is read
  // once here; the runtime binding uses this answer.
  const ordinaryMemory = preparation === undefined ? offeredMemory : undefined;
  if ((ordinaryMemory === 'read-write' || ordinaryMemory === 'read-write-if-admitted') && readerAttempt) {
    decline('agent_memory_selection_invalid: a memory-reader Attempt reads memory only', false);
    return;
  }
  const memoryAdmitted = this['agentMemoryMcpAdmitted']();
  if ((ordinaryMemory === 'read' || ordinaryMemory === 'read-write') && !memoryAdmitted) {
    decline('agent_memory_unavailable: this daemon does not admit the Agent memory MCP', false);
    return;
  }
  const ordinaryMemoryMode: PreparedAgentMemoryMode = ordinaryMemory === 'read-if-admitted'
    ? (memoryAdmitted ? 'read' : 'none')
    : ordinaryMemory === 'read-write-if-admitted'
      ? (memoryAdmitted ? 'read-write' : 'none')
      : ordinaryMemory ?? (this['deps'].agentMemoryMcp === 'off' ? 'none' : readerAttempt ? 'read' : 'read-write');
  const ordinaryMemoryMcp = ordinaryMemoryMode !== 'none' && memoryAdmitted;
  return {
    agentRef, decline, sessionRef, homeAccess, readerAttempt, homeBusyCode, preparation, agentMemory,
    preparedMemorySelected, ordinaryMemoryMode, ordinaryMemoryMcp,
  } as const;
}










