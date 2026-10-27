import type { DaemonEventListener, Unsubscribe, DaemonTaskInfo } from '../observer';
import type { McpToolsetConfig, McpToolsetReloadReceipt, McpToolsetObservation } from '../../types';
import type { DaemonScope } from './scope';

/** The daemon's local operations: approvals, observation and MCP toolset reloads (#926). */

/** Local approve/reject — see {@link Daemon.approve}/{@link Daemon.reject}. */
export async function approve(daemonScope: DaemonScope, taskId: string, opts: { approvalId: string }): Promise<void> {
  const { daemonState } = daemonScope;
  if (!daemonState.runner) throw new Error('daemon is not started; call start() first');
  await daemonState.runner.resolveApprovalLocally(taskId, opts.approvalId, 'approve');
}

export async function reject(daemonScope: DaemonScope, taskId: string, opts: { approvalId: string; reason?: string }): Promise<void> {
  const { daemonState } = daemonScope;
  if (!daemonState.runner) throw new Error('daemon is not started; call start() first');
  await daemonState.runner.resolveApprovalLocally(taskId, opts.approvalId, 'reject', opts.reason);
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
