import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from './fixtures/execution-scratch';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';
import { FRESH_OFFER, freshOfferEgressDeps } from './fixtures/fresh-offer';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult, RuntimeCapabilities, RuntimeOperationStartInput } from '../types';
import type { ToolAuthorizationResolver, ToolAuthorizationTask, ToolReminder } from '../tool-authorization';

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used in this test'); },
  uploadArtifact: async () => { throw new Error('not used in this test'); },
};

/** Records the daemon-built start input, including the `auto` gate. */
class GateCapturingAdapter extends StubRuntimeAdapter {
  readonly inputs: RuntimeOperationStartInput[] = [];
  constructor(capabilities: RuntimeCapabilities) { super('pi', { kind: 'available', version: '0.0.0' }, capabilities); }
  override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const result = await super.prepare(input);
    if (result.kind !== 'prepared') return result;
    const start = result.operation.start;
    return { ...result, operation: { ...result.operation, start: (startInput) => { this.inputs.push(startInput); return start(startInput); } } };
  }
}

const AUTO_CAPABLE: RuntimeCapabilities = { steer: true, resume: true, approvalInteractive: false, mcpToolsets: true, toolAuthorizationAuto: true };
const NO_AUTO: RuntimeCapabilities = { steer: true, resume: true, approvalInteractive: false, mcpToolsets: true };

function makeRunner(adapter: StubRuntimeAdapter, sent: Envelope[], extra: Partial<Pick<TaskRunnerDeps, 'toolAuthorization' | 'onToolReminder' | 'approvalTimeoutMs'>> = {}) {
  const approvalRegistry = new ApprovalRegistry();
  const runner = new TaskRunner({
    advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter], ...testAgentHomeDeps(), deviceId: 'device-1', send: (envelope) => { sent.push(envelope); },
    blobClient: unusedBlobClient, approvalRegistry, storeDir: 'unused-store-dir', productId: 'unused-product-id', ...extra,
  });
  return { runner, approvalRegistry };
}
async function offer(runner: TaskRunner, taskId: string): Promise<void> {
  await runner.handleEnvelope(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'do work' }, { taskId, seq: 1 }));
}
const declineReason = (sent: Envelope[]) => {
  const decline = sent.find(e => e.type === 'task.decline');
  return decline?.type === 'task.decline' && decline.payload.sealed === undefined ? decline.payload.reason : undefined;
};

