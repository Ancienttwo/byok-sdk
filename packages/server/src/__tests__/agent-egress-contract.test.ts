import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
  createEnvelope,
  type AgentEgressPolicy,
} from '@byok-sdk/protocol';
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

  it('keeps user-visible message delivery outside activity and acks the exact authenticated task binding', async () => {
    const consumed: unknown[] = [];
    const byok = createByokServer({
      productId: PRODUCT_ID,
      agentMessage: { consume: (input) => { consumed.push(input); return { outcome: 'accepted' }; } },
    });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-message-egress', 'terminal-projection-selection'],
    });
    ws = daemon.ws;
    await expect(byok.dispatch({
      deviceId: daemon.deviceId, instruction: 'missing server context', agentRef: AGENT_REF,
      sessionRef: 'session-server', egressPolicy: POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
      terminalProjection: { mode: 'none' },
    })).rejects.toBeDefined();
    expect(byok.tasks.list()).toHaveLength(0);
    const handle = await byok.dispatch({
      deviceId: daemon.deviceId, instruction: 'send one message', agentRef: AGENT_REF,
      sessionRef: 'session-server', egressPolicy: POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
      terminalProjection: { mode: 'none' },
      agentMessageContext: { destinationBinding: 'conversation/42/turn/7', freshnessCursor: 'turn-seq:7' },
    });
    await nextEnvelope(ws);
    const publish = createEnvelope('agent.message.publish', {
      agentRef: AGENT_REF, sessionRef: 'session-server', contract: 'example.chat.v1',
      messageId: '10000000-0000-4000-8000-000000000090', cursor: 1,
      contentType: 'text/markdown', body: 'hello',
      contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', byteCount: 5,
    }, { taskId: handle.taskId });
    const receipt = nextEnvelope(ws);
    send(ws, publish);
    expect(await receipt).toMatchObject({ type: 'agent.message.disposition', task_id: handle.taskId, payload: { outcome: 'accepted' } });
    expect(consumed).toHaveLength(1);
    send(ws, createEnvelope('agent.message.publish', {
      ...publish.payload,
      messageId: '10000000-0000-4000-8000-000000000091',
      body: 'second',
      byteCount: 6,
      contentHash: 'sha256:16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4',
    }, { taskId: handle.taskId }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ context: { destinationBinding: 'conversation/42/turn/7', freshnessCursor: 'turn-seq:7' } });
  });

  it.each(['held', 'refused'] as const)('does not re-invoke the product consumer for an exact %s transport replay', async (outcome) => {
    const consumed: unknown[] = [];
    const byok = createByokServer({
      productId: PRODUCT_ID,
      agentMessage: { consume: (input) => { consumed.push(input); return { outcome }; } },
    });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-message-egress', 'terminal-projection-selection'],
    });
    ws = daemon.ws;
    const handle = await byok.dispatch({
      deviceId: daemon.deviceId, instruction: 'send one message', agentRef: AGENT_REF,
      sessionRef: 'session-server', egressPolicy: POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
      terminalProjection: { mode: 'none' },
      agentMessageContext: { destinationBinding: 'conversation/42/turn/7' },
    });
    await nextEnvelope(ws);
    const publish = createEnvelope('agent.message.publish', {
      agentRef: AGENT_REF, sessionRef: 'session-server', contract: 'example.chat.v1',
      messageId: '10000000-0000-4000-8000-000000000092', cursor: 1,
      contentType: 'text/markdown', body: 'hello',
      contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', byteCount: 5,
    }, { taskId: handle.taskId });
    const first = nextEnvelope(ws);
    send(ws, publish);
    const firstDisposition = await first;
    const second = nextEnvelope(ws);
    send(ws, publish);
    const secondDisposition = await second;
    expect(firstDisposition).toMatchObject({ type: 'agent.message.disposition', payload: { outcome } });
    expect(secondDisposition).toMatchObject({
      type: 'agent.message.disposition',
      task_id: firstDisposition.task_id,
      payload: firstDisposition.payload,
    });
    expect(consumed).toHaveLength(1);
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

  it('requires the fresh-session capability before creating a fresh egress task', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack'],
    });
    ws = daemon.ws;

    await expect(byok.dispatchFreshAgentEgress({
      deviceId: daemon.deviceId,
      instruction: 'must not downgrade without policy',
      agentRef: AGENT_REF,
      egressPolicy: undefined,
    } as never)).rejects.toThrow(/requires exact AgentRef and egress policy/);
    await expect(byok.dispatchFreshAgentEgress({
      instruction: 'must not pick an ambient device',
      agentRef: AGENT_REF,
      egressPolicy: POLICY,
    } as never)).rejects.toThrow(/requires an explicit deviceId/);

    await expect(
      byok.dispatchFreshAgentEgress({
        deviceId: daemon.deviceId,
        instruction: 'fresh Agent work',
        agentRef: AGENT_REF,
        egressPolicy: POLICY,
      }),
    ).rejects.toThrow(/fresh-session capabilities/);
    expect(byok.tasks.list()).toHaveLength(0);
  });

  it('dispatches the additive fresh egress offer without inventing a sessionRef', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      capabilities: [
        'agent-home-contract',
        'agent-egress-policy',
        'agent-egress-reliable-ack',
        AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
      ],
    });
    ws = daemon.ws;

    await expect(byok.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'must not reinterpret resume as fresh',
      agentRef: AGENT_REF,
      egressPolicy: POLICY,
    })).rejects.toThrow(/dispatchFreshAgentEgress/);
    expect(byok.tasks.list()).toHaveLength(0);

    const handle = await byok.dispatchFreshAgentEgress({
      deviceId: daemon.deviceId,
      instruction: 'fresh Agent work',
      agentRef: AGENT_REF,
      egressPolicy: POLICY,
    });
    const offer = await nextEnvelope(ws);
    expect(offer).toMatchObject({
      type: 'task.offer_for_agent_with_egress_fresh',
      task_id: handle.taskId,
      payload: { agentRef: AGENT_REF, egressPolicy: POLICY },
    });
    expect('sessionRef' in offer.payload).toBe(false);
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
