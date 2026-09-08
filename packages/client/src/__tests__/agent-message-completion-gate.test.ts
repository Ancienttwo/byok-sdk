import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentMessageOutbox } from '../daemon/agent-message-outbox';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import * as runtimeStart from '../daemon/runtime-start';
import { RuntimeExecutionFailure, isRuntimeStartupDisposalFailure } from '../runtime-failure';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function temporary(prefix: string): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

async function cancellationFixture() {
    const sent: Envelope[] = [];
    const storeDir = await temporary('byok-publish-cancel-store-');
    const hostStorageRoot = await temporary('byok-publish-cancel-home-');
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
      steer: false, resume: true, approvalInteractive: false, mcpToolsets: true, permissionModes: ['auto'],
    });
    const deps: TaskRunnerDeps = {
      adapters: [adapter], workspaceRoot: await temporary('byok-publish-cancel-workspace-'),
      agentHome: new AgentHomeManager({ hostStorageRoot }), agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-cancel',
      send: envelope => sent.push(envelope),
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir), approvalRegistry: new ApprovalRegistry(),
      storeDir, productId: 'cancel-test', tenantId: 'tenant-cancel',
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
      agentMessageMcpPreflight: async () => {},
    };
    return { runner: new TaskRunner(deps), adapter, sent, deps };
}

