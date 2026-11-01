import { createHash, randomBytes } from 'node:crypto';
import { InMemoryAgentMessageDraftStore } from '@byok-sdk/cloud';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentMessagePublishPlainPayload } from '@byok-sdk/protocol';
import { createByokServer, createHmacTokenSigner, type ByokServer } from '../index';
import { TaskEventRelay } from '../relay';
import { connectFakeDaemonLongPoll, startServer, stopServer, type FakeLongPollDaemon } from './test-support';

const agentRef = { agentId: 'draft-agent', profileRevision: '1' };
const taskId = 'draft-task';
let instance: ByokServer;
let http: Awaited<ReturnType<typeof startServer>>;
let daemon: FakeLongPollDaemon;
let abort: AbortController;
let disposition: 'accepted' | 'held' | 'refused';
const frame = (text: string, offset = 0, revision = 1, overflow?: true) => createEnvelope('agent.message.draft', {
  agentRef, text, offset, revision, ...(overflow ? { overflow } : {}),
}, { taskId });
const publish = () => createEnvelope('agent.message.publish', { agentRef, sessionRef: 'session', contract: 'draft.v1',
  messageId: '10000000-0000-4000-8000-000000000500', cursor: 1, contentType: 'text/plain', body: '你好!', byteCount: 7,
  contentHash: `sha256:${'a'.repeat(64)}` }, { taskId });
const stream = (after?: { revision: number; offset: number }) => instance.tasks.messageDraft(taskId, daemon.deviceId, agentRef,
  { signal: abort.signal, ...(after ? { after } : {}) })[Symbol.asyncIterator]();
async function send(envelope: Parameters<FakeLongPollDaemon['send']>[0]) {
  const response = await daemon.send(envelope);
  expect(response.status).toBe(200);
  const body = await response.json() as { accepted: number; rejected?: number };
  expect(body.accepted).toBe(1);
  expect(body.rejected ?? 0).toBe(0);
}

