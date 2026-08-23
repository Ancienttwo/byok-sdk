import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentEgressPolicy, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeLayout } from '../agent-home';
import { AgentContentAuditStore } from '../daemon/agent-content-audit-store';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const roots: string[] = [];
let server: TestServer | undefined;
let daemon: Daemon | undefined;

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

const agentRef = { agentId: 'content-agent', profileRevision: 'profile-content-1' } as const;
const transfer = { maxBytes: 1024, allowedMimeTypes: ['text/plain'] };

function policy(overrides: Partial<AgentEgressPolicy['transfers']> = {}): AgentEgressPolicy {
  return {
    policyRevision: 'content-policy-r1',
    activity: { mode: 'metadata-status', delivery: 'latest-value' },
    reliable: {
      maxPendingEventsPerAgent: 8,
      maxPendingBytesPerAgent: 4096,
      maxPendingBytesPerTenant: 8192,
    },
    transfers: {
      workspace: transfer,
      transcript: transfer,
      artifact: 'disabled',
      ...overrides,
    },
  };
}

function readEnvelope(
  seq: number,
  input: {
    requestId: string;
    surface: 'workspace' | 'transcript' | 'artifact';
    cwd: string;
    target: string;
    policy?: typeof transfer;
  },
): Envelope {
  return createEnvelope('agent.content.read', {
    requestId: input.requestId,
    surface: input.surface,
    actor: { kind: 'user', id: 'content-user' },
    agentRef,
    sessionRef: 'content-session',
    runtime: 'pi',
    cwd: input.cwd,
    policyRevision: 'content-policy-r1',
    target: input.target,
    mimeType: 'text/plain',
    decodeAs: 'utf8',
    policy: input.policy ?? transfer,
  }, { seq });
}

function receipts(requestId: string): Envelope[] {
  return server?.received.filter(
    (envelope) => envelope.type === 'agent.content.receipt' && envelope.payload.requestId === requestId,
  ) ?? [];
}

async function acknowledgeLongPollReceipt(receipt: Envelope): Promise<void> {
  if (receipt.type !== 'agent.content.receipt') throw new Error('expected content receipt');
  server?.pushLongPollEvent(createEnvelope('agent.egress.ack', {
    agentRef: receipt.payload.agentRef,
    sessionRef: receipt.payload.sessionRef,
    policyRevision: receipt.payload.policyRevision,
    eventId: receipt.payload.eventId,
    cursor: receipt.payload.cursor,
    receiptId: receipt.payload.requestId,
  }, { seq: server.nextSeq() }));
  await vi.waitFor(() => expect(daemon?.status().egress.reliable.pendingEvents).toBe(0));
}

async function prepareAgentHome(hostStorageRoot: string): Promise<string> {
  const home = (await new AgentHomeLayout(hostStorageRoot).resolve(agentRef)).canonicalHome;
  await fs.mkdir(home, { recursive: true });
  await new AgentSessionHandoffStore().record({
    agentRef,
    taskId: 'task-content-session',
    sessionRef: 'content-session',
    runtimeId: 'pi',
    cwd: home,
    leaseId: 'lease-content-session',
  });
  return home;
}

async function startDaemon(
  currentServer: TestServer,
  hostStorageRoot: string,
  storeDir: string,
  currentPolicy = policy(),
  longPoll = false,
  pair = true,
): Promise<Daemon> {
  currentServer.setAckCapabilities(['agent-egress-reliable-ack']);
  const config: DaemonConfig = {
    localAgentRelease: { version: '0.0.0-content-test' },
    productName: 'Content test',
    productId: 'content-test',
    serverUrl: currentServer.url,
    workspaceRoot: await tmpDir('byok-content-workspace-'),
    storeDir,
    agentHome: { hostStorageRoot },
    agentEgress: {
      policy: currentPolicy,
      contentRead: {
        workspace: {
          root: { kind: 'agent-home' },
          maxTextBytes: 1024,
          textMimeTypes: ['text/plain'],
          sensitiveNames: ['host-only-secret.txt'],
        },
        transcript: {
          root: { kind: 'agent-home' },
          maxTextBytes: 1024,
          textMimeTypes: ['text/plain'],
        },
      },
    },
  };
  daemon = createDaemonWithAdapters(
    config,
    [new StubRuntimeAdapter('pi')],
    longPoll
      ? { longPoll: { wsFailureThreshold: 1, retryDelayMs: 10, idleDelayMs: 10, wsRetryIntervalMs: 100 } }
      : undefined,
  );
  if (pair) await daemon.pair('content-pair-code');
  await daemon.start();
  return daemon;
}

