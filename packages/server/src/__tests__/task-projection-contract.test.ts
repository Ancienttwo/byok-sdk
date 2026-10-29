import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import {
  claimAndStart, connectFakeDaemonLongPoll, sendOne, startServer, stopServer,
  TEST_AGENT_DISPATCH, TEST_AGENT_REF, TEST_SESSION_REF,
} from './test-support';

type Read<K extends 'get' | 'attempt' | 'offer' | 'deviceTerminal' | 'agentMessage' | 'messageDisposition'> =
  NonNullable<Awaited<ReturnType<ByokServer['tasks'][K]>>>;
type Plain<T> = Extract<T, { sealed?: undefined }>;
type TerminalPayload<K extends Read<'deviceTerminal'>['envelope']['type']> =
  Plain<Extract<Read<'deviceTerminal'>['envelope'], { type: K }>['payload']>;
type TaskEvent = ReturnType<ByokServer['tasks']['events']> extends AsyncIterable<infer Entry>
  ? Entry extends { event: infer Event } ? Event : never : never;
type Projections = {
  get: Read<'get'>;
  attempt: Read<'attempt'>;
  offer: Read<'offer'>;
  offerPayload: Plain<Read<'offer'>['payload']>;
  'task.complete': TerminalPayload<'task.complete'>;
  'task.fail': TerminalPayload<'task.fail'>;
  'task.decline': TerminalPayload<'task.decline'>;
  'task.cancelled': TerminalPayload<'task.cancelled'>;
  message: Read<'agentMessage'>['payload'];
  disposition: Read<'messageDisposition'>;
  error: Extract<TaskEvent, { kind: 'error' }>;
  result: NonNullable<Read<'get'>['result']>;
};
type DeclaredFields<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? false : true };

/**
 * Every declared key must be classified, including optional keys. A type
 * addition/removal or requiredness change fails typecheck until this table is
 * updated. True means required; false means optional, not excluded.
 */
const fields = {
  get: {
    taskId: true, state: true, deviceId: false, sessionRef: false, agentRef: false,
    createdAt: true, updatedAt: true, result: false, pendingApprovalId: false,
    claimedRuntime: false, claimedHarnessId: false, claimedRuntimeCapabilities: false,
  },
  attempt: {
    tenantId: true, taskId: true, deviceId: true, agentRef: false, ownerDeviceId: false,
    status: true, claimedRuntime: false, claimedHarnessId: false, claimedRuntimeCapabilities: false,
    terminalCause: false, cancellation: false, offeredAt: false, claimedAt: false,
    firstOutputAt: false, terminalAt: false, archivedAt: false, updatedAt: true,
  },
  offer: { taskId: true, deviceId: true, messageId: true, type: true, payload: true, recordedAt: true, delivered: true },
  offerPayload: {
    sealed: false, sealing: false, routineRef: false, instruction: false, agentRef: true,
    session: true, preparation: false, agentMemory: false, homeAccess: false, requiredToolsets: false,
    runtime: false, harnessId: false, dispatchSelection: false, terminalProjection: false,
    limits: false, egressPolicy: false, messageEgress: false,
  },
  'task.complete': {
    sealed: false, sealing: false, harnessId: false, summary: true, finalMessage: false,
    sessionRef: true, artifactRefs: false, document: false, usage: false, preparedObservation: false,
    agentRef: false, agentHomeProjection: false, agentHomeMemoryChange: false,
  },
  'task.fail': {
    sealed: false, sealing: false, recovery: false, harnessId: false, reason: true,
    retryable: false, failure: false, usage: false, preparedObservation: false,
    agentRef: false, agentHomeProjection: false, agentHomeMemoryChange: false,
  },
  'task.decline': {
    sealed: false, sealing: false, reason: true, retryable: false, agentRef: false, code: false, admission: false,
  },
  'task.cancelled': {
    sealed: false, sealing: false, harnessId: false, reason: false, usage: false,
    agentRef: false, agentHomeProjection: false, agentHomeMemoryChange: false,
  },
  message: {
    agentRef: true, sessionRef: true, contract: true, messageId: true, cursor: true,
    contentType: true, body: true, contentHash: true, byteCount: true,
  },
  disposition: {
    agentRef: true, sessionRef: true, contract: true, messageId: true, cursor: true,
    contentHash: true, outcome: true, receiptId: true, reasonCode: false,
  },
  error: { kind: true, reason: true, retryable: false },
  result: {
    state: true, summary: false, finalMessage: false, sessionRef: false, artifactRefs: false,
    reason: false, code: false, retryable: false, failure: false, document: false,
  },
} satisfies { [K in keyof Projections]: DeclaredFields<Projections[K]> };

