// `TaskRunner` members for Agent message egress and the submitted result
// (see ./support.ts for how a member module runs).
import { createEnvelope, type AgentMessageContentType, type AgentMessageDispositionPayload, validateResultOutcome } from '@byok-sdk/protocol';
import type { AgentRef } from '../../agent-home';
import type { AgentResultDescribeParams, AgentResultDescribeResult, AgentResultSubmitParams, AgentResultSubmitResult } from '../control-protocol';
import { AgentMessageOutbox, type AgentMessageOutboxRecord } from '../agent-message-outbox';
import { AGENT_RESULT_TOOL_NAME, AGENT_RESULT_TOOL_DESCRIPTION } from '../../sdk-reserved-mcp';
import { AgentResultStore } from '../agent-result-store';
import { DAEMON_TASK_FAILURE } from '../task-failure';
import type { TaskRunner } from '../task-runner';
import { hostFor } from './host';
import { beginTerminal } from './finish';
import { taskMessageSendAttempted } from './support';
import { successfulCompletionPlan } from './event-pump';

export async function publishAgentMessage(this: TaskRunner, input: {
  readonly contextToken: string;
  readonly contentType: AgentMessageContentType;
  readonly body: string;
}): Promise<{ messageId: string; state: 'staged' | 'pending' }> {
  const taskId = this['messageContextByToken'].get(input.contextToken);
  if (taskId === undefined || this['messageContextByTask'].get(taskId) !== input.contextToken) {
    throw new Error('invalid or expired Agent message task context');
  }
  const pending = this['pendingMessageTasks'].get(taskId);
  const active = this['tasks'].get(taskId);
  const context = pending ?? (active?.messageRequirement && active.agentRef && active.messageOutbox
    ? { taskId, agentRef: active.agentRef, requirement: active.messageRequirement, outbox: active.messageOutbox }
    : undefined);
  if (context === undefined) throw new Error('task has no active required Agent message contract');
  const isCurrent = () => {
    if (this['messageContextByToken'].get(input.contextToken) !== taskId
      || this['messageContextByTask'].get(taskId) !== input.contextToken || this['pendingCancelled'].has(taskId)) return false;
    const current = this['tasks'].get(taskId);
    return current === undefined
      ? active === undefined && this['pendingMessageTasks'].get(taskId) === pending
      : (active === undefined || current === active) && current.messageOutbox === context.outbox && this['canPublishAgentMessage'](current);
  };
  if (!isCurrent()) throw new Error('invalid or expired Agent message task context');
  const record = await context.outbox.appendDraft({
    taskId,
    tenantId: this['deps'].tenantId!,
    agentRef: context.agentRef,
    requirement: context.requirement,
    contentType: input.contentType,
    body: input.body,
    maxPendingEvents: 64,
    maxPendingBytes: 4 * 1024 * 1024,
  });
  if (!isCurrent()) throw new Error('invalid or expired Agent message task context');
  const current = this['tasks'].get(taskId);
  if (current === undefined) return { messageId: record.messageId, state: 'staged' };
  const activated = await this['activateAgentMessage'](context.outbox, taskId, current.session.sessionRef, isCurrent,
    () => taskMessageSendAttempted(this, taskId));
  if (!isCurrent()) throw new Error('invalid or expired Agent message task context');
  if (activated === undefined) throw new Error('Agent message draft disappeared before activation');
  this['sendAgentMessageRecord'](context.outbox, activated);
  return { messageId: activated.messageId, state: 'pending' };
}

export function describeAgentResult(this: TaskRunner, input: AgentResultDescribeParams): AgentResultDescribeResult {
  const context = this['resultContextByToken'].get(input.contextToken);
  if (context === undefined || this['resultContextByTask'].get(context.taskId) !== context || this['pendingCancelled'].has(context.taskId)) {
    throw new Error('invalid or expired Agent result task context');
  }
  return {
    name: AGENT_RESULT_TOOL_NAME,
    description: AGENT_RESULT_TOOL_DESCRIPTION,
    inputSchema: context.schema as Record<string, unknown>,
  };
}

