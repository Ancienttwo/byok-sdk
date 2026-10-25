import { acquireDaemonOwner, DaemonOwnerActiveError } from '../daemon-owner';
import { DaemonHaltError } from '../daemon-lifecycle';
import { attachOwnedProcessGroupLedger } from '../../adapters/process-tree';
import { InputPreparationUnsupportedRecordVersionError } from '../input-preparation-store';
import type { DeviceRecord } from '../store';
import { AgentEgressController } from '../agent-egress-controller';
import path from 'node:path';
import { createFleetJitter } from '../deterministic-jitter';
import { type JournalIdentity, journalHash, JournalRecordTooLargeError, type ReceivedEnvelopeRecord } from '../journal/journal';
import type { AgentRef } from '../../agent-home';
import { SealedTasks } from '../sealed-task';
import { decodeEnvelope, createEnvelope, encodeEnvelope, isTaskOfferType, isSealedMessageType, requiredReceiverCapabilities, AGENT_EGRESS_RELIABLE_ACK_CAPABILITY } from '@byok-sdk/protocol';
import { taskFailureField, DAEMON_TASK_FAILURE } from '../task-failure';
import { terminalIdentity } from '../terminal-identity';
import { assertJournalEnvelopeProtocol } from '../daemon-errors';
import { resultReplyFailureFromState, resultReplyFailureReason } from '../result-reply-failure';
import { serviceEnvironmentStatus } from '../../lifecycle/service-environment';
import { detectRuntimes, computeCapabilities, terminalKindOf, hasExactContentReadTransfer, policyRevisionMismatchPolicies, toJournalEnvelopeRecord } from './support';
import { BlobClient } from '../blob-client';
import { AgentHomeProjectionCompletionClient } from '../agent-home-projection-client';
import { createProviderProvisioningNoticeProcessor } from '../provider-provisioning';
import { createAgentMemoryIntentProcessor } from '../agent-memory-intent';
import { InputPreparationCompletionClient } from '../input-preparation-completion-client';
import { createRemoteInputPreparationHandler } from '../input-preparation-remote';
import type { Envelope } from '@byok-sdk/protocol';
import { type TaskRunnerDeps, TaskRunner } from '../task-runner';
import { randomUUID } from 'node:crypto';
import { resolveSdkReservedHelperBin } from '../../sdk-reserved-helper-host';
import { preflightAgentResultMcp } from '../agent-result-mcp-preflight';
import { resolveAgentMessageMcpBin } from '../resolve-agent-message-mcp-bin';
import { preflightAgentMessageMcp } from '../agent-message-mcp-preflight';
import { processE2eeKeyPackageNotice } from '../e2ee-key-package-notice';
import { type AgentContentSessionIdentity, AgentContentReadPolicyEngine, AGENT_CONTENT_READ_CAPABILITIES } from '../agent-content-read';
import { AgentContentAuditStore } from '../agent-content-audit-store';
import type { AgentContentReceiptWithoutReliableIdentity } from '../agent-egress-spool';
import { ConnectionManager } from '../connection-manager';
import type { DaemonScope } from './scope';
import type { SealedRunState } from './state';
import { openStartRun } from './start-run';
import { composeStartLanes } from './start-lanes';

/** One daemon start under the owner lease (#926). */

