import type { ControlStorageStatus, ControlStatusResult, ControlActiveTask } from '../control-protocol';
import { TASK_TRANSITIONS } from '@byok-sdk/protocol';
import type { AgentHomeExecutionStatus } from '../../agent-home';
import type { OutboundStatus } from '../outbound-settlement';
import type { DaemonStatus } from '../create-daemon';
import type { DaemonScope } from './scope';

/** The daemon status and the control-socket status (#926). */

// -------------------------------------------------------------------------
// M4 Phase 2: control socket method registry (`control-server.ts` is
// daemon-agnostic; this is the glue that closes over THIS daemon
// instance's own state). Built once; every handler below reads `runner`/
// `connection`/`lifecycle`/`auth` fresh at CALL time via normal JS
// closure semantics, so it stays correct across this daemon's own
// start()/stop() cycles.
// -------------------------------------------------------------------------

export function buildStorageStatus(daemonScope: DaemonScope): ControlStorageStatus {
  const { retentionSweeper, storageConfig, storagePressure } = daemonScope;
  const snapshot = retentionSweeper.snapshot();
  return { ...snapshot, ...(storageConfig.budget === undefined ? {} : { budget: {
    budgetBytes: storageConfig.budget.maxStoreBytes, pressureState: storagePressure.state,
  } }) };
}

export function buildControlStatus(daemonScope: DaemonScope): ControlStatusResult {
  const {
    buildStorageStatus, observer, approvalRegistry, localAgentRelease, daemonState,
    operationalHealth, outboundStatus, toolsetRegistry, agentHomeExecutionStatus,
  } = daemonScope;
  const storageStatus = buildStorageStatus();
  const activeTasks: ControlActiveTask[] = observer
    .tasks()
    .filter((task) => TASK_TRANSITIONS[task.state].length > 0) // non-terminal only — see the `status` method's own doc comment (control-protocol.ts)
    .map((task) => ({ taskId: task.taskId, state: task.state }));
  // Finding F4: computed once and reused for both `approvals` (the actual
  // entries, so `status`'s live section can render approvalIds without a
  // second control-socket round trip) and `approvalsPending` (the same
  // list's count) — same source `approvals.list` itself calls.
  const pendingApprovals = approvalRegistry.list();
  const clockSkew = daemonState.auth.clockSkew();
  // #1103: keep verdicts out of `runtimes` so a pre-#1103 CLI's strict
  // observation parser still accepts the array; new readers merge this
  // additive side channel by runtime id.
  const runtimeVersionVerdicts = daemonState.runtimeObservations.flatMap((observation) => observation.versionVerdict === undefined
    ? []
    : [{ id: observation.id, versionVerdict: { ...observation.versionVerdict } }]);
  // #1103 §2.6: the restart comparison travels the same way, so a pre-#1103
  // client's strict observation parser keeps accepting `runtimes`.
  const runtimeVersionChanges = daemonState.runtimeObservations.flatMap((observation) => observation.versionChange === undefined
    ? []
    : [{ id: observation.id, versionChange: { ...observation.versionChange } }]);
  // #1103 O10: the executable is local status evidence and travels the same way.
  const runtimeExecutables = daemonState.runtimeObservations.flatMap((observation) => observation.executableSource === undefined
    ? []
    : [{ id: observation.id, ...(observation.executablePath === undefined ? {} : { executablePath: observation.executablePath }), executableSource: observation.executableSource }]);
  return {
    localAgentRelease,
    pid: process.pid,
    uptimeMs: daemonState.startedAt !== undefined ? Date.now() - daemonState.startedAt : 0,
    paired: daemonState.auth.deviceId !== undefined,
    deviceId: daemonState.auth.deviceId,
    lifecycle: daemonState.lifecycle,
    activeTasks,
    environment: { ...daemonState.resolvedEnvironment },
    ...(daemonState.environmentResolvedAt === undefined ? {} : { environmentResolvedAt: daemonState.environmentResolvedAt }),
    runtimes: daemonState.runtimeObservations.map(({ versionVerdict: _versionVerdict, versionChange: _versionChange, executablePath: _executablePath, executableSource: _executableSource, ...observation }) => ({ ...observation })),
    ...(runtimeVersionVerdicts.length === 0 ? {} : { runtimeVersionVerdicts }),
    ...(runtimeVersionChanges.length === 0 ? {} : { runtimeVersionChanges }),
    ...(runtimeExecutables.length === 0 ? {} : { runtimeExecutables }),
    // M4 Phase 4 (part B.3): queue watermarks come from TaskRunner's own
    // active-task map (distinct from `observer.tasks()` above, which is
    // derived from the envelope feed) — see `TaskRunner.getQueueWatermarks`'s
    // own doc comment for why this is a progress-batcher-backlog +
    // in-flight-approval-count proxy rather than the adapter's own event
    // queue depth.
    queueWatermarks: daemonState.runner?.getQueueWatermarks() ?? [],
    approvals: pendingApprovals,
    approvalsPending: pendingApprovals.length,
    // S3b (L-003): the storage section, present only when a policy is
    // configured AND a measurement has actually happened. An engine that has
    // never ticked reports nothing rather than a zeroed snapshot — "not
    // measured" and "measured, and empty" are different facts, and a status
    // surface that conflates them is how an operator concludes a full disk is
    // fine.
    storage: storageStatus,
    operationalHealth: operationalHealth.snapshot(),
    outbound: outboundStatus(),
    toolsets: toolsetRegistry.status(),
    // WP0: same counts `Daemon.status()` reports, from the same reader.
    agentHomeExecution: agentHomeExecutionStatus(),
    ...(clockSkew === undefined ? {} : { clockSkew }),
  };
}

