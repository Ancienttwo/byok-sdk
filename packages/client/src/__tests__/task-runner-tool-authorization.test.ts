import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { TestServer } from './fixtures/test-server';
import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from './fixtures/execution-scratch';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { CodexProjection } from '../adapters/codex/projection';
import { createDaemonRecordProjector } from '../daemon/daemon-record';
import { DaemonObserver, type DaemonEvent } from '../daemon/observer';
import { createSessionKernel } from '../../vendor/oar/51b83c9/shared/session-kernel';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from './fixtures/execution-scratch';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { APPROVAL_REQUIRES_HOST, ApprovalRegistry, ApprovalRequiresHostError } from '../daemon/approvals';
import { connectControlClient } from '../bin/control-client';
import { ControlError } from '../daemon/control-protocol';
import type { BlobResolver } from '../daemon/blob-client';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';
import { FRESH_OFFER, freshOfferEgressDeps, resumeSession } from './fixtures/fresh-offer';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult, RuntimeCapabilities, RuntimeOperationStartInput } from '../types';
import type { ToolAuthorizationDecision, ToolAuthorizationResolver, ToolAuthorizationTask, ToolReminder } from '../tool-authorization';

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used in this test'); },
  uploadArtifact: async () => { throw new Error('not used in this test'); },
};

/** Records the daemon-built start input, including the `auto` gate. */
class GateCapturingAdapter extends StubRuntimeAdapter {
  readonly inputs: RuntimeOperationStartInput[] = [];
  constructor(capabilities: RuntimeCapabilities, runtimeId = 'pi') { super(runtimeId, { kind: 'available', version: '0.0.0' }, capabilities); }
  override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const result = await super.prepare(input);
    if (result.kind !== 'prepared') return result;
    const start = result.operation.start;
    return { ...result, operation: { ...result.operation, start: (startInput) => { this.inputs.push(startInput); return start(startInput); } } };
  }
}

const AUTO_CAPABLE: RuntimeCapabilities = { steer: true, resume: true, approvalInteractive: false, mcpToolsets: true, toolAuthorizationAuto: true };
const NO_AUTO: RuntimeCapabilities = { steer: true, resume: true, approvalInteractive: false, mcpToolsets: true };