describe('required Agent message completion gate', () => {
  it.each(['append-before', 'activate-before', 'activate-after'] as const)('fences a tool publish across cancellation: %s', async (phase) => {
    const { runner, adapter, sent, deps } = await cancellationFixture();
    const taskId = 'cancel-publish-task';
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'reply', policy: { mode: 'auto' }, runtime: 'pi',
      agentRef: { agentId: 'cancel-agent', profileRevision: '1' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
    }, { taskId, seq: 1 }));
    const ctx = adapter.startCalls[0]!.ctx;
    const token = ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const originalAppend = AgentMessageOutbox.prototype.appendDraft;
    const originalActivate = AgentMessageOutbox.prototype.activate;
    const spy = phase === 'append-before'
      ? vi.spyOn(AgentMessageOutbox.prototype, 'appendDraft').mockImplementation(async function (this: AgentMessageOutbox, ...args) {
          entered(); await gate; return originalAppend.apply(this, args);
        })
      : vi.spyOn(AgentMessageOutbox.prototype, 'activate').mockImplementation(async function (this: AgentMessageOutbox, ...args) {
          if (phase === 'activate-before') { entered(); await gate; }
          const result = await originalActivate.apply(this, args);
          if (phase === 'activate-after') { entered(); await gate; }
          return result;
        });
    try {
      const publish = runner.publishAgentMessage({ contextToken: token, contentType: 'text/markdown', body: 'old reply' });
      const outcome = publish.then(value => ({ value }), error => ({ error }));
      await reached;
      await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'cancel wins' }, { taskId, seq: 2 }));
      expect(sent.filter(e => e.type === 'task.cancelled')).toHaveLength(1);
      release();
      expect(await outcome).toMatchObject({ error: expect.any(Error) });
      expect(sent.filter(e => e.type === 'agent.message.publish')).toHaveLength(0);
      const reopened = await AgentMessageOutbox.open(ctx.workspaceDir);
      expect(reopened.retryableRecords().filter(record => record.sessionRef !== undefined)).toHaveLength(0);
      const recovery = new TaskRunner(deps);
      await recovery.recoverAgentMessageOutboxes(path.dirname(ctx.workspaceDir));
      recovery.retryRecoveredAgentMessages();
      expect(sent.filter(e => e.type === 'agent.message.publish')).toHaveLength(0);
      expect(runner.activeTaskCount).toBe(0);
    } finally { release(); spy.mockRestore(); await runner.shutdownActiveTasks('test cleanup'); }
  });

  it('pre-active cancellation retires more than 64 staged drafts and disposes late Sessions', async () => {
    const { runner, adapter, sent } = await cancellationFixture();
    let workspaceDir = '';
    for (let index = 0; index < 65; index++) {
      const releaseStart = adapter.blockStart();
      const taskId = `pre-active-${index}`;
      const offer = runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
        instruction: 'reply', policy: { mode: 'auto' }, runtime: 'pi',
        agentRef: { agentId: 'pre-active-agent', profileRevision: '1' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
      }, { taskId, seq: index * 2 + 1 }));
      try {
        await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(index + 1));
        const ctx = adapter.startCalls[index]!.ctx;
        workspaceDir = ctx.workspaceDir;
        expect(await runner.publishAgentMessage({
          contextToken: ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!,
          contentType: 'text/markdown', body: 'staged before Session',
        })).toMatchObject({ state: 'staged' });
        await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'pre-active cancel' }, { taskId, seq: index * 2 + 2 }));
        await offer;
        expect(sent.filter(e => e.type === 'task.cancelled')).toHaveLength(index + 1);
        await expect(runner.publishAgentMessage({
          contextToken: ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!,
          contentType: 'text/markdown', body: 'staged before Session',
        })).rejects.toThrow('invalid or expired');
        const reopened = await AgentMessageOutbox.open(workspaceDir);
        expect(reopened.retryableRecords()).toHaveLength(0);
      } finally {
        releaseStart();
        await vi.waitFor(() => expect(adapter.sessions).toHaveLength(index + 1));
        await runner.shutdownActiveTasks('late Session cleanup');
        await offer;
      }
      expect(adapter.sessions[index]!.closeCalled).toBe(true);
      expect(runner.activeTaskCount).toBe(0);
    }
    expect(sent.filter(e => e.type === 'agent.message.publish' || e.type === 'task.started')).toHaveLength(0);
    const reopened = await AgentMessageOutbox.open(workspaceDir);
    await expect(reopened.appendDraft({ taskId: 'next-legitimate', tenantId: 'tenant-cancel',
      agentRef: { agentId: 'pre-active-agent', profileRevision: '1' },
      requirement: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
      contentType: 'text/markdown', body: 'next', maxPendingEvents: 64, maxPendingBytes: 4 * 1024 * 1024,
    })).resolves.toBeDefined();
    const archive = await reopened.archiveTerminalRecords(await temporary('byok-pre-active-archive-'));
    expect(archive).toBeDefined();
    const archived = (await fs.readFile(archive!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(archived.filter(entry => entry.kind === 'revoke')).toHaveLength(65);
    expect(archived.filter(entry => entry.kind === 'append' && entry.record.body === 'staged before Session')).toHaveLength(65);
    expect((await AgentMessageOutbox.open(workspaceDir)).retryableRecords()).toHaveLength(1);
  }, 30_000);

  it.each(['late-session', 'quiescent-start-failure'] as const)('pre-active %s retains ownership when revoke fails and retries settlement once', async (mode) => {
    const { runner, adapter, sent } = await cancellationFixture();
    const releaseStart = adapter.blockStart();
    const startOwnedRuntime = runtimeStart.startOwnedRuntime;
    // Exercise the other catch branch with an explicit quiescent startup
    // failure receipt, after the real aborted start's late Session is closed.
    const startSpy = vi.spyOn(runtimeStart, 'startOwnedRuntime').mockImplementation(async (...args) => {
      try { return await startOwnedRuntime(...args); } catch (error) {
        if (mode === 'late-session' || !isRuntimeStartupDisposalFailure(error)) throw error;
        releaseStart();
        await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
        await error.retryDisposal();
        throw new RuntimeExecutionFailure({ phase: 'start', category: 'infrastructure', retry: 'non-retryable', reason: 'cancelled startup is quiescent' });
      }
    });
    const taskId = `revoke-failure-${mode}`;
    const offer = runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'reply', policy: { mode: 'auto' }, runtime: 'pi',
      agentRef: { agentId: 'revoke-failure-agent', profileRevision: '1' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
    }, { taskId, seq: 1 }));
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    const ctx = adapter.startCalls[0]!.ctx;
    const token = ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!;
    await runner.publishAgentMessage({ contextToken: token, contentType: 'text/markdown', body: 'retain exact draft' });
    let releaseRevoke!: () => void;
    const barrier = new Promise<void>(resolve => { releaseRevoke = resolve; });
    const revoke = AgentMessageOutbox.prototype.revoke;
    const revokeSpy = vi.spyOn(AgentMessageOutbox.prototype, 'revoke').mockImplementationOnce(async () => {
      await barrier;
      throw new Error('injected revoke write failure');
    });
    try {
      await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'cancel' }, { taskId, seq: 2 }));
      await vi.waitFor(() => expect(revokeSpy).toHaveBeenCalled());
      expect(sent.filter(e => e.type === 'task.cancelled')).toHaveLength(0);
      expect(runner.activeTaskCount).toBe(1);
      releaseRevoke();
      await offer;
      expect(sent.filter(e => e.type === 'task.cancelled')).toHaveLength(0);
      expect(runner.activeTaskCount).toBe(1);
      expect((await AgentMessageOutbox.open(ctx.workspaceDir)).records()).toHaveLength(1);
      await expect(runner.publishAgentMessage({ contextToken: token, contentType: 'text/markdown', body: 'stale' })).rejects.toThrow();
      releaseStart();
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
      revokeSpy.mockImplementation(revoke);
      await runner.shutdownActiveTasks('retry durable settlement');
      await runner.shutdownActiveTasks('idempotent cleanup');
      expect(runner.activeTaskCount).toBe(0);
      expect(adapter.sessions[0]!.closeCalled).toBe(true);
      expect(sent.filter(e => e.type === 'task.cancelled')).toHaveLength(1);
      expect(sent.filter(e => e.type === 'agent.message.publish')).toHaveLength(0);
      expect((await AgentMessageOutbox.open(ctx.workspaceDir)).retryableRecords()).toHaveLength(0);
    } finally {
      releaseRevoke(); releaseStart(); revokeSpy.mockRestore(); startSpy.mockRestore();
      await offer; await runner.shutdownActiveTasks('cleanup'); runner.stopAcceptingOffers();
    }
  });

  it('startup cancellation durably revokes a staged message activated while start was in flight', async () => {
    const { runner, adapter, sent, deps } = await cancellationFixture();
    const releaseStart = adapter.blockStart();
    const taskId = 'startup-cancel-message';
    const offer = runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'reply', policy: { mode: 'auto' }, runtime: 'pi',
      agentRef: { agentId: 'startup-agent', profileRevision: '1' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
    }, { taskId, seq: 1 }));
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    const ctx = adapter.startCalls[0]!.ctx;
    const token = ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!;
    expect(await runner.publishAgentMessage({ contextToken: token, contentType: 'text/markdown', body: 'staged reply' })).toMatchObject({ state: 'staged' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const activate = AgentMessageOutbox.prototype.activate;
    const spy = vi.spyOn(AgentMessageOutbox.prototype, 'activate').mockImplementation(async function (this: AgentMessageOutbox, ...args) {
      const record = await activate.apply(this, args);
      entered(); await gate; return record;
    });
    try {
      releaseStart();
      await reached;
      await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'startup cancelled' }, { taskId, seq: 2 }));
      release();
      await offer;
      expect(sent.filter(e => e.type === 'task.cancelled')).toHaveLength(1);
      expect(sent.filter(e => e.type === 'task.started' || e.type === 'agent.message.publish')).toHaveLength(0);
      const recovery = new TaskRunner(deps);
      await recovery.recoverAgentMessageOutboxes(path.dirname(ctx.workspaceDir));
      recovery.retryRecoveredAgentMessages();
      expect(sent.filter(e => e.type === 'agent.message.publish')).toHaveLength(0);
      expect(runner.activeTaskCount).toBe(0);
    } finally { release(); releaseStart(); spy.mockRestore(); await offer; await runner.shutdownActiveTasks('cleanup'); }
  });

  it('cancellation cannot emit terminal truth until an in-flight activation and its local revoke are durable', async () => {
    const { runner, adapter, sent } = await cancellationFixture();
    const taskId = 'activation-sync-cancel';
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'reply', policy: { mode: 'auto' }, runtime: 'pi',
      agentRef: { agentId: 'sync-agent', profileRevision: '1' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
    }, { taskId, seq: 1 }));
    const ctx = adapter.startCalls[0]!.ctx;
    const token = ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!;
    const file = path.join(ctx.workspaceDir, '.byok', 'messages', 'outbox-v1.jsonl');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const realOpen = fs.open.bind(fs);
    let logOpens = 0;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === file && ++logOpens === 2) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => { entered(); await gate; await sync(); });
      }
      return handle;
    });
    try {
      const publishing = runner.publishAgentMessage({ contextToken: token, contentType: 'text/markdown', body: 'in flight' });
      const outcome = publishing.then(value => ({ value }), error => ({ error }));
      await reached;
      const cancelling = runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'cancel during sync' }, { taskId, seq: 2 }));
      await vi.waitFor(() => expect(adapter.sessions[0]!.interruptCalled).toBe(true));
      expect(sent.filter(e => e.type === 'task.cancelled')).toHaveLength(0);
      release();
      await cancelling;
      expect(await outcome).toMatchObject({ error: expect.any(Error) });
      const reopened = await AgentMessageOutbox.open(ctx.workspaceDir);
      expect(reopened.retryableRecords()).toHaveLength(0);
      expect(sent.filter(e => e.type === 'agent.message.publish')).toHaveLength(0);
      expect(sent.filter(e => e.type === 'task.cancelled')).toHaveLength(1);
    } finally { release(); spy.mockRestore(); await runner.shutdownActiveTasks('cleanup'); }
  });

  it('ordinary failure preserves admission recovery for a message already handed to transport', async () => {
    const { runner, adapter } = await cancellationFixture();
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'reply', policy: { mode: 'auto' }, runtime: 'pi',
      agentRef: { agentId: 'failure-agent', profileRevision: '1' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
    }, { taskId: 'failure-after-send', seq: 1 }));
    const ctx = adapter.startCalls[0]!.ctx;
    const token = ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!;
    await runner.publishAgentMessage({ contextToken: token, contentType: 'text/markdown', body: 'admission still pending' });
    await runner.shutdownActiveTasks('ordinary daemon shutdown');
    const reopened = await AgentMessageOutbox.open(ctx.workspaceDir);
    expect(reopened.retryableRecords()).toHaveLength(1);
    expect(reopened.retryableRecords()[0]!.sessionRef).toBeDefined();
  });

  it.each(['accepted', 'held', 'refused'] as const)('releases only the exact durable %s recovered disposition and never replays it on reconnect', async (outcome) => {
    const root = await temporary('byok-recovery-disposition-');
    const agentRef = { agentId: 'agent-one', profileRevision: '7' };
    const home = path.join(root, 'agents', agentRef.agentId);
    await fs.mkdir(home, { recursive: true });
    const outbox = await AgentMessageOutbox.open(home);
    await outbox.appendDraft({ taskId: 'pending', tenantId: 'tenant-one', agentRef,
      requirement: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
      contentType: 'text/markdown', body: 'exact reply', maxPendingEvents: 4, maxPendingBytes: 2000 });
    const record = await outbox.activate('pending', 'session-one');
    const payload = outbox.publishPayload(record!);
    const sent: Envelope[] = [];
    const createRunner = () => new TaskRunner({
      adapters: [], workspaceRoot: root, storeDir: root, productId: 'recovery-test', deviceId: 'device-one', tenantId: 'tenant-one',
      send: (envelope) => sent.push(envelope),
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      sessionWorkspaces: new SessionWorkspaceStore(root), approvalRegistry: new ApprovalRegistry(),
    });
    const runner = createRunner();
    await runner.recoverAgentMessageOutboxes(path.join(root, 'agents'));
    expect(runner.hasPendingRecoveredAgentMessage('pending')).toBe(true);
    expect(runner.hasPendingRecoveredAgentMessage('unrelated')).toBe(false);
    const disposition = { agentRef, sessionRef: payload.sessionRef, contract: payload.contract,
      messageId: payload.messageId, cursor: payload.cursor, contentHash: payload.contentHash,
      outcome, receiptId: '10000000-0000-4000-8000-000000000001' };
    await runner.handleEnvelope(createEnvelope('agent.message.disposition', { ...disposition, sessionRef: 'wrong-session' }, { taskId: 'pending', seq: 1 }));
    expect(runner.hasPendingRecoveredAgentMessage('pending')).toBe(true);
    runner.retryRecoveredAgentMessages();
    expect(sent).toHaveLength(1);
    await runner.handleEnvelope(createEnvelope('agent.message.disposition', disposition, { taskId: 'pending', seq: 2 }));
    expect(runner.hasPendingRecoveredAgentMessage('pending')).toBe(false);
    runner.retryRecoveredAgentMessages();
    expect(sent).toHaveLength(1);
    const restarted = createRunner();
    await restarted.recoverAgentMessageOutboxes(path.join(root, 'agents'));
    expect(restarted.hasPendingRecoveredAgentMessage('pending')).toBe(false);
    restarted.retryRecoveredAgentMessages();
    expect(sent).toHaveLength(1);
  });

  it.each(['before-turn-end', 'after-turn-end', 'cancel-during-disposition', 'cancel-during-close'] as const)(
    'settles refused required messages exactly once: %s', async (timing) => {
      const sent: Envelope[] = [];
      const storeDir = await temporary('byok-refusal-store-');
      const hostStorageRoot = await temporary('byok-refusal-home-');
      const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
        steer: false, resume: true, approvalInteractive: false, mcpToolsets: true, permissionModes: ['auto'],
      });
      const runner = new TaskRunner({
        adapters: [adapter], workspaceRoot: await temporary('byok-refusal-workspace-'),
        agentHome: new AgentHomeManager({ hostStorageRoot }), agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-refusal',
        send: (envelope) => sent.push(envelope),
        blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
        sessionWorkspaces: new SessionWorkspaceStore(storeDir), approvalRegistry: new ApprovalRegistry(),
        storeDir, productId: 'refusal-test', tenantId: 'tenant-refusal',
        agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
        agentMessageMcpPreflight: async () => {},
      });
      const taskId = 'refused-task';
      const agentRef = { agentId: 'refused-agent', profileRevision: '1' };
      await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
        instruction: 'reply', policy: { mode: 'auto' }, runtime: 'pi', agentRef,
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
      }, { taskId, seq: 1 }));
      const session = adapter.sessions[0]!;
      const close = vi.spyOn(session, 'close');
      const ctx = adapter.startCalls[0]!.ctx;
      const token = ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!;
      await runner.publishAgentMessage({ contextToken: token, contentType: 'text/markdown', body: 'immutable reply' });
      const message = sent.find((e) => e.type === 'agent.message.publish');
      if (message?.type !== 'agent.message.publish') throw new Error('missing message');
      const { sessionRef, contract, messageId, cursor, contentHash } = message.payload;
      const disposition = createEnvelope('agent.message.disposition', {
        agentRef, sessionRef, contract, messageId, cursor, contentHash,
        outcome: 'refused', receiptId: '10000000-0000-4000-8000-000000000009', reasonCode: 'stale_product_context',
      }, { taskId, seq: 2 });
      if (timing === 'after-turn-end') {
        session.emit({ type: 'turn_end' });
        // The parked completion resends the existing immutable record.
        await vi.waitFor(() => expect(sent.filter((e) => e.type === 'agent.message.publish').length).toBeGreaterThan(1));
      }
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
      const original = AgentMessageOutbox.prototype.applyDisposition;
      const apply = vi.spyOn(AgentMessageOutbox.prototype, 'applyDisposition').mockImplementation(async function (this: AgentMessageOutbox, ...args) {
        const result = await original.apply(this, args);
        if (timing === 'cancel-during-disposition') { entered(); await gate; }
        return result;
      });
      const releaseClose = timing === 'cancel-during-close' ? session.blockClose() : undefined;
      try {
        const refusal = runner.handleEnvelope(disposition);
        if (timing === 'cancel-during-disposition') {
          await enteredGate;
          await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'cancel wins' }, { taskId, seq: 3 }));
          release();
        }
        if (timing === 'cancel-during-close') {
          await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
          const cancellation = runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'late cancel' }, { taskId, seq: 3 }));
          session.emit({ type: 'turn_end' });
          releaseClose!();
          await cancellation;
        }
        await refusal;
        session.emit({ type: 'turn_end' });
        await runner.handleEnvelope(disposition);
        expect(runner.activeTaskCount).toBe(0);
        expect(close).toHaveBeenCalledOnce();
        const terminals = sent.filter((e) => e.type === 'task.fail' || e.type === 'task.complete' || e.type === 'task.cancelled');
        expect(terminals).toHaveLength(1);
        expect(terminals[0]).toMatchObject(timing === 'cancel-during-disposition'
          ? { type: 'task.cancelled', payload: { reason: 'cancel wins', agentRef } }
          : { type: 'task.fail', payload: { reason: 'required Agent message was refused', retryable: false, agentRef } });
        await expect(runner.publishAgentMessage({ contextToken: token, contentType: 'text/markdown', body: 'again' })).rejects.toThrow(/invalid or expired/);
        const reopened = await AgentMessageOutbox.open(ctx.workspaceDir);
        expect(reopened.get(taskId)?.body).toBe('immutable reply');
        expect(reopened.retryableRecords()).toHaveLength(0);
      } finally {
        release(); releaseClose?.(); apply.mockRestore();
        await runner.shutdownActiveTasks('test cleanup');
      }
    },
  );

  it('declines before adapter preparation when the exact helper handshake fails', async () => {
    const sent: Envelope[] = [];
    const storeDir = await temporary('byok-message-preflight-store-');
    const hostStorageRoot = await temporary('byok-message-preflight-home-');
    const adapter = new StubRuntimeAdapter('codex', { kind: 'available' }, {
      steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
      permissionModes: ['auto'],
    });
    const runner = new TaskRunner({
      adapters: [adapter], workspaceRoot: await temporary('byok-message-preflight-workspace-'),
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-message',
      send: (envelope) => sent.push(envelope),
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir), approvalRegistry: new ApprovalRegistry(),
      storeDir, productId: 'message-test', tenantId: 'tenant-message-test',
      agentMessageMcpBin: { command: '/compiled/salesko-agent', args: ['__byok_sdk_helper', 'agent-message-mcp'] },
      agentMessageMcpPreflight: async () => { throw new Error('unknown command'); },
    });
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'send one reply', policy: { mode: 'auto' }, runtime: 'codex',
      agentRef: { agentId: 'agent-message', profileRevision: 'profile-r1' },
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
    }, { taskId: 'message-preflight-failure', seq: 1 }));

    expect(adapter.startCalls).toHaveLength(0);
    expect(sent.find((envelope) => envelope.type === 'task.decline')).toMatchObject({
      payload: { retryable: false, reason: expect.stringContaining('helper preflight failed: unknown command') },
    });
  });

  it('injects only the bounded body tool, retains held drafts, and completes only after exact accepted disposition', async () => {
    const sent: Envelope[] = [];
    const storeDir = await temporary('byok-message-store-');
    const hostStorageRoot = await temporary('byok-message-home-');
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
      steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
      permissionModes: ['auto'],
    });
    const researchExtractor = vi.fn(() => {
      throw new Error('message-only output is not a research document');
    });
    const helperPreflight = vi.fn<NonNullable<TaskRunnerDeps['agentMessageMcpPreflight']>>(async () => {});
    const runner = new TaskRunner({
      adapters: [adapter], workspaceRoot: await temporary('byok-message-workspace-'),
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-message',
      send: (envelope) => sent.push(envelope),
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir), approvalRegistry: new ApprovalRegistry(),
      storeDir, productId: 'message-test', tenantId: 'tenant-message-test',
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
      agentMessageMcpPreflight: helperPreflight,
      resultDocument: { extract: researchExtractor },
    });
    const taskId = 'message-task';
    const agentRef = { agentId: 'agent-message', profileRevision: 'profile-r1' } as const;
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'send one reply', policy: { mode: 'auto' }, runtime: 'pi', agentRef,
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
    }, { taskId, seq: 1 }));

    const messageMcp = adapter.startCalls[0]?.ctx.mcpServers?.byokagentmessage;
    expect(helperPreflight).toHaveBeenCalledOnce();
    // The helper is proved under the conditions it will actually run in: the
    // exact server config, the same allowlisted child environment the runtime
    // gets (never `process.env` — `BYOK_*` is hard-denied there), and the
    // Agent home as cwd.
    const [preflightServer, preflightEnv, preflightCwd] = helperPreflight.mock.calls[0]!;
    expect(preflightServer).toEqual(messageMcp);
    expect(preflightEnv).toEqual(adapter.startCalls[0]?.ctx.env);
    expect(Object.keys(preflightEnv!)).not.toContain('BYOK_STORE_DIR');
    expect(preflightCwd).toBe(adapter.startCalls[0]?.ctx.workspaceDir);
    expect(messageMcp).toMatchObject({
      command: process.execPath,
      args: ['/sdk/byok-agent-message-mcp.js'],
      env: { BYOK_STORE_DIR: storeDir, BYOK_PRODUCT_ID: 'message-test' },
    });
    expect(messageMcp?.env).not.toHaveProperty('BYOK_TASK_ID');
    const contextToken = messageMcp?.env?.BYOK_AGENT_MESSAGE_CONTEXT;
    expect(contextToken).toMatch(/^[0-9a-f-]+\.[0-9a-f-]+$/);
    await expect(runner.publishAgentMessage({ contextToken: '0'.repeat(64), contentType: 'text/markdown', body: 'wrong task' }))
      .rejects.toThrow(/invalid or expired/);
    const published = await runner.publishAgentMessage({ contextToken: contextToken!, contentType: 'text/markdown', body: '**hello**' });
    expect(published.state).toBe('pending');
    await expect(runner.publishAgentMessage({ contextToken: contextToken!, contentType: 'text/markdown', body: 'second body' }))
      .rejects.toThrow(/different immutable draft/);
    const message = sent.find((envelope) => envelope.type === 'agent.message.publish');
    expect(message?.type).toBe('agent.message.publish');
    if (message?.type !== 'agent.message.publish') throw new Error('missing message publish');
    expect(message.payload).not.toHaveProperty('tenantId');
    expect(message.payload).not.toHaveProperty('deviceId');
    expect(message.payload).not.toHaveProperty('target');

    adapter.sessions[0]!.emit({ type: 'progress', text: 'runtime activity stays separate' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(false));
    const exact = {
      agentRef, sessionRef: message.payload.sessionRef, contract: message.payload.contract,
      messageId: message.payload.messageId, cursor: message.payload.cursor, contentHash: message.payload.contentHash,
    };
    await runner.handleEnvelope(createEnvelope('agent.message.disposition', {
      ...exact, outcome: 'held', receiptId: '10000000-0000-4000-8000-000000000001', reasonCode: 'freshness_pending',
    }, { taskId, seq: 2 }));
    expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(false);
    const publishesAtHold = sent.filter((envelope) => envelope.type === 'agent.message.publish').length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(sent.filter((envelope) => envelope.type === 'agent.message.publish')).toHaveLength(publishesAtHold);
    await runner.handleEnvelope(createEnvelope('agent.message.disposition', {
      ...exact, outcome: 'accepted', receiptId: '10000000-0000-4000-8000-000000000002',
    }, { taskId, seq: 3 }));
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(true));
    expect(researchExtractor).not.toHaveBeenCalled();
    await expect(runner.publishAgentMessage({ contextToken: contextToken!, contentType: 'text/markdown', body: '**hello**' }))
      .rejects.toThrow(/invalid or expired/);

    const refusedTaskId = 'message-task-refused';
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'send one refused reply', policy: { mode: 'auto' }, runtime: 'pi', agentRef,
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
    }, { taskId: refusedTaskId, seq: 4 }));
    const refusedToken = adapter.startCalls[1]?.ctx.mcpServers?.byokagentmessage?.env?.BYOK_AGENT_MESSAGE_CONTEXT;
    const refusedDraft = await runner.publishAgentMessage({ contextToken: refusedToken!, contentType: 'text/markdown', body: 'refuse me' });
    const refusedMessage = sent.find((envelope) => envelope.type === 'agent.message.publish' && envelope.payload.messageId === refusedDraft.messageId);
    if (refusedMessage?.type !== 'agent.message.publish') throw new Error('missing refused message publish');
    const beforeRefusal = sent.filter((envelope) => envelope.type === 'agent.message.publish' && envelope.task_id === refusedTaskId).length;
    await runner.handleEnvelope(createEnvelope('agent.message.disposition', {
      agentRef, sessionRef: refusedMessage.payload.sessionRef, contract: refusedMessage.payload.contract,
      messageId: refusedMessage.payload.messageId, cursor: refusedMessage.payload.cursor, contentHash: refusedMessage.payload.contentHash,
      outcome: 'refused', receiptId: '10000000-0000-4000-8000-000000000003', reasonCode: 'stale_product_context',
    }, { taskId: refusedTaskId, seq: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(sent.filter((envelope) => envelope.type === 'agent.message.publish' && envelope.task_id === refusedTaskId)).toHaveLength(beforeRefusal);
    await expect(runner.publishAgentMessage({ contextToken: refusedToken!, contentType: 'text/markdown', body: 'refuse me' }))
      .rejects.toThrow(/invalid or expired/);
    expect(sent.some((envelope) => envelope.type === 'task.complete' && envelope.task_id === refusedTaskId)).toBe(false);

    const restartSent: Envelope[] = [];
    const restarted = new TaskRunner({
      adapters: [adapter], workspaceRoot: await temporary('byok-message-restart-workspace-'),
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-message',
      send: (envelope) => restartSent.push(envelope),
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      sessionWorkspaces: new SessionWorkspaceStore(await temporary('byok-message-restart-store-')),
      approvalRegistry: new ApprovalRegistry(), storeDir: await temporary('byok-message-restart-control-'),
      productId: 'message-test', tenantId: 'tenant-message-test',
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
    });
    await restarted.recoverAgentMessageOutboxes(path.join(hostStorageRoot, 'agents'));
    restarted.retryRecoveredAgentMessages();
    expect(restartSent.filter((envelope) => envelope.type === 'agent.message.publish')).toHaveLength(0);
  });
  it('delivers the runtime final output on the message lane when the model never called the tool', async () => {
    const sent: Envelope[] = [];
    const storeDir = await temporary('byok-message-auto-store-');
    const hostStorageRoot = await temporary('byok-message-auto-home-');
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
      steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
      permissionModes: ['auto'],
    });
    const runner = new TaskRunner({
      adapters: [adapter], workspaceRoot: await temporary('byok-message-auto-workspace-'),
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-message',
      send: (envelope) => sent.push(envelope),
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir), approvalRegistry: new ApprovalRegistry(),
      storeDir, productId: 'message-test', tenantId: 'tenant-message-test',
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
    });
    const taskId = 'message-task-auto';
    const agentRef = { agentId: 'agent-message', profileRevision: 'profile-r1' } as const;
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'send one reply', policy: { mode: 'auto' }, runtime: 'pi', agentRef,
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
    }, { taskId, seq: 1 }));

    adapter.sessions[0]!.emit({ type: 'progress', text: 'Hello from the runtime' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'agent.message.publish')).toBe(true));
    const message = sent.find((envelope) => envelope.type === 'agent.message.publish');
    if (message?.type !== 'agent.message.publish') throw new Error('missing message publish');
    expect(message.payload.body).toBe('Hello from the runtime');
    expect(message.payload.contract).toBe('example.chat.v1');
    expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(false);

    await runner.handleEnvelope(createEnvelope('agent.message.disposition', {
      agentRef, sessionRef: message.payload.sessionRef, contract: message.payload.contract,
      messageId: message.payload.messageId, cursor: message.payload.cursor, contentHash: message.payload.contentHash,
      outcome: 'accepted', receiptId: '20000000-0000-4000-8000-000000000001',
    }, { taskId, seq: 2 }));
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(true));
  });

  it('fails closed when the runtime produced no final output for the required message', async () => {
    const sent: Envelope[] = [];
    const storeDir = await temporary('byok-message-empty-store-');
    const hostStorageRoot = await temporary('byok-message-empty-home-');
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
      steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
      permissionModes: ['auto'],
    });
    const runner = new TaskRunner({
      adapters: [adapter], workspaceRoot: await temporary('byok-message-empty-workspace-'),
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-message',
      send: (envelope) => sent.push(envelope),
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir), approvalRegistry: new ApprovalRegistry(),
      storeDir, productId: 'message-test', tenantId: 'tenant-message-test',
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
    });
    const taskId = 'message-task-empty';
    const agentRef = { agentId: 'agent-message', profileRevision: 'profile-r1' } as const;
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'send one reply', policy: { mode: 'auto' }, runtime: 'pi', agentRef,
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
    }, { taskId, seq: 1 }));

    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.fail')).toBe(true));
    const failure = sent.find((envelope) => envelope.type === 'task.fail');
    if (failure?.type !== 'task.fail') throw new Error('missing task fail');
    expect(failure.payload.retryable).toBe(false);
    expect(failure.payload.reason).toContain('no reply text');
    expect(sent.some((envelope) => envelope.type === 'agent.message.publish')).toBe(false);
  });

  it('fails closed when the daemon-authored draft exceeds the offer byte cap', async () => {
    const sent: Envelope[] = [];
    const storeDir = await temporary('byok-message-cap-store-');
    const hostStorageRoot = await temporary('byok-message-cap-home-');
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
      steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
      permissionModes: ['auto'],
    });
    const runner = new TaskRunner({
      adapters: [adapter], workspaceRoot: await temporary('byok-message-cap-workspace-'),
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-message',
      send: (envelope) => sent.push(envelope),
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir), approvalRegistry: new ApprovalRegistry(),
      storeDir, productId: 'message-test', tenantId: 'tenant-message-test',
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
    });
    const taskId = 'message-task-cap';
    const agentRef = { agentId: 'agent-message', profileRevision: 'profile-r1' } as const;
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'send one reply', policy: { mode: 'auto' }, runtime: 'pi', agentRef,
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 8 },
    }, { taskId, seq: 1 }));

    adapter.sessions[0]!.emit({ type: 'progress', text: 'this final reply is far longer than eight bytes' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.fail')).toBe(true));
    const failure = sent.find((envelope) => envelope.type === 'task.fail');
    if (failure?.type !== 'task.fail') throw new Error('missing task fail');
    expect(failure.payload.retryable).toBe(false);
    expect(failure.payload.reason).toMatch(/failed to deliver/);
    expect(sent.some((envelope) => envelope.type === 'agent.message.publish')).toBe(false);
  });
  /**
   * Shared setup for the daemon-authored final-text-run cases below: a
   * `messageEgress.mode:'required'` task whose model never calls the message
   * tool, so the DAEMON authors the body from the runtime's own text.
   */
  async function startRequiredMessageTask(prefix: string, taskId: string): Promise<{
    sent: Envelope[];
    adapter: StubRuntimeAdapter;
    runner: TaskRunner;
    agentRef: { agentId: string; profileRevision: string };
  }> {
    const sent: Envelope[] = [];
    const storeDir = await temporary(`byok-${prefix}-store-`);
    const hostStorageRoot = await temporary(`byok-${prefix}-home-`);
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
      steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
      permissionModes: ['auto'],
    });
    const runner = new TaskRunner({
      adapters: [adapter], workspaceRoot: await temporary(`byok-${prefix}-workspace-`),
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-message',
      send: (envelope) => sent.push(envelope),
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir), approvalRegistry: new ApprovalRegistry(),
      storeDir, productId: 'message-test', tenantId: 'tenant-message-test',
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
    });
    const agentRef = { agentId: 'agent-message', profileRevision: 'profile-r1' } as const;
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'send one reply', policy: { mode: 'auto' }, runtime: 'pi', agentRef,
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
    }, { taskId, seq: 1 }));
    return { sent, adapter, runner, agentRef };
  }

  it('publishes only the final text run, dropping narration emitted before the last tool interaction', async () => {
    const taskId = 'message-task-final-run';
    const { sent, adapter, runner, agentRef } = await startRequiredMessageTask('message-final-run', taskId);

    adapter.sessions[0]!.emit({ type: 'progress', text: 'narration' });
    adapter.sessions[0]!.emit({ type: 'tool_result', tool: 'Read', output: 'file contents' });
    adapter.sessions[0]!.emit({ type: 'progress', text: 'the answer' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'agent.message.publish')).toBe(true));
    const message = sent.find((envelope) => envelope.type === 'agent.message.publish');
    if (message?.type !== 'agent.message.publish') throw new Error('missing message publish');
    expect(message.payload.body).toBe('the answer');

    // `task.complete.summary` is unchanged: still the WHOLE run's text.
    await runner.handleEnvelope(createEnvelope('agent.message.disposition', {
      agentRef, sessionRef: message.payload.sessionRef, contract: message.payload.contract,
      messageId: message.payload.messageId, cursor: message.payload.cursor, contentHash: message.payload.contentHash,
      outcome: 'accepted', receiptId: '30000000-0000-4000-8000-000000000001',
    }, { taskId, seq: 2 }));
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(true));
    const complete = sent.find((envelope) => envelope.type === 'task.complete');
    if (complete?.type !== 'task.complete') throw new Error('missing task complete');
    expect(complete.payload.summary).toBe('narrationthe answer');
  });

  it('falls back to the whole run when the last event is a tool interaction with no closing text', async () => {
    const taskId = 'message-task-no-closing-text';
    const { sent, adapter } = await startRequiredMessageTask('message-no-closing', taskId);

    adapter.sessions[0]!.emit({ type: 'progress', text: 'first half. ' });
    adapter.sessions[0]!.emit({ type: 'progress', text: 'second half.' });
    adapter.sessions[0]!.emit({ type: 'tool_use', tool: 'Write', input: { path: 'out.txt' } });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'agent.message.publish')).toBe(true));
    const message = sent.find((envelope) => envelope.type === 'agent.message.publish');
    if (message?.type !== 'agent.message.publish') throw new Error('missing message publish');
    expect(message.payload.body).toBe('first half. second half.');
  });

  it('keeps terminal usage out of the reset set so a text-only run still publishes its whole reply', async () => {
    const taskId = 'message-task-usage-before-turn-end';
    const { sent, adapter } = await startRequiredMessageTask('message-usage', taskId);

    adapter.sessions[0]!.emit({ type: 'progress', text: 'only text, ' });
    adapter.sessions[0]!.emit({ type: 'progress', text: 'no tools' });
    // Bundled adapters emit terminal usage immediately before turn_end.
    adapter.sessions[0]!.emit({ type: 'usage', outputTokens: 12 });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'agent.message.publish')).toBe(true));
    const message = sent.find((envelope) => envelope.type === 'agent.message.publish');
    if (message?.type !== 'agent.message.publish') throw new Error('missing message publish');
    expect(message.payload.body).toBe('only text, no tools');
  });
});
