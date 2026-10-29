import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import {
  claimAndStart, connectFakeDaemonLongPoll, sendOne, startServer, stopServer,
  TEST_AGENT_DISPATCH, TEST_AGENT_REF, TEST_SESSION_REF,
} from './test-support';

/** Compare every overlapping output key, including keys added after this test. */
function agree(projections: Record<string, object>): void {
  const entries = Object.entries(projections);
  for (const [index, [leftName, left]] of entries.entries()) {
    for (const [rightName, right] of entries.slice(index + 1)) {
      for (const key of Object.keys(left).filter(key => Object.hasOwn(right, key))) {
        expect(Reflect.get(left, key), `${leftName}.${key} vs ${rightName}.${key}`)
          .toEqual(Reflect.get(right, key));
      }
    }
  }
}

/**
 * TaskResult deliberately narrows device evidence (snapshot.ts). Compare the
 * union of the remaining output keys, not just their intersection: otherwise
 * losing an optional field such as code would make its assertion disappear.
 * New terminal fields require an explicit decision about this narrowing.
 */
function resultFields(payload: object): object {
  type Keys<T> = T extends unknown ? keyof T : never;
  type Terminal = NonNullable<Awaited<ReturnType<ByokServer['tasks']['deviceTerminal']>>>;
  type Snapshot = NonNullable<Awaited<ReturnType<ByokServer['tasks']['get']>>>;
  const evidenceOnly = {
    agentRef: true, harnessId: true, recovery: true, agentHomeProjection: true,
    agentHomeMemoryChange: true, usage: true, preparedObservation: true,
    sealed: true, sealing: true, admission: true,
  } satisfies Record<Exclude<Keys<Terminal['envelope']['payload']>, keyof NonNullable<Snapshot['result']>>, true>;
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !Object.hasOwn(evidenceOnly, key)));
}

const usage = {
  runtime: 'pi' as const, provider: 'observed-provider', model: 'observed-model',
  promptTokens: 17, completionTokens: 5, durationMs: 123,
  clientVersion: '0.31.0', reportedAt: '2026-10-29T00:00:00.000Z',
};
const terminals = [
  { name: 'complete', state: 'Complete', type: 'task.complete', payload: {
    agentRef: TEST_AGENT_REF, summary: 'commentary and answer', finalMessage: 'answer',
    sessionRef: TEST_SESSION_REF, artifactRefs: [], usage,
  } },
  { name: 'failure', state: 'Failed', type: 'task.fail', payload: {
    agentRef: TEST_AGENT_REF, reason: 'quota reached', retryable: false,
    failure: { class: 'quota', resetsAt: '2026-10-30T00:00:00.000Z' }, usage,
  } },
  { name: 'decline', state: 'Failed', type: 'task.decline', payload: {
    agentRef: TEST_AGENT_REF, reason: 'writer occupied', retryable: true, code: 'agent_home_writer_busy',
  } },
  { name: 'cancelled', state: 'Cancelled', type: 'task.cancelled', payload: {
    agentRef: TEST_AGENT_REF, reason: 'device stopped', usage,
  } },
] as const;

