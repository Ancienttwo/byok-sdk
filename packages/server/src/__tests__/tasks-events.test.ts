import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCloudError } from '@byok-sdk/cloud';
import { tenantId } from '@byok-sdk/core';
import { createEnvelope, type Envelope, type TaskState } from '@byok-sdk/protocol';
import { TaskEventRelay } from '../relay';
import { readTaskEvents } from '../task-handle';
import {
  createByokServer,
  createHmacTokenSigner,
  TaskEventsUnavailableError,
  type ByokServer,
  type CreateByokServerOptions,
  type TaskEventEntry,
} from '../index';
import {
  claimAndStart,
  connectFakeDaemonLongPoll,
  startServer,
  stopServer,
  TEST_AGENT_DISPATCH,
  TEST_AGENT_REF,
  type FakeLongPollDaemon,
} from './test-support';

const PRODUCT_ID = 'acme-task-events';
const AGENT = { agentId: 'events-agent', profileRevision: 'rev-1' };
const EXECUTION_CAPABILITIES = [
  'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection',
];
const EGRESS_POLICY = {
  policyRevision: '1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;
const BLOB_REF = {
  blobId: 'blob-large', contentHash: `sha256:${'a'.repeat(64)}`, size: 70_000, contentType: 'application/octet-stream',
};

async function collect(entries: AsyncIterable<TaskEventEntry>): Promise<TaskEventEntry[]> {
  const result: TaskEventEntry[] = [];
  for await (const entry of entries) result.push(entry);
  return result;
}

/** The first `next()`: where every refusal surfaces, without waiting on a live feed. */
function first(entries: AsyncIterable<TaskEventEntry>): Promise<IteratorResult<TaskEventEntry>> {
  return entries[Symbol.asyncIterator]().next();
}

async function take(reader: AsyncIterator<TaskEventEntry>, count: number): Promise<TaskEventEntry[]> {
  const result: TaskEventEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const next = await reader.next();
    if (next.done) throw new Error(`feed ended after ${result.length} of ${count} entries`);
    result.push(next.value);
  }
  return result;
}

/** The cursor's in-feed position. Tests may read the opaque form; hosts may not. */
function position(entry: TaskEventEntry): number {
  return Number(entry.cursor.slice(entry.cursor.lastIndexOf('.') + 1));
}

function unavailable(taskId: string, reason: 'cursor_unknown' | 'feed_expired') {
  return { name: 'TaskEventsUnavailableError', taskId, reason };
}

function progress(seq: number, ...texts: string[]) {
  return { seq, events: texts.map((text) => ({ type: 'progress', text })) };
}

/** A `readState` answer: the projected state and its `updatedAt`. */
function stateRead(state: TaskState) {
  return { state, at: '2026-10-27T00:00:00.000Z' };
}

