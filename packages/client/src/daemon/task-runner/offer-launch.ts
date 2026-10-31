import { requestApproval as requestTaskApproval } from './approvals';
import type { ApprovalKind } from '../approvals';
// `handleOffer` stages from the runtime launch to a started session: seal the
// manifest, claim, and start (see ./support.ts for how a member module runs).
import { observePreparedMemory, type PreparedAgentMemoryState } from '../prepared-agent-memory';
import { InputPreparationRequestError } from '../input-preparation-service';
import type { PiRuntimeLaunchResources } from '../../adapters/pi/runtime-launch';
import { DURABLE_REPLICA_DIRNAME } from '../../adapters/pi-durable/replica';
import { terminalIdentity } from '../terminal-identity';
import { abortedStartOf, startOwnedRuntime } from '../runtime-start';
import path from 'node:path';
import { createEnvelope } from '@byok-sdk/protocol';
import { sealRuntimeOperationManifest, type RuntimeOperationStartInput, type RuntimePreparedLaunchV1, type Session } from '../../types';
import { admitPreparedOffer, type PreparedOfferServerProjection } from '../prepared-offer-admission';
import type { InputPreparationStore } from '../input-preparation-store';
import { inputPreparationDigest } from '../../input-preparation';
import { isRuntimeStartupDisposalFailure, projectRuntimeBoundaryFailure } from '../../runtime-failure';
import { toRuntimeInfoCapabilities } from '../runtime-capabilities';
import { prependAgentMemoryModeGuidance } from '../memory-guidance';
import { isAgentMemorySecureFilesystemAvailable } from '../agent-memory';
import type { PreparedExecutionObservation, ActiveTask, OfferPhaseContext } from './support';
import { isKnownRuntimeId, offeredInstruction, errorMessage } from './support';
import type { TaskRunner, TaskRunnerDeps } from '../task-runner';
import type { AcceptedOfferPayload } from './support';
import type { OfferClaim, OfferHeld, OfferLimits, OfferManifest, OfferRequest, OfferRuntime, OfferWorkspace } from './offer';
import { activateOffer, type OfferActivationInput } from './offer-activation';
import { createAutoToolAuthorizationGate, parseToolAuthorizationPolicy, type ToolAuthorizationPolicy } from '../../tool-authorization';
import { mcpEventIdentities } from '../../mcp/event-identity';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from '../task-runner';

export interface OfferManifestInput
  extends Pick<OfferRequest, 'agentRef' | 'agentMemory' | 'preparation' | 'preparedMemorySelected' | 'readerAttempt' | 'sessionRef'>,
    Pick<OfferRuntime, 'env' | 'mcpEnv' | 'mcpToolsetTools' | 'offered' | 'pick' | 'prepared' | 'scratch'>,
    Pick<OfferLimits, 'requiredToolsets' | 'resolvedMcp'>,
    Pick<OfferWorkspace, 'workspaceDir'> {
  readonly agentBinding: OfferWorkspace['agentBinding'];
  readonly blobAbort: AbortController;
  readonly preparationLane: TaskRunnerDeps['inputPreparationLane'];
  readonly terminalProjection: ActiveTask['terminalProjection'];
}