export async function submitAgentResult(this: TaskRunner, input: AgentResultSubmitParams): Promise<AgentResultSubmitResult> {
  const context = this['resultContextByToken'].get(input.contextToken);
  if (context === undefined || this['resultContextByTask'].get(context.taskId) !== context) {
    throw new Error('invalid or expired Agent result task context');
  }
  const { taskId } = context;
  const active = this['tasks'].get(taskId);
  const isCurrent = (): boolean => {
    if (this['resultContextByToken'].get(input.contextToken) !== context
      || this['resultContextByTask'].get(taskId) !== context || this['pendingCancelled'].has(taskId)) return false;
    const current = this['tasks'].get(taskId);
    return current === undefined ? active === undefined : (active === undefined || current === active) && this['canPublishAgentMessage'](current);
  };
  if (!isCurrent()) throw new Error('invalid or expired Agent result task context');
  const { store, agentRef } = context;
  const tenantId = this['deps'].tenantId;
  if (store === undefined || agentRef === undefined || tenantId === undefined) {
    throw new Error('the Agent result store is not bound for this task');
  }
  const check = validateResultOutcome(context.schema, input.outcome);
  if (!check.ok) {
    return {
      state: 'rejected',
      reason: check.reason,
      issues: check.issues.map((issue) => ({ pointer: issue.pointer, keyword: issue.keyword, message: issue.message })),
      truncated: check.truncated,
    };
  }
  const record = await store.stage({
    taskId,
    tenantId,
    agentRef,
    contract: context.contract,
    schema: context.schema,
    outcome: check.canonical,
    byteCount: check.bytes,
  });
  if (!isCurrent()) throw new Error('invalid or expired Agent result task context');
  return { state: 'staged', receiptId: record.receiptId };
}

export async function recoverAgentMessageOutboxes(this: TaskRunner, agentsRoot: string, resultFailureTasks: ReadonlyMap<string, { agentRef: AgentRef; contract: string }> = new Map(), isCancelled?: (taskId: string) => Promise<boolean>): Promise<void> {
  if (this['deps'].tenantId === undefined) throw new Error('Agent message recovery requires authenticated tenant enrollment');
  for (const outbox of await AgentMessageOutbox.recover(agentsRoot, this['deps'].tenantId)) {
    this['messageOutboxesByHome'].set(outbox.homeDir, Promise.resolve(outbox));
    for (let record of outbox.records()) {
      if (await isCancelled?.(record.taskId)) { await outbox.revoke(record.taskId); continue; }
      const binding = resultFailureTasks.get(record.taskId);
      if (binding !== undefined && (record.agentRef.agentId !== binding.agentRef.agentId
        || record.agentRef.profileRevision !== binding.agentRef.profileRevision || record.contract !== binding.contract)) {
        throw new Error('recovered required reply does not match its durable offer');
      }
      if (record.sessionRef === undefined && record.recoverySessionRef !== undefined && resultFailureTasks.has(record.taskId)) {
        record = await outbox.activate(record.taskId, record.recoverySessionRef) ?? record;
      }
      if (record.sessionRef === undefined && !resultFailureTasks.has(record.taskId)) continue;
      const existing = this['recoveredMessageOutboxes'].get(record.taskId);
      if (existing !== undefined && existing !== outbox) throw new Error(`multiple Agent message outboxes claim task ${record.taskId}`);
      this['recoveredMessageOutboxes'].set(record.taskId, outbox);
    }
  }
}

export function agentMessageOutbox(this: TaskRunner, homeDir: string): Promise<AgentMessageOutbox> {
  const existing = this['messageOutboxesByHome'].get(homeDir);
  if (existing !== undefined) return existing;
  const opened = AgentMessageOutbox.open(homeDir);
  this['messageOutboxesByHome'].set(homeDir, opened);
  void opened.catch(() => {
    if (this['messageOutboxesByHome'].get(homeDir) === opened) this['messageOutboxesByHome'].delete(homeDir);
  });
  return opened;
}

