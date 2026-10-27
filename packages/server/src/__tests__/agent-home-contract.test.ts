import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION, type Envelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import {
  connectFakeDaemonLongPoll,
  pairFakeDaemon,
  startServer,
  stopServer,
  testPairingClaims,
  waitForTaskEvent,
  type FakeLongPollDaemon,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short injected hold so a long-poll in these tests never waits out the real ~50s default. */
const SHORT_HOLD_MS = 150;
const agentRef = { agentId: 'agent-1', profileRevision: 'profile-r7' } as const;
const SESSION_REF = 'sess-resume-1';

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

describe('agent-home-contract reference server', () => {
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

  it.each(['agent_home_writer_busy', 'agent_home_reader_busy', undefined] as const)(
    'returns decline code %s through tasks.deviceTerminal and tasks.get().result', async (code) => {
      const started = await start();
      const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
        productId: PRODUCT_ID, capabilities: ['agent-home-contract'],
      });
      const handle = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'busy readback', agentRef, sessionRef: SESSION_REF });
      await awaitEnvelope(daemon, e => e.task_id === handle.taskId);
      const payload = { reason: 'display only', retryable: true, agentRef, ...(code === undefined ? {} : { code }) };
      const terminal = createEnvelope('task.decline', payload, { taskId: handle.taskId });
      const response = await daemon.send(terminal);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ accepted: 1, outcomes: [{ id: terminal.id, outcome: 'accepted' }] });
      const deviceTerminal = await started.byok.tasks.deviceTerminal(handle.taskId);
      expect(deviceTerminal).toMatchObject({ envelope: terminal });
      if (code === undefined) expect(deviceTerminal?.envelope.payload).not.toHaveProperty('code');
      const expected = { state: 'Failed', reason: 'display only', retryable: true, ...(code === undefined ? {} : { code }) };
      expect((await started.byok.tasks.get(handle.taskId))?.result).toEqual(expected);
      expect(await handle.result()).toEqual(expected);
    },
  );

  it('rejects before task creation when an old daemon omits the capability', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: [],
    });

    await expect(
      started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'agent work', agentRef, sessionRef: SESSION_REF }),
    ).rejects.toThrow(/agent-home-contract/);
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
  });

  it('refuses a fresh Agent dispatch without an exact sessionRef before any durable write (#484)', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });

    // The required static type refuses this at compile time; a JS caller still meets the runtime guard.
    await expect(
      // @ts-expect-error sessionRef is required on the Agent resume dispatch (#484)
      started.byok.dispatch({
        deviceId: daemon.deviceId,
        taskId: 'fresh-refused',
        instruction: 'fresh Agent work',
        agentRef,
      }),
    ).rejects.toThrow(
      'Agent resume dispatch requires an exact sessionRef; use executions.submit for fresh execution',
    );

    expect(await started.byok.tasks.attempt('fresh-refused')).toBeUndefined();
    expect(await started.byok.tasks.get('fresh-refused')).toBeUndefined();
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
    // Nothing reached the mailbox: the next page is empty and the cursor never moved.
    expect(await daemon.next()).toEqual([]);
    expect(daemon.cursor()).toBe(0);

    // The refusal left no relay or store state: the same id dispatches as a resume.
    const handle = await started.byok.dispatch({
      deviceId: daemon.deviceId,
      taskId: 'fresh-refused',
      instruction: 'resume Agent work',
      agentRef,
      sessionRef: SESSION_REF,
    });
    expect(handle.taskId).toBe('fresh-refused');
    await awaitEnvelope(daemon, (e) => e.task_id === 'fresh-refused');
  });

  it('refuses an empty sessionRef before any durable write (#484)', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });

    await expect(
      started.byok.dispatch({
        deviceId: daemon.deviceId,
        taskId: 'empty-session-refused',
        instruction: 'fresh Agent work',
        agentRef,
        sessionRef: '',
      }),
    ).rejects.toThrow(
      'Agent resume dispatch requires an exact sessionRef; use executions.submit for fresh execution',
    );

    expect(await started.byok.tasks.attempt('empty-session-refused')).toBeUndefined();
    expect(await started.byok.tasks.get('empty-session-refused')).toBeUndefined();
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
    expect(await daemon.next()).toEqual([]);
    expect(daemon.cursor()).toBe(0);
  });

  it('refuses a missing or empty sessionRef before any capability read (#484)', async () => {
    const started = await start();
    // Advertises nothing: capability admission alone would refuse this dispatch.
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: [],
    });

    for (const [taskId, deviceId, session] of [
      ['missing-unknown-device', 'device-not-registered', {}],
      ['empty-unknown-device', 'device-not-registered', { sessionRef: '' }],
      ['missing-bare-device', daemon.deviceId, {}],
      ['empty-bare-device', daemon.deviceId, { sessionRef: '' }],
    ] as const) {
      await expect(
        // @ts-expect-error a JS caller may omit sessionRef on the Agent resume dispatch (#484)
        started.byok.dispatch({ deviceId, taskId, instruction: 'fresh Agent work', agentRef, requiredToolsets: ['salesko'], ...session }),
      ).rejects.toThrow(
        'Agent resume dispatch requires an exact sessionRef; use executions.submit for fresh execution',
      );
      expect(await started.byok.tasks.attempt(taskId)).toBeUndefined();
    }
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
    expect(await daemon.next()).toEqual([]);
    expect(daemon.cursor()).toBe(0);

    // The same dispatch with a real sessionRef reaches capability admission.
    await expect(
      started.byok.dispatch({
        deviceId: daemon.deviceId,
        instruction: 'resume Agent work',
        agentRef,
        sessionRef: SESSION_REF,
        requiredToolsets: ['salesko'],
      }),
    ).rejects.toThrow(/did not advertise toolset-selection capability/);
  });

  it('sends a resume task.offer and persists the exact AgentRef', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });

    const handle = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'agent work', agentRef, sessionRef: SESSION_REF });
    const envelope = await awaitEnvelope(daemon, (e) => e.task_id === handle.taskId);
    expect(envelope.type).toBe('task.offer');
    if (envelope.type !== 'task.offer') throw new Error('unreachable');
    expect(envelope.payload.agentRef).toEqual(agentRef);
    expect(envelope.payload.session).toEqual({ mode: 'resume', sessionRef: SESSION_REF });
    expect((await started.byok.tasks.get(handle.taskId))?.agentRef).toEqual(agentRef);
  });

  it('admits Agent dispatch after an authenticated long-poll conn.hello snapshot', async () => {
    const started = await start();
    const { code } = await started.byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const daemon = await pairFakeDaemon(started.baseUrl, code);
    const hello = createEnvelope('conn.hello', {
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: ['agent-home-contract'],
      deviceId: daemon.deviceId,
      productId: PRODUCT_ID,
    });

    const response = await fetch(`${started.baseUrl}/byok/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${daemon.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ messages: [hello] }),
    });
    expect(response.status).toBe(200);
    // The accepted hello's answer carries the poll's capability advertisement (#391 Phase 2).
    const answer = (await response.json()) as { accepted: number; capabilities?: string[] };
    expect(answer).toMatchObject({ accepted: 1, capabilities: expect.arrayContaining(['agent-home-contract']) });
    await expect(
      started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'agent over long-poll', agentRef, sessionRef: SESSION_REF }),
    ).resolves.toMatchObject({ taskId: expect.any(String) });
  });

  it('fails closed on claim and terminal AgentRef mismatches — the envelope is refused and writes nothing', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });

    const claimMismatch = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'claim mismatch', agentRef, sessionRef: SESSION_REF });
    await awaitEnvelope(daemon, (e) => e.task_id === claimMismatch.taskId);
    const claimRes = await daemon.send(
      createEnvelope(
        'task.claim',
        { deviceId: daemon.deviceId, agentRef: { ...agentRef, profileRevision: 'wrong' } },
        { taskId: claimMismatch.taskId },
      ),
    );
    expect(await claimRes.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect((await started.byok.tasks.get(claimMismatch.taskId))?.state).toBe('Offered'); // never claimed

    const terminalMismatch = await started.byok.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'terminal mismatch',
      agentRef,
      sessionRef: SESSION_REF,
    });
    await awaitEnvelope(daemon, (e) => e.task_id === terminalMismatch.taskId);
    await daemon.send(createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef }, { taskId: terminalMismatch.taskId }));
    await daemon.send(createEnvelope('task.started', {}, { taskId: terminalMismatch.taskId }));
    await waitForTaskEvent(terminalMismatch, (event) => event.kind === 'state' && event.state === 'Running');
    const terminalRes = await daemon.send(
      createEnvelope(
        'task.complete',
        { summary: 'done', sessionRef: 'sess-1', agentRef: { ...agentRef, profileRevision: 'wrong' } },
        { taskId: terminalMismatch.taskId },
      ),
    );
    expect(await terminalRes.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect((await started.byok.tasks.get(terminalMismatch.taskId))?.state).toBe('Running'); // no terminal was written
    expect((await started.byok.tasks.get(terminalMismatch.taskId))?.result).toBeUndefined();
  });

  // 2d gap: the pre-fold assertions split out of the test above. The deleted
  // hub answered an AgentRef mismatch by FORCE-FAILING the task
  // (`{ state: 'Failed', retryable: false }`); the kernel's inbound gate
  // refuses the envelope instead (`packages/cloud/src/inbound.ts:466`), on the
  // same reasoning it already applies to an ownership mismatch — force-failing
  // on an identity mismatch lets anyone who can produce a wrong echo kill the
  // real Agent's task. The refusal is pinned by the active test above.
  // Orchestrator decision: accept the kernel's refuse-don't-fail rule (and
  // document the break in Step 5), or restore a force-fail for the
  // same-device-wrong-AgentRef case only.
  it.skip('force-fails the task with retryable: false on a claim or terminal AgentRef mismatch', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });

    const claimMismatch = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'claim mismatch', agentRef, sessionRef: SESSION_REF });
    await awaitEnvelope(daemon, (e) => e.task_id === claimMismatch.taskId);
    await daemon.send(
      createEnvelope(
        'task.claim',
        { deviceId: daemon.deviceId, agentRef: { ...agentRef, profileRevision: 'wrong' } },
        { taskId: claimMismatch.taskId },
      ),
    );
    await waitForTaskEvent(claimMismatch, (event) => event.kind === 'state' && event.state === 'Failed');
    expect((await started.byok.tasks.get(claimMismatch.taskId))?.result).toMatchObject({ state: 'Failed', retryable: false });
  });

  it('does not let another authenticated device claim or fail a targeted Agent offer', async () => {
    const started = await start();
    const target = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      deviceName: 'target-laptop',
      capabilities: ['agent-home-contract'],
    });
    const attacker = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      deviceName: 'attacker-laptop',
      capabilities: ['agent-home-contract'],
    });

    const claimTarget = await started.byok.dispatch({
      deviceId: target.deviceId,
      instruction: 'target-device claim isolation',
      agentRef,
      sessionRef: SESSION_REF,
    });
    await awaitEnvelope(target, (e) => e.task_id === claimTarget.taskId);
    const claimResponse = await attacker.send(
      createEnvelope('task.claim', { deviceId: attacker.deviceId, agentRef }, { taskId: claimTarget.taskId }),
    );
    expect(claimResponse.status).toBe(200);
    expect(await claimResponse.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect((await started.byok.tasks.get(claimTarget.taskId))?.state).toBe('Offered');

    const declineTarget = await started.byok.dispatch({
      deviceId: target.deviceId,
      instruction: 'target-device decline isolation',
      agentRef,
      sessionRef: SESSION_REF,
    });
    await awaitEnvelope(target, (e) => e.task_id === declineTarget.taskId);
    const declineResponse = await attacker.send(
      createEnvelope(
        'task.decline',
        {
          reason: 'cross-device attempt',
          retryable: false,
          agentRef: { ...agentRef, profileRevision: 'wrong' },
        },
        { taskId: declineTarget.taskId },
      ),
    );
    expect(declineResponse.status).toBe(200);
    expect(await declineResponse.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect((await started.byok.tasks.get(declineTarget.taskId))?.state).toBe('Offered');
  });
});

// Deleted with `sqlite-task-store.ts` (WP3B Step 2b): the "reads an AgentRef
// back after SQLite restart" case drove `SqliteTaskStore` directly. There is
// no embedder-supplied task store any more (ADR-028); the durable adapter fact
// belongs to the Step 3 SQLite composition run against the conformance suites
// — see the notes' 2b conformance skim, class (C).