/** Resolves the runtime launch, seals the manifest, and admits and pins a prepared Execution. */
export async function sealOfferManifest(this: TaskRunner, phase: OfferPhaseContext, input: OfferManifestInput) {
  const { taskId, decline, admissionWithdrawn, admission } = phase;
  const {
    agentBinding, agentRef, agentMemory, preparation, preparedMemorySelected, readerAttempt, sessionRef, env, mcpEnv,
    mcpToolsetTools, offered, pick, prepared, scratch, requiredToolsets, resolvedMcp, workspaceDir, blobAbort,
    preparationLane, terminalProjection,
  } = input;
  // The local Host owns the mode; it never comes from the offer. `auto` needs
  // a pre-execution gate, so a runtime or lane without one is declined here,
  // before claim, instead of running ungated.
  let toolAuthorization: ToolAuthorizationPolicy;
  try {
    const resolver = this['deps'].toolAuthorization;
    toolAuthorization = parseToolAuthorizationPolicy(resolver === undefined ? { default: 'all' } : resolver(Object.freeze({
      taskId, runtimeId: pick.descriptor.id, ...(agentBinding.resolution.agentRef === undefined ? {} : { agentRef: agentBinding.resolution.agentRef }),
    })));
  } catch (error) {
    console.error(`[byok/client] tool authorization policy unresolved for task ${taskId}: ${errorMessage(error)}`);
    if (!admissionWithdrawn()) decline('tool_authorization_unresolved: local tool authorization policy could not be resolved', false);
    return;
  }
  if (toolAuthorization.default === 'auto' && (pick.descriptor.capabilities.toolAuthorizationAuto !== true || preparation !== undefined)) {
    if (!admissionWithdrawn()) {
      decline(`tool_authorization_unsupported: runtime ${pick.descriptor.id} cannot gate ${preparation === undefined ? '' : 'prepared '}tool calls before execution, so auto mode cannot run`, false);
    }
    return;
  }
  let runtimeLaunch: PiRuntimeLaunchResources | undefined;
  if (prepared.operation.resolveRuntimeLaunch !== undefined) {
    try {
      const resolveRuntimeLaunch = prepared.operation.resolveRuntimeLaunch;
      runtimeLaunch = await admission.time('runtimeLaunchMs', () => resolveRuntimeLaunch({
        kind: preparation === undefined ? 'instruction' : 'prepared', cwd: workspaceDir, env,
        scratch,
      }));
    } catch (error) {
      if (!admissionWithdrawn()) decline(`runtime launch admission failed: ${errorMessage(error)}`, false);
      return;
    }
    if (admissionWithdrawn()) return;
  }

  // `env` was built before admission (see its declaration above) so the
  // MCP probes and the runtime child are guaranteed to share one
  // allowlist decision rather than two computations that could drift.
  const manifest = sealRuntimeOperationManifest({
    ...(preparation === undefined ? {} : {agentMemory}),
    taskId,
    runtimeId: pick.descriptor.id,
    descriptor: pick.descriptor,
    requiredToolsetIds: requiredToolsets ?? [],
    ...(offered.dispatchSelection === undefined ? {} : { dispatchSelection: offered.dispatchSelection }),
    ...(sessionRef === undefined ? {} : { sessionRef }),
    agentRef: agentBinding.resolution.agentRef,
    cwd: workspaceDir,
    ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
    lease: {
      leaseId: agentBinding.lease.leaseId,
      canonicalHome: agentBinding.resolution.canonicalHome,
    },
    workspace: { workspaceDir },
    forwardedEnvironmentNames: Object.freeze(Object.keys(env).sort()),
  });

  // The prepared lane's whole admission, in the one order it is allowed to
  // happen: COMPARE the sealed Execution against the record item by item,
  // then PIN, then claim. Pinning strictly before the claim is what makes
  // single consumption real — two runners that both compared successfully
  // race the store's compare-and-set, and the loser returns here having
  // sent no claim and dispatched nothing.
  let preparedLaunch: RuntimePreparedLaunchV1 | undefined;
  let preparedObservation: PreparedExecutionObservation | undefined;
  if (preparation !== undefined) {
    const lane = preparationLane!;
    const record = lane.store.get(preparation.reference);
    if (record === undefined) {
      decline('preparation_not_found: no preparation record under this reference on this device', false);
      return;
    }
    // Each memory admission stage declines with its own C5 `reason: detail`
    // pair, decided by the stage (or the typed error it raised), never by
    // reading an error message. Every one is before pin and claim, and no
    // raw helper/transport text reaches the wire.
    const declineMemory = (reason: string): void => {
      decline(reason, false);
    };
    if (agentMemory === undefined) {
      declineMemory('agent_memory_selection_invalid: prepared offers require an explicit memory selection');
      return;
    }
    if (record.binding.agentMemory !== agentMemory) {
      declineMemory('agent_memory_mismatch: the offered Agent memory selection differs from the named preparation');
      return;
    }
    try {
      await lane.authorizeAgentMemory(record.binding);
    } catch (error) {
      declineMemory(error instanceof InputPreparationRequestError
        ? `${error.code}: ${error.message}`
        : 'authority_unavailable: the local Agent memory authority could not be consulted');
      return;
    }
    let memory: PreparedAgentMemoryState | null = null;
    if (agentMemory !== 'none') {
      const describe = this['deps'].agentMemoryDescribeBin;
      if (describe === undefined || this['deps'].agentMemoryMcpBin === undefined
        || !isAgentMemorySecureFilesystemAvailable(this['deps'].resolveAgentMemoryFilesystemHelperBin !== undefined)) {
        declineMemory('unsupported_input: agent_memory_unavailable');
        return;
      }
      try {
        memory = await observePreparedMemory(describe, mcpEnv, blobAbort.signal);
      } catch {
        declineMemory('toolsets_unobservable: agent_memory_descriptor_unobservable');
        return;
      }
    }
    // Only the toolsets this offer names: the preparation bound exactly the
    // revisions of the toolsets its record named, so binding every toolset
    // configured on the device would make an unrelated one a digest
    // mismatch. An unconfigured name was already declined above.
    const registryRevisions = lane.toolsetDefinitionRevisions();
    const revisions: Record<string, string> = {};
    for (const toolsetId of requiredToolsets ?? []) {
      const revision = registryRevisions.get(toolsetId);
      if (revision !== undefined) revisions[toolsetId] = revision;
    }
    const servers: PreparedOfferServerProjection[] = [];
    for (const [serverName, server] of Object.entries(resolvedMcp?.ok ? resolvedMcp.servers : {})) {
      const toolsetId = resolvedMcp!.toolsetIdByServer.get(serverName);
      if (toolsetId === undefined) continue;
      servers.push({
        serverName,
        toolsetId,
        command: server.command,
        args: Object.freeze([...(server.args ?? [])]),
      });
    }
    const admitted = await admitPreparedOffer({
      offeredAgentMemory: agentMemory, memory,
      terminalProjection,
      record,
      artifactPath: lane.store.artifactPathOf(record),
      offered: preparation,
      agentRef: agentRef!,
      deviceId: this['deps'].deviceId,
      policyRevision: lane.policyRevision,
      runtime: lane.runtime,
      // No projected server (memory-only or tool-less) means an empty
      // observation, not a missing one; a missing one with servers still
      // present stays a fail-closed decline in admission.
      observation: mcpToolsetTools ?? (preparedMemorySelected || servers.length === 0 ? {} : undefined),
      servers,
      toolsetDefinitionRevisions: Object.freeze(revisions),
      nowMs: Date.now(),
    });
    if (!admitted.ok) {
      // Non-retryable, every one of them: re-offering the same reference
      // against the same device state reaches the same answer, and a
      // prepared failure never permits sending a DIFFERENT input under the
      // same accounting.
      decline(`${admitted.reason}: ${admitted.detail}`, false);
      return;
    }
    let pinned: Awaited<ReturnType<InputPreparationStore['pin']>>;
    try {
      pinned = await lane.store.pin(record.recordId, {
        taskId,
        manifestDigest: inputPreparationDigest(manifest),
        sealedAt: new Date().toISOString(),
      });
    } catch (error) {
      decline(`preparation_not_ready: the preparation pin could not be written: ${errorMessage(error)}`, false);
      return;
    }
    if (pinned.kind === 'occupied') {
      decline(
        `preparation_already_pinned: task ${JSON.stringify(pinned.record.pin!.taskId)} already consumed this preparation`,
        false,
      );
      return;
    }
    this['preparationPinsByTask'].set(taskId, record.recordId);
    preparedLaunch = admitted.launch;
    // Seeded from the durable record the admission just compared, never
    // from the offer: the digest the Host ruled on and the window of the
    // model D was compiled for.
    preparedObservation = {
      requestDigest: record.artifact!.requestDigest,
      contextWindow: admitted.launch.expected.model.contextWindow,
      calls: 0,
    };
  }
  return { runtimeLaunch, manifest, preparedLaunch, preparedObservation, toolAuthorization };
}