describe('ByokServer.tasks projection contract (#1113)', () => {
  let byok: ByokServer | undefined;
  let http: Awaited<ReturnType<typeof startServer>> | undefined;

  afterEach(async () => {
    await byok?.close();
    if (http) await stopServer(http.server);
    byok = undefined;
    http = undefined;
  });

  it.each(terminals)('agrees across all eight readers after $name', async terminal => {
    const instance = createByokServer({
      productId: 'projection-contract', longPollHoldMs: 20,
      agentMessage: { consume: async () => ({ outcome: 'accepted' }) },
    });
    byok = instance;
    http = await startServer(instance);
    const daemon = await connectFakeDaemonLongPoll(http.baseUrl, instance, {
      productId: 'projection-contract', capabilities: [
        'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack',
        'agent-message-egress', 'terminal-projection-selection',
      ],
    });
    const handle = await instance.dispatch({
      ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'compare readers',
      egressPolicy: {
        policyRevision: '1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
        reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
        transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
      },
      messageEgress: { mode: 'required', contract: 'projection.v1', contentType: 'text/plain', maxBytes: 1024 },
      terminalProjection: { mode: 'none' }, agentMessageContext: { destinationBinding: 'contract' },
    });
    const { taskId } = handle;
    // Decline is a pre-claim terminal. Other scenarios exercise claim metadata.
    if (terminal.name !== 'decline') await claimAndStart(instance, daemon, handle, 'pi');
    const body = 'projection answer';
    const publish = createEnvelope('agent.message.publish', {
      agentRef: TEST_AGENT_REF, sessionRef: TEST_SESSION_REF, contract: 'projection.v1',
      messageId: '10000000-0000-4000-8000-000000000113', cursor: 1,
      contentType: 'text/plain', body, byteCount: Buffer.byteLength(body),
      contentHash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    }, { taskId });
    for (const envelope of [
      createEnvelope('agent.message.draft', { agentRef: TEST_AGENT_REF, revision: 1, offset: 0, text: body }, { taskId }),
      publish,
    ]) {
      expect(await sendOne(daemon, envelope)).toMatchObject({ status: 200, body: { accepted: 1 } });
    }
    const publishedDraft = [];
    for await (const event of instance.tasks.messageDraft(taskId, daemon.deviceId, TEST_AGENT_REF)) publishedDraft.push(event);
    expect(await sendOne(daemon, createEnvelope(terminal.type, terminal.payload, { taskId }) as Envelope))
      .toMatchObject({ status: 200, body: { accepted: 1 } });

    const [get, attempt, deviceTerminal, offer, agentMessage, messageDisposition] = await Promise.all([
      instance.tasks.get(taskId), instance.tasks.attempt(taskId), instance.tasks.deviceTerminal(taskId),
      instance.tasks.offer(taskId), instance.tasks.agentMessage(taskId, daemon.deviceId, TEST_AGENT_REF),
      instance.tasks.messageDisposition(taskId, daemon.deviceId, publish.payload),
    ]);
    const events = [];
    for await (const entry of instance.tasks.events(taskId)) events.push(entry.event);
    const messageDraft = [];
    for await (const event of instance.tasks.messageDraft(taskId, daemon.deviceId, TEST_AGENT_REF)) messageDraft.push(event);

    expect(get).toBeDefined();
    expect(attempt).toBeDefined();
    expect(deviceTerminal).toBeDefined();
    expect(offer).toBeDefined();
    expect(agentMessage).toBeDefined();
    expect(messageDisposition).toBeDefined();
    agree({ get: get!, attempt: attempt!, offer: offer! });
    agree({ get: get!, offer: offer!.payload, terminal: deviceTerminal!.envelope.payload, message: agentMessage!.payload });
    expect(deviceTerminal!.envelope.task_id).toBe(taskId);
    expect(deviceTerminal!.envelope.type).toBe(terminal.type);
    expect(deviceTerminal!.envelope.payload).toEqual(terminal.payload);
    expect(attempt!.status).toBe(terminal.state.toLowerCase());
    expect(get!.state).toBe(terminal.state);
    expect(get!.result).toEqual({ ...resultFields(deviceTerminal!.envelope.payload), state: terminal.state });
    const stateEvents = events.filter(event => event.kind === 'state');
    expect(stateEvents.at(-1)?.state).toBe(get!.state);
    for (const event of events.filter(event => event.kind === 'error')) agree({ event, result: get!.result! });

    expect(agentMessage!.payload).toEqual(publish.payload);
    expect(agentMessage!.disposition).toEqual(messageDisposition);
    agree({ message: agentMessage!.payload, disposition: messageDisposition! });
    expect(messageDisposition!.outcome).toBe('accepted');
    expect(messageDraft.at(-1)).toEqual({ kind: 'ended' });
    // Terminal ingestion deletes display-only draft text; the published body survives.
    expect(publishedDraft.at(-1)).toEqual(messageDraft.at(-1));
    expect(publishedDraft.filter(event => event.kind === 'append').map(event => event.text).join(''))
      .toBe(agentMessage!.payload.body);
  });
});