type StateRead = ReturnType<typeof stateRead> | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('ByokServer.tasks.events', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(options: Partial<CreateByokServerOptions> = {}): Promise<{ byok: ByokServer; daemon: FakeLongPollDaemon }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 150, ...options });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID, capabilities: EXECUTION_CAPABILITIES });
    return { byok: instance, daemon };
  }

  async function submit(instance: ByokServer, daemon: FakeLongPollDaemon, taskId: string): Promise<void> {
    await instance.executions.submit({
      taskId,
      deviceId: daemon.deviceId,
      payload: { instruction: 'stream me', runtime: 'pi', agentRef: AGENT, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' } },
    });
  }

  async function send(daemon: FakeLongPollDaemon, envelope: Envelope): Promise<void> {
    const response = await daemon.send(envelope);
    expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: { accepted: 1 } });
  }

  async function claimStarted(daemon: FakeLongPollDaemon, taskId: string): Promise<void> {
    await send(daemon, createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef: AGENT }, { taskId }));
    await send(daemon, createEnvelope('task.started', {}, { taskId }));
  }

  it('streams a submitted task in arrival order, with increasing cursors, and ends at the terminal', async () => {
    const { byok: instance, daemon } = await start();
    await submit(instance, daemon, 'streamed');
    const reader = instance.tasks.events('streamed')[Symbol.asyncIterator]();
    await claimStarted(daemon, 'streamed');
    await send(daemon, createEnvelope('task.progress', progress(1, 'reading', 'writing'), { taskId: 'streamed' }));
    await send(daemon, createEnvelope('task.artifact', { name: 'notes.txt', contentType: 'text/plain', inline: 'aGk=' }, { taskId: 'streamed' }));
    await send(daemon, createEnvelope('task.artifact', { name: 'big.bin', contentType: 'application/octet-stream', blobRef: BLOB_REF }, { taskId: 'streamed' }));
    await send(daemon, createEnvelope('task.await_approval', { summary: 'ok to write?', approvalId: 'appr-streamed' }, { taskId: 'streamed' }));

    const head = await take(reader, 9);
    const approval = head[7]!.event;
    if (approval.kind !== 'await_approval') throw new Error(`expected await_approval, got ${approval.kind}`);
    // The event carries the id the Host decides by, so no tasks.get is needed first.
    await instance.tasks.approve('streamed', { approvalId: approval.approvalId });
    await send(daemon, createEnvelope('task.complete', { agentRef: AGENT, summary: 'done', sessionRef: 'sess-streamed' }, { taskId: 'streamed' }));
    const tail = await take(reader, 2);
    expect(await reader.next()).toEqual({ value: undefined, done: true });

    const entries = [...head, ...tail];
    expect(entries.map((entry) => entry.event)).toEqual([
      { kind: 'state', state: 'Offered', at: expect.any(String) },
      { kind: 'state', state: 'Claimed', at: expect.any(String) },
      { kind: 'state', state: 'Running', at: expect.any(String) },
      { kind: 'agent', event: { type: 'progress', text: 'reading' } },
      { kind: 'agent', event: { type: 'progress', text: 'writing' } },
      { kind: 'artifact', artifact: { name: 'notes.txt', contentType: 'text/plain', inline: 'aGk=' } },
      { kind: 'artifact', artifact: { name: 'big.bin', contentType: 'application/octet-stream', blobRef: BLOB_REF } },
      { kind: 'await_approval', summary: 'ok to write?', approvalId: 'appr-streamed' },
      { kind: 'state', state: 'AwaitApproval', at: expect.any(String) },
      { kind: 'state', state: 'Running', at: expect.any(String) },
      { kind: 'state', state: 'Complete', at: expect.any(String) },
    ]);
    const positions = entries.map(position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
    expect((await instance.tasks.get('streamed'))?.result).toMatchObject({ state: 'Complete', summary: 'done' });
  });

  it('resumes after the last cursor a stopped reader saw, without repeating entries', async () => {
    const { byok: instance, daemon } = await start();
    await submit(instance, daemon, 'resumed');
    await claimStarted(daemon, 'resumed');
    const first = instance.tasks.events('resumed')[Symbol.asyncIterator]();
    const seen = await take(first, 2);
    await first.return?.();

    const resumed = instance.tasks.events('resumed', { after: seen[1]!.cursor })[Symbol.asyncIterator]();
    expect((await take(resumed, 1))[0]!.event).toMatchObject({ kind: 'state', state: 'Running' });
    await send(daemon, createEnvelope('task.progress', progress(1, 'more'), { taskId: 'resumed' }));
    expect((await take(resumed, 1))[0]!.event).toEqual({ kind: 'agent', event: { type: 'progress', text: 'more' } });
    await resumed.return?.();
  });

  it('marks the gap once when the resume position was dropped, and not when it was retained', async () => {
    const { byok: instance, daemon } = await start({ taskEventBufferLimit: 3 });
    await submit(instance, daemon, 'clipped');
    const [offered] = await take(instance.tasks.events('clipped')[Symbol.asyncIterator](), 1);
    await claimStarted(daemon, 'clipped');
    // Offered, Claimed, Running, then two progress events: the oldest two are dropped.
    await send(daemon, createEnvelope('task.progress', progress(1, 'one', 'two'), { taskId: 'clipped' }));

    const behind = instance.tasks.events('clipped', { after: offered!.cursor })[Symbol.asyncIterator]();
    const fromBehind = await take(behind, 4);
    await behind.return?.();
    expect(fromBehind.map((entry) => entry.event)).toEqual([
      { kind: 'error', reason: 'events_truncated' },
      { kind: 'state', state: 'Running', at: expect.any(String) },
      { kind: 'agent', event: { type: 'progress', text: 'one' } },
      { kind: 'agent', event: { type: 'progress', text: 'two' } },
    ]);

    // The marker's cursor stands just before the oldest retained entry.
    const fromMarker = instance.tasks.events('clipped', { after: fromBehind[0]!.cursor })[Symbol.asyncIterator]();
    expect((await take(fromMarker, 1))[0]!.event).toMatchObject({ kind: 'state', state: 'Running' });
    await fromMarker.return?.();

    const current = instance.tasks.events('clipped', { after: fromBehind[1]!.cursor })[Symbol.asyncIterator]();
    expect((await take(current, 2)).map((entry) => entry.event)).toEqual([
      { kind: 'agent', event: { type: 'progress', text: 'one' } },
      { kind: 'agent', event: { type: 'progress', text: 'two' } },
    ]);
    await current.return?.();
  });

  it('refuses an unknown task with task_not_found and a foreign or malformed cursor with cursor_unknown', async () => {
    const { byok: instance, daemon } = await start();
    const missing = await first(instance.tasks.events('no-such-task')).catch((error: unknown) => error);
    expect(isCloudError(missing, 'task_not_found')).toBe(true);

    await submit(instance, daemon, 'mine');
    await submit(instance, daemon, 'other');
    const [mine] = await take(instance.tasks.events('mine')[Symbol.asyncIterator](), 1);
    const feedId = mine!.cursor.slice(0, mine!.cursor.lastIndexOf('.'));
    for (const after of [mine!.cursor, 'garbage', '', `${feedId}.999`, `${feedId}.-1`, `${feedId}.1e2`, `${feedId}`]) {
      const refused = await first(instance.tasks.events('other', { after })).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(TaskEventsUnavailableError);
      expect(refused).toMatchObject(unavailable('other', 'cursor_unknown'));
    }
  });

  it('refuses a terminal task once its feed is reclaimed, after replaying it within retention', async () => {
    const { byok: instance, daemon } = await start({ taskEventRetentionMs: 20 });
    await submit(instance, daemon, 'reclaimed');
    await claimStarted(daemon, 'reclaimed');
    await send(daemon, createEnvelope('task.complete', { agentRef: AGENT, summary: 'done', sessionRef: 'sess-r' }, { taskId: 'reclaimed' }));
    expect((await collect(instance.tasks.events('reclaimed'))).map((entry) => entry.event)).toMatchObject([
      { state: 'Offered' }, { state: 'Claimed' }, { state: 'Running' }, { state: 'Complete' },
    ]);
    await vi.waitFor(async () => {
      await expect(collect(instance.tasks.events('reclaimed'))).rejects.toMatchObject(unavailable('reclaimed', 'feed_expired'));
    }, { timeout: 2_000, interval: 10 });
  });

  it('ends a pending read when its signal aborts or the server closes', async () => {
    const { byok: instance, daemon } = await start();
    await submit(instance, daemon, 'stoppable');
    const abort = new AbortController();
    const aborted = instance.tasks.events('stoppable', { signal: abort.signal })[Symbol.asyncIterator]();
    await take(aborted, 1);
    const pending = aborted.next();
    abort.abort();
    expect(await pending).toEqual({ value: undefined, done: true });

    const closing = instance.tasks.events('stoppable')[Symbol.asyncIterator]();
    await take(closing, 1);
    const open = closing.next();
    await instance.close();
    expect(await open).toEqual({ value: undefined, done: true });
    expect(await instance.tasks.events('stoppable')[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
  });

  it('releases a pending read on return(), for tasks.events and TaskHandle.events()', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 150 });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'idle' });
    const readers: Array<AsyncIterator<unknown>> = [
      instance.tasks.events(handle.taskId)[Symbol.asyncIterator](),
      handle.events()[Symbol.asyncIterator](),
    ];
    for (const reader of readers) {
      await reader.next();
      const pending = reader.next();
      // Nothing else will happen to this task, so only return() can settle both.
      await expect(reader.return!()).resolves.toEqual({ value: undefined, done: true });
      await expect(pending).resolves.toEqual({ value: undefined, done: true });
      await expect(reader.next()).resolves.toEqual({ value: undefined, done: true });
    }
  });

  it('starts from the entry where the current state began with from: state, keeping its cursor', async () => {
    const { byok: instance, daemon } = await start();
    await submit(instance, daemon, 'from-state');
    await claimStarted(daemon, 'from-state');
    await send(daemon, createEnvelope('task.progress', progress(1, 'earlier line'), { taskId: 'from-state' }));
    const whole = await take(instance.tasks.events('from-state')[Symbol.asyncIterator](), 4);
    const reader = instance.tasks.events('from-state', { from: 'state' })[Symbol.asyncIterator]();
    expect(await take(reader, 2)).toEqual([whole[2], whole[3]]);
    expect(whole[2]!.event).toMatchObject({ kind: 'state', state: 'Running' });
    await send(daemon, createEnvelope('task.await_approval', { summary: 'ok to write?', approvalId: 'appr-from-state' }, { taskId: 'from-state' }));
    const waiting = await take(reader, 2);
    expect(waiting.map((entry) => entry.event)).toMatchObject([
      { kind: 'await_approval', summary: 'ok to write?', approvalId: 'appr-from-state' }, { kind: 'state', state: 'AwaitApproval' },
    ]);
    await reader.return!();
    // While it awaits approval the start is the request, then its state.
    expect(await take(instance.tasks.events('from-state', { from: 'state' })[Symbol.asyncIterator](), 2)).toEqual(waiting);
  });

  it('keeps the from: state start past drop-oldest, then marks the gap before what is retained', async () => {
    const { byok: instance, daemon } = await start({ taskEventBufferLimit: 3 });
    await submit(instance, daemon, 'long-running');
    await claimStarted(daemon, 'long-running');
    await send(daemon, createEnvelope('task.await_approval', { summary: 'ok?', approvalId: 'appr-long' }, { taskId: 'long-running' }));
    const pinned = await take(instance.tasks.events('long-running', { from: 'state' })[Symbol.asyncIterator](), 2);
    await send(daemon, createEnvelope('task.progress', progress(1, 'a', 'b', 'c', 'd'), { taskId: 'long-running' }));
    const reader = instance.tasks.events('long-running', { from: 'state' })[Symbol.asyncIterator]();
    const read = await take(reader, 6);
    expect(read.slice(0, 2)).toEqual(pinned);
    expect(read.slice(2).map((entry) => entry.event)).toMatchObject([
      { kind: 'error', reason: 'events_truncated' }, { event: { text: 'b' } }, { event: { text: 'c' } }, { event: { text: 'd' } },
    ]);
    await reader.return!();
  });

  it('refuses after and from together before any entry', async () => {
    const { byok: instance, daemon } = await start();
    await submit(instance, daemon, 'both');
    await expect(first(instance.tasks.events('both', { after: 'x.0', from: 'state' }))).rejects.toThrow(TypeError);
  });

  it('gives TaskHandle.events() the same events as tasks.events', async () => {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 150 });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });
    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'resume me' });
    const viaHandle = (async () => { const out = []; for await (const event of handle.events()) out.push(event); return out; })();
    const viaTasks = collect(instance.tasks.events(handle.taskId));
    await claimAndStart(instance, daemon, handle);
    await send(daemon, createEnvelope('task.progress', progress(1, 'shared'), { taskId: handle.taskId }));
    await send(daemon, createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'done', sessionRef: 'sess-h' }, { taskId: handle.taskId }));
    const fromTasks = (await viaTasks).map((entry) => entry.event);
    expect(await viaHandle).toEqual(fromTasks);
    expect(fromTasks).toMatchObject([
      { state: 'Offered' }, { state: 'Claimed' }, { state: 'Running' }, { kind: 'agent' }, { state: 'Complete' },
    ]);
  });
});