export interface OfferClaimInput
  extends Pick<OfferRequest, 'agentRef'>,
    Pick<OfferRuntime, 'pick'>,
    Pick<OfferManifest, 'manifest' | 'preparedLaunch'> {
  readonly agentBinding: OfferWorkspace['agentBinding'];
  readonly blobAbort: AbortController;
  readonly payload: AcceptedOfferPayload;
  readonly taskMcpServers: OfferRuntime['taskMcpServers'];
}

/** Claims the task, resolves its instruction and binds prepared Agent memory. */
export async function claimOffer(this: TaskRunner, phase: OfferPhaseContext, input: OfferClaimInput) {
  const { taskId, admissionWithdrawn, admission } = phase;
  const { agentBinding, agentRef, pick, manifest, preparedLaunch, blobAbort, payload } = input;
  let { taskMcpServers } = input;
  // All semantic admission is now in `prepare()` and the frozen manifest.
  // Claim is the first externally visible commitment; instruction bytes and
  // process creation remain after it.
  if (admissionWithdrawn()) return;
  await this['deps'].beforeClaim?.(taskId, manifest.descriptor.id);
  if (admissionWithdrawn()) return;
  if (!isKnownRuntimeId(manifest.descriptor.id)) this['claimedHarnesses'].set(taskId, manifest.descriptor.id);
  const timings = admission.snapshot();
  this['deps'].send(
    createEnvelope(
      'task.claim',
      {
        deviceId: this['deps'].deviceId,
        ...(manifest.agentRef === undefined ? {} : { agentRef: manifest.agentRef }),
        // M5 (claimed runtime, docs/protocol.md §3.1): the ACTUAL adapter
        // `pickAdapter` just selected — covers both the explicit-runtime
        // path (`payload.runtime` named one) and the auto-select
        // (preference-ordered, pi last by default — M5 batch-3, see
        // `DEFAULT_RUNTIME_PREFERENCE`) path (`payload.runtime` was
        // absent) uniformly, since `pick.adapter` already reflects
        // whichever one won either way. Distinct from `payload.runtime`
        // (the merely REQUESTED runtime): this is what closes the gap
        // where an auto-selected task left the server never learning
        // which runtime actually ran.
        runtime: isKnownRuntimeId(manifest.descriptor.id) ? manifest.descriptor.id : undefined,
        ...(!isKnownRuntimeId(manifest.descriptor.id) ? { harnessId: manifest.descriptor.id } : {}),
        // S0/D-4 (`task.claim.capabilities`, docs/protocol.md §2.4): the
        // selected adapter's own capability self-report, carried on the
        // same message that establishes the task↔runtime binding. The
        // server gates control messages (`task.steer`) on this and only
        // this — connection-level `conn.hello.runtimes[].capabilities`
        // stays device discovery on both transports and cannot replace
        // the claim-time truth for this exact task/runtime binding.
        //
        // Sent UNCONDITIONALLY, deliberately NOT gated on
        // `isKnownRuntimeId` the way `runtime` above is: `runtime` is a
        // closed protocol enum a custom adapter has no member of, but
        // capabilities are a self-report every adapter can make honestly.
        // Gating them would silently strip a custom steer-capable
        // adapter's own truth and leave the server fail-closing on it
        // forever.
        capabilities: toRuntimeInfoCapabilities(manifest.descriptor.capabilities),
        ...(timings === undefined ? {} : { admission: timings }),
      },
      { taskId },
    ),
  );

  // Resolve the instruction blob after claim.
  // A prepared Execution resolves nothing here — it carries no instruction,
  // and the empty string below is never read: the prepared start variant has
  // no `instruction` field for it to reach.
  const offeredInstructionValue = offeredInstruction(payload);
  let resolvedInstruction: string;
  try {
    resolvedInstruction = offeredInstructionValue === undefined
      ? ''
      : await this['resolveInstruction'](offeredInstructionValue, blobAbort.signal);
  } catch (err) {
    const reason = `failed to resolve instruction blob: ${errorMessage(err)}`;
    await this['failClaimedAgent'](taskId, reason, true, {
      binding: agentBinding,
      runtimeId: pick.descriptor.id,
    });
    return;
  }

  if (preparedLaunch !== undefined && preparedLaunch.agentMemory !== 'none') {
    // Post-claim: a failure here is a truthful task failure, never a raw
    // throw that strands the claimed task. The finally below revokes any
    // context token minted for it and releases the pin.
    try {
      const helper = this['deps'].agentMemoryMcpBin;
      if (preparedLaunch.memory === null || helper === undefined) throw new Error('prepared Agent memory execution state missing');
      taskMcpServers = this['withAgentMemoryMcp'](taskMcpServers, taskId, agentRef, preparedLaunch.agentMemory, helper, 'complete');
    } catch {
      const reason = 'agent_memory_unavailable: the sealed Agent memory helper could not be bound for launch';
      await this['failClaimedAgent'](taskId, reason, false, {
        binding: agentBinding,
        runtimeId: pick.descriptor.id,
      });
      return;
    }
  }
  return { resolvedInstruction, taskMcpServers };
}

