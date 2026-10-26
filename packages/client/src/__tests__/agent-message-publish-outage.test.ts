import { createTestDeviceStore } from './fixtures/device-credentials';
import { testScratchOwner } from './fixtures/execution-scratch';
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
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { LongPollClient } from '../daemon/long-poll-transport';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { testIngressBudget } from './fixtures/activity-ingress';
import { waitForOpen } from './fixtures/lifecycle-barrier';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * Issue #693: during a route outage every retry of an `agent.message.publish`
 * (the live task's 1 s timer, and a recovered task's retry on each reconnect)
 * added one more envelope to the connection outbox. Every copy carried the
 * same `messageId` and a new envelope id, so the outbox grew without a limit.
 * At most one copy of a message may be pending, and a retry must still reach
 * the cloud after the outage ends.
 */
const roots: string[] = [];
let server: TestServer | undefined;
let connection: ConnectionManager | undefined;
let runner: TaskRunner | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await runner?.shutdownActiveTasks('test end');
  runner = undefined;
  await connection?.stop();
  connection = undefined;
  await server?.close();
  server = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

const isPublish = (envelope: Envelope): boolean => envelope.type === 'agent.message.publish';

async function openConnection() {
  const instance = await TestServer.start();
  server = instance;
  const storeDir = await temporary('byok-publish-outage-conn-');
  const auth = new AuthManager({ serverUrl: instance.url, store: createTestDeviceStore(storeDir) });
  const record = await auth.pair('pairing-code');
  const queuedPublishes: Envelope[] = [];
  const publishesPerPost: number[] = [];
  const manager = new ConnectionManager({
    serverUrl: instance.url, deviceId: record.deviceId, productId: 'publish-outage-test',
    capabilities: [], runtimes: [], auth, cursorStore: new CursorStore(storeDir), onEnvelope: () => {},
    onOutboundQueued: (envelope) => { if (isPublish(envelope)) queuedPublishes.push(envelope); },
    beforeOutboundPost: (batch) => { publishesPerPost.push(batch.filter(isPublish).length); },
    longPollRetryDelayMs: 20, longPollIdleDelayMs: 20,
  });
  connection = manager;
  await manager.start();
  await waitForOpen(manager);
  return { server: instance, manager, queuedPublishes, publishesPerPost };
}

function runnerDeps(manager: ConnectionManager, sentPublishes: Envelope[], storeDir: string, workspaceRoot: string): TaskRunnerDeps {
  return {
    getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [], workspaceRoot, storeDir, deviceId: 'device-outage',
    productId: 'publish-outage-test', tenantId: 'tenant-outage',
    send: (envelope) => {
      if (isPublish(envelope)) sentPublishes.push(envelope);
      manager.send(envelope);
    },
    blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
    approvalRegistry: new ApprovalRegistry(),
  };
}

