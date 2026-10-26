import { createEnvelope } from '@byok-sdk/protocol';
import type { DaemonEventListener, Unsubscribe, DaemonTaskInfo } from '../observer';
import type { McpToolsetConfig, McpToolsetReloadReceipt, McpToolsetObservation } from '../../types';
import type { DaemonScope } from './scope';

/** The daemon's local operations: approvals, observation and MCP toolset reloads (#926). */

/**
 * M3-2a: local approve/reject — see the `Daemon` interface's own doc
 * comments on {@link Daemon.approve}/{@link Daemon.reject} for the full
 * rationale (honest-but-currently-unexercised; every bundled adapter's
 * `resolveApproval` throws unconditionally today). Constructs the exact
 * envelope shape a server-sent `task.approve`/`task.reject` would be and
 * feeds it straight to `runner.handleEnvelope` — `TaskRunner`'s only public
 * entry point — rather than reaching into its private `handleApprove`/
 * `handleReject`. `seq: 0` is an inert local sentinel: this call never
 * passes through `ConnectionManager`, so nothing ever reads it as a real
 * redelivery cursor value, and `TaskRunner` itself only ever reads
 * `task_id`/`payload` off an approve/reject envelope, never `seq`.
 */
export async function approve(daemonScope: DaemonScope, taskId: string, opts: { approvalId: string }): Promise<void> {
  const { daemonState } = daemonScope;
  if (!daemonState.runner) throw new Error('daemon is not started; call start() first');
  await daemonState.runner.handleEnvelope(createEnvelope('task.approve', { approvalId: opts.approvalId }, { taskId, seq: 0 }));
}

export async function reject(daemonScope: DaemonScope, taskId: string, opts: { approvalId: string; reason?: string }): Promise<void> {
  const { daemonState } = daemonScope;
  if (!daemonState.runner) throw new Error('daemon is not started; call start() first');
  await daemonState.runner.handleEnvelope(createEnvelope('task.reject', { approvalId: opts.approvalId, reason: opts.reason }, { taskId, seq: 0 }));
}

export function subscribe(daemonScope: DaemonScope, listener: DaemonEventListener): Unsubscribe {
  const { observer } = daemonScope;
  return observer.subscribe(listener);
}

export function tasks(daemonScope: DaemonScope): DaemonTaskInfo[] {
  const { observer } = daemonScope;
  return observer.tasks();
}

export function reloadMcpToolsets(
  daemonScope: DaemonScope,
  mcpToolsets: Record<string, McpToolsetConfig> | undefined,
  expectedRevision: string,
): McpToolsetReloadReceipt {
  const { toolsetRegistry, daemonState } = daemonScope;
  const receipt = toolsetRegistry.reload(mcpToolsets, expectedRevision);
  if (daemonState.daemonStarted) daemonState.connection?.refreshHello();
  return receipt;
}

export function reportMcpToolsetObservation(
  daemonScope: DaemonScope,
  toolsetId: string,
  expectedDefinitionRevision: string,
  observation: McpToolsetObservation,
): void {
  const { toolsetRegistry } = daemonScope;
  toolsetRegistry.report(toolsetId, expectedDefinitionRevision, observation);
}