beforeEach(async () => {
  disposition = 'accepted';
  abort = new AbortController();
  instance = createByokServer({ productId: 'draft-tests', storage: { kind: 'memory' }, longPollHoldMs: 20,
    tokenSigner: createHmacTokenSigner(randomBytes(32), { now: () => new Date() }),
    agentMessage: { consume: async () => ({ outcome: disposition }) } });
  http = await startServer(instance);
  daemon = await connectFakeDaemonLongPoll(http.baseUrl, instance, { productId: 'draft-tests', capabilities: [
    'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-message-egress',
    'agent-egress-fresh-session', 'terminal-projection-selection',
  ] });
  await instance.executions.submit({ taskId, deviceId: daemon.deviceId, payload: { instruction: 'reply', agentRef, runtime: 'pi', session: { mode: 'fresh' },
    egressPolicy: { policyRevision: '1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
      reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
      transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' } },
    messageEgress: { mode: 'required', contract: 'draft.v1', contentType: 'text/plain', maxBytes: 16 }, terminalProjection: { mode: 'none' } },
    agentMessageContext: { destinationBinding: 'chat' } });
});
afterEach(async () => {
  abort.abort();
  vi.restoreAllMocks();
  await stopServer(http.server);
  await instance.close();
});

describe('tasks.messageDraft through real HTTP inbound', () => {
  it('wakes readers and emits ordered byte appends, then ended', async () => {
    const wake = vi.spyOn(TaskEventRelay.prototype, 'wake');
    const iterator = stream();
    const first = iterator.next();
    await send(frame('你好'));
    expect(await first).toEqual({ done: false, value: { kind: 'append', revision: 1, offset: 0, text: '你好' } });
    const second = iterator.next();
    await send(frame('!', 6));
    expect(await second).toEqual({ done: false, value: { kind: 'append', revision: 1, offset: 6, text: '!' } });
    const end = iterator.next();
    await send(publish());
    expect(await end).toEqual({ done: false, value: { kind: 'ended' } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(wake).toHaveBeenCalledWith(taskId);
  });
  it('keeps the final suffix when publication races the first snapshot read', async () => {
    const body = 'hello world';
    const message = createEnvelope('agent.message.publish', {
      ...(publish().payload as AgentMessagePublishPlainPayload), body, byteCount: Buffer.byteLength(body),
      contentHash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    }, { taskId });
    await send(frame('hello'));
    const originalRead = InMemoryAgentMessageDraftStore.prototype.read;
    // This fails with the old row-first order: it pairs "hello" with ended
    // and exits before it can emit " world". The wrapper returns the real row.
    const read = vi.spyOn(InMemoryAgentMessageDraftStore.prototype, 'read').mockImplementationOnce(
      async function (this: InMemoryAgentMessageDraftStore, tenant, id) {
        const row = await originalRead.call(this, tenant, id);
        expect(row).toMatchObject({ taskId, text: 'hello', byteCount: 5 });
        await send(frame(' world', 5));
        await send(message);
        return row;
      },
    );
    const events = [];
    for await (const event of instance.tasks.messageDraft(taskId, daemon.deviceId, agentRef, { signal: abort.signal })) {
      events.push(event);
    }
    expect(events.filter(event => event.kind === 'append').map(event => event.text).join('')).toBe(body);
    expect(events).toEqual([
      { kind: 'append', revision: 1, offset: 0, text: 'hello' },
      { kind: 'append', revision: 1, offset: 5, text: ' world' },
      { kind: 'ended' },
    ]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await instance.tasks.agentMessage(taskId, daemon.deviceId, agentRef)).toMatchObject({
      payload: { body }, disposition: { outcome: 'accepted' },
    });
  });
  it('resumes a UTF-8 suffix and sends a full replacement for a new revision', async () => {
    await send(frame('你好!'));
    const iterator = stream({ revision: 1, offset: 6 });
    expect((await iterator.next()).value).toEqual({ kind: 'append', revision: 1, offset: 6, text: '!' });
    const next = iterator.next();
    await send(frame('new', 0, 2));
    expect((await next).value).toEqual({ kind: 'append', revision: 2, offset: 0, text: 'new' });
    abort.abort();
    expect((await iterator.next()).done).toBe(true);
  });
  it.each(['gap', 'overflow'] as const)('emits %s once per revision and accepts a replacement', async state => {
    await send(frame('hello'));
    if (state === 'gap') await send(frame('x', 6));
    else await send(frame('', 5, 1, true));
    const iterator = stream();
    expect((await iterator.next()).value).toEqual({ kind: 'append', revision: 1, offset: 0, text: 'hello' });
    expect((await iterator.next()).value).toEqual(state === 'gap' ? { kind: 'gap', revision: 1 } : { kind: 'overflow', revision: 1, byteCount: 5 });
    const next = iterator.next();
    await send(frame('ignored', 5));
    await send(frame('new', 0, 2));
    expect((await next).value).toEqual({ kind: 'append', revision: 2, offset: 0, text: 'new' });
    abort.abort();
    expect((await iterator.next()).done).toBe(true);
  });
  it.each(['accepted', 'held', 'refused'] as const)('derives %s publish state without any draft frames', async outcome => {
    disposition = outcome;
    const iterator = stream();
    const next = iterator.next();
    await send(publish());
    expect((await next).value).toEqual({ kind: outcome === 'refused' ? 'discarded' : 'ended' });
    expect((await iterator.next()).done).toBe(true);
  });
  it('deletes refused drafts and device terminal drafts', async () => {
    await send(frame('你好'));
    disposition = 'refused';
    await send(publish());
    const iterator = stream();
    expect((await iterator.next()).value).toEqual({ kind: 'discarded' });
    expect((await iterator.next()).done).toBe(true);
  });
  it('waits for a device terminal after host cancellation, then discards', async () => {
    await send(frame('你好'));
    await instance.tasks.cancel(taskId, 'stop');
    const iterator = stream();
    expect((await iterator.next()).value).toEqual({ kind: 'append', revision: 1, offset: 0, text: '你好' });
    const next = iterator.next();
    await send(createEnvelope('task.cancelled', { agentRef, reason: 'stop' }, { taskId }));
    expect((await next).value).toEqual({ kind: 'discarded' });
    expect((await iterator.next()).done).toBe(true);
  });
  it('emits only discarded for an unsupported runtime with no published message', async () => {
    await send(createEnvelope('task.fail', { agentRef, reason: 'failed' }, { taskId }));
    const iterator = stream();
    expect((await iterator.next()).value).toEqual({ kind: 'discarded' });
    expect((await iterator.next()).done).toBe(true);
  });
  it('does not reveal data to a wrong task, device or Agent identity', async () => {
    await send(frame('secret'));
    for (const [task, device, ref] of [[taskId, 'wrong', agentRef], ['wrong', daemon.deviceId, agentRef],
      [taskId, daemon.deviceId, { ...agentRef, agentId: 'wrong' }], [taskId, daemon.deviceId, { ...agentRef, profileRevision: '2' }]] as const) {
      const values = [];
      for await (const event of instance.tasks.messageDraft(task, device, ref)) values.push(event);
      expect(values).toEqual([]);
    }
  });
  it('polls when relay wakes are lost and supports abort while waiting', async () => {
    vi.spyOn(TaskEventRelay.prototype, 'wake').mockImplementation(() => {});
    const iterator = stream();
    const next = iterator.next();
    await send(frame('polled'));
    expect((await next).value).toEqual({ kind: 'append', revision: 1, offset: 0, text: 'polled' });
    const waiting = iterator.next();
    abort.abort();
    expect((await waiting).done).toBe(true);
  });
  it('closes a pending iterator without a caller signal and releases its wake subscription', async () => {
    const iterator = instance.tasks.messageDraft(taskId, daemon.deviceId, agentRef)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await instance.close();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
  it('refuses additional frames once a message is published', async () => {
    await send(publish());
    expect(await (await daemon.send(frame('late'))).json()).toMatchObject({ accepted: 0, rejected: 1 });
  });
});
