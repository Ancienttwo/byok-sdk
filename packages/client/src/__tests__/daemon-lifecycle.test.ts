import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DaemonHaltError, type DaemonLifecycle } from '../daemon/daemon-lifecycle';
import { OPERATIONAL_HEALTH_FILENAME } from '../daemon/operational-health';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { OPEN_LIFECYCLE, waitForDaemonOpen } from './fixtures/lifecycle-barrier';

/**
 * Issue #391 acceptance: readiness is the server accepting this run's
 * `conn.hello`, reported through `status().lifecycle`; `start()` never waits
 * for the network.
 */

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

function hellos(): Envelope[] {
  return server?.received.filter((envelope) => envelope.type === 'conn.hello') ?? [];
}

function eventsPolls(): number {
  return server?.httpRequests.filter((request) => request.pathname === '/byok/events').length ?? 0;
}

async function startDaemon(config: Record<string, unknown> = {}): Promise<{ lifecycles: DaemonLifecycle[] }> {
  const workspaceRoot = await tmpDir('byok-lifecycle-workspace-');
  const storeDir = await tmpDir('byok-lifecycle-store-');
  daemon = createDaemonWithAdapters(
    {
      localAgentRelease: { version: '0.0.0-lifecycle-test' },
      productName: 'Lifecycle test',
      productId: 'lifecycle-test',
      serverUrl: server!.url,
      workspaceRoot,
      storeDir,
      ...config,
    },
    [new StubRuntimeAdapter('pi')],
    { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } },
  );
  const lifecycles: DaemonLifecycle[] = [];
  daemon.subscribe((event) => {
    if (event.kind === 'lifecycle') lifecycles.push(event.lifecycle);
  });
  await daemon.pair('lifecycle-pair-code');
  await daemon.start();
  return { lifecycles };
}