/**
 * WP0: the one place both status surfaces read the per-home Attempt counts
 * from, so `Daemon.status()` and the authenticated control status can never
 * disagree. A daemon with no Agent home configured reports the limit and
 * zeroes rather than omitting the section — "capped, nothing active" is a
 * fact worth stating.
 */
export function agentHomeExecutionStatus(daemonScope: DaemonScope): AgentHomeExecutionStatus {
  const { agentHomeManager, agentHomeReaderLimit } = daemonScope;
  const summary = agentHomeManager?.executionLeaseManager.activeAttemptSummary();
  return {
    maxConcurrentReaderAttemptsPerAgentHome: agentHomeReaderLimit,
    activeHomes: summary?.homes ?? 0,
    activeAttempts: summary?.attempts ?? 0,
    activeReaderAttempts: summary?.readerAttempts ?? 0,
  };
}

export function outboundStatus(daemonScope: DaemonScope): OutboundStatus {
  const { outbound } = daemonScope;
  return { ...outbound, rejectedByReason: { ...outbound.rejectedByReason }, ...(outbound.lastRejection === undefined ? {} : { lastRejection: { ...outbound.lastRejection } }) };
}

export function status(daemonScope: DaemonScope): DaemonStatus {
  const {
    daemonState, buildStorageStatus, localAgentRelease, terminalCommits, config, operationalHealth,
    outboundStatus, toolsetRegistry, agentHomeExecutionStatus, agentMemoryMcpAdmission, effectiveConfig,
  } = daemonScope;
  return {
    environment: { ...daemonState.resolvedEnvironment },
    ...(daemonState.environmentResolvedAt === undefined ? {} : { environmentResolvedAt: daemonState.environmentResolvedAt }),
    runtimes: daemonState.runtimeObservations.map(observation => ({ ...observation })),
    storage: buildStorageStatus(),
    localAgentRelease,
    paired: daemonState.auth.deviceId !== undefined,
    lifecycle: daemonState.lifecycle,
    deviceId: daemonState.auth.deviceId,
    activeTaskCount: daemonState.runner?.activeTaskCount ?? 0,
    pendingTerminalCommits: terminalCommits.pendingCount,
    branding: config.branding,
    operationalHealth: operationalHealth.snapshot(),
    outbound: outboundStatus(),
    toolsets: toolsetRegistry.status(),
    egress: daemonState.agentEgress.status(),
    agentHomeExecution: agentHomeExecutionStatus(),
    agentMemoryMcp: agentMemoryMcpAdmission,
    config: effectiveConfig,
  };
}
