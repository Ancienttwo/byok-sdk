// `TaskRunner` members for the Agent memory context and filesystem
// (see ./support.ts for how a member module runs).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RESIDENT_MEMORY_MAX_BYTES } from '@byok-sdk/protocol/constants';
import { appendAgentMemoryHomeAudit, compareAndSwapAgentMemoryHomeFile, isAgentMemorySecureFilesystemAvailable, observeAgentMemoryHomeFile, snapshotAndProjectAgentMemory, type AgentMemoryTaskContext } from '../agent-memory.js';
import type { AgentMemoryCommitHome } from '../agent-memory-commit.js';
import { openAgentMemoryFilesystemHelper } from '../agent-memory-fs-helper.js';
import type { ActiveTask } from './support.js';
import { outboundErrorMessage } from '../outbound-error.js';
import { errorMessage, taskFinalizing } from './support.js';
import type { TaskRunner } from '../task-runner.js';
import { AgentMemoryError } from '@byok-sdk/protocol/agent-memory';

export function activeMemoryContext(this: TaskRunner, contextToken: string): AgentMemoryTaskContext {
  const registered = this['memoryContextByToken'].get(contextToken);
  if (registered === undefined || this['memoryContextByTask'].get(registered.taskId) !== contextToken || this['memoryClosingTasks'].has(registered.taskId)) {
    throw new Error('invalid, expired, or quiescing Agent memory task context');
  }
  const active = this['tasks'].get(registered.taskId);
  if (
    active === undefined ||
    taskFinalizing(this, active.taskId) ||
    this['deps'].tenantId === undefined ||
    active.agentRef.agentId !== registered.agentRef.agentId ||
    active.agentRef.profileRevision !== registered.agentRef.profileRevision ||
    active.agentBinding.resolution.agentRef.agentId !== registered.agentRef.agentId ||
    active.agentBinding.resolution.agentRef.profileRevision !== registered.agentRef.profileRevision ||
    active.agentHandoff.sessionRef !== active.session.sessionRef ||
    active.agentHandoff.runtimeId !== active.adapter.descriptor.id ||
    active.agentHandoff.cwd !== active.agentBinding.lease.cwd ||
    active.agentBinding.lease.canonicalHome !== active.agentBinding.resolution.canonicalHome
  ) {
    throw new Error('Agent memory context no longer matches its exact active task identity');
  }
  return Object.freeze({
    taskId: registered.taskId,
    tenantId: this['deps'].tenantId,
    deviceId: this['deps'].deviceId,
    agentRef: Object.freeze({ ...active.agentRef }),
    sessionRef: active.session.sessionRef,
    runtimeId: active.adapter.descriptor.id,
    canonicalHome: active.agentBinding.resolution.canonicalHome,
    leaseId: active.agentBinding.lease.leaseId,
    homeIdentity: active.agentBinding.lease.homeIdentity,
  });
}

/**
 * A runtime may call memory before its `start()` returns (#1861): the context
 * token is registered before the start, the task enters `tasks` only at
 * activation. A call for a valid token whose offer is still in flight waits
 * for that offer's own outcome, activation or the end of the offer, and then
 * meets the unchanged identity check. No timer: the offer's startup deadline
 * already bounds the window.
 */
async function awaitMemoryTaskStart(this: TaskRunner, contextToken: string): Promise<void> {
  const registered = this['memoryContextByToken'].get(contextToken);
  if (registered === undefined || this['memoryContextByTask'].get(registered.taskId) !== contextToken) return;
  const { taskId } = registered;
  if (this['tasks'].has(taskId) || !this['inFlightOffers'].has(taskId)) return;
  let wait = this['memoryStartWaits'].get(taskId);
  if (wait === undefined) {
    let settle!: () => void;
    const started = new Promise<void>((resolve) => { settle = resolve; });
    wait = { started, settle };
    this['memoryStartWaits'].set(taskId, wait);
  }
  await wait.started;
}

