// `TaskRunner` members for terminal payloads, the staged result, Git
// observation and Agent terminal evidence (see ./support.ts for how a member
// module runs).
import type { ResultReplyFailure } from '../result-reply-failure';
import { terminalIdentity } from '../terminal-identity';
import { TERMINAL_INFERENCE_USAGE_MAX_DURATION_MS, TERMINAL_INFERENCE_USAGE_MAX_TOKENS, type TerminalInferenceUsage, type TerminalPreparedObservation, type TerminalAgentHomeProjection, type TerminalAgentHomeMemoryChange } from '@byok-sdk/protocol';
import type { AgentRef } from '../../agent-home';
import { compareAgentHomeMemory, digestAgentHomeMemory } from '../../agent-home-readers';
import type { AgentTerminalCause } from '../agent-session-handoff-store';
import type { GitWorkspaceObservation, GitWorkspaceError, GitErrorCategory } from '../git-workspace';
import type { GitWorkspacePhase } from '../git-workspace-store';
import { AGENT_RESULT_TOOL_NAME } from '../../sdk-reserved-mcp';
import type { AgentResultRecord } from '../agent-result-store';
import type { ActiveTask } from './support';
import { AGENT_TERMINAL_EVIDENCE_RETRY_DELAY_MS, GIT_OBSERVATION_TIMEOUT_MS, isKnownRuntimeId, terminalUsageNumber, errorMessage } from './support';
import type { TaskRunner } from '../task-runner';
import { AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS, RESULT_NOT_SUBMITTED_REASON_PREFIX, RESULT_UNREADABLE_REASON_PREFIX } from '../task-runner';