function makeRunner(adapter: StubRuntimeAdapter, sent: Envelope[], extra: Partial<Pick<TaskRunnerDeps, 'toolAuthorization' | 'onToolReminder' | 'onToolAuthorizationDecision' | 'approvalTimeoutMs' | 'getServerCapabilities'>> = {}) {
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
  it('F6 preserves suppressed built-in risks in an auto allow audit', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const decisions: ToolAuthorizationDecision[] = [];
    const { runner } = makeRunner(adapter, sent, {
      toolAuthorization: () => ({ mode: 'auto', rules: { allowWithoutAsking: [
        { id: 'push-origin', match: { toolName: 'bash', commandGlob: 'git push origin *' } },
      ] } }),
      onToolAuthorizationDecision: decision => decisions.push(decision),
    });
    await offer(runner, 'F6-auto-allow');
    const input = adapter.inputs[0]!;
    await expect(input.toolAuthorization!.authorize({ toolCallId: 'push', toolName: 'bash',
      input: { command: 'git push origin main' }, cwd: input.manifest.workspace.workspaceDir }))
      .resolves.toMatchObject({ decision: 'allow', authorization: { source: 'rule', ruleIds: ['push-origin'] } });
    expect(decisions).toEqual([{
      taskId: 'F6-auto-allow', toolName: 'bash', toolCallId: 'push', decision: 'allow',
      authorization: { source: 'rule', ruleIds: ['push-origin'] }, reasons: [], suppressedReasons: ['destructive-git'],
    }]);
    expect(sent.some(event => event.type === 'task.await_approval')).toBe(false);
  });

  it('F6 audits a high-risk all call suppressed by allow without emitting a reminder', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const decisions: ToolAuthorizationDecision[] = [];
    const reminders: ToolReminder[] = [];
    const { runner } = makeRunner(adapter, sent, {
      toolAuthorization: () => ({ mode: 'all', rules: { allowWithoutAsking: [
        { id: 'push-origin', match: { toolName: 'bash', commandGlob: 'git push origin *' } },
      ] } }),
      onToolAuthorizationDecision: decision => decisions.push(decision),
      onToolReminder: reminder => reminders.push(reminder),
    });
    await offer(runner, 'F6-all-allow');
    expect(adapter.inputs[0]!.toolAuthorization).toBeUndefined();
    adapter.sessions[0]!.queue.push({ type: 'tool_use', tool: 'bash', toolCallId: 'allowed-push',
      input: { command: 'git push origin main' } });
    await vi.waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]).toEqual({ taskId: 'F6-all-allow', toolName: 'bash', toolCallId: 'allowed-push', decision: 'allow',
      authorization: { source: 'rule', ruleIds: ['push-origin'] }, reasons: [], suppressedReasons: ['destructive-git'] });
    expect(reminders).toEqual([]);
    expect(sent.some(event => event.type === 'task.await_approval')).toBe(false);
  });

  it.each(['duplicate-rule', 'resolver-throw'] as const)('F8 keeps %s details local and uses a fixed wire decline', async scenario => {
    const privateDetail = 'F8_PRIVATE_OWNER_RULE';
    const localErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
      const sent: Envelope[] = [];
      const { runner } = makeRunner(adapter, sent, { toolAuthorization: () => {
        if (scenario === 'resolver-throw') throw new Error(privateDetail);
        return { mode: 'auto', rules: { alwaysAsk: [
          { id: privateDetail, match: { toolName: 'read' } },
          { id: privateDetail, match: { toolName: 'write' } },
        ] } };
      } });
      await offer(runner, `F8-${scenario}`);
      expect(declineReason(sent)).toBe('tool_authorization_unresolved: local tool authorization policy could not be resolved');
      expect(JSON.stringify(sent)).not.toContain(privateDetail);
      expect(localErrors.mock.calls.flat().join(' ')).toContain(privateDetail);
      expect(sent.some(event => event.type === 'task.claim')).toBe(false);
      expect(adapter.inputs).toEqual([]);
    } finally {
      localErrors.mockRestore();
    }
  });

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

  it('all: real Codex fileChange projection reminds on every changed high-risk path', async () => {
    const adapter = new GateCapturingAdapter(NO_AUTO);
    const sent: Envelope[] = [];
    const reminders: ToolReminder[] = [];
    const { runner } = makeRunner(adapter, sent, { onToolReminder: r => reminders.push(r) });
    await offer(runner, 'codex-file-change');
    const workspace = adapter.inputs[0]!.manifest.workspace.workspaceDir;
    const kernel = createSessionKernel('root');
    const projection = new CodexProjection(workspace, 'root');
    const body = { type: 'item/started', origin: 'byok-native', events: [], native: {
      item: { type: 'fileChange', id: 'files', changes: [
        { path: path.join(workspace, 'ordinary.txt'), kind: { type: 'add' } },
        { path: path.join(workspace, '..', 'outside.txt'), kind: { type: 'delete' } },
        { path: path.join(os.homedir(), '.ssh', 'id_ed25519'), kind: { type: 'update' } },
      ] },
    } };
    const frame = kernel.frame(body, { sessionId: 'root' });
    projection.consume(kernel, frame, event => adapter.sessions[0]!.queue.push(event));
    await vi.waitFor(() => expect(reminders).toHaveLength(1));
    expect(reminders[0]).toMatchObject({ toolName: 'file_change', toolCallId: 'files',
      reasons: expect.arrayContaining(['write-outside-workspace', 'sensitive-path']) });
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
      .resolves.toEqual({ decision: 'allow', authorization: { source: 'built-in', ruleIds: [] } });
    expect(sent.some(e => e.type === 'task.await_approval')).toBe(false);

    const denied = gate.authorize({ toolCallId: 'h1', toolName: 'bash', input: { command: 'sudo rm -rf /var/db' }, cwd: workspace });
    await vi.waitFor(() => expect(approvalRegistry.list()).toHaveLength(1));
    const request = sent.find(e => e.type === 'task.await_approval');
    if (request?.type !== 'task.await_approval' || request.payload.sealed !== undefined) throw new Error('missing await_approval');
    expect(request.payload.summary).toContain('privilege-escalation');
    approvalRegistry.resolve(approvalRegistry.list()[0]!.approvalId, 'reject', 'not now', 'control');
    await expect(denied).resolves.toEqual({ decision: 'deny', code: 'tool_authorization_denied', reason: 'not now', authorization: { source: 'built-in', ruleIds: [] } });

    const allowed = gate.authorize({ toolCallId: 'h2', toolName: 'edit', input: { file_path: '~/.zshrc' }, cwd: workspace });
    await vi.waitFor(() => expect(approvalRegistry.list()).toHaveLength(1));
    const pending = approvalRegistry.list()[0]!;
    expect(pending.kind).toBe('tool-authorization');
    // #1101: the control socket cannot approve a tool authorization; it stays pending for the Host.
    expect(() => approvalRegistry.resolve(pending.approvalId, 'approve', undefined, 'control')).toThrow(ApprovalRequiresHostError);
    expect(approvalRegistry.list()).toEqual([pending]);
    await runner.resolveApprovalLocally('task-auto', pending.approvalId, 'approve');
    await expect(allowed).resolves.toEqual({ decision: 'allow', authorization: { source: 'floor', ruleIds: [] } });

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
      await expect(second).resolves.toEqual({ decision: 'deny', code: 'tool_authorization_unavailable', reason: `tool authorization timed out after ${gate.timeoutMs}ms`, authorization: { source: 'built-in', ruleIds: [] } });
      // Withdrawn: a late decision cannot revive it, and nothing stays queued.
      expect(approvalRegistry.list()).toEqual([]);
      expect(() => approvalRegistry.resolve(dispatchedLate, 'approve', undefined, 'in-process')).toThrow();
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
    approvalRegistry.resolve(approvalRegistry.list()[0]!.approvalId, 'approve', undefined, 'control');
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
    { mode: 'auto', rules: { alwaysAsk: [{ id: 'empty', match: {} }] } },
    { mode: 'auto', rules: { allowWithoutAsking: 'all' } },
    { mode: 'all', rules: { alwaysAsk: [{ id: 'same', match: { toolName: 'read' } }], allowWithoutAsking: [{ id: 'same', match: { toolName: 'write' } }] } },
    { mode: 'auto', rules: { alwaysAsk: [{ id: 'bad', match: { commandRegex: '.*' } }] } },
  ])('declines malformed rule policies before claim: %j', async policy => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const { runner } = makeRunner(adapter, sent, { toolAuthorization: (() => policy) as unknown as ToolAuthorizationResolver });
    await offer(runner, 'invalid-rules');
    expect(declineReason(sent)).toMatch(/^tool_authorization_unresolved: /);
    expect(sent.some(event => event.type === 'task.claim')).toBe(false);
    expect(adapter.inputs).toEqual([]);
  });

  it('all uses the same rule precedence: ask reminds, allow suppresses, floor still reminds', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const reminders: ToolReminder[] = [];
    const { runner } = makeRunner(adapter, sent, {
      toolAuthorization: () => ({ mode: 'all', rules: {
        alwaysAsk: [{ id: 'ask-tests', match: { commandGlob: 'npm test' } }],
        allowWithoutAsking: [{ id: 'allow-bash', match: { toolName: 'bash' } }],
      } }),
      onToolReminder: reminder => reminders.push(reminder),
    });
    await offer(runner, 'all-rule-precedence');
    expect(adapter.inputs[0]!.toolAuthorization).toBeUndefined();
    const session = adapter.sessions[0]!;
    session.queue.push({ type: 'tool_use', tool: 'bash', toolCallId: 'allowed', input: { command: 'git push origin main' } });
    session.queue.push({ type: 'tool_use', tool: 'bash', toolCallId: 'asked', input: { command: 'npm test' } });
    session.queue.push({ type: 'tool_use', tool: 'bash', toolCallId: 'floor', input: { command: 'cat ~/.ssh/id_ed25519' } });
    session.queue.push({ type: 'tool_use', tool: 'Bash', toolCallId: 'builtin', input: { command: 'sudo true' } });
    await vi.waitFor(() => expect(reminders).toHaveLength(3));
    expect(reminders.map(reminder => [reminder.toolCallId, reminder.authorization])).toEqual([
      ['asked', { source: 'rule', ruleIds: ['ask-tests'] }],
      ['floor', { source: 'floor', ruleIds: [] }],
      ['builtin', { source: 'built-in', ruleIds: [] }],
    ]);
    expect(sent.some(event => event.type === 'task.await_approval')).toBe(false);
  });

  it('all matches MCP selectors from the event identity, never by splitting the tool label', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const reminders: ToolReminder[] = [];
    const { runner } = makeRunner(adapter, sent, {
      toolAuthorization: () => ({ mode: 'all', rules: { alwaysAsk: [{ id: 'mcp-delete', match: { mcpServer: 'x__y', mcpTool: 'delete_*' } }] } }),
      onToolReminder: reminder => reminders.push(reminder),
    });
    await offer(runner, 'all-mcp-rules');
    const session = adapter.sessions[0]!;
    session.queue.push({ type: 'tool_use', tool: 'mcp__x__y__delete_item', toolCallId: 'label-only', input: {} });
    session.queue.push({ type: 'tool_use', tool: 'mcp__x__y__delete_item', toolCallId: 'identified', input: {}, mcp: { server: 'x__y', tool: 'delete_item' } });
    await vi.waitFor(() => expect(reminders).toHaveLength(1));
    expect(reminders[0]).toMatchObject({ toolCallId: 'identified', authorization: { source: 'rule', ruleIds: ['mcp-delete'] } });
  });

  it('copies the resolved policy before claim and isolates later tasks from the active snapshot', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const decisions: ToolAuthorizationDecision[] = [];
    const policy = { mode: 'auto' as const, rules: { alwaysAsk: [{ id: 'read-once', match: { toolName: 'read' } }] } };
    const { runner, approvalRegistry } = makeRunner(adapter, sent, {
      toolAuthorization: () => policy, onToolAuthorizationDecision: decision => decisions.push(decision),
    });
    await offer(runner, 'snapshot-first');
    policy.rules.alwaysAsk[0]!.id = 'changed';
    policy.rules.alwaysAsk[0]!.match.toolName = 'write';
    await offer(runner, 'snapshot-second');
    const call = { toolCallId: 'reading', toolName: 'read', input: { path: 'notes.md' }, cwd: adapter.inputs[0]!.manifest.workspace.workspaceDir };
    const first = adapter.inputs[0]!.toolAuthorization!.authorize(call);
    await vi.waitFor(() => expect(approvalRegistry.list()).toHaveLength(1));
    approvalRegistry.resolve(approvalRegistry.list()[0]!.approvalId, 'reject', 'ask rule applies');
    await expect(first).resolves.toMatchObject({ decision: 'deny', authorization: { source: 'rule', ruleIds: ['read-once'] } });
    await expect(adapter.inputs[1]!.toolAuthorization!.authorize({ ...call, toolCallId: 'new-reading', cwd: adapter.inputs[1]!.manifest.workspace.workspaceDir }))
      .resolves.toMatchObject({ decision: 'allow', authorization: { source: 'built-in', ruleIds: [] } });
    expect(decisions.map(decision => [decision.taskId, decision.decision, decision.authorization])).toEqual([
      ['snapshot-first', 'deny', { source: 'rule', ruleIds: ['read-once'] }],
      ['snapshot-second', 'allow', { source: 'built-in', ruleIds: [] }],
    ]);
    expect(JSON.stringify(decisions)).not.toContain('notes.md');
  });

  it('re-resolves rules for a resume offer of the same Agent instead of reviving a previous allow', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const seen: string[] = [];
    let askOnResume = false;
    const { runner, approvalRegistry } = makeRunner(adapter, sent, { toolAuthorization: task => {
      seen.push(task.taskId);
      return { mode: 'auto', rules: askOnResume
        ? { alwaysAsk: [{ id: 'resumed-read', match: { toolName: 'read' } }] }
        : { allowWithoutAsking: [{ id: 'first-read', match: { toolName: 'read' } }] } };
    } });
    const agentRef = freshTestAgentRef();
    await runner.handleEnvelope(createEnvelope('task.offer', { agentRef, ...FRESH_OFFER, instruction: 'first turn' }, { taskId: 'first-turn', seq: 1 }));
    const first = adapter.inputs[0]!;
    await expect(first.toolAuthorization!.authorize({ toolCallId: 'first-read', toolName: 'read', input: { path: 'notes.md' }, cwd: first.manifest.workspace.workspaceDir }))
      .resolves.toMatchObject({ decision: 'allow', authorization: { source: 'rule', ruleIds: ['first-read'] } });
    const sessionRef = adapter.sessions[0]!.sessionRef;
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some(event => event.type === 'task.complete' && event.task_id === 'first-turn')).toBe(true));
    askOnResume = true;
    await runner.handleEnvelope(createEnvelope('task.offer', { agentRef, ...resumeSession(sessionRef), instruction: 'resumed turn' }, { taskId: 'resumed-turn', seq: 2 }));
    expect(adapter.inputs).toHaveLength(2);
    expect(adapter.inputs[1]!.manifest.sessionRef).toBe(sessionRef);
    expect(seen).toEqual(['first-turn', 'resumed-turn']);
    const verdict = adapter.inputs[1]!.toolAuthorization!.authorize({ toolCallId: 'resumed-read', toolName: 'read', input: { path: 'notes.md' }, cwd: first.manifest.workspace.workspaceDir });
    await vi.waitFor(() => expect(approvalRegistry.list()).toHaveLength(1));
    approvalRegistry.resolve(approvalRegistry.list()[0]!.approvalId, 'reject', 'resume needs approval');
    await expect(verdict).resolves.toMatchObject({ decision: 'deny', authorization: { source: 'rule', ruleIds: ['resumed-read'] } });
    expect(adapter.sessions[1]!.interruptCalled).toBe(false);
  });

  it.each(['codex', 'grok', 'hermes'])('auto rules do not add missing pre-tool support to %s', async runtimeId => {
    const adapter = new GateCapturingAdapter(NO_AUTO, runtimeId);
    const sent: Envelope[] = [];
    const { runner } = makeRunner(adapter, sent, { getServerCapabilities: () => ['custom-harness'], toolAuthorization: () => ({ mode: 'auto', rules: {
      allowWithoutAsking: [{ id: 'allow-read', match: { toolName: 'read' } }],
    } }) });
    await offer(runner, `unsupported-${runtimeId}`);
    expect(declineReason(sent)).toMatch(new RegExp(`^tool_authorization_unsupported: runtime ${runtimeId} `));
    expect(sent.some(event => event.type === 'task.claim')).toBe(false);
    expect(adapter.inputs).toEqual([]);
  });

  it('publishes content-free gate audit records and redacts reminder summaries', () => {
    const observer = new DaemonObserver();
    const events: DaemonEvent[] = [];
    observer.subscribe(event => events.push(event));
    const decision: ToolAuthorizationDecision = {
      taskId: 'audit-task', toolName: 'bash', toolCallId: 'audit-call', decision: 'allow',
      authorization: { source: 'rule', ruleIds: ['push-origin'] }, reasons: [],
    };
    observer.noteToolAuthorizationDecision(decision);
    observer.noteToolReminder({ taskId: 'audit-task', toolName: 'read', toolCallId: 'read-call',
      authorization: { source: 'floor', ruleIds: [] }, reasons: ['sensitive-path'], summary: 'private summary and path' });
    expect(events[0]).toMatchObject({ kind: 'tool-authorization', ...decision });
    const projector = createDaemonRecordProjector();
    const records = events.flatMap(event => projector.project(event));
    expect(records[0]).toEqual({ kind: 'tool-authorization', ts: events[0]!.ts, taskId: decision.taskId,
      toolCallId: decision.toolCallId, decision: decision.decision, authorization: decision.authorization, reasons: decision.reasons });
    expect(records[1]).toEqual({ kind: 'tool-reminder', ts: events[1]!.ts, taskId: 'audit-task',
      authorization: { source: 'floor', ruleIds: [] }, reasons: ['sensitive-path'], summaryBytes: Buffer.byteLength('private summary and path') });
    expect(JSON.stringify(records)).not.toContain('private summary');
    expect(JSON.stringify(records)).not.toContain('description');
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


async function withPublicDaemon(
  run: (daemon: Daemon, server: TestServer, adapter: GateCapturingAdapter, storeDir: string) => Promise<void>,
  extra: { localToolApproval?: 'allow' } = {},
): Promise<void> {
  const server = await TestServer.start();
  server.setAckCapabilities(['custom-harness']);
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-tool-auth-public-'));
  const adapter = new GateCapturingAdapter({ ...AUTO_CAPABLE, approvalInteractive: true });
  const daemon = createDaemonWithAdapters({
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'tool-auth-public',
    serverUrl: server.url, storeDir, agentMemoryMcp: 'off',
    agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
    storage: { scratchRoot: testScratchRoot() }, toolAuthorization: () => 'auto', ...extra,
  }, [adapter]);
  try {
    await daemon.pair('pairing-code');
    await daemon.start();
    server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'do work' },
      { taskId: 'public-task', seq: server.nextSeq() }));
    await server.waitFor(e => e.type === 'task.started' && e.task_id === 'public-task');
    await run(daemon, server, adapter, storeDir);
  } finally {
    await daemon.stop();
    await server.close();
    await fs.rm(storeDir, { recursive: true, force: true });
  }
}

