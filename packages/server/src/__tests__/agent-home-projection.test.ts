import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_HOME_PROJECTION_CAPABILITY,
  byokAgentHomeProjectionCompletionPath,
  type Envelope,
} from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer, type FakeLongPollDaemon } from './test-support';

const PRODUCT_ID = 'agent-home-projection-test';
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}`;
/** Short injected hold so a long-poll in these tests never waits out the real ~50s default. */
const SHORT_HOLD_MS = 150;

function desired() {
  return {
    requestId: REQUEST_ID,
    agentRef: { agentId: 'agent-one', profileRevision: '7' },
    projectionHash: HASH,
    projection: { schemaVersion: 'host.opaque.v1', displayName: 'Agent One' },
  } as const;
}

/**
 * Drain the device's mailbox until an envelope matching `predicate` appears.
 *
 * The long-poll replacement for the deleted `nextEnvelope(ws)`: every control
 * this file enqueues is a durable mailbox row written inside the awaited
 * host call, so the poll that follows returns it without racing anything.
 */
async function awaitEnvelope(
  daemon: FakeLongPollDaemon,
  predicate: (envelope: Envelope) => boolean,
  timeoutMs = 5_000,
): Promise<Envelope> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const envelope of await daemon.next()) if (predicate(envelope)) return envelope;
    if (Date.now() > deadline) throw new Error('awaitEnvelope: no matching envelope was delivered');
  }
}

describe('reference task-free Agent-home projection', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(): Promise<{ byok: ByokServer; baseUrl: string }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  it('fails capability admission before any task or projection state is created', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });

    await expect(started.byok.enqueueAgentHomeProjection({ deviceId: daemon.deviceId, payload: desired() }))
      .rejects.toThrow(AGENT_HOME_PROJECTION_CAPABILITY);
    expect(await started.byok.readAgentHomeProjection(daemon.deviceId, desired().agentRef, REQUEST_ID)).toBeUndefined();
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
  });

  it.each(['applied', 'idempotent', 'stale', 'conflict'] as const)('awaits durable %s completion and rejects changed terminal facts', async outcome => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', AGENT_HOME_PROJECTION_CAPABILITY],
    });

    const pending = await started.byok.enqueueAgentHomeProjection({ deviceId: daemon.deviceId, payload: desired() });
    expect(pending).toMatchObject({
      deviceId: daemon.deviceId,
      requestId: REQUEST_ID,
      status: 'pending',
      agentRef: desired().agentRef,
      projectionHash: HASH,
    });
    const envelope = await awaitEnvelope(daemon, (e) => e.type === 'agent.home.projection');
    if (envelope.type !== 'agent.home.projection') throw new Error('unreachable');
    expect(envelope.task_id).toBeUndefined();
    expect(envelope.payload).toEqual(desired());
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);

    // An exact replay of the same request is accepted rather than refused. The
    // pre-fold pin that it enqueued no SECOND envelope was written against
    // `stats().envelopesOut`, which is deleted with the in-process outbox that
    // produced it (WP3B 2a deviation 3) — see the notes' 2d-server-2 section.
    await started.byok.enqueueAgentHomeProjection({ deviceId: daemon.deviceId, payload: desired() });

    const completion = {
      requestId: REQUEST_ID,
      agentRef: desired().agentRef,
      projectionHash: HASH,
      outcome,
    } as const;
    const waiting = started.byok.awaitAgentHomeProjection(daemon.deviceId, desired().agentRef, REQUEST_ID);
    const response = await fetch(`${started.baseUrl}${byokAgentHomeProjectionCompletionPath(REQUEST_ID)}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${daemon.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(completion),
    });
    expect(response.status).toBe(200);
    const readback = await response.json();
    expect(await waiting).toEqual(readback);
    expect(await started.byok.awaitAgentHomeProjection(daemon.deviceId, desired().agentRef, REQUEST_ID)).toEqual(readback);
    expect(readback).toMatchObject({
      deviceId: daemon.deviceId,
      requestId: REQUEST_ID,
      status: outcome,
      completedAt: expect.any(String),
    });
    expect(await started.byok.readAgentHomeProjection(daemon.deviceId, desired().agentRef, REQUEST_ID)).toEqual(readback);
    await expect(
      started.byok.readAgentHomeProjection(
        daemon.deviceId,
        { agentId: 'agent-two', profileRevision: desired().agentRef.profileRevision },
        REQUEST_ID,
      ),
    ).resolves.toBeUndefined();
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);

    const changed = await fetch(`${started.baseUrl}${byokAgentHomeProjectionCompletionPath(REQUEST_ID)}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${daemon.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...completion, outcome: outcome === 'conflict' ? 'applied' : 'conflict' }),
    });
    expect(changed.status).toBe(409);
    expect(await started.byok.readAgentHomeProjection(daemon.deviceId, desired().agentRef, REQUEST_ID)).toEqual(readback);
  });

  it('cancels offline waits and rejects pending and future waits on close', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID, capabilities: ['agent-home-contract', AGENT_HOME_PROJECTION_CAPABILITY],
    });
    await started.byok.enqueueAgentHomeProjection({ deviceId: daemon.deviceId, payload: desired() });
    expect(await started.byok.awaitAgentHomeProjection('other-device', desired().agentRef, REQUEST_ID)).toBeUndefined();
    const abort = new AbortController();
    const cancelled = started.byok.awaitAgentHomeProjection(daemon.deviceId, desired().agentRef, REQUEST_ID, { signal: abort.signal });
    const cancellation = expect(cancelled).rejects.toThrow('offline cancelled');
    abort.abort(new Error('offline cancelled'));
    await cancellation;
    const pending = started.byok.awaitAgentHomeProjection(daemon.deviceId, desired().agentRef, REQUEST_ID);
    const closed = expect(pending).rejects.toThrow('ByokServer closed');
    await started.byok.close();
    await closed;
    await expect(started.byok.awaitAgentHomeProjection(daemon.deviceId, desired().agentRef, REQUEST_ID)).rejects.toThrow('ByokServer closed');
  });

  it('does not allow another authenticated device to complete the exact target request', async () => {
    const started = await start();
    const target = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      deviceName: 'target-laptop',
      capabilities: ['agent-home-contract', AGENT_HOME_PROJECTION_CAPABILITY],
    });
    const other = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      deviceName: 'other-laptop',
      capabilities: ['agent-home-contract', AGENT_HOME_PROJECTION_CAPABILITY],
    });

    await started.byok.enqueueAgentHomeProjection({ deviceId: target.deviceId, payload: desired() });
    await awaitEnvelope(target, (e) => e.type === 'agent.home.projection');
    const response = await fetch(`${started.baseUrl}${byokAgentHomeProjectionCompletionPath(REQUEST_ID)}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${other.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: REQUEST_ID,
        agentRef: desired().agentRef,
        projectionHash: HASH,
        outcome: 'applied',
      }),
    });
    expect(response.status).toBe(404);
    expect((await started.byok.readAgentHomeProjection(target.deviceId, desired().agentRef, REQUEST_ID))?.status).toBe('pending');
  });
});
