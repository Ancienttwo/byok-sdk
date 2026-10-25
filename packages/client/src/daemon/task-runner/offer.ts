// `TaskRunner.handleOffer`: one offer from redelivery guard to active task
// (see ./support.ts for how a member module runs).
import { AgentMessageDraftPublisher } from '../agent-message-draft';
import type { ExecutionScratch } from '../retention/scratch';
import { observePreparedMemory, type PreparedAgentMemoryState } from '../prepared-agent-memory';
import { InputPreparationRequestError } from '../input-preparation-service';
import type { PiRuntimeLaunchResources } from '../../adapters/pi/runtime-launch';
import { terminalIdentity } from '../terminal-identity';
import { abortedStartOf, startOwnedRuntime } from '../runtime-start';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createEnvelope, PreparedAgentMemoryModeSchema, type PreparedAgentMemoryMode, type TerminalAgentHomeProjection, type TaskDeclinePayload } from '@byok-sdk/protocol';
import { sealRuntimeOperationManifest, type RuntimeOperationStartInput, type RuntimePreparedLaunchV1, type Session } from '../../types';
import { admitPreparedOffer, type PreparedOfferServerProjection } from '../prepared-offer-admission';
import type { InputPreparationStore } from '../input-preparation-store';
import { inputPreparationDigest } from '../../input-preparation';
import { AgentHomeBusyError, AgentHomeReaderRunMissingError, AgentHomeResolutionError, type AgentHomeExecutionBinding, type AgentRef } from '../../agent-home';
import { digestAgentHomeMemory } from '../../agent-home-readers';
import { isRuntimeStartupDisposalFailure, projectRuntimeBoundaryFailure } from '../../runtime-failure';
import { ExecutionRecordAccumulator } from '../execution-record';
import { toRuntimeInfoCapabilities } from '../runtime-capabilities';
import { ProgressBatcher } from '../progress-batcher';
import type { SessionWorkspaceStore } from '../session-workspace-store';
import type { GitWorkspaceLease, GitWorkspaceObservation, GitWorkspaceError } from '../git-workspace';
import { prependGitWorkspaceGuidance } from '../git-workspace';
import type { GitWorkspaceLedgerRecord, GitWorkspacePhase } from '../git-workspace-store';
import { prependAgentMemoryModeGuidance } from '../memory-guidance';
import { isAgentMemorySecureFilesystemAvailable } from '../agent-memory';
import type { PreparedExecutionObservation, ActiveTask, OfferPhaseContext } from './support';
import { isKnownRuntimeId, offeredPreparation, offeredInstruction, sameEgressPolicy, offeredAgentRef, offeredSessionRef, offeredHomeAccess, errorMessage, outboundErrorMessage } from './support';
import type { TaskRunner } from '../task-runner';
import { DEFAULT_APPROVAL_TIMEOUT_MS, NoPendingApprovalError } from '../task-runner';
import type { AcceptedOfferPayload } from './support';