export interface OfferStartInput
  extends Pick<OfferRequest, 'ordinaryMemoryMode' | 'readerAttempt'>,
    Pick<OfferRuntime, 'env' | 'mcpEnv' | 'mcpToolsetTools' | 'mcpToolApprovals' | 'pick' | 'prepared' | 'scratch'>,
    Pick<OfferManifest, 'manifest' | 'preparedLaunch' | 'runtimeLaunch' | 'toolAuthorization'>,
    Pick<OfferClaim, 'resolvedInstruction' | 'taskMcpServers'> {
  readonly agentBinding: OfferWorkspace['agentBinding'];
  readonly sessionLease: OfferWorkspace['sessionLease'];
  readonly blobAbort: AbortController;
  readonly startupDeadline: number;
}

/**
 * Starts the runtime session. A start that failed or raced a cancel goes to
 * startup ownership; a started session goes to startup ownership and then to
 * {@link activateOffer} on the same synchronous path.
 *
 * The runtime may ask for approval while it starts or while activation is
 * still writing. Such a request waits until this launch settles: by then the
 * task is either active and the request is presented, or it never became
 * active and the request is refused.
 */
export async function startOfferRuntime(
  this: TaskRunner,
  phase: OfferPhaseContext,
  held: OfferHeld,
  input: OfferStartInput,
  activation: Omit<OfferActivationInput, 'session'>,
): Promise<void> {
  let settleLaunch!: () => void;
  const launch: LaunchGate = { settled: false, promise: new Promise<void>((resolve) => { settleLaunch = resolve; }) };
  try {
    await startAndActivateRuntime.call(this, phase, held, input, activation, launch);
  } finally {
    launch.settled = true;
    settleLaunch();
  }
}