/** Ends the start window of `taskId`: called where it enters `tasks` and where its offer leaves `inFlightOffers`. */
export function endMemoryStartWait(this: TaskRunner, taskId: string): void {
  const wait = this['memoryStartWaits'].get(taskId);
  if (wait === undefined) return;
  this['memoryStartWaits'].delete(taskId);
  wait.settle();
}

export async function runMemoryOperation<T>(this: TaskRunner, contextToken: string, required: 'read'|'write', operation: (context: AgentMemoryTaskContext) => Promise<T>): Promise<T> {
  await awaitMemoryTaskStart.call(this, contextToken);
  let context = this['activeMemoryContext'](contextToken);
  if (required === 'write' && this['memoryContextByToken'].get(contextToken)?.mode !== 'read-write') throw new AgentMemoryError('agent_memory_operation_denied: write denied by sealed capability');
  context = await this['bindAgentMemoryFilesystem'](context);
  // The helper handshake is asynchronous. Reconstruct the authority again so
  // a task that began closing during it cannot retain a stale context.
  const current = this['activeMemoryContext'](contextToken);
  if (current.taskId !== context.taskId || current.leaseId !== context.leaseId) throw new Error('Agent memory context changed during secure filesystem handshake');
  context = Object.freeze({ ...current, ...(context.filesystem === undefined ? {} : { filesystem: context.filesystem }) });
  const pending = this['memoryInFlightByTask'].get(context.taskId) ?? new Set<Promise<unknown>>();
  this['memoryInFlightByTask'].set(context.taskId, pending);
  const result = operation(context);
  pending.add(result);
  try {
    return await result;
  } finally {
    pending.delete(result);
    if (pending.size === 0) this['memoryInFlightByTask'].delete(context.taskId);
  }
}

export async function quiesceAndSnapshotAgentMemory(this: TaskRunner, active: ActiveTask): Promise<void> {
  if (!isAgentMemorySecureFilesystemAvailable(this['deps'].resolveAgentMemoryFilesystemHelperBin !== undefined)) return;
  if (this['deps'].tenantId === undefined) {
    console.error(`[byok/client] Agent memory quiescent snapshot skipped for ${active.taskId}: exact tenant context is unavailable`);
    return;
  }
  this['memoryClosingTasks'].add(active.taskId);
  try {
    await Promise.allSettled([...this['memoryInFlightByTask'].get(active.taskId) ?? []]);
    // A failure skips the projection, so a failed task's writes never reach the
    // Host. The lease still goes, and the next one settles the copy.
    const settled = active.agentMemoryCommit !== true
      || await settleAgentMemoryCommitCopy.call(this, active.taskId, active.agentBinding.lease);
    const context = await this['bindAgentMemoryFilesystem']({
      taskId: active.taskId,
      tenantId: this['deps'].tenantId,
      deviceId: this['deps'].deviceId,
      agentRef: active.agentRef,
      sessionRef: active.agentHandoff.sessionRef,
      runtimeId: active.agentHandoff.runtimeId,
      canonicalHome: active.agentBinding.resolution.canonicalHome,
      leaseId: active.agentBinding.lease.leaseId,
      homeIdentity: active.agentBinding.lease.homeIdentity,
    });
    await restoreResidentMemory(context, active.residentMemoryStart);
    if (settled) await snapshotAndProjectAgentMemory(context, this['deps'].agentMemoryHostedProjection, this['deps'].sealedTasks);
  } catch (error) {
    // Projection never becomes a second task-terminal authority. A failed
    // snapshot/upload is observable locally and preserves the raw home plus
    // any already-appended redacted outbox record for later replay.
    console.error(`[byok/client] Agent memory quiescent snapshot failed for ${active.taskId}: ${errorMessage(error)}`);
  } finally {
    await this['closeAgentMemoryFilesystem'](active.taskId);
  }
}

/**
 * The one memory write the SDK makes itself (#1439): a writer Attempt that left
 * `MEMORY.md` over the limit gets that file back as it started. The runtime has
 * stopped and in-flight memory operations have drained, so the projection after
 * this sees the restored file; the terminal already reported the written size.
 * `notes/` stay as they are. A failed compare-and-swap leaves the file for the
 * next fresh task to refuse, and is audited, not retried.
 */