export function terminalInferenceUsagePayload(this: TaskRunner, active: ActiveTask): { usage?: TerminalInferenceUsage } {
  const release = this['deps'].localAgentRelease;
  const runtimeId = active.adapter.descriptor.id;
  if (!isKnownRuntimeId(runtimeId)) return {};
  if (release === undefined || active.lastUsage === undefined) return {};
  if (active.lastUsage.inputTokens === undefined && active.lastUsage.outputTokens === undefined) return {};

  const nowMs = Date.now();
  const durationMs = terminalUsageNumber(nowMs - active.startedAtMs, TERMINAL_INFERENCE_USAGE_MAX_DURATION_MS);
  const promptTokens = terminalUsageNumber(active.lastUsage?.inputTokens, TERMINAL_INFERENCE_USAGE_MAX_TOKENS);
  const completionTokens = terminalUsageNumber(active.lastUsage?.outputTokens, TERMINAL_INFERENCE_USAGE_MAX_TOKENS);

  return {
    usage: {
      runtime: runtimeId,
      clientVersion: release.version,
      reportedAt: new Date(nowMs).toISOString(),
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  };
}

export function preparedObservationPayload(this: TaskRunner, active: ActiveTask): { preparedObservation?: TerminalPreparedObservation } {
  const observed = active.prepared;
  if (observed?.initialPromptTokens === undefined || observed.maxPromptTokens === undefined) return {};
  return {
    preparedObservation: {
      requestDigest: observed.requestDigest,
      initialPromptTokens: observed.initialPromptTokens,
      maxPromptTokens: observed.maxPromptTokens,
    },
  };
}

export function agentTerminalPayload(
  this: TaskRunner,
  active: ActiveTask,
): {
  agentRef?: AgentRef;
  harnessId?: string;
  agentHomeProjection?: TerminalAgentHomeProjection;
  agentHomeMemoryChange?: TerminalAgentHomeMemoryChange;
} {
  return {
    ...terminalIdentity(active.adapter.descriptor.id, active.agentRef),
    ...(active.appliedAgentHomeProjection === undefined ? {} : { agentHomeProjection: active.appliedAgentHomeProjection }),
    ...(active.agentHomeMemoryChange === undefined ? {} : { agentHomeMemoryChange: active.agentHomeMemoryChange }),
  };
}

export async function resolveStagedResult(
  this: TaskRunner,
  active: ActiveTask,
): Promise<{ deliver: true; document?: unknown; failure?: ResultReplyFailure } | { deliver: false }> {
  const selection = active.terminalProjection;
  if (selection?.mode !== 'result-document') return { deliver: true };
  this['revokeAgentResultContext'](active.taskId);
  let record: AgentResultRecord | undefined;
  try {
    if (active.resultStore === undefined) throw new Error('the task has no Agent result store');
    record = await active.resultStore.get(active.taskId);
  } catch (err) {
    if (this['tasks'].get(active.taskId) !== active || active.beingTornDown) return { deliver: false };
    if (active.messageRequirement !== undefined) return { deliver: true, failure: 'required-reply-result-unreadable' };
    await this['fail'](active.taskId, `${RESULT_UNREADABLE_REASON_PREFIX}: the staged result for contract ${selection.contract} could not be read: ${errorMessage(err)}`, false);
    return { deliver: false };
  }
  if (this['tasks'].get(active.taskId) !== active || active.beingTornDown) return { deliver: false };
  if (record === undefined) {
    if (active.messageRequirement !== undefined) return { deliver: true, failure: 'required-reply-result-missing' };
    await this['fail'](
      active.taskId,
      `${RESULT_NOT_SUBMITTED_REASON_PREFIX}: the offer requires result contract ${selection.contract}, but the runtime ended its turn without a staged ${AGENT_RESULT_TOOL_NAME} outcome`,
      false,
    );
    return { deliver: false };
  }
  if (record.contract !== selection.contract || record.tenantId !== this['deps'].tenantId
    || active.agentRef === undefined || record.agentRef.agentId !== active.agentRef.agentId
    || record.agentRef.profileRevision !== active.agentRef.profileRevision) {
    if (active.messageRequirement !== undefined) return { deliver: true, failure: 'required-reply-result-unreadable' };
    await this['fail'](active.taskId, `${RESULT_UNREADABLE_REASON_PREFIX}: the staged result does not belong to this task's contract and Agent`, false);
    return { deliver: false };
  }
  return { deliver: true, document: record.outcome };
}

export async function observeGit(this: TaskRunner, active: ActiveTask, phase: GitWorkspacePhase): Promise<void> {
  if (!active.gitWorkspaceId || !this['deps'].gitWorkspaceManager || !this['deps'].gitWorkspaceStore) return;
  try {
    const observation = await new Promise<GitWorkspaceObservation>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Git workspace observation timed out')), GIT_OBSERVATION_TIMEOUT_MS);
      timer.unref?.();
      void this['deps'].gitWorkspaceManager!.observe(active.workspaceDir, active.gitBaseline).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
    await this['deps'].gitWorkspaceStore.updateObservation(active.gitWorkspaceId, observation, phase);
    this['deps'].onGitWorkspaceEvent?.({ taskId: active.taskId, workspaceId: active.gitWorkspaceId, phase, observation });
  } catch (err) {
    const category = ((err as GitWorkspaceError).category ?? 'repository-invalid') as GitErrorCategory;
    await this['updateGitPhaseBestEffort'](active.gitWorkspaceId, phase, category);
    this['deps'].onGitWorkspaceEvent?.({ taskId: active.taskId, workspaceId: active.gitWorkspaceId, phase, errorCategory: category });
  }
}

export async function persistAgentTerminalEvidence(
  this: TaskRunner,
  active: ActiveTask,
  cause: AgentTerminalCause,
  reason?: string,
): Promise<boolean> {
  // Cancellation revokes publication. Ordinary failure preserves a message that
  // may already be in transport, including its existing admission recovery gate.
  // For unsent messages, join activation and revoke before terminal truth.
  if (cause === 'cancelled' || (cause === 'failed' && !active.messageSendAttempted)) {
    await active.messageOutbox?.revoke(active.taskId);
  }
  active.terminalCause = cause;
  active.terminalReason = reason;
  await this['measureReaderMemoryChange'](active);
  if (active.agentBinding === undefined || active.agentRef === undefined || active.agentHandoff === undefined) {
    return true;
  }
  const agentRef = active.agentRef;
  const handoff = active.agentHandoff;
  const result = await this['retryAgentTerminalEvidence'](() =>
    this['deps'].agentSessionHandoffs!.recordTerminal(
      {
        agentRef,
        sessionRef: handoff.sessionRef,
        runtimeId: handoff.runtimeId,
        home: handoff.home,
        cwd: handoff.cwd,
        ...(handoff.homeAccess === undefined ? {} : { homeAccess: handoff.homeAccess }),
      },
      cause,
      reason,
    ),
  );
  if (result.ok) {
    active.agentTerminalPersisted = true;
    return true;
  }
  console.warn(
    `[byok/client] Agent terminal evidence for ${active.taskId} remained unavailable after ` +
      `${AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS} attempts; publishing the exact terminal and retrying during cleanup: ${errorMessage(result.error)}`,
  );
  return false;
}

export async function measureReaderMemoryChange(this: TaskRunner, active: ActiveTask): Promise<void> {
  if (active.readerMemoryBaseline === undefined || active.agentHomeMemoryChange !== undefined) return;
  const binding = active.agentBinding;
  if (binding === undefined) return;
  const after = await digestAgentHomeMemory(binding.resolution.canonicalHome);
  active.agentHomeMemoryChange ??= compareAgentHomeMemory(
    active.readerMemoryBaseline.digest,
    after,
    binding.lease.writerOverlapped(),
  );
}

export async function retryAgentTerminalEvidence(
  this: TaskRunner,
  write: () => Promise<unknown>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> {
  let lastError: unknown = new Error('Agent terminal evidence write did not run');
  for (let attempt = 1; attempt <= AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS; attempt++) {
    try {
      await write();
      return { ok: true };
    } catch (error) {
      lastError = error;
      if (attempt < AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, AGENT_TERMINAL_EVIDENCE_RETRY_DELAY_MS);
          timer.unref?.();
        });
      }
    }
  }
  return { ok: false, error: lastError };
}

export function reportAgentTerminalEvidenceFailure(this: TaskRunner, input: {
  taskId: string;
  agentRef: AgentRef;
  runtimeId: string;
  cwd: string;
  cause: AgentTerminalCause;
  reason?: string;
  error: unknown;
}): void {
  const error = errorMessage(input.error);
  console.error(
    `[byok/client] Agent terminal evidence permanently unavailable for ${input.taskId} after ` +
      `${AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS} attempts; terminal publication continued to avoid a stuck cloud task: ${error}`,
  );
  this['deps'].onAgentTerminalEvidenceFailure?.({
    taskId: input.taskId,
    agentRef: input.agentRef,
    runtimeId: input.runtimeId,
    cwd: input.cwd,
    cause: input.cause,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    attempts: AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS,
    error,
  });
}
