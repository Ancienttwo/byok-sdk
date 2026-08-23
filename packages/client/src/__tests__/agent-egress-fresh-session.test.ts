import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const roots: string[] = [];
let server: TestServer | undefined;
let daemon: Daemon | undefined;

const agentRef = { agentId: 'fresh-egress-agent', profileRevision: 'profile-fresh-r1' } as const;
const freshTaskId = 'fresh-egress-task';

async function tmpDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await server?.close();
  server = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function reliableEnvelopes(): Envelope[] {
  return server?.received.filter((envelope) => envelope.type === 'agent.egress.reliable') ?? [];
}

describe('fresh Agent egress session authority', () => {
  it('starts fresh without a resume argument, fsyncs the runtime session handoff, and accepts only exact reliable append/ack', async () => {
    server = await TestServer.start();
    server.setAckCapabilities(['agent-egress-reliable-ack']);
    const workspaceRoot = await tmpDir('byok-fresh-egress-workspace-');
    const storeDir = await tmpDir('byok-fresh-egress-store-');
    const hostStorageRoot = await tmpDir('byok-fresh-egress-home-');
    const adapter = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-fresh-egress-test' },
        productName: 'Fresh egress test',
        productId: 'fresh-egress-test',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        agentHome: { hostStorageRoot },
        agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      },
      [adapter],
    );
    await daemon.pair('fresh-egress-pair-code');
    await daemon.start();

    await vi.waitFor(() => {
      const hello = server?.received.find((envelope) => envelope.type === 'conn.hello');
      expect(hello?.type).toBe('conn.hello');
      if (hello?.type === 'conn.hello') {
        expect(hello.payload.capabilities).toContain('agent-egress-fresh-session');
      }
    });

    server.send(createEnvelope(
      'task.offer_for_agent_with_egress_fresh',
      {
        instruction: 'mint a native session only after start',
        policy: { mode: 'auto' },
        runtime: 'pi',
        agentRef,
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      },
      { taskId: freshTaskId, seq: server.nextSeq() },
    ));

    await server.waitFor((envelope) => envelope.type === 'task.started' && envelope.task_id === freshTaskId);
    expect(adapter.sessions).toHaveLength(1);
    expect(adapter.startCalls[0]?.task.sessionRef).toBeUndefined();
    const sessionRef = adapter.sessions[0]!.sessionRef;
    const home = path.join(await fs.realpath(hostStorageRoot), 'agents', agentRef.agentId);
    await expect(new AgentSessionHandoffStore().requireMatch({
      agentRef,
      sessionRef,
      runtimeId: 'pi',
      cwd: home,
    })).resolves.toMatchObject({ taskId: freshTaskId, sessionRef, runtimeId: 'pi', cwd: home });

    // Redelivery cannot create a second fresh session for the same task.
    server.send(createEnvelope(
      'task.offer_for_agent_with_egress_fresh',
      {
        instruction: 'mint a native session only after start',
        policy: { mode: 'auto' },
        runtime: 'pi',
        agentRef,
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      },
      { taskId: freshTaskId, seq: server.nextSeq() },
    ));
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((envelope) => envelope.type === 'task.complete' && envelope.task_id === freshTaskId);
    await vi.waitFor(() => expect(daemon?.status().activeTaskCount).toBe(0));

    const publish = daemon.publishReliableAgentEgress;
    if (publish === undefined) throw new Error('expected configured reliable egress publisher');
    const appended = await publish({
      agentRef,
      sessionRef,
      runtimeId: 'pi',
      taskId: freshTaskId,
      eventId: '9bfab15e-bd5c-4d31-aa8d-cc0195dfc59e',
      payload: { status: 'persisted-after-exact-handoff' },
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) throw new Error(`unexpected reliable egress refusal: ${appended.reason}`);
    const reliable = await server.waitFor((envelope) =>
      envelope.type === 'agent.egress.reliable' && envelope.payload.eventId === appended.record.eventId,
    );
    if (reliable.type !== 'agent.egress.reliable') throw new Error('expected reliable egress envelope');
    expect(reliable.payload).toMatchObject({ agentRef, sessionRef, policyRevision: DEFAULT_AGENT_EGRESS_POLICY.policyRevision });

    server.send(createEnvelope('agent.egress.ack', {
      agentRef,
      sessionRef,
      policyRevision: appended.record.policyRevision,
      eventId: appended.record.eventId,
      cursor: appended.record.cursor,
      receiptId: 'd4de726e-7bb9-4f4b-8dd6-17e2132aa8a0',
    }, { seq: server.nextSeq() }));
    await vi.waitFor(() => expect(daemon?.status().egress.reliable.pendingEvents).toBe(0));

    const rejectedBytes = 'must-not-reach-sanitizer-or-spool';
    const beforeRejected = reliableEnvelopes().length;
    await expect(publish({
      agentRef,
      sessionRef: 'invented-native-session',
      runtimeId: 'pi',
      payload: { rejectedBytes },
    })).rejects.toThrow(/handoff/i);
    await expect(publish({
      agentRef,
      sessionRef,
      runtimeId: 'codex',
      payload: { rejectedBytes },
    })).rejects.toThrow(/handoff/i);
    await expect(publish({
      agentRef,
      sessionRef,
      runtimeId: 'pi',
      taskId: 'other-task',
      payload: { rejectedBytes },
    })).rejects.toThrow(/taskId/i);
    await expect(publish({
      agentRef: { agentId: agentRef.agentId, profileRevision: 'wrong-profile' },
      sessionRef,
      runtimeId: 'pi',
      payload: { rejectedBytes },
    })).rejects.toThrow(/handoff/i);
    expect(reliableEnvelopes()).toHaveLength(beforeRejected);
    const spool = await fs.readFile(path.join(home, '.byok', 'egress', 'reliable-v1.jsonl'), 'utf8');
    expect(spool).not.toContain(rejectedBytes);

    // The legacy strict egress message remains exact-resume-only.
    server.send(createEnvelope(
      'task.offer_for_agent_with_egress',
      {
        instruction: 'this must not become fresh',
        policy: { mode: 'auto' },
        runtime: 'pi',
        agentRef,
        sessionRef: 'mismatched-resume-session',
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      },
      { taskId: 'legacy-egress-resume-mismatch', seq: server.nextSeq() },
    ));
    await server.waitFor((envelope) =>
      envelope.type === 'task.decline' && envelope.task_id === 'legacy-egress-resume-mismatch',
    );
    expect(adapter.sessions).toHaveLength(1);
  });

  it('does not send task.started when fresh handoff fsync fails', async () => {
    const hostStorageRoot = await tmpDir('byok-fresh-fsync-home-');
    const storeDir = await tmpDir('byok-fresh-fsync-store-');
    const adapter = new StubRuntimeAdapter('pi');
    const handoffs = new AgentSessionHandoffStore();
    vi.spyOn(handoffs, 'record').mockRejectedValueOnce(new Error('fsync unavailable'));
    const sent: Envelope[] = [];
    const runner = new TaskRunner({
      adapters: [adapter],
      workspaceRoot: await tmpDir('byok-fresh-fsync-workspace-'),
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentSessionHandoffs: handoffs,
      deviceId: 'fresh-fsync-device',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir),
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'fresh-fsync-test',
    });

    await runner.handleEnvelope(createEnvelope(
      'task.offer_for_agent_with_egress_fresh',
      {
        instruction: 'fail only at handoff fsync',
        policy: { mode: 'auto' },
        runtime: 'pi',
        agentRef,
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      },
      { taskId: 'fresh-fsync-task', seq: 1 },
    ));

    expect(adapter.sessions).toHaveLength(1);
    expect(adapter.sessions[0]?.closeCalled).toBe(true);
    expect(sent.map((envelope) => envelope.type)).toEqual(['task.claim', 'task.fail']);
    expect(sent.some((envelope) => envelope.type === 'task.started')).toBe(false);
  });
});
