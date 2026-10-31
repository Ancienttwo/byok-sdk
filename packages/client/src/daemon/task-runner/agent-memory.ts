// `TaskRunner` members for the Agent memory context and filesystem
// (see ./support.ts for how a member module runs).
import { isAgentMemorySecureFilesystemAvailable, snapshotAndProjectAgentMemory, type AgentMemoryTaskContext } from '../agent-memory';
import { openAgentMemoryFilesystemHelper } from '../agent-memory-fs-helper';
import type { ActiveTask } from './support';
import { errorMessage, taskFinalizing } from './support';
import type { TaskRunner } from '../task-runner';
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

export async function runMemoryOperation<T>(this: TaskRunner, contextToken: string, required: 'read'|'write', operation: (context: AgentMemoryTaskContext) => Promise<T>): Promise<T> {
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
    await snapshotAndProjectAgentMemory(context, this['deps'].agentMemoryHostedProjection);
  } catch (error) {
    // Projection never becomes a second task-terminal authority. A failed
    // snapshot/upload is observable locally and preserves the raw home plus
    // any already-appended redacted outbox record for later replay.
    console.error(`[byok/client] Agent memory quiescent snapshot failed for ${active.taskId}: ${errorMessage(error)}`);
  } finally {
    await this['closeAgentMemoryFilesystem'](active.taskId);
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
