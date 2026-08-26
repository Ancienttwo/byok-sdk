import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function temporary(prefix: string): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

describe('required Agent message completion gate', () => {
  it('injects only the bounded body tool, retains held drafts, and completes only after exact accepted disposition', async () => {
    const sent: Envelope[] = [];
    const storeDir = await temporary('byok-message-store-');
    const hostStorageRoot = await temporary('byok-message-home-');
    const adapter = new StubRuntimeAdapter('pi', { present: true }, {
      steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
      permissionModes: ['auto'],
    });
    const researchExtractor = vi.fn(() => {
      throw new Error('message-only output is not a research document');
    });
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
});