/** Restore the route, then prove the dedupe released: a later retry reaches the cloud again. */
async function expectDeliveryAfterOutage(f: Awaited<ReturnType<typeof openConnection>>): Promise<void> {
  f.server.setFailMessagesSends(false);
  await vi.waitFor(() => expect(f.server.received.filter(isPublish).length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
  expect(new Set(f.server.received.filter(isPublish).map((envelope) => envelope.id)).size).toBe(1);
  expect(Math.max(...f.publishesPerPost)).toBe(1);
}

describe('one pending agent.message.publish per message during a route outage (#693)', () => {
  it('keeps one queued copy for the live task retry timer and still retries after the outage', async () => {
    const f = await openConnection();
    const storeDir = await temporary('byok-publish-outage-store-');
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
      steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
    });
    const sentPublishes: Envelope[] = [];
    runner = new TaskRunner({
      ...runnerDeps(f.manager, sentPublishes, storeDir, await temporary('byok-publish-outage-workspace-')),
      adapters: [adapter],
      agentHome: new AgentHomeManager({ hostStorageRoot: await temporary('byok-publish-outage-home-') }),
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY, agentSessionHandoffs: new AgentSessionHandoffStore(),
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
      agentMessageMcpPreflight: async () => {},
    });
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'reply', runtime: 'pi', agentRef: { agentId: 'outage-agent', profileRevision: '1' },
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
    }, { taskId: 'live-outage', seq: 1 }));
    const token = adapter.startCalls[0]!.ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!;

    f.server.setFailMessagesSends(true);
    await runner.publishAgentMessage({ contextToken: token, contentType: 'text/markdown', body: 'reply during outage' });
    // The first send plus at least two 1 s retries, all during the outage.
    await vi.waitFor(() => expect(sentPublishes.length).toBeGreaterThanOrEqual(3), { timeout: 5_000 });

    expect(f.queuedPublishes).toHaveLength(1);
    await expectDeliveryAfterOutage(f);
  });

  it('keeps one queued copy for a recovered task retried on every reconnect', async () => {
    const f = await openConnection();
    const root = await temporary('byok-publish-outage-recovered-');
    const agentRef = { agentId: 'recovered-agent', profileRevision: '1' };
    const home = path.join(root, 'agents', agentRef.agentId);
    await fs.mkdir(home, { recursive: true });
    const outbox = await AgentMessageOutbox.open(home);
    await outbox.appendDraft({ taskId: 'recovered-outage', tenantId: 'tenant-outage', agentRef,
      requirement: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
      contentType: 'text/markdown', body: 'reply recovered after a crash', maxPendingEvents: 4, maxPendingBytes: 2000 });
    await outbox.activate('recovered-outage', 'session-outage');
    const sentPublishes: Envelope[] = [];
    runner = new TaskRunner(runnerDeps(f.manager, sentPublishes, root, root));
    await runner.recoverAgentMessageOutboxes(path.join(root, 'agents'));

    f.server.setFailMessagesSends(true);
    // Each call stands in for one `onStateChange('open')` during the outage.
    for (let reconnect = 0; reconnect < 5; reconnect += 1) runner.retryRecoveredAgentMessages();
    // The 1 s timer of the last call fires once more.
    await vi.waitFor(() => expect(sentPublishes.length).toBeGreaterThanOrEqual(6), { timeout: 5_000 });

    expect(f.queuedPublishes).toHaveLength(1);
    await expectDeliveryAfterOutage(f);
  });

  it('does not queue a second copy while the first is in flight, and keeps one copy when that post fails', async () => {
    const f = await openConnection();
    const body = 'in flight';
    const publish = createEnvelope('agent.message.publish', {
      agentRef: { agentId: 'in-flight-agent', profileRevision: '1' }, sessionRef: 'session-in-flight', contract: 'chat.v1',
      messageId: '10000000-0000-4000-8000-000000000693', cursor: 1, contentType: 'text/markdown', body,
      byteCount: Buffer.byteLength(body), contentHash: `sha256:${'0'.repeat(64)}`,
    }, { taskId: 'in-flight' });
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
    const nativePostBatch = LongPollClient.prototype.postBatch;
    let failedOnce = false;
    vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async function (this: LongPollClient, batch) {
      if (failedOnce || !batch.some(isPublish)) return nativePostBatch.call(this, batch);
      failedOnce = true;
      await postGate;
      return undefined; // a route failure: the drain retains the exact batch
    });

    f.manager.send(publish);
    await vi.waitFor(() => expect(f.publishesPerPost).toEqual([1]));
    // Two retries while the first copy is in flight.
    f.manager.send(publish);
    f.manager.send(publish);
    expect(f.manager.outboxLength()).toBe(1);
    releasePost();

    await vi.waitFor(() => expect(f.server.received.filter(isPublish)).toHaveLength(1), { timeout: 5_000 });
    expect(f.queuedPublishes).toHaveLength(1);
    expect(Math.max(...f.publishesPerPost)).toBe(1);
    await vi.waitFor(() => expect(f.manager.outboxLength()).toBe(0));

    // Settled copies leave the pending set: the next retry is queued and sent again.
    f.manager.send(publish);
    await vi.waitFor(() => expect(f.server.received.filter(isPublish)).toHaveLength(2), { timeout: 5_000 });
    expect(f.queuedPublishes).toHaveLength(2);
  });
});