function projection<K extends keyof Projections>(name: K, value: Projections[K]) {
  return { name, value, fields: fields[name] };
}

/** Intersect declarations, never observations: omission must not erase an assertion. */
function agree(...projections: { name: string; value: object; fields: Record<string, boolean> }[]): void {
  for (const [index, left] of projections.entries()) {
    for (const [key, required] of Object.entries(left.fields)) {
      if (required) expect(Object.hasOwn(left.value, key), `${left.name}.${key} required`).toBe(true);
    }
    for (const right of projections.slice(index + 1)) {
      for (const key of Object.keys(left.fields).filter(key => Object.hasOwn(right.fields, key))) {
        const leftValue = Reflect.get(left.value, key);
        const rightValue = Reflect.get(right.value, key);
        if (left.fields[key] || right.fields[key] || leftValue !== undefined || rightValue !== undefined) {
          expect(Object.hasOwn(left.value, key), `${left.name}.${key} present`).toBe(true);
          expect(Object.hasOwn(right.value, key), `${right.name}.${key} present`).toBe(true);
        }
        expect(leftValue, `${left.name}.${key} vs ${right.name}.${key}`).toEqual(rightValue);
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
    if (offer!.payload.sealing !== undefined || deviceTerminal!.envelope.payload.sealed !== undefined) {
      throw new Error('This fixture exercises plaintext projections');
    }
    agree(projection('get', get!), projection('attempt', attempt!), projection('offer', offer!));
    agree(
      projection('get', get!), projection('offerPayload', offer!.payload),
      projection(deviceTerminal!.envelope.type, deviceTerminal!.envelope.payload),
      projection('message', agentMessage!.payload),
    );
    expect(deviceTerminal!.envelope.task_id).toBe(taskId);
    expect(deviceTerminal!.envelope.type).toBe(terminal.type);
    expect(deviceTerminal!.envelope.payload).toEqual(terminal.payload);
    expect(attempt!.status).toBe(terminal.state.toLowerCase());
    expect(get!.state).toBe(terminal.state);
    expect(get!.result).toEqual({ ...resultFields(deviceTerminal!.envelope.payload), state: terminal.state });
    const stateEvents = events.filter(event => event.kind === 'state');
    expect(stateEvents.at(-1)?.state).toBe(get!.state);
    for (const event of events.filter(event => event.kind === 'error')) {
      agree(projection('error', event), projection('result', get!.result!));
    }

    expect(agentMessage!.payload).toEqual(publish.payload);
    expect(agentMessage!.disposition).toEqual(messageDisposition);
    agree(projection('message', agentMessage!.payload), projection('disposition', messageDisposition!));
    expect(messageDisposition!.outcome).toBe('accepted');
    expect(messageDraft.at(-1)).toEqual({ kind: 'ended' });
    // Terminal ingestion deletes display-only draft text; the published body survives.
    expect(publishedDraft.at(-1)).toEqual(messageDraft.at(-1));
    expect(publishedDraft.filter(event => event.kind === 'append').map(event => event.text).join(''))
      .toBe(agentMessage!.payload.body);
  });
});