describe('ByokServer.tasks.events across a SQLite restart', () => {
  it('follows a live task from now on, refuses old cursors, and refuses a Host-cancelled task', async () => {
    const root = mkdtempSync(join(tmpdir(), 'byok-task-events-restart-'));
    const options = {
      productId: PRODUCT_ID, storage: { kind: 'sqlite' as const, path: join(root, 'sdk.sqlite') }, longPollHoldMs: 20,
      // The device's access token must stay valid across the restart.
      tokenSigner: createHmacTokenSigner(randomBytes(32), { now: () => new Date() }),
    };
    let instance = createByokServer(options);
    let http = await startServer(instance);
    try {
      const daemon = await connectFakeDaemonLongPoll(http.baseUrl, instance, { productId: PRODUCT_ID, capabilities: EXECUTION_CAPABILITIES });
      // After the restart the daemon fixture still dials the old port.
      const post = async (envelope: Envelope) => {
        const response = await fetch(`${http.baseUrl}/byok/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.accessToken}` },
          body: JSON.stringify({ messages: [envelope] }),
        });
        expect(await response.json()).toMatchObject({ accepted: 1 });
      };
      for (const taskId of ['survivor', 'cancelled']) {
        await instance.executions.submit({
          taskId, deviceId: daemon.deviceId,
          payload: { instruction: 'outlive me', runtime: 'pi', agentRef: AGENT, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' } },
        });
        await post(createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef: AGENT }, { taskId }));
        await post(createEnvelope('task.started', {}, { taskId }));
      }
      await post(createEnvelope('task.progress', progress(1, 'before restart'), { taskId: 'survivor' }));
      const before = await take(instance.tasks.events('survivor')[Symbol.asyncIterator](), 4);
      const oldCursor = before[3]!.cursor;
      // Accepted by the Host; the device never acknowledges it.
      await instance.tasks.cancel('cancelled', 'no longer needed');

      await stopServer(http.server);
      await instance.close();
      instance = createByokServer(options);
      http = await startServer(instance);

      await expect(first(instance.tasks.events('survivor', { after: oldCursor })))
        .rejects.toMatchObject(unavailable('survivor', 'cursor_unknown'));
      // Terminal by the snapshot projection while the attempt is still
      // cancel_requested: refused at once rather than waiting on the device.
      await expect(first(instance.tasks.events('cancelled'))).rejects.toMatchObject(unavailable('cancelled', 'feed_expired'));

      const reader = instance.tasks.events('survivor')[Symbol.asyncIterator]();
      // The attached feed starts with the state the read found, so once it
      // arrives the feed listens for the next envelope.
      expect((await reader.next()).value?.event).toEqual({ kind: 'state', state: 'Running', at: (await instance.tasks.get('survivor'))!.updatedAt });
      // Enough entries that the new feed has handed out the old cursor's
      // position too: only the feed id tells the two apart.
      await post(createEnvelope('task.progress', progress(2, 'a', 'b', 'c', 'd', 'e', 'f'), { taskId: 'survivor' }));
      const rest = await take(reader, 6);
      expect(rest.map((entry) => entry.event)).toMatchObject([
        { event: { text: 'a' } }, { event: { text: 'b' } }, { event: { text: 'c' } }, { event: { text: 'd' } }, { event: { text: 'e' } }, { event: { text: 'f' } },
      ]);
      expect(position(rest[5]!)).toBeGreaterThan(Number(oldCursor.slice(oldCursor.lastIndexOf('.') + 1)));
      await expect(first(instance.tasks.events('survivor', { after: oldCursor })))
        .rejects.toMatchObject(unavailable('survivor', 'cursor_unknown'));

      await post(createEnvelope('task.complete', { agentRef: AGENT, summary: 'finished after restart', sessionRef: 'sess-s' }, { taskId: 'survivor' }));
      expect((await take(reader, 1))[0]!.event).toMatchObject({ kind: 'state', state: 'Complete' });
      expect(await reader.next()).toEqual({ value: undefined, done: true });
    } finally {
      await stopServer(http.server);
      await instance.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ByokServer.tasks.events after a SQLite restart, when the task is submitted again', () => {
  it('keeps a delivered task\'s attached feed as it is: the resubmit is refused before the relay hears of it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'byok-task-events-resubmit-'));
    const options = {
      productId: PRODUCT_ID, storage: { kind: 'sqlite' as const, path: join(root, 'sdk.sqlite') }, longPollHoldMs: 20,
      tokenSigner: createHmacTokenSigner(randomBytes(32), { now: () => new Date() }),
    };
    let instance = createByokServer(options);
    let http = await startServer(instance);
    try {
      const daemon = await connectFakeDaemonLongPoll(http.baseUrl, instance, { productId: PRODUCT_ID, capabilities: EXECUTION_CAPABILITIES });
      const post = async (envelope: Envelope) => {
        const response = await fetch(`${http.baseUrl}/byok/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.accessToken}` },
          body: JSON.stringify({ messages: [envelope] }),
        });
        expect(await response.json()).toMatchObject({ accepted: 1 });
      };
      const input = {
        taskId: 'resubmitted', deviceId: daemon.deviceId,
        payload: { instruction: 'outlive me', runtime: 'pi' as const, agentRef: AGENT, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' as const } },
      };
      await instance.executions.submit(input);
      await post(createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef: AGENT }, { taskId: 'resubmitted' }));
      await post(createEnvelope('task.started', {}, { taskId: 'resubmitted' }));

      await stopServer(http.server);
      await instance.close();
      instance = createByokServer(options);
      http = await startServer(instance);

      const reader = instance.tasks.events('resubmitted')[Symbol.asyncIterator]();
      expect((await reader.next()).value?.event).toMatchObject({ kind: 'state', state: 'Running' });
      await expect(instance.executions.submit(input)).rejects.toMatchObject({ code: 'agent_task_already_exists' });
      await post(createEnvelope('task.progress', progress(1, 'after the refused resubmit'), { taskId: 'resubmitted' }));
      // No `Offered` with the original timestamp lands after the live state.
      expect((await reader.next()).value?.event).toEqual({ kind: 'agent', event: { type: 'progress', text: 'after the refused resubmit' } });
      await reader.return!();
    } finally {
      await stopServer(http.server);
      await instance.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('TaskEventRelay dispatch phases', () => {
  const started = (taskId: string) => ({
    tenantId: tenantId(PRODUCT_ID), deviceId: 'device-a', outcome: 'accepted' as const,
    envelope: createEnvelope('task.started', {}, { taskId }),
  });

  async function states(relay: TaskEventRelay, taskId: string, count: number): Promise<unknown[]> {
    const reader = relay.entries(taskId, relay.feed(taskId)!)[Symbol.asyncIterator]();
    const values: unknown[] = [];
    for (let i = 0; i < count; i += 1) values.push((await reader.next()).value?.value);
    return values;
  }

  it('puts Offered first when the device reports during a dispatch over an attached feed (#1033)', async () => {
    const relay = new TaskEventRelay({});
    const attached = relay.attach('resubmitted');
    relay.provision('resubmitted');
    relay.onInboundCommitted(started('resubmitted'));
    relay.noteDispatched('resubmitted', '2026-10-27T00:00:00.000Z');
    expect(relay.feed('resubmitted')).toBe(attached);
    expect(await states(relay, 'resubmitted', 2)).toMatchObject([{ state: 'Offered' }, { state: 'Running' }]);
    relay.stop();
  });

  it('returns an attached feed to its readers with what it buffered when the dispatch is refused', async () => {
    const relay = new TaskEventRelay({});
    const attached = relay.attach('refused');
    relay.provision('refused');
    relay.onInboundCommitted(started('refused'));
    relay.abort('refused');
    expect(relay.feed('refused')).toBe(attached);
    expect(await states(relay, 'refused', 1)).toMatchObject([{ state: 'Running' }]);
    relay.onInboundCommitted(started('refused'));
    expect(await states(relay, 'refused', 2)).toMatchObject([{ state: 'Running' }, { state: 'Running' }]);
    relay.stop();
  });

  it('starts a dispatched feed at Offered with from: state after drop-oldest discarded it', async () => {
    const relay = new TaskEventRelay({ taskEventBufferLimit: 2 });
    relay.provision('offered');
    relay.noteDispatched('offered', '2026-10-27T00:00:00.000Z');
    relay.onInboundCommitted({
      tenantId: tenantId(PRODUCT_ID), deviceId: 'device-a', outcome: 'accepted',
      envelope: createEnvelope('task.progress', progress(1, 'a', 'b', 'c'), { taskId: 'offered' }),
    });
    const reader = readTaskEvents({ relay, readState: async () => stateRead('Offered') }, 'offered', { from: 'state' })[Symbol.asyncIterator]();
    expect((await reader.next()).value?.event).toEqual({ kind: 'state', state: 'Offered', at: '2026-10-27T00:00:00.000Z' });
    await reader.return!();
    relay.stop();
  });

  it('holds a Host transition made while a dispatch is in flight until Offered', async () => {
    const relay = new TaskEventRelay({});
    relay.provision('cancelled-early');
    relay.noteHostTransition('cancelled-early', 'Cancelled', '2026-10-27T00:00:01.000Z');
    relay.noteDispatched('cancelled-early', '2026-10-27T00:00:00.000Z');
    expect(await states(relay, 'cancelled-early', 2)).toMatchObject([{ state: 'Offered' }, { state: 'Cancelled' }]);
    relay.stop();
  });
});

describe('readTaskEvents against the relay', () => {
  it('leaves a provisional dispatch feed alone when the task is not stored yet', async () => {
    const relay = new TaskEventRelay({});
    relay.provision('in-flight');
    const provisional = relay.feed('in-flight');
    const refused = await first(readTaskEvents({ relay, readState: async () => undefined }, 'in-flight')).catch((error: unknown) => error);
    expect(isCloudError(refused, 'task_not_found')).toBe(true);
    expect(relay.feed('in-flight')).toBe(provisional);

    relay.noteDispatched('in-flight', '2026-10-27T00:00:00.000Z');
    const reader = readTaskEvents({ relay, readState: async () => stateRead('Offered') }, 'in-flight')[Symbol.asyncIterator]();
    expect((await reader.next()).value?.event).toEqual({ kind: 'state', state: 'Offered', at: '2026-10-27T00:00:00.000Z' });
    relay.stop();
  });

  it('attaches nothing when the read is stopped during its first store read', async () => {
    const relay = new TaskEventRelay({});
    const read = deferred<StateRead>();
    const abort = new AbortController();
    const pending = first(readTaskEvents({ relay, readState: () => read.promise }, 'stopped-early', { signal: abort.signal }));
    abort.abort();
    read.resolve(stateRead('Running'));
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(relay.feed('stopped-early')).toBeUndefined();
    relay.stop();
  });

  it('drops the feed it attached when the task turns terminal before the feed listened', async () => {
    const relay = new TaskEventRelay({});
    const reads: StateRead[] = [stateRead('Running'), stateRead('Complete')];
    const refused = await first(readTaskEvents({ relay, readState: async () => reads.shift() }, 'restarted')).catch((error: unknown) => error);
    expect(refused).toMatchObject(unavailable('restarted', 'feed_expired'));
    expect(relay.feed('restarted')).toBeUndefined();
    relay.stop();
  });

  it('repeats a state at most once when the read sees a commit the relay has not delivered yet', async () => {
    // The kernel notifies the relay only after the write's own await returns
    // (`handleInboundEnvelope`), so a read can see a state before its entry.
    const relay = new TaskEventRelay({});
    const reader = readTaskEvents(
      { relay, readState: async () => stateRead('Running') }, 'gap', { from: 'state' },
    )[Symbol.asyncIterator]();
    const seeded = reader.next();
    await vi.waitFor(() => { expect(relay.feed('gap')?.current).toHaveLength(1); });
    relay.onInboundCommitted({
      tenantId: tenantId(PRODUCT_ID), deviceId: 'device-a', outcome: 'accepted', envelope: createEnvelope('task.started', {}, { taskId: 'gap' }),
    });
    expect((await seeded).value?.event).toMatchObject({ kind: 'state', state: 'Running' });
    expect((await reader.next()).value?.event).toMatchObject({ kind: 'state', state: 'Running' });
    await reader.return!();
    relay.stop();
  });

  it('keeps a feed a host read attached when a dispatch of the same task is refused', async () => {
    const relay = new TaskEventRelay({});
    const read = deferred<StateRead>();
    const reads = [Promise.resolve<StateRead>(stateRead('Running')), read.promise];
    const reader = readTaskEvents({ relay, readState: () => reads.shift()! }, 'existing')[Symbol.asyncIterator]();
    const first = reader.next();
    await vi.waitFor(() => { expect(relay.feed('existing')).toBeDefined(); });
    const attached = relay.feed('existing');
    relay.provision('existing');
    relay.abort('existing');
    expect(relay.feed('existing')).toBe(attached);
    read.resolve(stateRead('Running'));
    relay.noteDispatched('existing', '2026-10-27T00:00:00.000Z');
    expect((await first).value?.event).toEqual({ kind: 'state', state: 'Offered', at: '2026-10-27T00:00:00.000Z' });
    relay.stop();
  });
});