describe('daemon lifecycle (#391)', () => {
  it('halts with handshake_rejected when the server rejects conn.hello, and stops talking to it', async () => {
    server = await TestServer.start();
    server.setRejectHello(true);
    await startDaemon();

    await vi.waitFor(() => {
      expect(daemon!.status().lifecycle).toMatchObject({ phase: 'halted', reason: 'handshake_rejected' });
    }, { timeout: 5_000 });
    // A rejected hello is a halt, not a retry: the server saw exactly one
    // hello and this device never polled.
    const pollsAtHalt = eventsPolls();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hellos()).toHaveLength(1);
    expect(eventsPolls()).toBe(pollsAtHalt);
    expect(pollsAtHalt).toBe(0);
  });

  it('keeps running while the server is unreachable, retries the handshake, and opens once it recovers', async () => {
    server = await TestServer.start();
    server.setFailMessagesSends(true);
    const { lifecycles } = await startDaemon();

    // `start()` resolved with no server: the daemon runs and keeps re-sending
    // a fresh hello from its one reconnect loop.
    expect(daemon!.status().lifecycle).toEqual({ phase: 'running', connection: 'connecting' });
    await vi.waitFor(() => {
      expect(server!.httpRequests.filter((request) => request.method === 'POST' && request.pathname === '/byok/messages').length)
        .toBeGreaterThanOrEqual(3);
    }, { timeout: 5_000 });
    expect(daemon!.status().lifecycle).toEqual({ phase: 'running', connection: 'connecting' });
    expect(hellos()).toHaveLength(0);

    server.setFailMessagesSends(false);
    await waitForDaemonOpen(daemon!, 5_000);
    expect(daemon!.status().lifecycle).toEqual(OPEN_LIFECYCLE);
    expect(lifecycles).toEqual([{ phase: 'running', connection: 'connecting' }, OPEN_LIFECYCLE]);
  });

  it('sends a reliable record held for capability_missing after a reconnect, without a restart', async () => {
    server = await TestServer.start();
    server.setAckCapabilities([]);
    const hostStorageRoot = await tmpDir('byok-lifecycle-home-');
    const agentRef = { agentId: 'lifecycle-egress-agent', profileRevision: 'profile-r1' } as const;
    const taskId = 'lifecycle-egress-task';
    const adapter = new StubRuntimeAdapter('pi');
    const workspaceRoot = await tmpDir('byok-lifecycle-workspace-');
    const storeDir = await tmpDir('byok-lifecycle-store-');
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-lifecycle-test' },
        productName: 'Lifecycle test',
        productId: 'lifecycle-test',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        agentHome: { hostStorageRoot },
        agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      },
      [adapter],
      { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } },
    );
    await daemon.pair('lifecycle-pair-code');
    await daemon.start();
    await waitForDaemonOpen(daemon);

    server.send(createEnvelope(
      'task.offer_for_agent_with_egress_fresh',
      { instruction: 'mint a session to publish from', runtime: 'pi', agentRef, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY },
      { taskId, seq: server.nextSeq() },
    ));
    await server.waitFor((envelope) => envelope.type === 'task.started' && envelope.task_id === taskId);
    const sessionRef = adapter.sessions[0]!.sessionRef;
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((envelope) => envelope.type === 'task.complete' && envelope.task_id === taskId);
    // The task releases its Agent-home writer lease after the terminal.
    await vi.waitFor(() => expect(daemon!.status().activeTaskCount).toBe(0));

    const appended = await daemon.publishReliableAgentEgress!({
      agentRef,
      sessionRef,
      runtimeId: 'pi',
      taskId,
      eventId: '0d6f1f8e-3f6b-4e0a-9d43-6c1f0e7b9a21',
      payload: { status: 'held-until-the-server-acks' },
    });
    if (!appended.ok) throw new Error(`unexpected reliable egress refusal: ${appended.reason}`);
    // The server does not advertise the ack capability: the record is held,
    // durable and unsent.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.received.filter((envelope) => envelope.type === 'agent.egress.reliable')).toHaveLength(0);
    expect(daemon.status().egress.reliable.pendingEvents).toBe(1);

    // Break the session; the server gains the capability while the daemon is
    // reconnecting.
    const hellosBeforeBreak = hellos().length;
    server.setFailEventsPolls(true);
    await vi.waitFor(() => expect(daemon!.status().lifecycle).toEqual({ phase: 'running', connection: 'connecting' }));
    server.setAckCapabilities(['agent-egress-reliable-ack']);
    server.setFailEventsPolls(false);

    const reliable = await server.waitFor((envelope) =>
      envelope.type === 'agent.egress.reliable' && envelope.payload.eventId === appended.record.eventId,
    );
    expect(reliable.type).toBe('agent.egress.reliable');
    // It went out on a later session of the same run, after a reconnect's
    // fresh hello (a hello already in flight when the capability changed may
    // be the one whose answer carries it).
    expect(hellos().length).toBeGreaterThan(hellosBeforeBreak);
    const firstReconnectHello = hellos()[hellosBeforeBreak]!;
    expect(server.received.indexOf(firstReconnectHello)).toBeLessThan(server.received.indexOf(reliable));
  });

  it('a start failure that is not a halt is a crash: start() throws it and operational health records a lifecycle failure (#394)', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tmpDir('byok-lifecycle-workspace-');
    const storeDir = await tmpDir('byok-lifecycle-store-');
    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-lifecycle-test' }, productName: 'Lifecycle test', productId: 'lifecycle-test', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter('pi')],
    );
    const { deviceId } = await daemon.pair('lifecycle-pair-code');
    // An unreadable redelivery cursor (a directory where its file belongs) is
    // a local fault no halt reason names.
    const cursorKey = createHash('sha256').update(`${server.url}::${deviceId}`).digest('hex').slice(0, 32);
    await fs.mkdir(path.join(storeDir, `cursor-${cursorKey}.json`));

    const failure = await daemon.start().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(DaemonHaltError);
    expect(daemon.status().lifecycle).toEqual({ phase: 'stopped' });
    const health = JSON.parse(await fs.readFile(path.join(storeDir, OPERATIONAL_HEALTH_FILENAME), 'utf8')) as {
      failures: Array<{ source: string }>;
    };
    expect(health.failures.map((entry) => entry.source)).toEqual(['lifecycle']);
  });
});