describe('agent.content.read daemon integration', () => {
  it('spools a content-free allowed receipt before send, then crash/restart replays the exact receipt without a second upload', async () => {
    server = await TestServer.start();
    const hostStorageRoot = await tmpDir('byok-content-home-');
    const storeDir = await tmpDir('byok-content-store-');
    const home = await prepareAgentHome(hostStorageRoot);
    await fs.writeFile(path.join(home, 'notes.txt'), 'ws explicit bytes', 'utf8');
    await startDaemon(server, hostStorageRoot, storeDir);

    const hello = server.received.find((envelope) => envelope.type === 'conn.hello');
    expect(hello?.type).toBe('conn.hello');
    if (hello?.type !== 'conn.hello') throw new Error('missing conn.hello');
    expect(hello.payload.capabilities).toContain('agent-content-workspace-read');
    expect(hello.payload.capabilities).toContain('agent-content-transcript-read');
    expect(hello.payload.capabilities).not.toContain('agent-content-artifact-read');

    const requestId = '00000000-0000-4000-8000-000000000101';
    server.send(readEnvelope(server.nextSeq(), { requestId, surface: 'workspace', cwd: home, target: 'notes.txt' }));
    await vi.waitFor(() => expect(receipts(requestId)).toHaveLength(1));
    const first = receipts(requestId)[0]!;
    if (first.type !== 'agent.content.receipt' || first.payload.decision !== 'allowed') throw new Error('expected allowed receipt');
    expect(first.payload).toMatchObject({
      requestId,
      eventId: requestId,
      cursor: expect.any(Number),
      cwd: home,
      target: 'notes.txt',
      byteCount: Buffer.byteLength('ws explicit bytes'),
      contentHash: 'sha256:80a11c57edc23806bb79f0644d26b60cd3cc47c1ccc188e3cda40ff4183c5ec6',
    });
    expect(server.blobContent(first.payload.blobRef.blobId)?.toString('utf8')).toBe('ws explicit bytes');
    const spoolBytes = await fs.readFile(path.join(home, '.byok', 'egress', 'reliable-v1.jsonl'), 'utf8');
    expect(spoolBytes).toContain(first.payload.blobRef.blobId);
    expect(spoolBytes).not.toContain('ws explicit bytes');

    // The TestServer deliberately does not emit a receipt ack. A fresh daemon
    // must recover the pending spool row and resend that exact content receipt
    // as `agent.content.receipt`, not generic reliable egress.
    const runningDaemon = daemon;
    await runningDaemon?.stop();
    daemon = undefined;
    const restartedDaemon = await startDaemon(server, hostStorageRoot, storeDir, policy(), false, false);
    await vi.waitFor(() => expect(receipts(requestId)).toHaveLength(2));
    const second = receipts(requestId)[1]!;
    if (second.type !== 'agent.content.receipt' || second.payload.decision !== 'allowed') throw new Error('expected replay receipt');
    expect(second.payload.eventId).toBe(first.payload.eventId);
    expect(second.payload.cursor).toBe(first.payload.cursor);
    expect(second.payload.blobRef).toEqual(first.payload.blobRef);
    expect(server.received.filter((envelope) => envelope.type === 'agent.egress.reliable')).toHaveLength(0);
    expect(server.httpRequests.filter((request) => request.method === 'PUT' && request.pathname.startsWith('/_test/blob-upload/'))).toHaveLength(1);

    await restartedDaemon.stop();
    daemon = undefined;
    const restartedAudit = new AgentContentAuditStore(path.join(home, '.byok', 'content-read-audit-v1.jsonl'));
    await expect(restartedAudit.readback()).resolves.toMatchObject([
      { requestId, agentRef, relativeTarget: 'notes.txt', decision: 'allow' },
    ]);
    await expect(restartedAudit.readback()).resolves.toHaveLength(1);
  });

  it('uses the same exact Agent session/cwd mapping over long-poll and denies cross-Agent, profile, session, runtime, and cwd claims before reading', async () => {
    server = await TestServer.start();
    server.setRejectWs(true);
    const hostStorageRoot = await tmpDir('byok-content-longpoll-home-');
    const storeDir = await tmpDir('byok-content-longpoll-store-');
    const home = await prepareAgentHome(hostStorageRoot);
    await fs.writeFile(path.join(home, 'transcript.txt'), 'long-poll transcript', 'utf8');
    await startDaemon(server, hostStorageRoot, storeDir, policy(), true);

    const allowedId = '00000000-0000-4000-8000-000000000102';
    server.pushLongPollEvent(readEnvelope(server.nextSeq(), {
      requestId: allowedId,
      surface: 'transcript',
      cwd: home,
      target: 'transcript.txt',
    }));
    await vi.waitFor(() => expect(receipts(allowedId)).toHaveLength(1));
    const allowed = receipts(allowedId)[0]!;
    if (allowed.type !== 'agent.content.receipt' || allowed.payload.decision !== 'allowed') throw new Error('expected long-poll allowed receipt');
    expect(allowed.payload.cwd).toBe(home);
    await acknowledgeLongPollReceipt(allowed);

    const identityMismatches = [
      { agentRef: { agentId: 'other-agent', profileRevision: agentRef.profileRevision } },
      { agentRef: { ...agentRef, profileRevision: 'other-profile' } },
      { sessionRef: 'other-session' },
      { runtime: 'codex' as const },
      { cwd: path.join(home, 'other-cwd') },
    ];
    for (const [index, mismatch] of identityMismatches.entries()) {
      const requestId = `00000000-0000-4000-8000-0000000001${String(index + 3).padStart(2, '0')}`;
      const base = readEnvelope(server.nextSeq(), {
        requestId,
        surface: 'workspace',
        cwd: home,
        target: 'notes.txt',
      });
      if (base.type !== 'agent.content.read') throw new Error('content read fixture changed type');
      server.pushLongPollEvent(createEnvelope('agent.content.read', {
        ...base.payload,
        ...mismatch,
      }, { seq: base.seq }));
      await vi.waitFor(() => expect(receipts(requestId)).toHaveLength(1));
      const denied = receipts(requestId)[0]!;
      if (denied.type !== 'agent.content.receipt' || denied.payload.decision !== 'denied') throw new Error('expected denied receipt');
      expect(denied.payload.reason).toBe('identity-mismatch');
      await acknowledgeLongPollReceipt(denied);
    }
  });
});