describe('public tool authorization decisions', () => {
  it.each(['local', 'wire'] as const)('auto: public %s reject denies only the tool and the turn continues', async entry => {
    await withPublicDaemon(async (daemon, server, adapter) => {
      const decisions: DaemonEvent[] = [];
      const unsubscribe = daemon.subscribe(event => { if (event.kind === 'tool-authorization') decisions.push(event); });
      const input = adapter.inputs[0]!;
      const gate = input.toolAuthorization!;
      const session = adapter.sessions[0]!;
      const call = { toolCallId: 'dangerous', toolName: 'bash', input: { command: 'sudo rm -rf /var/db' }, cwd: input.manifest.workspace.workspaceDir };
      const verdict = gate.authorize(call);
      const awaited = await server.waitFor(e => e.type === 'task.await_approval');
      if (awaited.type !== 'task.await_approval' || awaited.payload.sealed !== undefined) throw new Error('missing approval');
      const approvalId = awaited.payload.approvalId;
      if (entry === 'local') await daemon.reject('public-task', { approvalId, reason: 'choose a safer tool' });
      else server.send(createEnvelope('task.reject', { approvalId, reason: 'choose a safer tool' },
        { taskId: 'public-task', seq: server.nextSeq() }));
      await expect(verdict).resolves.toEqual({ decision: 'deny', code: 'tool_authorization_denied', reason: 'choose a safer tool', authorization: { source: 'built-in', ruleIds: [] } });
      await expect(gate.authorize({ ...call, toolCallId: 'safe', input: { command: 'ls -la' } })).resolves.toEqual({ decision: 'allow', authorization: { source: 'built-in', ruleIds: [] } });
      expect(decisions).toMatchObject([
        { kind: 'tool-authorization', taskId: 'public-task', toolCallId: 'dangerous', decision: 'deny', authorization: { source: 'built-in', ruleIds: [] } },
        { kind: 'tool-authorization', taskId: 'public-task', toolCallId: 'safe', decision: 'allow', authorization: { source: 'built-in', ruleIds: [] } },
      ]);
      unsubscribe();
      expect(session.interruptCalled).toBe(false);
      expect(session.closeCalled).toBe(false);
      session.queue.push({ type: 'progress', text: 'continuing with the safer alternative' });
      await server.waitFor(e => e.type === 'task.progress');
      expect(session.interruptCalled).toBe(false);
      expect(session.closeCalled).toBe(false);
      expect(server.received.filter(e => e.type === 'task.fail')).toEqual([]);
      expect(server.received.filter(e => e.type === 'task.approval_resolved')).toHaveLength(entry === 'local' ? 1 : 0);
    });
  });

  it.each(['local', 'wire'] as const)('public %s task-terminal approval still rejects the task', async entry => {
    await withPublicDaemon(async (daemon, server, adapter) => {
      const session = adapter.sessions[0]!;
      const outcome = session.requestApproval('task-terminal approval');
      const awaited = await server.waitFor(e => e.type === 'task.await_approval');
      if (awaited.type !== 'task.await_approval' || awaited.payload.sealed !== undefined) throw new Error('missing approval');
      const approvalId = awaited.payload.approvalId;
      if (entry === 'local') await daemon.reject('public-task', { approvalId, reason: 'stop this task' });
      else server.send(createEnvelope('task.reject', { approvalId, reason: 'stop this task' }, { taskId: 'public-task', seq: server.nextSeq() }));
      await outcome;
      await server.waitFor(e => e.type === 'task.fail');
      expect(session.interruptCalled).toBe(true);
      expect(session.approvalResults).toEqual([{ approved: false, reason: 'stop this task' }]);
    });
  });

  it.each(['tool-authorization', 'task-terminal'] as const)('queued %s keeps its kind across the preceding decision', async queuedKind => {
    await withPublicDaemon(async (daemon, server, adapter) => {
      const input = adapter.inputs[0]!;
      const session = adapter.sessions[0]!;
      const call = { toolCallId: 'first', toolName: 'bash', input: { command: 'sudo true' }, cwd: input.manifest.workspace.workspaceDir };
      const first = input.toolAuthorization!.authorize(call);
      const awaited = await server.waitFor(e => e.type === 'task.await_approval');
      if (awaited.type !== 'task.await_approval' || awaited.payload.sealed !== undefined) throw new Error('missing first approval');
      const firstId = awaited.payload.approvalId;
      const queued = queuedKind === 'tool-authorization'
        ? input.toolAuthorization!.authorize({ ...call, toolCallId: 'second' })
        : session.requestApproval('task-terminal queued');
      await daemon.reject('public-task', { approvalId: firstId, reason: 'first tool denied' });
      await expect(first).resolves.toMatchObject({ decision: 'deny' });
      expect(session.interruptCalled).toBe(false);
      const next = await server.waitFor(e => e.type === 'task.await_approval' && e.payload.approvalId !== firstId);
      if (next.type !== 'task.await_approval' || next.payload.sealed !== undefined) throw new Error('missing queued approval');
      await daemon.reject('public-task', { approvalId: next.payload.approvalId, reason: 'queued denied' });
      if (queuedKind === 'tool-authorization') {
        await expect(queued).resolves.toMatchObject({ decision: 'deny', code: 'tool_authorization_denied' });
        expect(session.interruptCalled).toBe(false);
        expect(server.received.some(e => e.type === 'task.fail')).toBe(false);
      } else {
        await queued;
        await server.waitFor(e => e.type === 'task.fail');
        expect(session.interruptCalled).toBe(true);
      }
    });
  });

  it.each(['local', 'wire'] as const)('auto: public %s approve permits the tool without stopping the task', async entry => {
    await withPublicDaemon(async (daemon, server, adapter) => {
      const input = adapter.inputs[0]!;
      const verdict = input.toolAuthorization!.authorize({ toolCallId: 'dangerous', toolName: 'bash', input: { command: 'sudo true' }, cwd: input.manifest.workspace.workspaceDir });
      const awaited = await server.waitFor(e => e.type === 'task.await_approval');
      if (awaited.type !== 'task.await_approval' || awaited.payload.sealed !== undefined) throw new Error('missing approval');
      const approvalId = awaited.payload.approvalId;
      if (entry === 'local') await daemon.approve('public-task', { approvalId });
      else server.send(createEnvelope('task.approve', { approvalId }, { taskId: 'public-task', seq: server.nextSeq() }));
      await expect(verdict).resolves.toEqual({ decision: 'allow', authorization: { source: 'built-in', ruleIds: [] } });
      expect(adapter.sessions[0]!.interruptCalled).toBe(false);
    });
  });
});

