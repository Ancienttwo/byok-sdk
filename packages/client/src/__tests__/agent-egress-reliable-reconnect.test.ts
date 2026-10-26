import { testScratchRoot } from './fixtures/execution-scratch';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import type { AgentReliableEgressRecord } from '../daemon/agent-egress-spool';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { LongPollClient } from '../daemon/long-poll-transport';
import { waitForDaemonOpen } from './fixtures/lifecycle-barrier';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * Issue #698: each reconnect advertises `agent-egress-reliable-ack` again, and
 * the daemon then dispatches every held reliable record again. Each dispatch
 * built a new envelope id, so the #693 id skip in `ConnectionManager.send` did
 * not stop it: on a flapping route (handshake accepted, every other post
 * refused) each reconnect queued one more copy of each held record. At most one
 * copy of a record may be pending, and each record must still reach the cloud
 * and retire on its exact ack after the route recovers.
 */
const roots: string[] = [];
let server: TestServer | undefined;
let daemon: Daemon | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await daemon?.stop();
  daemon = undefined;
  await server?.close();
  server = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tmpDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

type ReliableEnvelope = Extract<Envelope, { type: 'agent.egress.reliable' }>;
const isReliable = (envelope: Envelope): envelope is ReliableEnvelope => envelope.type === 'agent.egress.reliable';
const hellos = (): number => server?.received.filter((envelope) => envelope.type === 'conn.hello').length ?? 0;

const agentRef = { agentId: 'reconnect-egress-agent', profileRevision: 'profile-r1' } as const;
const taskId = 'reconnect-egress-task';
const eventIds = ['6a1d9f0e-1b7c-4e5a-8f3d-2c4b6a8e0d11', '7b2e0a1f-2c8d-4f6b-9a4e-3d5c7b9f1e22'];

describe('one pending copy of each held reliable record across reconnects (#698)', () => {
  it('keeps one queued copy per record while a flapping route reconnects, then retires each on its ack', async () => {
    server = await TestServer.start();
    // No ack capability yet: published records are held, durable and unsent.
    server.setAckCapabilities([]);
    const adapter = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-reconnect-egress-test' },
        productName: 'Reconnect egress test',
        productId: 'reconnect-egress-test',
        serverUrl: server.url,
        storeDir: await tmpDir('byok-reconnect-egress-store-'),
        agentHome: { hostStorageRoot: await tmpDir('byok-reconnect-egress-home-') },
        agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      },
      [adapter],
      { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } },
    );
    await daemon.pair('reconnect-egress-pair-code');
    await daemon.start();
    await waitForDaemonOpen(daemon);

    // A finished fresh-session task leaves the durable handoff that reliable egress publishes from.
    server.send(createEnvelope(
      'task.offer_for_agent_with_egress_fresh',
      { instruction: 'mint a session to publish from', runtime: 'pi', agentRef, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY },
      { taskId, seq: server.nextSeq() },
    ));
    await server.waitFor((envelope) => envelope.type === 'task.started' && envelope.task_id === taskId);
    const sessionRef = adapter.sessions[0]!.sessionRef;
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((envelope) => envelope.type === 'task.complete' && envelope.task_id === taskId);
    await vi.waitFor(() => expect(daemon!.status().activeTaskCount).toBe(0));

    const records: AgentReliableEgressRecord[] = [];
    for (const eventId of eventIds) {
      const appended = await daemon.publishReliableAgentEgress!({
        agentRef, sessionRef, runtimeId: 'pi', taskId, eventId, payload: { held: eventId },
      });
      if (!appended.ok) throw new Error(`unexpected reliable egress refusal: ${appended.reason}`);
      records.push(appended.record);
    }
    expect(daemon.status().egress.reliable.pendingEvents).toBe(eventIds.length);
    expect(server.received.filter(isReliable)).toHaveLength(0);

    // A flapping route: each handshake is accepted, and every other post is refused.
    let flapping = true;
    const refusedPosts: ReliableEnvelope[][] = [];
    const nativePostBatch = LongPollClient.prototype.postBatch;
    vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async function (
      this: LongPollClient,
      ...args: Parameters<LongPollClient['postBatch']>
    ) {
      const [batch] = args;
      if (!flapping || (batch.length === 1 && batch[0]!.type === 'conn.hello')) return nativePostBatch.apply(this, args);
      refusedPosts.push(batch.filter(isReliable));
      return undefined; // a route failure: the drain keeps the batch and the session reconnects
    });
    const hellosBeforeFlap = hellos();
    // From now on, every handshake answer advertises the ack capability again.
    server.setAckCapabilities(['agent-egress-reliable-ack']);
    await vi.waitFor(() => expect(refusedPosts.length).toBeGreaterThanOrEqual(6), { timeout: 5_000 });
    expect(hellos() - hellosBeforeFlap).toBeGreaterThanOrEqual(5);

    // No refused post carries a record twice. The first post can leave before
    // the second record is dispatched, so it may carry one record only.
    const eventIdsPerPost = refusedPosts.map((post) => post.map((envelope) => envelope.payload.eventId));
    expect(eventIdsPerPost.map((ids) => ids.length)).toEqual(eventIdsPerPost.map((ids) => new Set(ids).size));
    // Each dispatch of a record resends the same envelope.
    const flapEnvelopes = refusedPosts.flat();
    expect(new Set(flapEnvelopes.map((envelope) => envelope.id)).size).toBe(eventIds.length);
    const envelopeIdByEvent = new Map(flapEnvelopes.map((envelope) => [envelope.payload.eventId, envelope.id]));
    expect([...envelopeIdByEvent.keys()].sort()).toEqual([...eventIds].sort());

    flapping = false;
    await vi.waitFor(() => {
      expect(new Set(server!.received.filter(isReliable).map((envelope) => envelope.payload.eventId)).size).toBe(eventIds.length);
    }, { timeout: 5_000 });
    for (const envelope of server.received.filter(isReliable)) {
      expect(envelope.id).toBe(envelopeIdByEvent.get(envelope.payload.eventId));
    }

    for (const record of records) {
      server.send(createEnvelope('agent.egress.ack', {
        agentRef,
        sessionRef,
        policyRevision: record.policyRevision,
        eventId: record.eventId,
        cursor: record.cursor,
        receiptId: randomUUID(),
      }, { seq: server.nextSeq() }));
    }
    await vi.waitFor(() => expect(daemon!.status().egress.reliable.pendingEvents).toBe(0));
  });
});