async function restoreResidentMemory(context: AgentMemoryTaskContext, start: ActiveTask['residentMemoryStart']): Promise<void> {
  if (start === undefined) return;
  const stat = await fs.lstat(path.join(context.canonicalHome, 'MEMORY.md')).catch(() => undefined);
  if (stat?.isFile() !== true || stat.size <= RESIDENT_MEMORY_MAX_BYTES) return;
  const record = (values: Record<string, unknown>): Promise<void> => appendAgentMemoryHomeAudit(context, {
    kind: 'resident_memory_restore', taskId: context.taskId, agentRef: context.agentRef, path: 'MEMORY.md', byteCount: stat.size, ...values,
  }).catch((error: unknown) => {
    console.error(`[byok/client] Agent memory restore audit failed for ${context.taskId}: ${errorMessage(error)}`);
  });
  try {
    const current = await observeAgentMemoryHomeFile(context, 'MEMORY.md');
    await compareAndSwapAgentMemoryHomeFile(context, {
      path: 'MEMORY.md', operation: 'replace', expectedRevision: current.revision, content: start.content,
    });
  } catch (error) {
    console.error(`[byok/client] Agent memory restore failed for ${context.taskId}: ${errorMessage(error)}`);
    await record({ outcome: 'failed' });
    return;
  }
  await record({ outcome: 'restored', revision: start.revision });
}

/**
 * Settles before a lease release, which must still happen: it never throws. It
 * answers whether the copy is gone; one that remains waits for the next lease.
 */
export async function settleAgentMemoryCommitCopy(this: TaskRunner, taskId: string, home: AgentMemoryCommitHome): Promise<boolean> {
  try {
    await this['deps'].agentMemoryCommit!.settle(home);
    return true;
  } catch (error) {
    console.error(`[byok/client] Agent memory commit copy of ${taskId} was not settled: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * The reason to fail a task that would otherwise complete, when it leaves a home
 * the next start of a commit Attempt would refuse (#1474). `task.fail` then rolls
 * its writes back. A check that cannot finish leaves the terminal as it was, for
 * that next start to decide.
 */
export async function agentMemoryCommitRefusalReason(this: TaskRunner, active: ActiveTask): Promise<string | undefined> {
  if (active.agentMemoryCommit !== true) return undefined;
  try {
    const refusal = await this['deps'].agentMemoryCommit!.refusal(active.agentBinding.lease, active.taskId);
    return refusal === undefined ? undefined : `agent_memory_commit_refused: ${outboundErrorMessage(refusal)}; the memory changes of this task are rolled back`;
  } catch (error) {
    console.error(`[byok/client] Agent memory commit check of ${active.taskId} did not finish: ${errorMessage(error)}`);
    return undefined;
  }
}

export async function bindAgentMemoryFilesystem(this: TaskRunner, context: AgentMemoryTaskContext): Promise<AgentMemoryTaskContext> {
  const helperBin = this['deps'].resolveAgentMemoryFilesystemHelperBin?.();
  if (helperBin === undefined) return context;
  let filesystem = this['memoryFilesystemByTask'].get(context.taskId);
  if (filesystem === undefined) {
    filesystem = openAgentMemoryFilesystemHelper({
      helperBin,
      assetRoot: this['deps'].agentMemoryHelperAssetRoot,
      ancestorRoot: this['tasks'].get(context.taskId)!.agentBinding.resolution.hostStorageRoot,
      canonicalHome: context.canonicalHome,
      homeIdentity: context.homeIdentity,
    });
    this['memoryFilesystemByTask'].set(context.taskId, filesystem);
    void filesystem.catch(() => {
      if (this['memoryFilesystemByTask'].get(context.taskId) === filesystem) this['memoryFilesystemByTask'].delete(context.taskId);
    });
  }
  return Object.freeze({ ...context, filesystem: await filesystem });
}