export async function handleOffer(
  this: TaskRunner,
  taskId: string,
  payload: AcceptedOfferPayload,
  strictAgentOffer: boolean,
): Promise<void> {
  // Finding P2, Fix 2c (redelivered offer for an already-active/finished
  // task): checked first, ahead of everything below — a redelivered
  // `task.offer` for a taskId this device already claimed/started, or
  // already finished, can never be "the first time" for it, so there is
  // nothing left to decide. Without this, the stalled-cursor long-poll
  // re-pull (see `ConnectionManager.dedupWatermark`) redelivering this
  // same offer while its first prepared operation is still in flight (or
  // well after it already succeeded) would start a SECOND adapter session
  // for the same task, orphaning the first.
  if (this['tasks'].has(taskId) || this['startupOwnership'].has(taskId) || this['inFlightOffers'].has(taskId) || this['finishedTaskIds'].has(taskId) || this['strictDeclinedTaskIds'].has(taskId)) {
    return;
  }

  let agentRef: AgentRef | undefined;
  if (strictAgentOffer) {
    try {
      agentRef = offeredAgentRef(payload);
    } catch (error) {
      this['decline'](taskId, `invalid AgentRef: ${errorMessage(error)}`, false);
      return;
    }
    if (agentRef === undefined || this['deps'].agentHome === undefined || this['deps'].agentSessionHandoffs === undefined) {
      this['decline'](
        taskId,
        'Agent offer requires the SDK-owned agent-home-contract layout and handoff store',
        false,
        agentRef,
      );
      return;
    }
  }
  const decline = (reason: string, retryable: boolean, code?: TaskDeclinePayload['code']): void => {
    this['decline'](taskId, reason, retryable, agentRef, code);
  };
  const sessionRef = offeredSessionRef(payload);
  const homeAccess = offeredHomeAccess(payload);
  const readerAttempt = homeAccess === 'memory-reader';
  const homeBusyCode = readerAttempt ? 'agent_home_reader_busy' : 'agent_home_writer_busy';
  // The prepared lane is selected by the presence of this value and nothing
  // else. Absent for every ordinary offer, so every branch below that does
  // not mention it behaves exactly as it did before this lane existed.
  const preparation = offeredPreparation(payload);
  const offeredMemory = 'agentMemory' in payload ? payload.agentMemory : undefined;
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
  const preparationLane = this['deps'].inputPreparationLane;
  if (preparation !== undefined) {
    if (preparationLane === undefined) {
      // By name, not by reinterpretation. A daemon with no input-preparation
      // section holds no record this reference could mean, and running the
      // offer some other way would be running an Execution nobody counted.
      this['decline'](taskId, 'preparation_lane_unconfigured: this daemon is not configured for input preparation', false, agentRef);
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
        `preparation_store_unavailable: the preparation store could not be opened: ${outboundErrorMessage(error)}`,
        false,
        agentRef,
      );
      return;
    } finally {
      this['inFlightOffers'].delete(taskId);
    }
    if (preparationLane.store.get(preparation.reference) === undefined) {
      this['decline'](taskId, 'preparation_not_found: no preparation record under this reference on this device', false, agentRef);
      return;
    }
  }
  const messageRequirement = 'messageEgress' in payload ? payload.messageEgress : undefined;
  const terminalProjection = 'terminalProjection' in payload ? payload.terminalProjection : undefined;
  if ('egressPolicy' in payload) {
    if (this['deps'].agentEgressPolicy === undefined || !sameEgressPolicy(this['deps'].agentEgressPolicy, payload.egressPolicy)) {
      decline('Agent egress offer policy is not exactly enabled by this daemon', false);
      return;
    }
  }
  if (messageRequirement !== undefined && (agentRef === undefined || (preparation === undefined && this['deps'].agentMessageMcpBin === undefined) || this['deps'].tenantId === undefined)) {
    decline('required Agent message egress is unavailable on this daemon', false);
    return;
  }
  if (terminalProjection?.mode === 'result-document') {
    if (agentRef === undefined || this['deps'].tenantId === undefined || this['deps'].agentResultMcpBin === undefined) {
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
  let agentBinding: AgentHomeExecutionBinding | undefined;
  let gitLease: GitWorkspaceLease | undefined;
  // The one owner of the offer's leases, pin, and contexts at each moment.
  // Each change of owner happens on the same synchronous path as the
  // startup registration or the active handoff it names.
  let owner: 'offer' | 'startup' | 'active' = 'offer';
  let runtimeLaunch: PiRuntimeLaunchResources | undefined;
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
    taskId, decline, admissionWithdrawn, admissionSignal: blobAbort.signal, releaseReservation, reserveHome,
  };
  try {
    if (this['admitOffer'](phase, strictAgentOffer) === undefined) return;

    if (agentRef !== undefined) {
      if (await this['reserveOfferHome'](phase, agentRef, readerAttempt, sessionRef, homeAccess) === undefined) return;
    }

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
    const { scratch, offered, pick, env, mcpEnv, mcpToolsetTools, prepared } = runtime;
    let taskMcpServers = runtime.taskMcpServers;

    if (agentRef !== undefined) {
      // A resumed reader runs again in the run directory its session handoff
      // recorded. The ledger lives in the home, so it is found by sessionRef.
      let readerRunDirectory: string | undefined;
      if (readerAttempt && sessionRef !== undefined) {
        try {
          const resolution = await this['deps'].agentHome!.layout.resolve(agentRef);
          readerRunDirectory = await this['deps'].agentSessionHandoffs!.readerSessionCwd({
            agentRef: resolution.agentRef,
            sessionRef,
            runtimeId: pick.descriptor.id,
            home: resolution.canonicalHome,
          });
        } catch (error) {
          decline(`Agent session handoff mismatch: ${outboundErrorMessage(error)}`, error instanceof AgentHomeBusyError,
            error instanceof AgentHomeBusyError ? homeBusyCode : undefined);
          return;
        }
      }
      try {
        agentBinding = await this['deps'].agentHome!.acquireExecution(agentRef, {
          taskId,
          sessionRef,
          homeAccess,
          ...(readerRunDirectory === undefined ? {} : { runDirectory: readerRunDirectory }),
        });
        releaseReservation();
      } catch (error) {
        decline(
          `Agent home admission failed: ${outboundErrorMessage(error)}`,
          error instanceof AgentHomeBusyError || !(error instanceof AgentHomeResolutionError),
          error instanceof AgentHomeBusyError ? homeBusyCode : undefined,
        );
        return;
      }
    }

    let known: Awaited<ReturnType<SessionWorkspaceStore['get']>> = undefined;
    let workspaceDir: string;
    let gitWorkspaceId: string | undefined;
    let gitBaseline: string | undefined;
    let gitExisting = false;
    let plainWorkspaceNeedsResolve = false;
    let appliedAgentHomeProjection: TerminalAgentHomeProjection | undefined;
    let readerMemoryBaseline: ActiveTask['readerMemoryBaseline'];
    if (agentBinding !== undefined) {
      workspaceDir = agentBinding.lease.cwd;
      if (sessionRef !== undefined) {
        try {
          await this['deps'].agentSessionHandoffs!.requireMatch({
            agentRef: agentBinding.resolution.agentRef,
            sessionRef,
            runtimeId: pick.descriptor.id,
            home: agentBinding.resolution.canonicalHome,
            cwd: workspaceDir,
            ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
          });
        } catch (error) {
          await agentBinding.lease.release().catch(() => {});
          agentBinding = undefined;
          decline(`Agent session handoff mismatch: ${outboundErrorMessage(error)}`, false);
          return;
        }
      }
      if (readerAttempt) {
        const fresh = sessionRef === undefined;
        try {
          await this['deps'].agentHome!.prepareReaderRun(agentBinding, { fresh });
        } catch (error) {
          await agentBinding.lease.release().catch(() => {});
          agentBinding = undefined;
          // A busy run directory (a redelivered task found a directory it
          // cannot reuse) may clear; every other failure is permanent.
          decline(error instanceof AgentHomeReaderRunMissingError
            ? `Agent session ${sessionRef} cannot resume: its reader run directory no longer exists`
            : `Agent reader run directory preparation failed: ${outboundErrorMessage(error)}`,
            error instanceof AgentHomeBusyError,
            error instanceof AgentHomeBusyError ? homeBusyCode : undefined);
          return;
        }
      }
      try {
        await this['deps'].agentHome!.initializeExecution(agentBinding);
      } catch (error) {
        await agentBinding.lease.release().catch(() => {});
        agentBinding = undefined;
        decline(`Agent home initialization failed: ${outboundErrorMessage(error)}`, error instanceof AgentHomeBusyError,
          error instanceof AgentHomeBusyError ? homeBusyCode : undefined);
        return;
      }
      // Terminal evidence only (#318): an unreadable projection record must not
      // block an Attempt that ran before this evidence existed, so omit it.
      appliedAgentHomeProjection = await this['deps'].agentHome!.readAppliedProjection(agentBinding).catch((error: unknown) => {
        console.warn(`[byok/client] Agent-home projection record is unreadable for ${taskId}; terminal evidence omits it: ${errorMessage(error)}`);
        return undefined;
      });
      // Evidence only (#317): the SDK does not make memory read-only. The
      // reader terminal compares this digest with one taken at the terminal.
      if (readerAttempt) {
        readerMemoryBaseline = { digest: await digestAgentHomeMemory(agentBinding.resolution.canonicalHome) };
      }
      if (messageRequirement !== undefined) {
        try {
          const outbox = await this['agentMessageOutbox'](agentBinding.resolution.canonicalHome);
          this['pendingMessageTasks'].set(taskId, {
            taskId,
            agentRef: agentBinding.resolution.agentRef,
            requirement: messageRequirement,
            outbox,
          });
        } catch (error) {
          await agentBinding.lease.release().catch(() => {});
          agentBinding = undefined;
          decline(`Agent message outbox initialization failed: ${outboundErrorMessage(error)}`, true);
          return;
        }
      }
      if (terminalProjection?.mode === 'result-document') {
        try {
          const store = await this['agentResultStore'](agentBinding.resolution.canonicalHome);
          const context = this['resultContextByTask'].get(taskId);
          if (context === undefined) throw new Error('the task result context was revoked before its Agent home was bound');
          context.store = store;
          context.agentRef = agentBinding.resolution.agentRef;
        } catch (error) {
          await agentBinding.lease.release().catch(() => {});
          agentBinding = undefined;
          decline(`Agent result store initialization failed: ${outboundErrorMessage(error)}`, true);
          return;
        }
      }
    } else if (this['deps'].gitWorkspaceManager && this['deps'].gitWorkspaceStore) {
      known = sessionRef ? await this['deps'].sessionWorkspaces.get(sessionRef) : undefined;
      const gitManager = this['deps'].gitWorkspaceManager;
      const gitStore = this['deps'].gitWorkspaceStore;
      if (sessionRef) {
        const ledger = await gitStore.findBySessionAnyPhase(sessionRef).catch(() => undefined);
        const sameProtocolTask = ledger?.taskId === taskId;
        const interruptedOldTask = ledger?.phase === 'interrupted' && sameProtocolTask;
        const activeDifferentTask = ledger !== undefined && ledger.taskId !== taskId && (ledger.phase === 'preparing' || ledger.phase === 'active');
        if (!known || known.workspaceKind !== 'git' || !known.gitWorkspaceId || !ledger ||
            ledger.workspaceId !== known.gitWorkspaceId || ledger.sessionRef !== sessionRef ||
            path.resolve(ledger.workspaceDir) !== path.resolve(known.workspaceDir) ||
            interruptedOldTask || activeDifferentTask) {
          decline('session is incompatible with Git workspace mode', true);
          return;
        }
        workspaceDir = known.workspaceDir;
        gitWorkspaceId = known.gitWorkspaceId;
        gitBaseline = ledger.baseline;
        gitExisting = true;
        try {
          await gitManager.validateExisting(workspaceDir);
        } catch {
          decline('workspace is busy or unavailable', true);
          return;
        }
      } else {
        workspaceDir = this['legacyWorkspaceDir'](taskId);
        gitWorkspaceId = randomUUID();
      }
      try {
        gitLease = await gitManager.acquireLease(workspaceDir, sessionRef);
      } catch {
        decline('workspace is busy or unavailable', true);
        return;
      }
    } else if (!this['deps'].gitWorkspaceManager && !this['deps'].gitWorkspaceStore) {
      known = sessionRef ? await this['deps'].sessionWorkspaces.get(sessionRef) : undefined;
      workspaceDir = known?.workspaceDir ?? this['legacyWorkspaceDir'](taskId);
      plainWorkspaceNeedsResolve = true;
    } else {
      decline('workspace mode is unavailable', true);
      return;
    }

    if (prepared.operation.resolveRuntimeLaunch !== undefined) {
      try {
        runtimeLaunch = await prepared.operation.resolveRuntimeLaunch({
          kind: preparation === undefined ? 'instruction' : 'prepared', cwd: workspaceDir, env,
          scratch,
        });
      } catch (error) {
        gitLease?.release();
        if (!admissionWithdrawn()) decline(`runtime launch admission failed: ${errorMessage(error)}`, false);
        return;
      }
      if (admissionWithdrawn()) { gitLease?.release(); return; }
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
      ...(sessionRef === undefined || (known === undefined && agentBinding === undefined)
        ? {}
        : { sessionRef }),
      ...(agentBinding === undefined ? {} : {
        agentRef: agentBinding.resolution.agentRef,
        cwd: agentBinding.lease.cwd,
        ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
        lease: {
          leaseId: agentBinding.lease.leaseId,
          canonicalHome: agentBinding.resolution.canonicalHome,
        },
      }),
      cwd: workspaceDir,
      workspace: {
        workspaceDir,
        ...(gitWorkspaceId === undefined ? {} : { workspaceId: gitWorkspaceId }),
        ...(gitBaseline === undefined ? {} : { baseline: gitBaseline }),
      },
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
        gitLease?.release();
        decline('preparation_not_found: no preparation record under this reference on this device', false);
        return;
      }
      // Each memory admission stage declines with its own C5 `reason: detail`
      // pair, decided by the stage (or the typed error it raised), never by
      // reading an error message. Every one is before pin and claim, and no
      // raw helper/transport text reaches the wire.
      const declineMemory = (reason: string): void => {
        gitLease?.release();
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
        gitLease?.release();
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
        gitLease?.release();
        decline(`preparation_not_ready: the preparation pin could not be written: ${errorMessage(error)}`, false);
        return;
      }
      if (pinned.kind === 'occupied') {
        gitLease?.release();
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

    // All semantic admission is now in `prepare()` and the frozen manifest.
    // Claim is the first externally visible commitment; instruction bytes,
    // workspace preparation, and process creation remain after it.
    if (admissionWithdrawn()) { gitLease?.release(); return; }
    await this['deps'].beforeClaim?.(taskId, manifest.descriptor.id);
    if (admissionWithdrawn()) { gitLease?.release(); return; }
    if (!isKnownRuntimeId(manifest.descriptor.id)) this['claimedHarnesses'].set(taskId, manifest.descriptor.id);
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
        },
        { taskId },
      ),
    );

    // Resolve the instruction blob after claim; workspace preparation follows.
    // A prepared Execution resolves nothing here — it carries no instruction,
    // and the empty string below is never read: the prepared start variant has
    // no `instruction` field for it to reach.
    const offeredInstructionValue = offeredInstruction(payload);
    let resolvedInstruction: string;
    try {
      resolvedInstruction = offeredInstructionValue === undefined
        ? ''
        : await this['resolveInstruction'](offeredInstructionValue, blobAbort.signal);
      if (plainWorkspaceNeedsResolve) workspaceDir = await this['resolveWorkspaceDir'](taskId, known?.workspaceDir);
    } catch (err) {
      gitLease?.release();
      const reason = `failed to resolve instruction blob: ${errorMessage(err)}`;
      if (agentBinding === undefined) {
        await this['fail'](taskId, reason, true);
      } else {
        await this['failClaimedAgent'](taskId, reason, true, {
          binding: agentBinding,
          runtimeId: pick.descriptor.id,
        });
      }
      return;
    }

    if (this['deps'].gitWorkspaceManager && gitLease) {
      try {
        let observation: GitWorkspaceObservation;
        if (gitExisting) {
          observation = await this['deps'].gitWorkspaceManager.validateExisting(workspaceDir);
        } else {
          const workspaceId = gitWorkspaceId ?? randomUUID();
          const now = new Date().toISOString();
          gitWorkspaceId = workspaceId;
          await this['deps'].gitWorkspaceStore?.upsert({
            workspaceId,
            taskId,
            workspaceDir,
            phase: 'preparing',
            commitsSinceBaseline: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
            createdAt: now,
            updatedAt: now,
          });
          this['deps'].onGitWorkspaceEvent?.({ taskId, workspaceId, phase: 'preparing' });
          observation = await this['deps'].gitWorkspaceManager.prepareFresh(workspaceDir);
        }
        const workspaceId = gitWorkspaceId ?? randomUUID();
        const phase: GitWorkspacePhase = 'active';
        const now = new Date().toISOString();
        const ledgerRecord: GitWorkspaceLedgerRecord = {
          workspaceId,
          taskId,
          workspaceDir,
          sessionRef,
          phase,
          baseline: gitBaseline ?? observation.head,
          current: observation.head,
          commitsSinceBaseline: observation.commitsSinceBaseline,
          staged: observation.staged,
          unstaged: observation.unstaged,
          untracked: observation.untracked,
          conflicted: observation.conflicted,
          createdAt: now,
          updatedAt: now,
        };
        await this['deps'].gitWorkspaceStore?.upsert(ledgerRecord);
        this['deps'].onGitWorkspaceEvent?.({ taskId, workspaceId, phase, observation });
        gitWorkspaceId = workspaceId;
        gitBaseline = gitBaseline ?? observation.head;
      } catch (err) {
        const category = (err as GitWorkspaceError).category ?? 'repository-invalid';
        await this['updateGitPhaseBestEffort'](gitWorkspaceId, 'failed', category);
        gitLease.release();
        this['deps'].onGitWorkspaceEvent?.({ taskId, workspaceId: gitWorkspaceId ?? '', phase: 'failed', errorCategory: category });
        await this['fail'](taskId, 'Git workspace preparation failed', true);
        return;
      }
    }

    if (preparedLaunch !== undefined && preparedLaunch.agentMemory !== 'none') {
      // Post-claim: a failure here is a truthful task failure, never a raw
      // throw that strands the claimed task. The finally below revokes any
      // context token minted for it and releases the pin.
      try {
        const helper = this['deps'].agentMemoryMcpBin;
        if (preparedLaunch.memory === null || agentRef === undefined || helper === undefined) throw new Error('prepared Agent memory execution state missing');
        taskMcpServers = this['withAgentMemoryMcp'](taskMcpServers, taskId, agentRef, preparedLaunch.agentMemory, helper, 'complete');
      } catch {
        const reason = 'agent_memory_unavailable: the sealed Agent memory helper could not be bound for launch';
        await this['updateGitPhaseBestEffort'](gitWorkspaceId, 'failed');
        gitLease?.release();
        if (agentBinding === undefined) {
          await this['fail'](taskId, reason, false);
        } else {
          await this['failClaimedAgent'](taskId, reason, false, {
            binding: agentBinding,
            runtimeId: pick.descriptor.id,
          });
        }
        return;
      }
    }
    const durableBinding = agentBinding;
    const startInput: RuntimeOperationStartInput = {
      scratch,
      ...(runtimeLaunch?.kind !== 'pi-durable' ? {} : { durableContext: {
        tenantId: this['deps'].tenantId!, replicaRoot: path.join(this['deps'].storeDir, 'durable-replicas'), lifecycle: {
          ownsLease: () => durableBinding !== undefined && !blobAbort.signal.aborted && !this['pendingCancelled'].has(taskId),
          record: async (kind: 'tool-intent' | 'tool-committed' | 'respawn-intent', ordinal: number) => {
            if (!durableBinding || !this['deps'].recordDurableTransition || !this['deps'].tenantId) throw new Error('durable parent authority unavailable');
            await this['deps'].agentHome!.executionLeaseManager.mutate(durableBinding, () => {
              // Do not overwrite a persisted normal-turn failure intent.
              if (this['tasks'].get(taskId)?.resultReplyFailure !== undefined) return Promise.resolve();
              return this['deps'].recordDurableTransition!(taskId, durableBinding.lease.leaseId, kind, ordinal);
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
          instruction: agentBinding === undefined
            ? (gitWorkspaceId ? prependGitWorkspaceGuidance(resolvedInstruction) : resolvedInstruction)
            : prependAgentMemoryModeGuidance(resolvedInstruction, ordinaryMemoryMode, readerAttempt),
        }
        : { kind: 'prepared' as const, preparation: preparedLaunch }),
      manifest,
      env,
      ...(taskMcpServers === undefined ? {} : { mcpServers: taskMcpServers }),
      ...(mcpToolsetTools === undefined ? {} : { mcpToolsetTools }),
      approvalChannel: {
        taskId,
        storeDir: this['deps'].storeDir,
        productId: this['deps'].productId,
        timeoutMs: this['deps'].approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
        resolve: async (approved, reason) => {
          const currentActive = this['tasks'].get(taskId);
          const pendingId = currentActive?.pendingApprovalId;
          if (!pendingId) {
            throw new NoPendingApprovalError(taskId);
          }
          // 'wire': this closure is invoked ONLY by an adapter's own
          // `session.resolveApproval()` on a custom adapter, which is called from
          // `handleApprove`/`handleReject` below — i.e. a server-sent wire
          // `task.approve`/`task.reject`. The server already knows this
          // decision (it sent it); `task.approval_resolved` must never be
          // sent back for it — see `ApprovalOrigin`'s own doc comment
          // (`approvals.ts`) and `sendApprovalResolved`'s gate below.
          this['deps'].approvalRegistry.resolve(pendingId, approved ? 'approve' : 'reject', reason, 'wire');
        },
      },
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
        const ownedBinding = agentBinding;
        const cancellation = createEnvelope('task.cancelled', {
          reason: this['pendingCancelled'].get(taskId),
          ...terminalIdentity(this['claimedHarnesses'].get(taskId)),
          ...(agentBinding === undefined ? {} : { agentRef: agentBinding.resolution.agentRef }),
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
            await ownedBinding?.lease.release();
            gitLease?.release();
            await this['releasePreparationPin'](taskId);
          },
        });
        owner = 'startup';
        // An abort while the start still runs is not a disposal failure:
        // nothing has been disposed yet. `StartupOwnership.dispose` reports
        // it if a later attempt fails.
        if (disposalFailure && abortedStart === undefined) this['deps'].onRuntimeDisposalFailure?.({ taskId,
          runtimeId: pick.descriptor.id, stage: 'quiescence', reason: err.message });
        if (!cancelled) {
          const reason = this['stoppingOffers'] ? 'daemon shutting down during runtime startup' : errorMessage(err);
          const retryable = this['stoppingOffers'];
          if (agentBinding === undefined) await this['fail'](taskId, reason, retryable);
          else await this['failClaimedAgent'](taskId, reason, retryable, {
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
      await this['updateGitPhaseBestEffort'](gitWorkspaceId, 'failed', 'repository-invalid');
      gitLease?.release();
      if (agentBinding === undefined) {
        await this['fail'](taskId, failure.reason, failure.retryable, failure.failure);
      } else {
        await this['failClaimedAgent'](taskId, failure.reason, failure.retryable, {
          binding: agentBinding,
          runtimeId: pick.descriptor.id,
        }, failure.failure);
      }
      return;
    }

    const ownedBinding = agentBinding;
    this['startupOwnership'].register(taskId, {
      runtimeId: pick.descriptor.id,
      dispose: async () => { await session.close(); await scratch.release(); },
      release: async () => {
        await ownedBinding?.lease.release();
        gitLease?.release();
        await this['releasePreparationPin'](taskId);
      },
    });
    owner = 'startup';
    try {
    if (agentBinding !== undefined) {
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
    }

    let active!: ActiveTask;
    active = {
      taskId,
      blobAbort,
      egressEnabled: 'egressPolicy' in payload,
      adapter: pick.adapter,
      session,
      scratch,
      workspaceDir,
      ...(agentBinding === undefined ? {} : {
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
      }),
      gitWorkspaceId,
      gitLease,
      gitBaseline,
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
    if (active.messageRequirement !== undefined && active.agentRef !== undefined
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
    if (agentBinding !== undefined) {
      const binding = agentBinding;
      try {
        await this['deps'].agentHome!.mutateExecution(binding, () =>
          this['deps'].agentSessionHandoffs!.record({
            agentRef: binding.resolution.agentRef,
            taskId,
            sessionRef: session.sessionRef,
            runtimeId: pick.descriptor.id,
            home: binding.resolution.canonicalHome,
            cwd: workspaceDir,
            ...(readerAttempt ? { homeAccess: 'memory-reader' as const } : {}),
            leaseId: binding.lease.leaseId,
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
      owner = 'active';
      await this['settleSemanticTerminal'](active, async () => {
        active.eventPump ??= this['pump'](active);
        await this['interruptBounded'](active);
        await this['updateGitPhaseBestEffort'](gitWorkspaceId, 'cancelled');
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
    // `handleCancel`). An earlier version of this method awaited the
    // sessionWorkspaces write (below) before registering `active` and broke
    // exactly this: a cancel racing a task.offer lost its `interrupt()`/
    // `task.cancelled` entirely.
    this['inFlightBlobAborts'].delete(taskId);
    this['startupOwnership'].transferToActive(taskId);
    this['tasks'].set(taskId, active);
    owner = 'active';
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

    // Record (or refresh) this session's resumable workspace for any future
    // task.offer that carries the same sessionRef, fire-and-forget:
    // `session.sessionRef` is always the adapter's real, resumable
    // identifier (see PiSession / resolveFreshSessionId) whether or not
    // *this* dispatch was itself a resume. Deliberately not awaited — see
    // the comment above; losing this mapping only costs a future resume
    // opportunity, never the correctness of the task in progress.
    if (agentBinding === undefined) {
      void this['deps'].sessionWorkspaces
        .record(session.sessionRef, {
          workspaceDir,
          runtimeSessionId: session.sessionRef,
          ...(gitWorkspaceId ? { workspaceKind: 'git' as const, gitWorkspaceId } : {}),
        })
        .catch(() => {});
    }
    if (gitWorkspaceId && this['deps'].gitWorkspaceStore) {
      void this['deps'].gitWorkspaceStore.attachSession(gitWorkspaceId, session.sessionRef).catch(() => {});
    }
    } catch (error) {
      if (this['tasks'].has(taskId)) throw error;
      const reason = `runtime activation failed: ${outboundErrorMessage(error)}`;
      if (agentBinding === undefined) await this['fail'](taskId, reason, false);
      else await this['failClaimedAgent'](taskId, reason, false, {
        binding: agentBinding, runtimeId: pick.descriptor.id, sessionRef: session.sessionRef,
      });
    }
  } finally {
    clearTimeout(startupTimer);
    releaseReservation();
    try {
      if (owner === 'startup') {
        // Startup release must succeed. The startup owner releases the
        // leases and the preparation pin only after the disposal receipt
        // and the terminal commit. A failed release keeps the owner, and
        // StartupOwnership retries it.
        await this['startupOwnership'].dispose(taskId);
      }
      if (owner === 'offer') {
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
        await agentBinding?.lease.release().catch(() => {});
        gitLease?.release();
        await this['releasePreparationPin'](taskId);
      }
      // An active task's Session owns the runtime launch. The projection
      // holds env or IPC references, not the key, so removing it does not
      // revoke a credential. Its cleanup timing for a retained startup
      // stays unchanged here.
      if (owner === 'offer' && executionScratch !== undefined) {
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
