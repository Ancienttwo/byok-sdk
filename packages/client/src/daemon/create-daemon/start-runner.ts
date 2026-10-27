import type { TaskRunnerDeps } from '../task-runner';
import { randomUUID } from 'node:crypto';
import { resolveSdkReservedHelperBin } from '../../sdk-reserved-helper-host';
import { preflightAgentResultMcp } from '../agent-result-mcp-preflight';
import { resolveAgentMessageMcpBin } from '../resolve-agent-message-mcp-bin';
import { preflightAgentMessageMcp } from '../agent-message-mcp-preflight';
import type { DaemonScope } from './scope';
import type { StartRun } from './start-run';
import type { StartLanes } from './start-lanes';
import type { StartTerminals } from './start-terminals';

/**
 * The fourth stage of `runStartUnderLease` (#926), synchronous: builds the
 * `TaskRunnerDeps` for this start.
 */
export function composeStartRunnerDeps(daemonScope: DaemonScope, run: Pick<StartRun & StartLanes & StartTerminals, 'record' | 'sendEnvelope' | 'withReplyTransition' | 'activeJournal' | 'journalIdentity' | 'recordReplyState' | 'blobClient' | 'opened' | 'activePressureEngine'>) {
  const {
    adapters, config, agentHomeManager, agentHomeReaderLimit, scratchRoot, agentSessionHandoffs,
    toolsetRegistry, daemonState, inputPreparationLimits, egressBatcherOptions, egressPolicy,
    observer, approvalRegistry, storeDir,
    localAgentRelease, overrides, terminalCommits, agentMemoryMcpBin, agentMemoryDescribeBin,
    resolveAgentMemoryFilesystemHelperBin, taskContextCapabilityAvailable, waitForHostTaskContext,
  } = daemonScope;
  const {
    record, sendEnvelope, withReplyTransition, activeJournal, journalIdentity, recordReplyState,
    blobClient, opened, activePressureEngine,
  } = run;
  const deps: TaskRunnerDeps = {
    adapters,
    runtimeAllowlist: config.runtimeAllowlist,
    // M5 batch-3: see `DaemonConfig.runtimePreference`'s own doc comment above.
    runtimePreference: config.runtimePreference,
    ...(agentHomeManager === undefined ? {} : { agentHome: agentHomeManager }),
    // Already validated up front — see `DaemonConfig.maxConcurrentReaderAttemptsPerAgentHome`.
    maxConcurrentReaderAttemptsPerAgentHome: agentHomeReaderLimit,
    scratchRoot,
    ...(agentSessionHandoffs === undefined ? {} : { agentSessionHandoffs }),
    deviceId: record.deviceId,
    getMcpToolsets: () => toolsetRegistry.snapshot().toolsets,
    // The prepared-Execution lane, present only on a daemon whose input
    // preparation service actually constructed — which is also the only
    // daemon that advertises `agent-input-preparation-v9` and can hold a record
    // a prepared `task.offer` could name. The three device facts travel with
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
    // The array `conn.hello` is built from; presence and the capability
    // declaration edit it in place, so read it at offer time.
    advertisedCapabilities: () => daemonState.helloCapabilities,
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
  return {
    deps,
  };
}

export type StartRunnerDeps = ReturnType<typeof composeStartRunnerDeps>;
