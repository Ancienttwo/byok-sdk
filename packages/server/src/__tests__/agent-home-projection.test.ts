import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_HOME_PROJECTION_CAPABILITY,
  byokAgentHomeProjectionCompletionPath,
} from '@byok-sdk/protocol';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import {
  connectFakeDaemon,
  nextEnvelope,
  startServer,
  stopServer,
  testPairingClaims,
} from './test-support';

const PRODUCT_ID = 'agent-home-projection-test';
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}`;

function desired() {
  return {
    requestId: REQUEST_ID,
    agentRef: { agentId: 'agent-one', profileRevision: '7' },
    projectionHash: HASH,
    projection: { schemaVersion: 'host.opaque.v1', displayName: 'Agent One' },
  } as const;
}

describe('reference task-free Agent-home projection', () => {
  let server: HttpServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    if (server) await stopServer(server);
    server = undefined;
  });

  it('fails capability admission before any task or projection state is created', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const pairing = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, pairing.code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });
    sockets.push(daemon.ws);

    await expect(byok.enqueueAgentHomeProjection({ deviceId: daemon.deviceId, payload: desired() }))
      .rejects.toThrow(AGENT_HOME_PROJECTION_CAPABILITY);
    expect(byok.readAgentHomeProjection(daemon.deviceId, REQUEST_ID)).toBeUndefined();
    expect(byok.tasks.list()).toHaveLength(0);
  });

  it('delivers one exact non-task control, records an exact authenticated completion, and rejects changed terminal facts', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const pairing = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, pairing.code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', AGENT_HOME_PROJECTION_CAPABILITY],
    });
    sockets.push(daemon.ws);

    const pending = await byok.enqueueAgentHomeProjection({ deviceId: daemon.deviceId, payload: desired() });
    expect(pending).toMatchObject({
      deviceId: daemon.deviceId,
      requestId: REQUEST_ID,
      status: 'pending',
      agentRef: desired().agentRef,
      projectionHash: HASH,
    });
    const envelope = await nextEnvelope(daemon.ws);
    expect(envelope.type).toBe('agent.home.projection');
    if (envelope.type !== 'agent.home.projection') throw new Error('unreachable');
    expect(envelope.task_id).toBeUndefined();
    expect(envelope.payload).toEqual(desired());
    expect(byok.tasks.list()).toHaveLength(0);

    const beforeReplay = byok.stats().envelopesOut;
    await byok.enqueueAgentHomeProjection({ deviceId: daemon.deviceId, payload: desired() });
    expect(byok.stats().envelopesOut).toBe(beforeReplay);

    const completion = {
      requestId: REQUEST_ID,
      agentRef: desired().agentRef,
      projectionHash: HASH,
      outcome: 'applied',
    } as const;
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
    expect(readback).toMatchObject({
      deviceId: daemon.deviceId,
      requestId: REQUEST_ID,
      status: 'applied',
      completedAt: expect.any(String),
    });
    expect(byok.readAgentHomeProjection(daemon.deviceId, REQUEST_ID)).toEqual(readback);
    expect(byok.tasks.list()).toHaveLength(0);

    const changed = await fetch(`${started.baseUrl}${byokAgentHomeProjectionCompletionPath(REQUEST_ID)}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${daemon.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...completion, outcome: 'conflict' }),
    });
    expect(changed.status).toBe(409);
    expect(byok.readAgentHomeProjection(daemon.deviceId, REQUEST_ID)).toEqual(readback);
  });

  it('does not allow another authenticated device to complete the exact target request', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const targetPairing = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const target = await connectFakeDaemon(started.baseUrl, started.port, targetPairing.code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', AGENT_HOME_PROJECTION_CAPABILITY],
    });
    sockets.push(target.ws);
    const otherPairing = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const other = await connectFakeDaemon(started.baseUrl, started.port, otherPairing.code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', AGENT_HOME_PROJECTION_CAPABILITY],
    });
    sockets.push(other.ws);

    await byok.enqueueAgentHomeProjection({ deviceId: target.deviceId, payload: desired() });
    await nextEnvelope(target.ws);
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
    expect(byok.readAgentHomeProjection(target.deviceId, REQUEST_ID)?.status).toBe('pending');
  });
});