export async function cancelRecoveredAgentMessage(this: TaskRunner, taskId: string, persist: () => Promise<void>): Promise<void> {
  this['cancelledRecoveredMessages'].add(taskId);
  const timer = this['recoveredMessageRetryTimers'].get(taskId);
  if (timer !== undefined) clearTimeout(timer);
  this['recoveredMessageRetryTimers'].delete(taskId);
  await persist();
  await this['recoveredMessageOutboxes'].get(taskId)?.revoke(taskId);
  this['recoveredMessageOutboxes'].delete(taskId);
}

export async function activateAgentMessage(
  this: TaskRunner,
  outbox: AgentMessageOutbox, taskId: string, sessionRef: string, isCurrent: () => boolean,
  wasSendAttempted: () => boolean = () => false,
): Promise<AgentMessageOutboxRecord | undefined> {
  if (!isCurrent()) return undefined;
  const record = await outbox.activate(taskId, sessionRef, isCurrent);
  if (!isCurrent()) {
    if (!wasSendAttempted()) await outbox.revoke(taskId);
    return undefined;
  }
  return record;
}

export function sendAgentMessageRecord(this: TaskRunner, outbox: AgentMessageOutbox, record: AgentMessageOutboxRecord): void {
  const active = this['tasks'].get(record.taskId);
  const authorized = active === undefined
    ? !this['cancelledRecoveredMessages'].has(record.taskId) && this['recoveredMessageOutboxes'].get(record.taskId) === outbox
    : active.messageOutbox === outbox && this['canPublishAgentMessage'](active);
  if (!authorized || record.sessionRef === undefined
    || !outbox.retryableRecords().some(pending => pending.messageId === record.messageId)) return;
  if (active !== undefined) {
    active.messageDraft?.finalize(record.body);
    active.messageDraft?.stop();
    // M3: the send attempt only affects a failed terminal's outbox revoke.
    void hostFor(this).dispatch({
      type: 'message.send_attempted',
      taskId: record.taskId,
      atMs: Date.now(),
    }).catch(() => undefined);
  }
  const envelope = this['agentMessageEnvelopes'].get(record) ?? createEnvelope('agent.message.publish', outbox.publishPayload(record), {
    taskId: record.taskId,
    sessionRef: record.sessionRef,
  });
  this['agentMessageEnvelopes'].set(record, envelope);
  this['deps'].send(envelope);
  if (active?.messageOutbox === outbox) {
    if (active.messageRetryTimer !== undefined) clearTimeout(active.messageRetryTimer);
    active.messageRetryTimer = setTimeout(() => {
      active.messageRetryTimer = undefined;
      if (this['tasks'].get(record.taskId) !== active) return;
      const pending = outbox.get(record.taskId);
      if (pending !== undefined) this['sendAgentMessageRecord'](outbox, pending);
    }, 1_000);
    active.messageRetryTimer.unref?.();
    return;
  }
  if (this['recoveredMessageOutboxes'].get(record.taskId) === outbox) {
    const prior = this['recoveredMessageRetryTimers'].get(record.taskId);
    if (prior !== undefined) clearTimeout(prior);
    const timer = setTimeout(() => {
      this['recoveredMessageRetryTimers'].delete(record.taskId);
      const pending = outbox.get(record.taskId);
      if (pending !== undefined && this['recoveredMessageOutboxes'].get(record.taskId) === outbox) {
        this['sendAgentMessageRecord'](outbox, pending);
      }
    }, 1_000);
    timer.unref?.();
    this['recoveredMessageRetryTimers'].set(record.taskId, timer);
  }
}