/** #1101: the control socket (`byok-agent approve`) is a same-user channel, not the Host. */
describe('control-socket decisions on tool authorization', () => {
  it("rejects a localToolApproval value other than 'allow' at construction", () => {
    expect(() => createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'tool-auth-config',
      serverUrl: 'http://127.0.0.1:1', storeDir: path.join(os.tmpdir(), 'byok-tool-auth-config-unused'), agentMemoryMcp: 'off',
      agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      storage: { scratchRoot: testScratchRoot() }, localToolApproval: 'deny' as unknown as 'allow',
    }, [new GateCapturingAdapter(AUTO_CAPABLE)])).toThrow('DaemonConfig.localToolApproval must be "allow"');
  });

  async function controlResolve(storeDir: string, params: { approvalId: string; decision: 'approve' | 'reject'; reason?: string }) {
    const conn = await connectControlClient({ storeDir, productId: 'tool-auth-public' });
    if (!conn.ok) throw new Error(conn.reason);
    try {
      return await conn.client.request('approvals.resolve', params);
    } finally {
      conn.client.close();
    }
  }
  async function controlList(storeDir: string) {
    const conn = await connectControlClient({ storeDir, productId: 'tool-auth-public' });
    if (!conn.ok) throw new Error(conn.reason);
    try {
      return (await conn.client.request<{ approvals: Array<{ approvalId: string; kind: string }> }>('approvals.list')).approvals;
    } finally {
      conn.client.close();
    }
  }
  function dangerousCall(adapter: GateCapturingAdapter) {
    const input = adapter.inputs[0]!;
    return input.toolAuthorization!.authorize({ toolCallId: 'dangerous', toolName: 'bash', input: { command: 'sudo true' }, cwd: input.manifest.workspace.workspaceDir });
  }
  async function awaitedApprovalId(server: TestServer): Promise<string> {
    const awaited = await server.waitFor(e => e.type === 'task.await_approval');
    if (awaited.type !== 'task.await_approval' || awaited.payload.sealed !== undefined) throw new Error('missing approval');
    return awaited.payload.approvalId;
  }

  it('by default refuses a control approve with approval_requires_host and keeps it pending; the Host then approves', async () => {
    await withPublicDaemon(async (daemon, server, adapter, storeDir) => {
      const verdict = dangerousCall(adapter);
      const approvalId = await awaitedApprovalId(server);
      expect(await controlList(storeDir)).toEqual([expect.objectContaining({ approvalId, kind: 'tool-authorization' })]);
      const refused = controlResolve(storeDir, { approvalId, decision: 'approve' });
      await expect(refused).rejects.toBeInstanceOf(ControlError);
      await expect(refused).rejects.toMatchObject({ code: APPROVAL_REQUIRES_HOST });
      expect(await controlList(storeDir)).toEqual([expect.objectContaining({ approvalId })]);
      expect(server.received.filter(e => e.type === 'task.approval_resolved')).toEqual([]);
      await daemon.approve('public-task', { approvalId });
      await expect(verdict).resolves.toEqual({ decision: 'allow' });
    });
  });

  it('by default still accepts a control reject, which denies only the tool', async () => {
    await withPublicDaemon(async (_daemon, server, adapter, storeDir) => {
      const verdict = dangerousCall(adapter);
      const approvalId = await awaitedApprovalId(server);
      await expect(controlResolve(storeDir, { approvalId, decision: 'reject', reason: 'not from here' })).resolves.toEqual({ resolved: true });
      await expect(verdict).resolves.toEqual({ decision: 'deny', code: 'tool_authorization_denied', reason: 'not from here' });
      await server.waitFor(e => e.type === 'task.approval_resolved');
      expect(adapter.sessions[0]!.interruptCalled).toBe(false);
    });
  });

  it("with localToolApproval: 'allow' accepts a control approve", async () => {
    await withPublicDaemon(async (_daemon, server, adapter, storeDir) => {
      const verdict = dangerousCall(adapter);
      const approvalId = await awaitedApprovalId(server);
      await expect(controlResolve(storeDir, { approvalId, decision: 'approve' })).resolves.toEqual({ resolved: true });
      await expect(verdict).resolves.toEqual({ decision: 'allow' });
      await server.waitFor(e => e.type === 'task.approval_resolved');
    }, { localToolApproval: 'allow' });
  });

  it('by default still accepts a control approve of a task-terminal approval', async () => {
    await withPublicDaemon(async (_daemon, server, adapter, storeDir) => {
      const session = adapter.sessions[0]!;
      const outcome = session.requestApproval('task-terminal approval');
      const approvalId = await awaitedApprovalId(server);
      expect(await controlList(storeDir)).toEqual([expect.objectContaining({ approvalId, kind: 'task-terminal' })]);
      await expect(controlResolve(storeDir, { approvalId, decision: 'approve' })).resolves.toEqual({ resolved: true });
      await outcome;
      expect(session.approvalResults).toEqual([{ approved: true }]);
    });
  });
});
