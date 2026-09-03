import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
  createEnvelope,
  type AgentEgressPolicy,
  type Envelope,
} from '@byok-sdk/protocol';
import { createByokServer, type ByokServer, type CreateByokServerOptions } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer, type FakeLongPollDaemon } from './test-support';

const PRODUCT_ID = 'egress-product';
/** Short injected hold so a long-poll in these tests never waits out the real ~50s default. */
const SHORT_HOLD_MS = 150;
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

/** Drain the device's mailbox until an envelope matching `predicate` appears — the long-poll replacement for the deleted `nextEnvelope(ws)`. */
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

describe('reference-server Agent egress contract', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server !== undefined) await stopServer(server);
    server = undefined;
  });

  async function start(
    capabilities: string[],
    opts: Pick<CreateByokServerOptions, 'agentMessage'> = {},
  ): Promise<{ byok: ByokServer; daemon: FakeLongPollDaemon }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS, ...opts });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID, capabilities });
    return { byok: instance, daemon };
  }

  it('keeps user-visible message delivery outside activity and acks the exact authenticated task binding', async () => {
    const consumed: unknown[] = [];
    const { byok: instance, daemon } = await start(
      ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-message-egress', 'terminal-projection-selection'],
      { agentMessage: { consume: async (input) => { consumed.push(input); return { outcome: 'accepted' }; } } },
    );

    await expect(instance.dispatch({
      deviceId: daemon.deviceId, instruction: 'missing server context', agentRef: AGENT_REF,
      sessionRef: 'session-server', egressPolicy: POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
      terminalProjection: { mode: 'none' },
    })).rejects.toBeDefined();
    expect((await instance.tasks.list()).tasks).toHaveLength(0);

    const handle = await instance.dispatch({
      deviceId: daemon.deviceId, instruction: 'send one message', agentRef: AGENT_REF,
      sessionRef: 'session-server', egressPolicy: POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
      terminalProjection: { mode: 'none' },
      agentMessageContext: { destinationBinding: 'conversation/42/turn/7', freshnessCursor: 'turn-seq:7' },
    });
    await awaitEnvelope(daemon, (e) => e.task_id === handle.taskId);

    const publish = createEnvelope('agent.message.publish', {
      agentRef: AGENT_REF, sessionRef: 'session-server', contract: 'example.chat.v1',
      messageId: '10000000-0000-4000-8000-000000000090', cursor: 1,
      contentType: 'text/markdown', body: 'hello',
      contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', byteCount: 5,
    }, { taskId: handle.taskId });
    await daemon.send(publish);
    expect(await awaitEnvelope(daemon, (e) => e.type === 'agent.message.disposition')).toMatchObject({
      type: 'agent.message.disposition', task_id: handle.taskId, payload: { outcome: 'accepted' },
    });
    expect(consumed).toHaveLength(1);

    // A DIFFERENT message on the same task must not re-invoke the product
    // consumer: the offer's message contract is consumed once. The awaited send
    // is the barrier — `POST /byok/messages` runs the admission hook inline.
    await daemon.send(createEnvelope('agent.message.publish', {
      ...publish.payload,
      messageId: '10000000-0000-4000-8000-000000000091',
      body: 'second',
      byteCount: 6,
      contentHash: 'sha256:16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4',
    }, { taskId: handle.taskId }));
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ context: { destinationBinding: 'conversation/42/turn/7', freshnessCursor: 'turn-seq:7' } });
  });

  it.each(['held', 'refused'] as const)('does not re-invoke the product consumer for an exact %s transport replay', async (outcome) => {
    const consumed: unknown[] = [];
    const { byok: instance, daemon } = await start(
      ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-message-egress', 'terminal-projection-selection'],
      { agentMessage: { consume: async (input) => { consumed.push(input); return { outcome }; } } },
    );

    const handle = await instance.dispatch({
      deviceId: daemon.deviceId, instruction: 'send one message', agentRef: AGENT_REF,
      sessionRef: 'session-server', egressPolicy: POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
      terminalProjection: { mode: 'none' },
      agentMessageContext: { destinationBinding: 'conversation/42/turn/7' },
    });
    await awaitEnvelope(daemon, (e) => e.task_id === handle.taskId);

    const publish = createEnvelope('agent.message.publish', {
      agentRef: AGENT_REF, sessionRef: 'session-server', contract: 'example.chat.v1',
      messageId: '10000000-0000-4000-8000-000000000092', cursor: 1,
      contentType: 'text/markdown', body: 'hello',
      contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', byteCount: 5,
    }, { taskId: handle.taskId });

    await daemon.send(publish);
    const firstDisposition = await awaitEnvelope(daemon, (e) => e.type === 'agent.message.disposition');
    expect(firstDisposition).toMatchObject({ type: 'agent.message.disposition', task_id: handle.taskId, payload: { outcome } });

    // An EXACT transport replay: the awaited send is the barrier, since the
    // admission hook runs inline inside `POST /byok/messages`.
    await daemon.send(publish);
    expect(consumed).toHaveLength(1);
  });

  // 2d gap: the second half of the `it.each` above. The deleted hub answered
  // every replay by SENDING another `agent.message.disposition` down the live
  // socket, so a replay observably produced a second, identical frame. The
  // kernel's `enqueueAgentMessageDisposition` (`packages/cloud/src/cloud.ts`)
  // is keyed `agent-message-disposition:<receiptId>` and appends exactly ONE
  // durable mailbox row per disposition, so a replay adds nothing new to
  // deliver — the device's next poll is empty. The frozen disposition itself is
  // unchanged and still readable from the retained window. Orchestrator
  // decision: accept one-durable-row delivery (the mailbox is at-least-once, so
  // a device that lost the row re-reads it by cursor), or re-append on replay.
  it.skip('answers an exact transport replay with a second, identical agent.message.disposition delivery', async () => {
    expect.fail('the kernel appends one durable disposition row per message — see the 2d gap note above');
  });

  it('fails closed before task enqueue for a legacy Agent-home daemon', async () => {
    const { byok: instance, daemon } = await start(['agent-home-contract']);

    await expect(
      instance.dispatch({
        deviceId: daemon.deviceId,
        instruction: 'must not enqueue',
        agentRef: AGENT_REF,
        sessionRef: 'session-server',
        egressPolicy: POLICY,
      }),
      // The kernel's admission names the exact missing capabilities
      // (`assertAgentCapabilities`, `packages/cloud/src/cloud.ts`) where the
      // deleted hub used prose ("egress policy and reliable acknowledgement
      // capabilities").
    ).rejects.toThrow(/agent-egress-policy, agent-egress-reliable-ack/);
    expect((await instance.tasks.list()).tasks).toHaveLength(0);
  });

  it('requires the fresh-session capability before creating a fresh egress task', async () => {
    const { byok: instance, daemon } = await start([
      'agent-home-contract',
      'agent-egress-policy',
      'agent-egress-reliable-ack',
    ]);

    // `dispatchFreshAgentEgress`'s own argument guards throw SYNCHRONOUSLY
    // (`index.ts`), before the async body runs, so each call is wrapped to give
    // `.rejects` a promise to inspect either way.
    const rejects = (call: () => unknown) => expect(Promise.resolve().then(call));

    await rejects(() => instance.dispatchFreshAgentEgress({
      deviceId: daemon.deviceId,
      instruction: 'must not downgrade without policy',
      agentRef: AGENT_REF,
      egressPolicy: undefined,
    } as never)).rejects.toThrow(/requires exact AgentRef and egress policy/);

    await rejects(() => instance.dispatchFreshAgentEgress({
      instruction: 'must not pick an ambient device',
      agentRef: AGENT_REF,
      egressPolicy: POLICY,
    } as never)).rejects.toThrow(/requires an explicit deviceId/);

    await expect(
      instance.dispatchFreshAgentEgress({
        deviceId: daemon.deviceId,
        instruction: 'fresh Agent work',
        agentRef: AGENT_REF,
        egressPolicy: POLICY,
      }),
    ).rejects.toThrow(/agent-egress-fresh-session/);
    expect((await instance.tasks.list()).tasks).toHaveLength(0);
  });

  it('dispatches the additive fresh egress offer without inventing a sessionRef', async () => {
    const { byok: instance, daemon } = await start([
      'agent-home-contract',
      'agent-egress-policy',
      'agent-egress-reliable-ack',
      AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
    ]);

    await expect(instance.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'must not reinterpret resume as fresh',
      agentRef: AGENT_REF,
      egressPolicy: POLICY,
    })).rejects.toThrow(/dispatchFreshAgentEgress/);
    expect((await instance.tasks.list()).tasks).toHaveLength(0);

    const handle = await instance.dispatchFreshAgentEgress({
      deviceId: daemon.deviceId,
      instruction: 'fresh Agent work',
      agentRef: AGENT_REF,
      egressPolicy: POLICY,
    });
    const offer = await awaitEnvelope(daemon, (e) => e.task_id === handle.taskId);
    expect(offer).toMatchObject({
      type: 'task.offer_for_agent_with_egress_fresh',
      task_id: handle.taskId,
      payload: { agentRef: AGENT_REF, egressPolicy: POLICY },
    });
    expect('sessionRef' in offer.payload).toBe(false);
  });

  it('uses the strict offer and returns one exact durable receipt on reliable replay', async () => {
    const { byok: instance, daemon } = await start([
      'agent-home-contract',
      'agent-egress-policy',
      'agent-egress-reliable-ack',
    ]);

    const handle = await instance.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'typed egress Agent work',
      agentRef: AGENT_REF,
      sessionRef: 'session-server',
      egressPolicy: POLICY,
    });
    const offer = await awaitEnvelope(daemon, (e) => e.task_id === handle.taskId);
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
    await daemon.send(event);
    const first = await awaitEnvelope(daemon, (e) => e.type === 'agent.egress.ack');
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
    expect(await instance.egress.get(daemon.deviceId, event.payload.eventId)).toMatchObject({
      payload: event.payload,
      receiptId: first.payload.receiptId,
    });

    // An exact replay returns the SAME durable receipt — the first-write-wins
    // record is unchanged, and no second one is minted.
    await daemon.send(event);
    expect(await instance.egress.get(daemon.deviceId, event.payload.eventId)).toMatchObject({
      payload: event.payload,
      receiptId: first.payload.receiptId,
    });
  });

  // 2d gap: the replay half of the test above. The deleted hub re-SENT an
  // `agent.egress.ack` frame down the live socket for every replay. The
  // kernel's ack is one durable mailbox row keyed by the receipt id
  // (`packages/cloud/src/cloud.ts:1235`), so a replay re-derives the identical
  // receipt but appends nothing new to deliver, and the device's next poll is
  // empty. Same family as the `agent.message.disposition` replay gap above; the
  // receipt identity itself is still pinned, through `egress.get`.
  // Orchestrator decision: accept one-durable-row delivery, or re-append the
  // ack on replay.
  it.skip('re-delivers an identical agent.egress.ack envelope on an exact reliable replay', async () => {
    expect.fail('the kernel appends one durable ack row per receipt — see the 2d gap note above');
  });

  it('gates each content-read surface before putting a control request in the outbox', async () => {
    // `agent-egress-policy` is required by the kernel's own admission for
    // `enqueueAgentContentRead` (`assertAgentCapabilities`,
    // `packages/cloud/src/cloud.ts`), where the deleted hub gated on the
    // per-surface read capability alone.
    const { byok: instance, daemon } = await start([
      'agent-home-contract',
      'agent-egress-policy',
      'agent-egress-reliable-ack',
      'agent-content-workspace-read',
    ]);

    await expect(
      instance.requestAgentContentRead({
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

    await instance.requestAgentContentRead({
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
    const delivered = await awaitEnvelope(daemon, (e) => e.type === 'agent.content.read');
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
    await daemon.send(receipt);
    const first = await awaitEnvelope(daemon, (e) => e.type === 'agent.egress.ack');
    expect(first).toMatchObject({
      type: 'agent.egress.ack',
      payload: {
        eventId: delivered.payload.requestId,
        cursor: 20,
        receiptId: delivered.payload.requestId,
      },
    });

    // An exact replay (a fresh envelope id carrying the identical receipt body)
    // is accepted and appends no second ack row — the durable ack is keyed by
    // the receipt id. The "an identical ack frame is re-delivered" half of the
    // pre-fold pin is the `it.skip` gap recorded above.
    const replayRes = await daemon.send(createEnvelope('agent.content.receipt', receipt.payload));
    expect(replayRes.status).toBe(200);
    expect(await daemon.next()).toEqual([]);
  });
});
