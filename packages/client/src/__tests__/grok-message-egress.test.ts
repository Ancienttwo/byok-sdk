import { testScratchOwner } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { TaskRunner } from '../daemon/task-runner';
import { testIngressBudget } from './fixtures/activity-ingress';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function temporary(prefix: string): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

it('publishes the closing Grok reply on the message lane when Grok never called the message tool', async () => {
  const log = path.join(await temporary('byok-grok-egress-log-'), 'agent.log');
  vi.stubEnv('FAKE_ACP_LOG', log);
  const sent: Envelope[] = [];
  const storeDir = await temporary('byok-grok-egress-store-');
  const runner = new TaskRunner({ getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [new GrokAdapter({ resolveBin: () => ({ command: fixture, source: 'path' }) })],
    getServerCapabilities: () => ['custom-harness'],
    agentHome: new AgentHomeManager({ hostStorageRoot: await temporary('byok-grok-egress-home-') }),
    agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-grok-egress',
    send: (envelope) => sent.push(envelope),
    blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
    approvalRegistry: new ApprovalRegistry(),
    storeDir, productId: 'grok-egress-test', tenantId: 'tenant-grok-egress',
    agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
  });
  const taskId = 'grok-egress-task';
  const agentRef = { agentId: 'agent-grok', profileRevision: 'profile-r1' } as const;
  await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
    instruction: 'tool', harnessId: 'grok', agentRef,
    egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
  }, { taskId, seq: 1 }));

  await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'agent.message.publish')).toBe(true), { timeout: 8000 });
  const message = sent.find((envelope) => envelope.type === 'agent.message.publish');
  if (message?.type !== 'agent.message.publish') throw new Error('missing message publish');
  // The text before the tool call is narration; the closing reply is the run after it.
  expect(message.payload.body).toBe('Found a.txt.');
  expect(message.payload.contract).toBe('example.chat.v1');
  // The SDK message toolset was attached to the Grok session.
  const opened = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(fact => fact.kind === 'open');
  expect(opened.params.mcpServers.map((server: { name: string }) => server.name)).toContain('byokagentmessage');

  await runner.handleEnvelope(createEnvelope('agent.message.disposition', {
    agentRef, sessionRef: message.payload.sessionRef, contract: message.payload.contract,
    messageId: message.payload.messageId, cursor: message.payload.cursor, contentHash: message.payload.contentHash,
    outcome: 'accepted', receiptId: '20000000-0000-4000-8000-000000000001',
  }, { taskId, seq: 2 }));
  await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(true));
  const complete = sent.find((envelope) => envelope.type === 'task.complete');
  if (complete?.type !== 'task.complete') throw new Error('missing task.complete');
  expect(complete.payload.finalMessage).toBe('Found a.txt.');
});