interface LaunchGate { settled: boolean; readonly promise: Promise<void> }

async function startAndActivateRuntime(
  this: TaskRunner,
  phase: OfferPhaseContext,
  held: OfferHeld,
  input: OfferStartInput,
  activation: Omit<OfferActivationInput, 'session'>,
  launch: LaunchGate,
): Promise<void> {
  const { taskId } = phase;
  const {
    agentBinding, ordinaryMemoryMode, readerAttempt, env, mcpEnv, mcpToolsetTools, mcpToolApprovals, pick, prepared, scratch, manifest,
    preparedLaunch, runtimeLaunch, resolvedInstruction, taskMcpServers, blobAbort, startupDeadline, toolAuthorization,
  } = input;
  const requestApproval = (summary: string, signal?: AbortSignal, kind: ApprovalKind = 'task-terminal') => launch.settled
    ? requestTaskApproval.call(this, taskId, summary, signal, kind)
    : launch.promise.then(() => requestTaskApproval.call(this, taskId, summary, signal, kind));
  const startInput: RuntimeOperationStartInput = {
    scratch,
    ...(input.sessionLease === undefined ? {} : { sessionLease: input.sessionLease }),
    ...(runtimeLaunch?.kind !== 'pi-durable' ? {} : { durableContext: {
      tenantId: this['deps'].tenantId!, replicaRoot: path.join(this['deps'].storeDir, DURABLE_REPLICA_DIRNAME), lifecycle: {
        ownsLease: () => !blobAbort.signal.aborted && !this['pendingCancelled'].has(taskId),
        record: async (kind: 'tool-intent' | 'tool-committed' | 'respawn-intent', ordinal: number) => {
          if (!this['deps'].recordDurableTransition || !this['deps'].tenantId) throw new Error('durable parent authority unavailable');
          await this['deps'].agentHome!.executionLeaseManager.mutate(agentBinding, () => {
            // Do not overwrite a persisted normal-turn failure intent.
            if (this['tasks'].get(taskId)?.resultReplyFailure !== undefined) return Promise.resolve();
            return this['deps'].recordDurableTransition!(taskId, agentBinding.lease.leaseId, kind, ordinal);
          });
        },
      },
    } }),
    mcpEnv,
    ...(runtimeLaunch === undefined ? {} : { runtimeLaunch }),
    // The two lanes are mutually exclusive authority over the same bytes,
    // so they are two variants rather than one shape with an optional
    // field: the prepared Execution's request was compiled, counted and
    // frozen before this offer existed, and the ordinary one's is the
    // instruction resolved above. `preparedLaunch` is set ONLY after the
    // item-by-item comparison passed, the manifest was sealed, the record
    // was pinned and the claim went out.
    ...(preparedLaunch === undefined
      ? {
        kind: 'instruction' as const,
        instruction: prependAgentMemoryModeGuidance(resolvedInstruction, ordinaryMemoryMode, readerAttempt),
      }
      : { kind: 'prepared' as const, preparation: preparedLaunch }),
    manifest,
    env,
    ...(taskMcpServers === undefined ? {} : { mcpServers: taskMcpServers }),
    ...(mcpToolApprovals === undefined ? {} : { mcpToolApprovals }),
    ...(mcpToolsetTools === undefined ? {} : { mcpToolsetTools }),
    ...(pick.descriptor.capabilities.approvalInteractive ? { approvalChannel: { request: requestApproval } } : {}),
    // User authorization reuses the task's one approval path: the wire
    // `task.await_approval` and local `Daemon.approve`/`reject` resolve it.
    ...(toolAuthorization.default !== 'auto' ? {} : { toolAuthorization: createAutoToolAuthorizationGate({
      workspace: manifest.workspace.workspaceDir,
      rules: toolAuthorization.rules,
      mcpIdentities: mcpEventIdentities(mcpToolsetTools),
      onDecision: ({ call, risk, verdict }) => this['deps'].onToolAuthorizationDecision?.(Object.freeze({
        taskId, toolName: call.toolName, toolCallId: call.toolCallId, decision: verdict.decision,
        authorization: risk?.authorization ?? Object.freeze({ source: 'built-in' as const, ruleIds: Object.freeze([]) }),
        reasons: risk?.level === 'high' ? risk.reasons : Object.freeze([]),
        ...(risk?.level === 'normal' && risk.suppressedReasons !== undefined ? { suppressedReasons: risk.suppressedReasons } : {}),
        ...(verdict.decision === 'deny' ? { code: verdict.code } : {}),
      })),
      timeoutMs: (this['deps'].approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS) + 5_000,
      requestAuthorization: (summary, signal) => requestApproval(summary, signal, 'tool-authorization'),
    }) }),
  };
  let session: Session;
  try {
    session = await startOwnedRuntime(input => prepared.operation.start(input), startInput, blobAbort.signal,
      Math.max(0, startupDeadline - Date.now()));
  } catch (err) {
    const disposalFailure = isRuntimeStartupDisposalFailure(err);
    const cancelled = this['pendingCancelled'].has(taskId);
    if (disposalFailure || cancelled) {
      if (cancelled) {
        this['revokeAgentMessageContext'](taskId);
        this['revokeAgentResultContext'](taskId);
      }
      const cancellation = createEnvelope('task.cancelled', {
        reason: this['pendingCancelled'].get(taskId),
        ...terminalIdentity(this['claimedHarnesses'].get(taskId)),
        agentRef: agentBinding.resolution.agentRef,
      }, { taskId });
      let cancellationSettled = false;
      const abortedStart = abortedStartOf(err);
      this['startupOwnership'].register(taskId, {
        runtimeId: pick.descriptor.id,
        ...(abortedStart === undefined ? {} : { abortedStart }),
        dispose: async () => { if (disposalFailure) await err.retryDisposal(); await scratch.release(); },
        ...(cancelled ? { settle: async () => {
          if (cancellationSettled) return;
          // Retain startup ownership on a failed durable barrier, just as
          // active cancellation retains its owner until terminal evidence.
          await this['pendingMessageTasks'].get(taskId)?.outbox.revoke(taskId);
          this['deps'].send(cancellation);
          cancellationSettled = true;
          this['pendingCancelled'].delete(taskId);
          this['addFinishedTaskId'](taskId);
        } } : {}),
        release: async () => {
          await agentBinding.lease.release();
          await this['releasePreparationPin'](taskId);
        },
      });
      held.owner = 'startup';
      // An abort while the start still runs is not a disposal failure:
      // nothing has been disposed yet. `StartupOwnership.dispose` reports
      // it if a later attempt fails.
      if (disposalFailure && abortedStart === undefined) this['deps'].onRuntimeDisposalFailure?.({ taskId,
        runtimeId: pick.descriptor.id, stage: 'quiescence', reason: err.message });
      if (!cancelled) {
        const reason = this['stoppingOffers'] ? 'daemon shutting down during runtime startup' : errorMessage(err);
        const retryable = this['stoppingOffers'];
        await this['failClaimedAgent'](taskId, reason, retryable, {
          binding: agentBinding, runtimeId: pick.descriptor.id,
        });
      }
      return;
    }
    const failure = projectRuntimeBoundaryFailure(err, 'start');
    if (failure.contractViolation) {
      // Never the error object itself: stderr is a service log and an
      // adapter's error can carry runtime output (issue #395).
      console.error(`[byok/client] runtime adapter ${pick.descriptor.id} start() returned an untyped failure for task ${taskId}`);
    }
    await this['failClaimedAgent'](taskId, failure.reason, failure.retryable, {
      binding: agentBinding,
      runtimeId: pick.descriptor.id,
    }, failure.failure);
    return;
  }

  this['startupOwnership'].register(taskId, {
    runtimeId: pick.descriptor.id,
    dispose: async () => { await session.close(); await scratch.release(); },
    release: async () => {
      await agentBinding.lease.release();
      await this['releasePreparationPin'](taskId);
    },
  });
  held.owner = 'startup';
  await activateOffer.call(this, phase, held, { ...activation, session });
}
