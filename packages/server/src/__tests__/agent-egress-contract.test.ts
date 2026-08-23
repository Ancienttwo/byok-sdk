import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type AgentEgressPolicy } from '@byok-sdk/protocol';
import type { WebSocket } from 'ws';
import { createByokServer } from '../index';
import {
  connectFakeDaemon,
  nextEnvelope,
  send,
  startServer,
  stopServer,
  testPairingClaims,
} from './test-support';

const PRODUCT_ID = 'egress-product';
const AGENT_REF = { agentId: 'agent-server-egress', profileRevision: 'profile-server-r1' } as const;
const CONTENT_HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POLICY: AgentEgressPolicy = {
  policyRevision: 'server-policy-r1',
  activity: { mode: 'metadata-status' as const, delivery: 'latest-value' as const },
  reliable: {
    maxPendingEventsPerAgent: 10,
    maxPendingBytesPerAgent: 4096,
    maxPendingBytesPerTenant: 8192,
  },
  transfers: {
    workspace: { maxBytes: 1024, allowedMimeTypes: ['text/plain'] },
    transcript: 'disabled' as const,
    artifact: 'disabled' as const,
  },
};

describe('reference-server Agent egress contract', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server !== undefined) await stopServer(server);
    ws = undefined;
    server = undefined;
  });

  it('fails closed before task enqueue for a legacy Agent-home daemon', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });
    ws = daemon.ws;

    await expect(
      byok.dispatch({
        deviceId: daemon.deviceId,
        instruction: 'must not enqueue',
        agentRef: AGENT_REF,
        sessionRef: 'session-server',
        egressPolicy: POLICY,
      }),
    ).rejects.toThrow(/egress policy and reliable acknowledgement capabilities/);
    expect(byok.tasks.list()).toHaveLength(0);
  });

  it('uses the strict offer and returns one exact durable receipt on reliable replay', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack'],
    });
    ws = daemon.ws;

    await byok.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'typed egress Agent work',
      agentRef: AGENT_REF,
      sessionRef: 'session-server',
      egressPolicy: POLICY,
    });
    const offer = await nextEnvelope(ws);
    expect(offer).toMatchObject({
      type: 'task.offer_for_agent_with_egress',
      payload: { agentRef: AGENT_REF, sessionRef: 'session-server', egressPolicy: POLICY },
    });

    const event = createEnvelope('agent.egress.reliable', {
      agentRef: AGENT_REF,
      sessionRef: 'session-server',
      policyRevision: POLICY.policyRevision,
      eventId: '10000000-0000-4000-8000-000000000040',
      cursor: 19,
      payload: { status: 'ready' },
      contentHash: CONTENT_HASH,
      byteCount: 18,
    });
    const firstAck = nextEnvelope(ws);
    send(ws, event);
    const first = await firstAck;
    expect(first).toMatchObject({
      type: 'agent.egress.ack',
      payload: {
        agentRef: AGENT_REF,
        sessionRef: 'session-server',
        policyRevision: POLICY.policyRevision,
        eventId: event.payload.eventId,
        cursor: 19,
      },
    });
    if (first.type !== 'agent.egress.ack') throw new Error('unreachable');
    expect(byok.egress.get(daemon.deviceId, event.payload.eventId)).toMatchObject({
      payload: event.payload,
      receiptId: first.payload.receiptId,
    });

    const replayAck = nextEnvelope(ws);
    send(ws, event);
    const replay = await replayAck;
    expect(replay.type).toBe('agent.egress.ack');
    if (replay.type !== 'agent.egress.ack') throw new Error('unreachable');
    expect(replay.payload).toEqual(first.payload);
  });

  it('gates each content-read surface before putting a control request in the outbox', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-egress-reliable-ack', 'agent-content-workspace-read'],
    });
    ws = daemon.ws;

    await expect(
      byok.requestAgentContentRead({
        deviceId: daemon.deviceId,
        payload: {
          requestId: '10000000-0000-4000-8000-000000000041',
          surface: 'transcript',
          actor: { kind: 'user', id: 'actor-server-1' },
          agentRef: AGENT_REF,
          sessionRef: 'session-server',
          runtime: 'codex',
          cwd: '/workspace',
          policyRevision: POLICY.policyRevision,
          target: 'trace.jsonl',
          mimeType: 'application/json',
          decodeAs: 'utf8',
          policy: { maxBytes: 1024, allowedMimeTypes: ['application/json'] },
        },
      }),
    ).rejects.toThrow(/agent-content-transcript-read/);

    const request = nextEnvelope(ws);
    await byok.requestAgentContentRead({
      deviceId: daemon.deviceId,
      payload: {
        requestId: '10000000-0000-4000-8000-000000000042',
        surface: 'workspace',
        actor: { kind: 'user', id: 'actor-server-1' },
        agentRef: AGENT_REF,
        sessionRef: 'session-server',
        runtime: 'codex',
        cwd: '/workspace',
        policyRevision: POLICY.policyRevision,
        target: 'README.md',
        mimeType: 'text/plain',
        decodeAs: 'utf8',
        policy: { maxBytes: 1024, allowedMimeTypes: ['text/plain'] },
      },
    });
    const delivered = await request;
    expect(delivered).toMatchObject({
      type: 'agent.content.read',
      payload: { surface: 'workspace', agentRef: AGENT_REF, sessionRef: 'session-server' },
    });
    if (delivered.type !== 'agent.content.read') throw new Error('unreachable');
    const receipt = createEnvelope('agent.content.receipt', {
      requestId: delivered.payload.requestId,
      eventId: delivered.payload.requestId,
      cursor: 20,
      surface: delivered.payload.surface,
      actor: delivered.payload.actor,
      agentRef: delivered.payload.agentRef,
      sessionRef: delivered.payload.sessionRef,
      runtime: delivered.payload.runtime,
      cwd: delivered.payload.cwd,
      policyRevision: delivered.payload.policyRevision,
      target: delivered.payload.target,
      mimeType: delivered.payload.mimeType,
      decodeAs: delivered.payload.decodeAs,
      decision: 'denied',
      byteCount: 0,
      reason: 'policy-disabled',
    });
    const firstAck = nextEnvelope(ws);
    send(ws, receipt);
    const first = await firstAck;
    expect(first).toMatchObject({
      type: 'agent.egress.ack',
      payload: {
        eventId: delivered.payload.requestId,
        cursor: 20,
        receiptId: delivered.payload.requestId,
      },
    });
    const replayAck = nextEnvelope(ws);
    send(ws, createEnvelope('agent.content.receipt', receipt.payload));
    const replay = await replayAck;
    expect(replay).toMatchObject({
      type: 'agent.egress.ack',
      payload: first.payload,
    });
  });
});