export async function handleAgentMessageDisposition(this: TaskRunner, taskId: string, disposition: AgentMessageDispositionPayload): Promise<void> {
  const active = this['tasks'].get(taskId);
  const outbox = active?.messageOutbox ?? this['recoveredMessageOutboxes'].get(taskId);
  if (outbox === undefined) return;
  const outcome = await outbox.applyDisposition(taskId, disposition, () => this['deps'].recordAgentMessageAccepted?.(taskId) ?? Promise.resolve());
  if (active === undefined) {
    if (outcome === 'accepted' || outcome === 'held' || outcome === 'refused') {
      const timer = this['recoveredMessageRetryTimers'].get(taskId);
      if (timer !== undefined) clearTimeout(timer);
      this['recoveredMessageRetryTimers'].delete(taskId);
    }
    if (outcome === 'accepted') this['recoveredMessageOutboxes'].delete(taskId);
    return;
  }
  // Disposition persistence may race cancellation and disposal. Never create
  // a new terminal for an execution that finished while its receipt was written.
  if (this['tasks'].get(taskId) !== active) return;
  if (outcome === 'held') {
    if (active.messageRetryTimer !== undefined) clearTimeout(active.messageRetryTimer);
    active.messageRetryTimer = undefined;
    return;
  }
  const host = hostFor(this);
  const current = host.current(taskId);
  const completionToken = current?.completion?.token;
  if (outcome === 'refused') {
    if (active.messageRetryTimer !== undefined) clearTimeout(active.messageRetryTimer);
    active.messageRetryTimer = undefined;
    this['revokeAgentMessageContext'](taskId);
    host.clearMessageCompletion(taskId);
    if (current?.terminal !== undefined) {
      // M4: the terminal was selected first; a late refusal only audits.
      void host.dispatch({
        type: 'message.refused', taskId, atMs: Date.now(),
        ...(completionToken === undefined ? {} : { completionToken }),
      }).catch(() => undefined);
      return;
    }
    await this['fail'](taskId, 'required Agent message was refused', false);
    return;
  }
  if (outcome !== 'accepted') return;
  if (active.messageRetryTimer !== undefined) {
    clearTimeout(active.messageRetryTimer);
    active.messageRetryTimer = undefined;
  }
  this['revokeAgentMessageContext'](taskId);
  if (current?.terminal !== undefined) {
    // M4: cancel/terminal first; acceptance never revives the task.
    void host.dispatch({
      type: 'message.accepted', taskId, atMs: Date.now(),
      ...(completionToken === undefined ? {} : { completionToken }),
    }).catch(() => undefined);
    return;
  }
  const completion = host.clearMessageCompletion(taskId);
  if (completion?.failureReason !== undefined) {
    // An accepted message whose staged result failed still fails the task; the
    // gate never turns that into a successful completion.
    await this['fail'](taskId, completion.failureReason, false);
    return;
  }
  if (current?.completion !== undefined) {
    // M1: the open completion gate is resolved by the acceptance. Register the
    // exact completion plan first so M1's terminal effects find it.
    const receipt = beginTerminal.call(this, active, successfulCompletionPlan.call(
      this, active, completion?.finalOutput ?? '', completion?.document,
    ));
    void host.dispatch({
      type: 'message.accepted',
      taskId,
      atMs: Date.now(),
      completionToken: current.completion.token,
    }).catch((error: unknown) => host.rejectTerminal(taskId, error));
    await receipt;
    return;
  }
  // M0: accepted before turn_end only records the flag; the turn keeps running.
  void host.dispatch({
    type: 'message.accepted', taskId, atMs: Date.now(),
  }).catch(() => undefined);
}

export function agentResultStore(this: TaskRunner, homeDir: string): Promise<AgentResultStore> {
  const existing = this['resultStoresByHome'].get(homeDir);
  if (existing !== undefined) return existing;
  const opened = AgentResultStore.open(homeDir);
  this['resultStoresByHome'].set(homeDir, opened);
  void opened.catch(() => {
    if (this['resultStoresByHome'].get(homeDir) === opened) this['resultStoresByHome'].delete(homeDir);
  });
  return opened;
}