export async function runStartUnderLease(daemonScope: DaemonScope): Promise<void> {
  const {
    terminalCommits, daemonState, setLifecycle, storeDir, ownedProcessLedger, scratchRoot,
    initializeInputPreparation, config, retentionSweeper, replaceControlServer,
    initializeOwnedHostedStorage, storagePressure, egressPolicy, agentHomeManager, cursorStore,
    operationalHealth, observer, gitWorkspaceManager, gitWorkspaceStore, adapters,
    provenAgentMemoryIntentBackend, agentContentReadPolicies, inputPreparationLimits, sealIdentityOf,
    overrides, approvalRegistry, agentHomeReaderLimit, agentSessionHandoffs, toolsetRegistry,
    egressBatcherOptions, sessionWorkspaces, localAgentRelease, agentMemoryMcpBin,
    agentMemoryDescribeBin, resolveAgentMemoryFilesystemHelperBin, taskContextCapabilityAvailable,
    waitForHostTaskContext, memberStatus, logMember, dispatchReliableRecord, outbound,
    runPresenceDiscovery, halted, crashed, startPresenceProducer, startDeviceMember,
    startupHaltReason, runShutdownSequence,
  } = daemonScope;
  terminalCommits.resume();
  // A new run begins; a previous run's halt or crash no longer describes it.
  if (daemonState.lifecycle.phase === 'halted' || daemonState.lifecycle.phase === 'crashed') setLifecycle({ phase: 'stopped' });
  if (!daemonState.daemonOwnerLease) {
    try {
      daemonState.daemonOwnerLease = await acquireDaemonOwner(storeDir, 'daemon');
    } catch (err) {
      if (err instanceof DaemonOwnerActiveError) throw new DaemonHaltError('store_owned', { cause: err });
      throw err;
    }
  }
  try {
  const run = await openStartRun(daemonScope);
  if (run === undefined) return;
  const {
    record, activeJournal, activePressureEngine, journalIdentity, resultReplyRecoveryTasks,
    sealedRun, recordRecoveryFailure, runtimes, harnesses, blobClient, agentMemoryIntentBackend,
  } = run;
  const {
    capabilities, agentHomeProjectionCompletion, processProviderProvisioningNotice,
    processAgentMemoryIntentNotice, handleRemoteInputPreparation, opened,
  } = composeStartLanes(daemonScope, { agentMemoryIntentBackend, record, blobClient, sealedRun });

  /** With `replaces`, the terminal replaces the refused terminal of that hash (#654 §77b). */
  const commitTerminal = (taskId: string, terminal: Envelope | (() => Promise<Envelope | undefined>), replaces?: string): void => {
    const ownerIdentity = sealedRun.ownSealIdentity;
    const plainBytes = typeof terminal === 'function' ? undefined : encodeEnvelope(terminal);
    // A sealed terminal is sealed once and its bytes are journaled; a retry
    // of the commit reuses them and never seals or uploads again (§9.2).
    let sealing: Promise<Envelope | undefined> | undefined;
    // The seal and its upload run before the commit joins the one commit
    // tail, so a slow upload holds no other task's terminal.
    const seal = typeof terminal === 'function'
      ? async (): Promise<void> => {
        sealing ??= terminal();
        try { await sealing; } catch (error) { sealing = undefined; throw error; }
      }
      : undefined;
    terminalCommits.enqueue(taskId, async () => {
      let envelope: Envelope | undefined;
      if (typeof terminal === 'function') {
        envelope = await sealing;
        if (envelope === undefined) return;
      } else envelope = terminal;
      const bytes = plainBytes ?? encodeEnvelope(envelope);
      try {
        const durableRecord = { taskId, terminalType: terminalKindOf(envelope.type)!, bytes,
          payloadHash: journalHash(bytes), truthState: 'pending' as const, attempt: 1, recordedAt: new Date().toISOString() };
        await (replaces === undefined ? activeJournal.recordTerminal(durableRecord) : activeJournal.replaceRefusedTerminal(taskId, replaces, durableRecord));
        // Read the first immutable winner, not an attempted replacement candidate.
        const durableTerminal = (await activeJournal.listPendingTerminals(journalIdentity)).find((row) => row.taskId === taskId);
        if (!durableTerminal || durableTerminal.truthState !== 'pending') return;
        const durable = decodeEnvelope(durableTerminal.bytes);
        overrides.executionRecoveryFault?.('terminal:before-send');
        observer.captureOutboundApproval(durable);
        daemonState.connection?.send(durable);
      } catch (error: unknown) {
        if (!(error instanceof JournalRecordTooLargeError)) throw error;
        // A completed result can exceed the journal's bounded record size.
        // Do not truncate or invent a success: settle the exact task identity
        // with one small, canonical, non-retryable failure. The offer is the
        // sole source of AgentRef, so a foreign or missing ref is never guessed.
        const task = await activeJournal.readTask(taskId, journalIdentity);
        if (!task) throw new Error(`missing durable task ${taskId}`);
        if (!('envelopeBytes' in task)) throw new Error(`task ${taskId} has a withheld offer and no result`);
        const offer = decodeEnvelope(task.envelopeBytes);
        if (!isTaskOfferType(offer.type) || offer.task_id !== taskId) throw new Error(`invalid durable offer binding for ${taskId}`);
        const offerPayload = offer.payload as { agentRef?: AgentRef };
        const plainFailure = createEnvelope('task.fail', {
          reason: 'terminal_result_too_large', retryable: false,
          ...taskFailureField(DAEMON_TASK_FAILURE, daemonState.connection?.getServerCapabilities() ?? []),
          ...terminalIdentity(task.claimedRuntime, offerPayload.agentRef),
        }, { taskId });
        // Only the owner run's tenant, device and member seal this failure.
        const sameIdentity = ownerIdentity !== undefined && ownerIdentity === daemonState.latestSealIdentity?.();
        const failure = await daemonState.latestSealedTasks!.sealRecovered(offer, plainFailure, sameIdentity);
        const failureBytes = encodeEnvelope(failure);
        await activeJournal.recordTerminal({ taskId, terminalType: 'failed', bytes: failureBytes,
          payloadHash: journalHash(failureBytes), truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString() });
        const durableFailure = (await activeJournal.listPendingTerminals(journalIdentity)).find((row) => row.taskId === taskId);
        if (!durableFailure || durableFailure.truthState !== 'pending') return;
        const decoded = decodeEnvelope(durableFailure.bytes);
        observer.captureOutboundApproval(decoded);
        daemonState.connection?.send(decoded);
        // Never recurse through arbitrary fallback terminals. A storage or
        // canonicalization failure remains visible and requires operator
        // recovery; the oversized result itself is never silently dropped.
      }
    }, seal);
  };

  /**
   * #654: seals a sealed task's terminal when the commit queue runs it. The
   * queue can hold it past a failed stop. Then it seals through the run it
   * runs in, after that run's start and member resume: a throw here is a
   * retry. A run whose resume found no member, or whose member is lost,
   * gives the closed plaintext form. Without an `owner` run, it always seals
   * through the task's journaled offer.
   */
  const sealQueuedTerminal = async (owner: SealedTasks | undefined, ownerIdentity: string | undefined, envelope: Envelope): Promise<Envelope | undefined> => {
    const taskId = envelope.task_id!;
    if (daemonState.startInProgress) throw new Error(`${envelope.type} for sealed task ${taskId} waits for the start under way`);
    const current = daemonState.latestSealedTasks!;
    if (current === owner) return owner.sealOutbound(envelope);
    if (daemonState.memberResuming) throw new Error(`${envelope.type} for sealed task ${taskId} waits for this run's member`);
    const task = await activeJournal.readTask(taskId, journalIdentity);
    if (!task || !('envelopeBytes' in task)) throw new Error(`missing durable offer of sealed task ${taskId}`);
    // A run under another tenant, device or member never seals this task's output.
    return current.sealRecovered(decodeEnvelope(task.envelopeBytes), envelope, ownerIdentity !== undefined && ownerIdentity === daemonState.latestSealIdentity?.());
  };

  // #654: a task waits on its approval request. One that cannot be sealed
  // (no sealing key, or over the inline frame) never reaches the Host, so
  // the device denies it locally and the task goes on or ends.
  const denyUnsentApproval = (envelope: Envelope): void => {
    const { approvalId } = envelope.payload as { approvalId?: string };
    if (envelope.type !== 'task.await_approval' || approvalId === undefined) return;
    console.error(`[byok/client] approval ${approvalId} of sealed task ${envelope.task_id} was not sent; denied locally`);
    try {
      approvalRegistry.resolve(approvalId, 'reject', 'the approval request could not be sealed for the Host');
    } catch {
      // Already resolved, for example by the approval timeout.
    }
  };

  // The journal owns terminal bytes; the transport owns one delivery queue.
  // A local write failure must never bypass durability and send different truth.
  // #654: a task that seals its output sends each outbound sealed, in order.
  const sendEnvelope: TaskRunnerDeps['send'] = (envelope) => {
    const terminal = envelope.task_id !== undefined && terminalKindOf(envelope.type) !== undefined;
    if (sealedRun.sealedTasks?.sealsOutbound(envelope)) {
      // The local observer reads the plaintext envelope; see `plainOf`.
      observer.captureOutboundApproval(envelope);
      const sealedTaskOutput = sealedRun.sealedTasks;
      if (terminal) {
        const ownerIdentity = sealedRun.ownSealIdentity;
        commitTerminal(envelope.task_id!, () => sealQueuedTerminal(sealedTaskOutput, ownerIdentity, envelope));
        return;
      }
      void sealedTaskOutput.sealOutbound(envelope).then(
        (sealed) => { if (sealed !== undefined) daemonState.connection?.send(sealed); else denyUnsentApproval(envelope); },
        (error: unknown) => {
          console.error(`[byok/client] ${envelope.type} for sealed task ${envelope.task_id} not sent`, error);
          denyUnsentApproval(envelope);
        },
      );
      return;
    }
    if (!terminal) {
      observer.captureOutboundApproval(envelope);
      daemonState.connection?.send(envelope);
      return;
    }
    commitTerminal(envelope.task_id!, envelope);
  };

  /**
   * #654 §77b: a sealed terminal that named its ciphertext blob and that the
   * Host refused gets one replacement, the failure of a terminal that cannot
   * be sealed. It seals with the member that sealed the refused terminal once
   * this run's start and member resume are over, else it is the closed
   * plaintext form. A journaled terminal is replaced in the journal, so the
   * Host receives exactly one terminal. Never throws: the caller is the
   * outbound settlement, which would post the refused bytes again.
   */
  const replaceRefusedTerminal = (refused: Envelope): void => {
    const failure = opened.refusedReplacement(refused);
    if (failure === undefined) return;
    const taskId = refused.task_id!;
    const refusedHash = journalHash(encodeEnvelope(refused));
    const ownerIdentity = JSON.stringify([record.tenantId, record.deviceId, (refused.payload as { sealed: { sender: string } }).sealed.sender]);
    commitTerminal(taskId, async () => {
      // A repeated trigger after the replacement committed changes nothing.
      const durable = (await activeJournal.listPendingTerminals(journalIdentity)).find((row) => row.taskId === taskId);
      if (durable?.payloadHash !== refusedHash || durable.truthState !== 'failed') return undefined;
      return sealQueuedTerminal(undefined, ownerIdentity, failure);
    }, refusedHash);
  };

  // #826: an inbound envelope above the journal record bound is never stored
  // or run, and it must not hold the cursor. An offer is declined once,
  // non-retryably, from a journal record kept without its bytes. Any other
  // envelope is dropped; for a task.cancel, the local task runs until it ends.
  const refuseOverBoundEnvelope = async (envelope: Envelope, record: ReceivedEnvelopeRecord, byteLength: number): Promise<void> => {
    const taskId = envelope.task_id;
    if (!isTaskOfferType(envelope.type) || taskId === undefined) {
      console.warn(`[byok/client] dropped inbound ${envelope.type} (seq=${record.seq}): ${byteLength} bytes is over the journal record bound`);
      return;
    }
    const { agentRef } = envelope.payload as { agentRef?: AgentRef };
    // A sealed offer this device cannot hold is one it cannot open; a device
    // with no keyring declines every sealed offer for want of a key. The
    // closed code is a value gate on the server's `sealed-payload-v1`.
    const code = sealedRun.sealedMember === undefined ? 'sealed_key_unavailable' : 'sealed_open_failed';
    const serverCapabilities = daemonState.connection?.getServerCapabilities() ?? [];
    const closedCode = isSealedMessageType(envelope.type)
      && requiredReceiverCapabilities('task.decline', { reason: code, code }).every((flag) => serverCapabilities.includes(flag));
    const decline = createEnvelope('task.decline', {
      ...(closedCode ? { reason: code, code } : { reason: 'inbound_envelope_too_large' }),
      retryable: false, ...(agentRef === undefined ? {} : { agentRef }),
    }, { taskId });
    const bytes = encodeEnvelope(decline);
    const receipt = await activeJournal.appendWithheldOffer({
      identity: journalIdentity, envelopeId: record.envelopeId, taskId, seq: record.seq, bytesHash: record.bytesHash,
      byteLength, receivedAt: record.receivedAt, decline: { bytes, payloadHash: journalHash(bytes) },
    });
    // The decline is already durable. A new receipt sends it; a redelivery
    // retries a send still in flight (startup replays any other pending one).
    if (receipt.created) sendEnvelope(decline);
    else if (terminalCommits.hasPending(taskId)) await terminalCommits.retry(taskId);
    await terminalCommits.receipt(taskId);
  };

  // Serialize the marker/acceptance handshake across inbound dispositions
  // and turn_end. Acceptance evidence precedes deletion of the exact draft.
  let resultReplyTransitionTail: Promise<void> = Promise.resolve();
  const withReplyTransition = (write: () => Promise<void>): Promise<void> => {
    const operation = resultReplyTransitionTail.then(write);
    resultReplyTransitionTail = operation.catch(() => {});
    return operation;
  };
  const recordReplyState = (taskId: string, failure?: import('../result-reply-failure').ResultReplyFailure): Promise<void> => {
    return withReplyTransition(async () => {
      const task = await activeJournal.readTask(taskId, journalIdentity);
      if (!task || task.localState.startsWith('terminal:')) return;
      const priorFailure = resultReplyFailureFromState(task.localState);
      const accepted = failure === undefined || task.localState === 'required-reply-accepted' || task.localState.endsWith('-accepted');
      const kind = failure ?? priorFailure;
      const state = kind === undefined ? 'required-reply-accepted' : `${kind}${accepted ? '-accepted' : ''}`;
      await activeJournal.recordTransition({ transitionId: `result-reply:${taskId}:${state}`, taskId,
        to: state, occurredAt: new Date().toISOString() });
    });
  };
  const deps: TaskRunnerDeps = {
    adapters,
    runtimeAllowlist: config.runtimeAllowlist,
    // M5 batch-3: see `DaemonConfig.runtimePreference`'s own doc comment above.
    runtimePreference: config.runtimePreference,
    ...(config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot }),
    ...(agentHomeManager === undefined ? {} : { agentHome: agentHomeManager }),
    ...(config.strictAgentOnly === true ? { strictAgentOnly: true } : {}),
    // Already validated up front — see `DaemonConfig.maxConcurrentReaderAttemptsPerAgentHome`.
    maxConcurrentReaderAttemptsPerAgentHome: agentHomeReaderLimit,
    scratchRoot,
    ...(agentSessionHandoffs === undefined ? {} : { agentSessionHandoffs }),
    deviceId: record.deviceId,
    getMcpToolsets: () => toolsetRegistry.snapshot().toolsets,
    // The prepared-Execution lane, present only on a daemon whose input
    // preparation service actually constructed — which is also the only
    // daemon that advertises `agent-input-preparation-v9` and can hold a record
    // a `task.offer_prepared` could name. The three device facts travel with
    // the store because this file already owns them: re-deriving the
    // installed runtime identity or the operator's policy revision inside the
    // task runner would be a second opinion about the same configuration.
    ...(daemonState.inputPreparationService === undefined || inputPreparationLimits === undefined
      ? {}
      : {
        inputPreparationLane: {
          store: daemonState.inputPreparationService.store,
          // The service's own once-only open latch. The task runner awaits
          // it before its first record read so a restarted daemon that has
          // served no control call yet still sees its durable records; the
          // replay behind it stays the service's single authority.
          open: daemonState.inputPreparationService.open,
          runtime: daemonState.inputPreparationService.runtime,
          policyRevision: inputPreparationLimits.revision,
          authorizeAgentMemory: (binding) => daemonState.inputPreparationService!.authorizeAgentMemory(binding),
          toolsetDefinitionRevisions: () => new Map(
            toolsetRegistry.status().toolsets.map((row) => [row.id as string, row.definitionRevision]),
          ),
        },
      }),
    // Queue the exact bytes; observer delivery projections run only after
    // the awaited outbound settlement, including terminal journal fsync.
    send: sendEnvelope,
    ...(config.durablePi !== true ? {} : { durablePi: true, recordDurableTransition: async (taskId: string, leaseId: string, kind: string, ordinal: number) => {
      await withReplyTransition(async () => {
        const task = await activeJournal.readTask(taskId, journalIdentity);
        const to = task?.localState.startsWith('required-reply-') ? task.localState : 'running';
        await activeJournal.recordTransition({ transitionId: randomUUID(), taskId, to,
          occurredAt: new Date().toISOString(), detail: JSON.stringify({ kind, leaseId, ordinal }) });
      });
    } }),
    recordResultReplyFailure: (taskId, failure) => recordReplyState(taskId, failure),
    recordAgentMessageAccepted: taskId => recordReplyState(taskId),
    beforeClaim: async (taskId: string, runtime: string) => {
      await activeJournal.recordAdmission({ taskId, admitted: true, claimedRuntime: runtime, decidedAt: new Date().toISOString() });
    },
    blobClient,
    batcherOptions: egressBatcherOptions,
    agentEgress: daemonState.agentEgress,
    ...(config.agentEgress === undefined ? {} : { agentEgressPolicy: egressPolicy }),
    sessionWorkspaces,
    gitWorkspaceManager,
    gitWorkspaceStore,
    onGitWorkspaceEvent: (event) => observer.noteGitWorkspace({
      taskId: event.taskId,
      workspaceId: event.workspaceId,
      phase: event.phase,
      headChanged: event.observation?.headChanged,
      commitsSinceBaseline: event.observation?.commitsSinceBaseline,
      dirty: event.observation ? { staged: event.observation.staged, unstaged: event.observation.unstaged, untracked: event.observation.untracked, conflicted: event.observation.conflicted } : undefined,
      errorCategory: event.errorCategory,
    }),
    onRuntimeDisposalFailure: (event) => observer.noteRuntimeDisposalFailure(event),
    onExecutionRecord: (record) => observer.noteExecutionRecord(record),

    // M4 Phase 3: the SAME `ApprovalRegistry` instance the control
    // socket's own `approvals.list`/`approvals.resolve` methods already
    // share (see that field's own construction above) — `TaskRunner
    // .requestApproval` registers into it directly, so a decision arriving
    // via either the server wire or the local CLI resolves the identical
    // entry. `storeDir`/`productId` let the prepared operation approval channel
    // (populated per-task by `TaskRunner`) tell an out-of-process helper
    // exactly which control socket to dial.
    approvalRegistry,
    storeDir,
    productId: config.productId,
    tenantId: record.tenantId,
    // U2 terminal inference usage consumes the one U4a-resolved,
    // process-immutable identity captured above. This is composition-only:
    // TaskRunner receives no config, manifest, or second identity resolver.
    localAgentRelease,
    approvalTimeoutMs: overrides.approvalTimeoutMs,
    // Finding F5(a): see TaskRunnerDeps.shutdownInterruptTimeoutMs's own doc comment.
    shutdownInterruptTimeoutMs: overrides.shutdown?.taskInterruptTimeoutMs,
    // M5 batch-3 (workstream 2): see DaemonConfig.maxTaskOutputBytes's own doc comment — already validated above.
    awaitTerminalCommit: taskId => terminalCommits.receipt(taskId),
    maxTaskOutputBytes: config.maxTaskOutputBytes,
    artifactLimits: config.artifactLimits,
    startupTimeoutMs: config.startupTimeoutMs,
    // See DaemonConfig.maxInlineEventBytes's own doc comment — already validated above.
    maxInlineEventBytes: config.maxInlineEventBytes,
    ...(config.agentHome === undefined ? {} : {
      agentResultMcpBin: (() => {
        const resolved = resolveSdkReservedHelperBin('agent-result-mcp', config.sdkHelperHost);
        return Object.freeze({ command: resolved.command, args: resolved.args });
      })(),
      agentResultMcpPreflight: preflightAgentResultMcp,
    }),
    ...(agentMemoryMcpBin === undefined ? {} : { agentMemoryMcpBin }),
    ...(config.agentMemoryMcp === undefined ? {} : { agentMemoryMcp: config.agentMemoryMcp }),
    ...(agentMemoryDescribeBin === undefined ? {} : { agentMemoryDescribeBin }),
    ...(resolveAgentMemoryFilesystemHelperBin === undefined ? {} : { resolveAgentMemoryFilesystemHelperBin }),
    ...(config.agentMemoryHelperAssetRoot === undefined ? {} : { agentMemoryHelperAssetRoot: config.agentMemoryHelperAssetRoot }),
    ...(config.agentHome !== undefined && config.agentEgress !== undefined ? {
      agentMessageMcpBin: resolveAgentMessageMcpBin(config.sdkHelperHost),
      agentMessageMcpPreflight: preflightAgentMessageMcp,
    } : {}),
    ...(config.agentMemory === undefined ? {} : { agentMemoryHostedProjection: config.agentMemory }),
    // M4 Phase 3 hardening: bridges TaskRunner's stale-approval-race
    // finding out to the SAME local observability seam every other
    // daemon-local event already uses (see observer.ts's own module doc
    // comment) — TaskRunner itself still has no notion `DaemonObserver`
    // exists, exactly like every other `deps.send`-shaped seam here.
    onStaleApprovalDecision: (taskId, decision, reason) => {
      observer.noteStaleApprovalDecision(taskId, decision, reason);
    },
    // Finding F4: see `TaskRunnerDeps.onApprovalDispatched`'s own doc
    // comment — lets `observer`'s `awaiting-approval` DaemonEvent (and
    // thus `tasks --follow`) surface the approvalId an operator actually
    // needs to call `approve`/`reject`/`approvals` against.
    onApprovalDispatched: (taskId, approvalId) => {
      observer.noteApprovalDispatched(taskId, approvalId);
    },
    // M4 (additive-minor, `task.approval_resolved`): read fresh at call
    // time via `connection` (assigned just below — safe by the time this
    // is actually invoked, same closure pattern `send` above already
    // relies on) rather than captured once here, since the negotiated
    // capability is only known once the handshake completes, strictly
    // after this `deps` object is constructed.
    getServerCapabilities: () => daemonState.connection?.getServerCapabilities() ?? [],
    sealedTasks: opened,
    // Same late-binding closure as `getServerCapabilities`; with no
    // connection yet there is no advertisement, and that is an error.
    getIngressBudget: () => {
      if (daemonState.connection === undefined) throw new Error('no activity ingress has been advertised; the connection is not started');
      return daemonState.connection.getIngressBudget();
    },
    // Contract §8.1: the nonce injection asks the SAME gate the RPC and the
    // hello advertisement ask, read fresh at offer time for the same reason
    // `getServerCapabilities` is — the declaration lands after this `deps`
    // object is built.
    hostTaskContextAvailable: () => taskContextCapabilityAvailable(),
    prepareHostTaskContext: waitForHostTaskContext,
    // S3b (L-003): the production admission guard — §12.7.2.1's hard-pressure
    // row. Reads the state the last maintenance tick computed (no disk work
    // on the offer path), and is absent entirely when no storage policy is
    // configured, which is what keeps `handleOffer` byte-identical for every
    // daemon that does not opt in.
    ...(activePressureEngine ? { admissionGuard: () => activePressureEngine.admissionGuard() } : {}),
  };
  daemonState.runner = new TaskRunner(deps);
  if (config.agentHome !== undefined && config.agentEgress !== undefined) {
    await daemonState.runner.recoverAgentMessageOutboxes(path.join(config.agentHome.hostStorageRoot, 'agents'), resultReplyRecoveryTasks,
      async taskId => (await activeJournal.readTask(taskId, journalIdentity))?.localState === 'terminal:cancelled');
  }
  // Both prerequisites survive process death in their existing authorities:
  // immutable terminal bytes in the journal and exact disposition in the outbox.
  // Queueing the message first is insufficient: a failed POST must not let the
  // terminal close cloud admission while its message is still pending.
  const replayRecoveryTerminals = async (taskId?: string): Promise<void> => {
    for (const id of resultReplyRecoveryTasks.keys()) {
      if (taskId !== undefined && taskId !== id) continue;
      const task = await activeJournal.readTask(id, journalIdentity);
      const failure = task && resultReplyFailureFromState(task.localState);
      if (!task || !failure || !('envelopeBytes' in task)) { resultReplyRecoveryTasks.delete(id); continue; }
      const state = daemonState.runner?.recoveredAgentMessageState(id);
      const accepted = task.localState.endsWith('-accepted');
      if (!accepted && state !== 'refused') continue;
      const offer = decodeEnvelope(task.envelopeBytes);
      const payload = offer.payload as { agentRef?: AgentRef; terminalProjection: { contract: string } };
      const reason = accepted ? resultReplyFailureReason(failure, payload.terminalProjection.contract) : 'required Agent message was refused';
      await recordRecoveryFailure(task, reason);
      resultReplyRecoveryTasks.delete(id);
    }
    for (const terminal of await activeJournal.listPendingTerminals(journalIdentity)) {
      if (taskId !== undefined && terminal.taskId !== taskId) continue;
      // A refusal recorded before its replacement committed (#654 §77b).
      if (terminal.truthState === 'failed' && !terminalCommits.hasPending(terminal.taskId)) replaceRefusedTerminal(decodeEnvelope(terminal.bytes));
      if (terminal.truthState !== 'pending') continue;
      if (daemonState.runner?.hasPendingRecoveredAgentMessage(terminal.taskId)) continue;
      assertJournalEnvelopeProtocol(terminal.bytes, terminal.taskId, 'pending-terminal');
      const envelope = decodeEnvelope(terminal.bytes);
      if (envelope.task_id !== terminal.taskId || terminalKindOf(envelope.type) !== terminal.terminalType) {
        throw new Error('durable terminal execution binding mismatch');
      }
      overrides.executionRecoveryFault?.('terminal:before-send');
      observer.captureOutboundApproval(envelope);
      daemonState.connection?.send(envelope);
    }
  };

  const handleAgentHomeProjectionEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'agent.home.projection') return false;
    if (agentHomeManager === undefined || agentHomeProjectionCompletion === undefined) {
      // A sender cannot turn a missing local consumer into a successful
      // no-op. Throwing retains the mailbox row/cursor for operator repair.
      throw new Error('task-free Agent-home projection is not configured on this daemon');
    }
    const outcome = await agentHomeManager.project(envelope.payload);
    await agentHomeProjectionCompletion.complete({
      requestId: envelope.payload.requestId,
      agentRef: envelope.payload.agentRef,
      projectionHash: envelope.payload.projectionHash,
      outcome,
    });
    return true;
  };
  const handleAgentInputPreparationEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'agent.input.preparation') return false;
    // Resolves once the completion is durably recorded by the cloud. Anything
    // that prevents that recording throws, so the cursor stays put and the
    // row is redelivered — a redelivery reads the immutable cloud completion
    // before local readiness/deadline checks or a second compile/count.
    await handleRemoteInputPreparation(envelope.payload);
    return true;
  };
  const handleAgentMemoryIntentEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'agent.memory.intent.available') return false;
    // Task-free and never journaled, like provisioning: resolves only after
    // the Host readback matched a durable terminal and the `ackedAt`
    // barrier succeeded. Any throw keeps the row and the cursor.
    await processAgentMemoryIntentNotice(envelope.payload);
    return true;
  };
  const handleProviderProvisioningEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'provider.provisioning.available') return false;
    // Task-free and never journaled: it is consumed here, ahead of the
    // journal append below, and resolves only on a durable terminal
    // readback. Any throw keeps the row and the cursor for redelivery.
    await processProviderProvisioningNotice(envelope.payload);
    return true;
  };
  const handleE2eeKeyPackageEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'e2ee.key_package.available') return false;
    // Task-free and never journaled, like provisioning. It throws only while
    // the member resumes or when a Host read fails or times out, which keeps
    // the row; a final Host answer is acknowledged.
    await processE2eeKeyPackageNotice(envelope.payload, memberStatus(), logMember);
    return true;
  };
  const handleAgentEgressEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'agent.egress.ack') return false;
    if (config.agentEgress === undefined) return true;
    await daemonState.agentEgress.acknowledge({ ...envelope.payload, tenantId: record.tenantId });
    return true;
  };
  const handleAgentContentReadEnvelope = async (envelope: Envelope): Promise<boolean> => {
    if (envelope.type !== 'agent.content.read') return false;
    // This build could not have advertised a content-read capability without
    // both authorities. A stale or malicious sender gets no implicit local
    // path, tenant, or receipt synthesized from incomplete identity.
    if (config.agentEgress === undefined || agentHomeManager === undefined || agentSessionHandoffs === undefined) {
      return true;
    }

    const payload = envelope.payload;
    const session: AgentContentSessionIdentity = Object.freeze({
      agentRef: payload.agentRef,
      sessionRef: payload.sessionRef,
      runtimeId: payload.runtime,
      cwd: payload.cwd,
    });
    const canonicalHome = (await agentHomeManager.layout.resolve(payload.agentRef)).canonicalHome;
    const exactWirePolicy =
      payload.policyRevision === egressPolicy.policyRevision &&
      hasExactContentReadTransfer(egressPolicy.transfers[payload.surface], payload.policy);
    const policies = exactWirePolicy
      ? agentContentReadPolicies
      : policyRevisionMismatchPolicies(agentContentReadPolicies, payload.surface);
    const policyEngine = new AgentContentReadPolicyEngine({
      agentHomeLayout: agentHomeManager.layout,
      policies,
      capabilities,
      ...(config.agentEgress.contentRead?.runtimeAllowlistedRoots === undefined
        ? {}
        : { runtimeAllowlistedRoots: config.agentEgress.contentRead.runtimeAllowlistedRoots }),
      // `requireMatch` is the only session authority for every surface. A
      // wire cwd must be the exact canonical Agent home before any bytes can
      // be read; there is no workspace/artifact exception.
      resolveSessionIdentity: async (request) => {
        const requestedSession = request.session;
        if (requestedSession === undefined) return undefined;
        if (requestedSession.cwd !== canonicalHome) return undefined;
        const handoff = await agentSessionHandoffs.requireMatch({
          agentRef: request.agentRef,
          sessionRef: requestedSession.sessionRef,
          runtimeId: requestedSession.runtimeId,
          cwd: requestedSession.cwd,
        });
        if (handoff.cwd !== canonicalHome) return undefined;
        return Object.freeze({
          agentRef: handoff.agentRef,
          sessionRef: handoff.sessionRef,
          runtimeId: handoff.runtimeId,
          cwd: handoff.cwd,
        });
      },
      // This factory derives the SDK-owned address solely from the canonical
      // AgentHomeLayout resolution and shares its writer queue with every
      // same-Agent envelope in this daemon process.
      auditStore: AgentContentAuditStore.forCanonicalAgentHome(canonicalHome),
    });
    const result = await policyEngine.read({
      requestId: payload.requestId,
      actor: payload.actor,
      tenantId: record.tenantId,
      deviceId: record.deviceId,
      agentRef: payload.agentRef,
      surface: payload.surface,
      relativeTarget: payload.target,
      mimeType: payload.mimeType,
      capability: AGENT_CONTENT_READ_CAPABILITIES[payload.surface],
      policyRevision: payload.policyRevision,
      maxBytes: payload.policy.maxBytes,
      allowedMimeTypes: payload.policy.allowedMimeTypes,
      decodeAs: payload.decodeAs,
      session,
    });

    const receipt = {
      requestId: payload.requestId,
      surface: payload.surface,
      actor: payload.actor,
      agentRef: payload.agentRef,
      sessionRef: payload.sessionRef,
      runtime: payload.runtime,
      cwd: payload.cwd,
      policyRevision: payload.policyRevision,
      target: payload.target,
      mimeType: payload.mimeType,
      decodeAs: payload.decodeAs,
    } as const;
    const appendAndDispatchContentReceipt = async (
      contentReceipt: AgentContentReceiptWithoutReliableIdentity,
    ): Promise<void> => {
      const appended = await daemonState.agentEgress.appendContentReceipt({
        homeDir: canonicalHome,
        agentRef: payload.agentRef,
        payload: contentReceipt,
      });
      if (!appended.ok) {
        // Throwing keeps the inbound request unacknowledged, so the server
        // redelivers rather than treating a non-durable content decision as
        // complete or silently moving it to latest-value activity.
        throw new Error(`content receipt could not enter reliable spool: ${appended.reason}`);
      }
      dispatchReliableRecord(appended.record);
    };
    if (result.decision === 'deny') {
      await appendAndDispatchContentReceipt({
        ...receipt,
        decision: 'denied',
        byteCount: 0,
        reason: result.reason,
      });
      return true;
    }

    // A committed audit receipt plus this requestId-stable blob reservation
    // makes a crash/redelivery retry the same upload rather than minting a
    // second cloud object.
    const blobRef = await blobClient.uploadArtifact(result.content, payload.mimeType, {
      idempotencyKey: payload.requestId,
    });
    await appendAndDispatchContentReceipt({
      ...receipt,
      decision: 'allowed',
      byteCount: result.byteCount,
      contentHash: `sha256:${result.contentHash}`,
      blobRef,
    });
    return true;
  };

  daemonState.connection = new ConnectionManager({
    serverUrl: config.serverUrl,
    deviceId: record.deviceId,
    productId: config.productId,
    capabilities,
    clientVersion: localAgentRelease.version,
    runtimes,
    harnesses,
    getConfiguredToolsets: () => toolsetRegistry.snapshot().configuredToolsets,
    auth: daemonState.auth,
    cursorStore,
    // Finding F3: return (not void-and-forget) so ConnectionManager can
    // await this handler and only advance/persist its redelivery cursor
    // once it actually resolves — see connection-manager.ts's `process`.
    // M3-2a: also this file's own closure, unrelated to F3's redelivery
    // semantics above — `handleInboundEnvelope` only ever looks at
    // `task.offer` (the one event with no corresponding outbound envelope
    // of its own) and never throws, so it can't affect cursor advancement.
    // S3b (L-002): where "ack after durable commit" stops being a
    // discipline and becomes the only expressible behaviour.
    //
    // `ConnectionManager.process` advances (and persists) the redelivery
    // cursor ONLY when this handler resolves, and merely records a stall
    // when it throws (`connection-manager.ts`) — that was already true, and
    // is not changed by this slice. Putting the journal transaction INSIDE
    // this handler therefore makes the ordering structural: the cursor
    // cannot move past a seq whose envelope is not yet committed, because
    // the only thing that moves the cursor is this function resolving, and
    // this function does not resolve until the commit does. There is no
    // second path to the cursor to keep in step, and the transport is
    // untouched.
    //
    // Placed after the observer (which never throws and owns no durable
    // state) and before the runner, so the bytes are on disk before any
    // work is scheduled off them. A redelivered envelope is absorbed by the
    // journal's own receipt and costs one no-op transaction.
    onEnvelope: async (envelope) => {
      if (daemonState.tenantRebinding) {
        throw new Error('tenant enrollment is being re-paired; inbound work is blocked until restart');
      }
      observer.handleInboundEnvelope(envelope);
      if (await handleAgentHomeProjectionEnvelope(envelope)) return;
      if (await handleAgentInputPreparationEnvelope(envelope)) return;
      if (await handleProviderProvisioningEnvelope(envelope)) return;
      if (await handleAgentMemoryIntentEnvelope(envelope)) return;
      if (await handleE2eeKeyPackageEnvelope(envelope)) return;
      if (await handleAgentEgressEnvelope(envelope)) return;
      if (await handleAgentContentReadEnvelope(envelope)) return;
      // S3b (L-003): §12.7.2.1's `emergency` row — "fail-closed，不 ack
      // 新 mailbox row；保留现有 recovery evidence". Throwing HERE, ahead
      // of the append, reuses the ordering the journal branch already
      // established: the handler rejects, so the cursor does not move,
      // so the mailbox keeps the row and redelivers it later. The task
      // is not lost; it is left in the one place that still has room
      // for it. Nothing is deleted to make space.
      activePressureEngine?.assertAckCriticalAllowed();
      const record = toJournalEnvelopeRecord(envelope, journalIdentity);
      try {
        await activeJournal.appendEnvelope(record);
      } catch (error: unknown) {
        if (!(error instanceof JournalRecordTooLargeError)) throw error;
        await refuseOverBoundEnvelope(envelope, record, error.actualBytes);
        return;
      }
      if (isTaskOfferType(envelope.type) && envelope.task_id !== undefined) {
        // A selected terminal fences admission even if its transaction rolled
        // back to received. Check before reading a possibly stale task row.
        if (terminalCommits.hasPending(envelope.task_id)) {
          await terminalCommits.retry(envelope.task_id);
          return;
        }
        const task = await activeJournal.readTask(envelope.task_id, journalIdentity);
        if (!task) throw new Error('durable offer has no execution record');
        if (task.localState !== 'received') {
          await terminalCommits.retry(envelope.task_id);
          return;
        }
      }
      if (envelope.type === 'task.cancel' && envelope.task_id !== undefined && resultReplyRecoveryTasks.has(envelope.task_id)) {
        const taskId = envelope.task_id;
        const binding = resultReplyRecoveryTasks.get(taskId)!;
        await daemonState.runner!.cancelRecoveredAgentMessage(taskId, async () => {
          // Without its offer the cancel cannot tell a sealed task: it is never sent.
          const task = await activeJournal.readTask(taskId, journalIdentity);
          if (!task || !('envelopeBytes' in task)) throw new Error(`missing durable offer of recovered task ${taskId}`);
          const cancelled = createEnvelope('task.cancelled', { reason: envelope.payload.reason,
            ...terminalIdentity(task.claimedRuntime, binding.agentRef) }, { taskId });
          sendEnvelope(await opened.sealRecovered(decodeEnvelope(task.envelopeBytes), cancelled));
          await terminalCommits.receipt(taskId);
        });
        resultReplyRecoveryTasks.delete(taskId);
      } else await daemonState.runner?.handleEnvelope(envelope);
      if (envelope.type === 'agent.message.disposition') {
        // handleEnvelope fsyncs only an exact disposition before this
        // gate opens. A crash before sending leaves the journal pending.
        await replayRecoveryTerminals(envelope.task_id);
      }
      // In particular, a pre-claim decline must be durable before ack.
      if (envelope.task_id !== undefined) await terminalCommits.receipt(envelope.task_id);
    },
    onOutboundQueued: (envelope) => {
      if (terminalKindOf(envelope.type) !== undefined) overrides.executionRecoveryFault?.('terminal:queued');
    },
    beforeOutboundPost: (envelopes) => {
      if (envelopes.some((envelope) => terminalKindOf(envelope.type) !== undefined)) overrides.executionRecoveryFault?.('outbound:before-post');
    },
    onOutboundSettled: async (settlements) => {
      // All terminal fsyncs must succeed before publishing any observation.
      // A retry after a partial local write can repeat the idempotent journal
      // operation, without double-counting an earlier part of this batch.
      for (const settlement of settlements) {
        const { envelope } = settlement;
        if (terminalKindOf(envelope.type) === undefined || envelope.task_id === undefined) continue;
        const hash = journalHash(encodeEnvelope(envelope));
        if (settlement.outcome === 'rejected') {
          await activeJournal.rejectTerminal(envelope.task_id, hash, settlement.reason);
          replaceRefusedTerminal(envelope);
        } else {
          overrides.executionRecoveryFault?.('outbound:after-ack');
          await activeJournal.confirmTerminal(envelope.task_id, hash);
        }
      }
      for (const settlement of settlements) {
        const { envelope } = settlement;
        outbound[settlement.outcome] += 1;
        if (settlement.outcome !== 'rejected') { observer.handleOutboundEnvelope(sealedRun.sealedTasks?.plainOf(envelope) ?? envelope); continue; }
        const rejection = {
          envelopeId: envelope.id, type: envelope.type,
          ...(envelope.task_id === undefined ? {} : { taskId: envelope.task_id }),
          reason: settlement.reason, terminal: terminalKindOf(envelope.type) !== undefined,
        };
        outbound.rejectedByReason[rejection.reason] = (outbound.rejectedByReason[rejection.reason] ?? 0) + 1;
        if (rejection.terminal) outbound.rejectedTerminals += 1;
        outbound.lastRejection = rejection;
        observer.noteOutboundRejected(sealedRun.sealedTasks?.plainOf(envelope) ?? envelope, rejection);
      }
    },
    onStateChange: (state) => {
      setLifecycle({ phase: 'running', connection: state });
      // Discovery is armed before the first connection can deliver offers.
      // Every open replaces the read, so rollout/reconnect facts cannot be
      // borrowed from a previous connection generation.
      if (state === 'open') {
        daemonState.runner?.retryRecoveredAgentMessages();
        runPresenceDiscovery();
      }
    },
    onHalted: (reason) => halted(reason),
    onCrashed: () => crashed(),
    // Reliable records held for `capability_missing` go out as soon as an
    // advertisement carries the ack capability — on every reconnect, not
    // only at start.
    onCapabilitiesAdvertised: (added) => {
      if (!added.includes(AGENT_EGRESS_RELIABLE_ACK_CAPABILITY) || daemonState.connection === undefined) return;
      for (const record of daemonState.agentEgress.retryableReliableRecords(daemonState.connection.getServerCapabilities())) {
        dispatchReliableRecord(record);
      }
    },
    longPollRetryDelayMs: overrides.longPoll?.retryDelayMs,
    longPollIdleDelayMs: overrides.longPoll?.idleDelayMs,
    fleetJitter: daemonState.fleetJitter,
    onOperationalOutcome: (outcome, source) => {
      const write = outcome === 'success'
        ? operationalHealth.recordSuccess(source)
        : operationalHealth.recordFailure(source);
      void write.catch((err: unknown) => {
        console.warn(`[byok/client] failed to persist operational health: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
  });
  await replayRecoveryTerminals();
  startPresenceProducer();
  // Before the connection, so a key package notice in the first poll waits for the resume.
  startDeviceMember(record);
  await daemonState.connection.start();
  daemonState.daemonStarted = true;
  } catch (err) {
    // A failed start opens no session: its teardown settles a queued
    // terminal as a stop does.
    daemonState.startInProgress = false;
    const haltReason = startupHaltReason(err);
    if (haltReason === undefined) {
      // #394: a crash, the one start failure a restart may fix. Recorded so
      // that a crash loop degrades operational health.
      try {
        await operationalHealth.startRun();
        await operationalHealth.recordFailure('lifecycle');
      } catch (healthError) {
        console.warn(`[byok/client] failed to persist operational health: ${healthError instanceof Error ? healthError.message : String(healthError)}`);
      }
    } else if (haltReason !== 'store_owned') {
      halted(haltReason);
    }
    const thrown = haltReason === undefined || err instanceof DaemonHaltError ? err : new DaemonHaltError(haltReason, { cause: err });
    try {
      // startUnderLease already owns the process-local lifecycle slot. Run
      // teardown directly; queueing requestShutdown here would wait on this
      // operation itself and deadlock.
      await runShutdownSequence('startup failed', { drainTimeoutMs: 0 });
    } catch (cleanupError) {
      throw new AggregateError([thrown, cleanupError], 'daemon startup failed and teardown was incomplete');
    }
    throw thrown;
  }
}