describe('daemon tool authorization', () => {
  it('defaults to all: no gate reaches the runtime, a high-risk tool_use only emits a reminder', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const reminders: ToolReminder[] = [];
    const { runner } = makeRunner(adapter, sent, { onToolReminder: reminder => reminders.push(reminder) });
    await offer(runner, 'task-all');
    expect(adapter.inputs[0]?.toolAuthorization).toBeUndefined();
    const session = adapter.sessions[0]!;
    session.queue.push({ type: 'tool_use', tool: 'bash', toolCallId: 'c1', input: { command: 'ls -la' } });
    session.queue.push({ type: 'tool_use', tool: 'bash', toolCallId: 'c2', input: { command: 'git push --force origin main' } });
    await vi.waitFor(() => expect(reminders).toHaveLength(1));
    expect(reminders[0]).toMatchObject({ taskId: 'task-all', toolName: 'bash', toolCallId: 'c2', reasons: ['destructive-git'] });
    expect(reminders[0]!.summary).toContain('git push --force origin main');
    expect(sent.some(e => e.type === 'task.await_approval')).toBe(false);
  });

  it('auto: the Host resolver sees local task identity; high-risk calls wait for the task approval path', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const reminders: ToolReminder[] = [];
    const seen: ToolAuthorizationTask[] = [];
    const resolver: ToolAuthorizationResolver = (task) => { seen.push(task); return 'auto'; };
    const { runner, approvalRegistry } = makeRunner(adapter, sent, { toolAuthorization: resolver, onToolReminder: r => reminders.push(r) });
    await offer(runner, 'task-auto');
    expect(seen).toEqual([expect.objectContaining({ taskId: 'task-auto', runtimeId: 'pi', agentRef: expect.any(Object) })]);
    const gate = adapter.inputs[0]!.toolAuthorization!;
    expect(gate).toBeDefined();
    const workspace = adapter.inputs[0]!.manifest.workspace.workspaceDir;

    await expect(gate.authorize({ toolCallId: 'n', toolName: 'write', input: { path: 'notes/a.md' }, cwd: workspace }))
      .resolves.toEqual({ decision: 'allow' });
    expect(sent.some(e => e.type === 'task.await_approval')).toBe(false);

    const denied = gate.authorize({ toolCallId: 'h1', toolName: 'bash', input: { command: 'sudo rm -rf /var/db' }, cwd: workspace });
    await vi.waitFor(() => expect(approvalRegistry.list()).toHaveLength(1));
    const request = sent.find(e => e.type === 'task.await_approval');
    if (request?.type !== 'task.await_approval' || request.payload.sealed !== undefined) throw new Error('missing await_approval');
    expect(request.payload.summary).toContain('privilege-escalation');
    approvalRegistry.resolve(approvalRegistry.list()[0]!.approvalId, 'reject', 'not now');
    await expect(denied).resolves.toEqual({ decision: 'deny', code: 'tool_authorization_denied', reason: 'not now' });

    const allowed = gate.authorize({ toolCallId: 'h2', toolName: 'edit', input: { file_path: '~/.zshrc' }, cwd: workspace });
    await vi.waitFor(() => expect(approvalRegistry.list()).toHaveLength(1));
    approvalRegistry.resolve(approvalRegistry.list()[0]!.approvalId, 'approve');
    await expect(allowed).resolves.toEqual({ decision: 'allow' });

    // `auto` already asked before execution; the event stream adds no reminder.
    adapter.sessions[0]!.queue.push({ type: 'tool_use', tool: 'bash', toolCallId: 'h1', input: { command: 'sudo rm -rf /var/db' } });
    adapter.sessions[0]!.queue.push({ type: 'progress', text: 'done' });
    await vi.waitFor(() => expect(sent.some(e => e.type === 'task.progress')).toBe(true), { timeout: 3_000 }).catch(() => {});
    expect(reminders).toEqual([]);
  });

  it('auto: two concurrent unanswered calls are both denied within the gate deadline, queue wait included', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = makeRunner(adapter, sent, { toolAuthorization: () => 'auto', approvalTimeoutMs: 6_000 });
    await offer(runner, 'task-queued');
    const gate = adapter.inputs[0]!.toolAuthorization!;
    const workspace = adapter.inputs[0]!.manifest.workspace.workspaceDir;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const settled: string[] = [];
      const first = gate.authorize({ toolCallId: 'h1', toolName: 'bash', input: { command: 'sudo rm -rf /var/db' }, cwd: workspace });
      const second = gate.authorize({ toolCallId: 'h2', toolName: 'bash', input: { command: 'git push --force origin main' }, cwd: workspace });
      void first.then(() => settled.push('first'));
      void second.then(() => settled.push('second'));
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(first).resolves.toMatchObject({ decision: 'deny', code: 'tool_authorization_denied' });
      // The queued call was only now dispatched, with its own 6s approval
      // window that would end at 12s: past the gate's 11s wall-clock bound.
      expect(approvalRegistry.list()).toHaveLength(1);
      const dispatchedLate = approvalRegistry.list()[0]!.approvalId;
      await vi.advanceTimersByTimeAsync(gate.timeoutMs - 6_000);
      expect(settled).toEqual(['first', 'second']);
      await expect(second).resolves.toEqual({ decision: 'deny', code: 'tool_authorization_unavailable', reason: `tool authorization timed out after ${gate.timeoutMs}ms` });
      // Withdrawn: a late decision cannot revive it, and nothing stays queued.
      expect(approvalRegistry.list()).toEqual([]);
      expect(() => approvalRegistry.resolve(dispatchedLate, 'approve')).toThrow();
      expect(sent.filter(e => e.type === 'task.await_approval')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto: the gate withdraws a queued approval it stops waiting for, before it is ever dispatched', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = makeRunner(adapter, sent, { toolAuthorization: () => 'auto', approvalTimeoutMs: 60_000 });
    await offer(runner, 'task-withdraw');
    const holder = runner.requestApproval('task-withdraw', 'hold the approval slot');
    const withdraw = new AbortController();
    const queued = runner.requestApproval('task-withdraw', 'queued', withdraw.signal);
    expect(approvalRegistry.list()).toHaveLength(1);
    withdraw.abort();
    await expect(queued).resolves.toMatchObject({ approved: false });
    approvalRegistry.resolve(approvalRegistry.list()[0]!.approvalId, 'approve');
    await expect(holder).resolves.toEqual({ approved: true, reason: undefined });
    // The withdrawn request never reached the server.
    expect(sent.filter(e => e.type === 'task.await_approval')).toHaveLength(1);
    expect(approvalRegistry.list()).toEqual([]);
  });

  it('auto on a runtime without a pre-execution gate is declined before claim, never run ungated', async () => {
    const adapter = new GateCapturingAdapter(NO_AUTO);
    const sent: Envelope[] = [];
    const { runner } = makeRunner(adapter, sent, { toolAuthorization: () => 'auto' });
    await offer(runner, 'task-unsupported');
    expect(adapter.inputs).toEqual([]);
    expect(sent.some(e => e.type === 'task.claim')).toBe(false);
    expect(declineReason(sent)).toMatch(/^tool_authorization_unsupported: runtime pi /);
  });

  it.each([
    ['a legacy mode name', () => 'full access'],
    ['a throwing resolver', () => { throw new Error('host policy store offline'); }],
  ])('declines on %s instead of picking a mode', async (_label, resolver) => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const { runner } = makeRunner(adapter, sent, { toolAuthorization: resolver as unknown as ToolAuthorizationResolver });
    await offer(runner, 'task-unresolved');
    expect(adapter.inputs).toEqual([]);
    expect(declineReason(sent)).toMatch(/^tool_authorization_unresolved: /);
  });
});
