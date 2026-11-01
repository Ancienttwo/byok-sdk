import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ByokCloudError, createInProcessTaskEventsWake, isCloudError, type ActivityTail, type ActivityTailEntry } from '@byok-sdk/cloud';
import { tenantId } from '@byok-sdk/core';
import { createEnvelope, type AgentEventOrUnknown, type Envelope } from '@byok-sdk/protocol';
import { TaskEventRelay } from '../relay';
import { readTaskEvents, type ActivityLogPosition, type TaskEventFacts, type TaskEventSources } from '../task-events';
import {
  createByokServer,
  createHmacTokenSigner,
  TaskEventsUnavailableError,
  type ByokServer,
  type CreateByokServerOptions,
  type ServerTaskEvent,
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

function unknownCursor(taskId: string) {
  return { name: 'TaskEventsUnavailableError', taskId, reason: 'cursor_unknown' };
}

function progress(seq: number, ...texts: string[]) {
  return { seq, events: texts.map((text) => ({ type: 'progress', text })) };
}

function sqliteOptions(root: string) {
  return {
    productId: PRODUCT_ID, storage: { kind: 'sqlite' as const, path: join(root, 'sdk.sqlite') }, longPollHoldMs: 20,
    // The device's access token must stay valid across the restart.
    tokenSigner: createHmacTokenSigner(randomBytes(32), { now: () => new Date() }),
  };
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
      payload: { instruction: 'stream me', runtime: 'pi', session: { mode: 'fresh' }, agentRef: AGENT, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' } },
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

  it('follows state, approval and the activity log of a submitted task, with distinct cursors, and ends at the terminal', async () => {
    const { byok: instance, daemon } = await start();
    await submit(instance, daemon, 'streamed');
    const reader = instance.tasks.events('streamed')[Symbol.asyncIterator]();
    const entries = await take(reader, 1);
    await send(daemon, createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef: AGENT }, { taskId: 'streamed' }));
    entries.push(...await take(reader, 1));
    await send(daemon, createEnvelope('task.started', {}, { taskId: 'streamed' }));
    entries.push(...await take(reader, 1));
    await send(daemon, createEnvelope('task.progress', progress(1, 'reading', 'writing'), { taskId: 'streamed' }));
    await send(daemon, createEnvelope('task.artifact', { name: 'notes.txt', contentType: 'text/plain', inline: 'aGk=' }, { taskId: 'streamed' }));
    await send(daemon, createEnvelope('task.artifact', { name: 'big.bin', contentType: 'application/octet-stream', blobRef: BLOB_REF }, { taskId: 'streamed' }));
    await send(daemon, createEnvelope('task.await_approval', { summary: 'ok to write?', approvalId: 'appr-streamed' }, { taskId: 'streamed' }));
    entries.push(...await take(reader, 6));
    const approval = entries[7]!.event;
    if (approval.kind !== 'await_approval') throw new Error(`expected await_approval, got ${approval.kind}`);
    // The event carries the id the Host decides by, so no tasks.get is needed first.
    await instance.tasks.approve('streamed', { approvalId: approval.approvalId });
    entries.push(...await take(reader, 1));
    await send(daemon, createEnvelope('task.progress', progress(2, 'finishing'), { taskId: 'streamed' }));
    await send(daemon, createEnvelope('task.complete', { agentRef: AGENT, summary: 'done', sessionRef: 'sess-streamed' }, { taskId: 'streamed' }));
    entries.push(...await take(reader, 2));
    expect(await reader.next()).toEqual({ value: undefined, done: true });

    expect(entries.map((entry) => entry.event)).toEqual([
      { kind: 'state', state: 'Offered', at: expect.any(String) },
      { kind: 'state', state: 'Claimed', at: expect.any(String) },
      { kind: 'state', state: 'Running', at: expect.any(String) },
      // The window that yielded Running reads the log next, in revision order;
      // the following window yields the request, then its state.
      { kind: 'agent', event: { type: 'progress', text: 'reading' } },
      { kind: 'agent', event: { type: 'progress', text: 'writing' } },
      { kind: 'artifact', artifact: { name: 'notes.txt', contentType: 'text/plain', inline: 'aGk=' } },
      { kind: 'artifact', artifact: { name: 'big.bin', contentType: 'application/octet-stream', blobRef: BLOB_REF } },
      { kind: 'await_approval', summary: 'ok to write?', approvalId: 'appr-streamed' },
      { kind: 'state', state: 'AwaitApproval', at: expect.any(String) },
      { kind: 'state', state: 'Running', at: expect.any(String) },
      // The log is read past the terminal before the terminal is yielded.
      { kind: 'agent', event: { type: 'progress', text: 'finishing' } },
      { kind: 'state', state: 'Complete', at: expect.any(String) },
    ]);
    // A position names what was consumed of each source, so it changes with every log entry.
    const logCursors = entries.filter((entry) => entry.event.kind === 'agent' || entry.event.kind === 'artifact').map((entry) => entry.cursor);
    expect(new Set(logCursors).size).toBe(logCursors.length);
    expect((await instance.tasks.get('streamed'))?.result).toMatchObject({ state: 'Complete', summary: 'done' });
  });

  it('resumes after any cursor without repeating entries, including inside one progress batch', async () => {
    const { byok: instance, daemon } = await start();
    await submit(instance, daemon, 'resumed');
    await claimStarted(daemon, 'resumed');
    await send(daemon, createEnvelope('task.progress', progress(1, 'a', 'b', 'c'), { taskId: 'resumed' }));
    const reader = instance.tasks.events('resumed')[Symbol.asyncIterator]();
    const seen = await take(reader, 3);
    await reader.return!();
    expect(seen.map((entry) => entry.event)).toMatchObject([{ state: 'Running' }, { event: { text: 'a' } }, { event: { text: 'b' } }]);

    const resumed = instance.tasks.events('resumed', { after: seen[2]!.cursor })[Symbol.asyncIterator]();
    expect((await take(resumed, 1))[0]!.event).toEqual({ kind: 'agent', event: { type: 'progress', text: 'c' } });
    await send(daemon, createEnvelope('task.progress', progress(2, 'more'), { taskId: 'resumed' }));
    expect((await take(resumed, 1))[0]!.event).toEqual({ kind: 'agent', event: { type: 'progress', text: 'more' } });
    await resumed.return!();

    // Every cursor resumes exactly after its own entry.
    for (const [index, entry] of seen.entries()) {
      const after = instance.tasks.events('resumed', { after: entry.cursor })[Symbol.asyncIterator]();
      const rest = await take(after, 4 - index);
      await after.return!();
      expect(rest.map((next) => next.event)).toEqual([...seen.slice(index + 1).map((next) => next.event),
        { kind: 'agent', event: { type: 'progress', text: 'c' } }, { kind: 'agent', event: { type: 'progress', text: 'more' } }]);
    }
  });

  it('refuses an unknown task with task_not_found and a foreign, malformed or relay-era cursor with cursor_unknown', async () => {
    const { byok: instance, daemon } = await start();
    const missing = await first(instance.tasks.events('no-such-task')).catch((error: unknown) => error);
    expect(isCloudError(missing, 'task_not_found')).toBe(true);

    await submit(instance, daemon, 'mine');
    await submit(instance, daemon, 'other');
    const [mine] = await take(instance.tasks.events('mine')[Symbol.asyncIterator](), 1);
    const forged = (body: unknown) => `te1.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
    for (const after of [
      mine!.cursor, 'garbage', '', 'te1.', 'te1.!!!', `${globalThis.crypto.randomUUID()}.3`,
      forged(['other', null, 0, 0, 0]), forged(['other', null, 1, 0, 0, null]), forged(['other', 'g', -1, 0, 0, null]),
      forged(['other', null, 0, 0, 0, 'Nope']), forged({ task: 'other' }),
    ]) {
      const refused = await first(instance.tasks.events('other', { after })).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(TaskEventsUnavailableError);
      expect(refused).toMatchObject(unknownCursor('other'));
    }
  });

  it('serves a terminal task from the stores, however long after its terminal', async () => {
    const { byok: instance, daemon } = await start();
    await submit(instance, daemon, 'finished');
    await claimStarted(daemon, 'finished');
    await send(daemon, createEnvelope('task.progress', progress(1, 'work'), { taskId: 'finished' }));
    await send(daemon, createEnvelope('task.complete', { agentRef: AGENT, summary: 'done', sessionRef: 'sess-r' }, { taskId: 'finished' }));
    const read = await collect(instance.tasks.events('finished'));
    expect(read.map((entry) => entry.event)).toMatchObject([{ kind: 'agent', event: { text: 'work' } }, { kind: 'state', state: 'Complete' }]);
    expect(await collect(instance.tasks.events('finished'))).toEqual(read);
    expect(await collect(instance.tasks.events('finished', { after: read[0]!.cursor }))).toEqual(read.slice(1));
    expect(await collect(instance.tasks.events('finished', { after: read[1]!.cursor }))).toEqual([]);
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

  it('starts at the pending request and current state with from: state, then follows only new activity', async () => {
    const { byok: instance, daemon } = await start();
    await submit(instance, daemon, 'from-state');
    await claimStarted(daemon, 'from-state');
    await send(daemon, createEnvelope('task.progress', progress(1, 'earlier line'), { taskId: 'from-state' }));
    const reader = instance.tasks.events('from-state', { from: 'state' })[Symbol.asyncIterator]();
    expect((await take(reader, 1)).map((entry) => entry.event)).toMatchObject([{ kind: 'state', state: 'Running' }]);
    await send(daemon, createEnvelope('task.await_approval', { summary: 'ok to write?', approvalId: 'appr-from-state' }, { taskId: 'from-state' }));
    const waiting = (await take(reader, 2)).map((entry) => entry.event);
    expect(waiting).toMatchObject([
      { kind: 'await_approval', summary: 'ok to write?', approvalId: 'appr-from-state' }, { kind: 'state', state: 'AwaitApproval' },
    ]);
    await send(daemon, createEnvelope('task.progress', progress(2, 'later line'), { taskId: 'from-state' }));
    expect((await take(reader, 1))[0]!.event).toMatchObject({ kind: 'agent', event: { text: 'later line' } });
    await reader.return!();
    // While it awaits approval the start is the request, then its state.
    expect((await take(instance.tasks.events('from-state', { from: 'state' })[Symbol.asyncIterator](), 2)).map((entry) => entry.event))
      .toEqual(waiting);
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
    await claimAndStart(instance, daemon, handle);
    await send(daemon, createEnvelope('task.progress', progress(1, 'shared'), { taskId: handle.taskId }));
    await send(daemon, createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'done', sessionRef: 'sess-h' }, { taskId: handle.taskId }));
    const viaHandle = [];
    for await (const event of handle.events()) viaHandle.push(event);
    const fromTasks = (await collect(instance.tasks.events(handle.taskId))).map((entry) => entry.event);
    expect(viaHandle).toEqual(fromTasks);
    expect(fromTasks).toMatchObject([{ kind: 'agent' }, { state: 'Complete' }]);
  });
});

describe('ByokServer.tasks.events across a SQLite restart', () => {
  async function restartable(prefix: string, run: (control: {
    instance: () => ByokServer;
    post: (envelope: Envelope) => Promise<void>;
    restart: () => Promise<void>;
    deviceId: string;
  }) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const options = sqliteOptions(root);
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
      await run({
        instance: () => instance,
        post,
        deviceId: daemon.deviceId,
        restart: async () => {
          await stopServer(http.server);
          await instance.close();
          instance = createByokServer(options);
          http = await startServer(instance);
        },
      });
    } finally {
      await stopServer(http.server);
      await instance.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function submitRunning(instance: ByokServer, post: (envelope: Envelope) => Promise<void>, deviceId: string, taskId: string) {
    await instance.executions.submit({
      taskId, deviceId,
      payload: { instruction: 'outlive me', runtime: 'pi', session: { mode: 'fresh' }, agentRef: AGENT, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' } },
    });
    await post(createEnvelope('task.claim', { deviceId, agentRef: AGENT }, { taskId }));
    await post(createEnvelope('task.started', {}, { taskId }));
  }

  it('resumes a cursor from before the restart exactly, and ends a Host-cancelled task at its state', async () => {
    await restartable('byok-task-events-restart-', async ({ instance, post, restart, deviceId }) => {
      for (const taskId of ['survivor', 'cancelled']) await submitRunning(instance(), post, deviceId, taskId);
      await post(createEnvelope('task.progress', progress(1, 'one', 'two'), { taskId: 'survivor' }));
      const before = instance().tasks.events('survivor')[Symbol.asyncIterator]();
      const seen = await take(before, 2);
      await before.return!();
      expect(seen.map((entry) => entry.event)).toMatchObject([{ state: 'Running' }, { event: { text: 'one' } }]);
      // Accepted by the Host; the device never acknowledges it.
      await instance().tasks.cancel('cancelled', 'no longer needed');

      await restart();

      const reader = instance().tasks.events('survivor', { after: seen[1]!.cursor })[Symbol.asyncIterator]();
      expect((await take(reader, 1))[0]!.event).toEqual({ kind: 'agent', event: { type: 'progress', text: 'two' } });
      await post(createEnvelope('task.progress', progress(2, 'after restart'), { taskId: 'survivor' }));
      expect((await take(reader, 1))[0]!.event).toEqual({ kind: 'agent', event: { type: 'progress', text: 'after restart' } });
      await post(createEnvelope('task.complete', { agentRef: AGENT, summary: 'finished after restart', sessionRef: 'sess-s' }, { taskId: 'survivor' }));
      expect((await take(reader, 1))[0]!.event).toMatchObject({ kind: 'state', state: 'Complete' });
      expect(await reader.next()).toEqual({ value: undefined, done: true });

      // Terminal by the snapshot projection while the attempt is still cancel_requested.
      expect((await collect(instance().tasks.events('cancelled'))).map((entry) => entry.event))
        .toMatchObject([{ kind: 'state', state: 'Cancelled' }]);
    });
  });

  it('starts with the approval request a device sent after the restart, then its state', async () => {
    await restartable('byok-task-events-seed-', async ({ instance, post, restart, deviceId }) => {
      await submitRunning(instance(), post, deviceId, 'waiting');
      await restart();
      await post(createEnvelope('task.await_approval', { summary: 'ok to deploy?', approvalId: 'appr-restart' }, { taskId: 'waiting' }));

      const snapshot = (await instance().tasks.get('waiting'))!;
      expect(snapshot).toMatchObject({ state: 'AwaitApproval', pendingApprovalId: 'appr-restart' });
      const reader = instance().tasks.events('waiting', { from: 'state' })[Symbol.asyncIterator]();
      const seeded = await take(reader, 2);
      expect(seeded.map((entry) => entry.event)).toEqual([
        { kind: 'await_approval', summary: 'ok to deploy?', approvalId: 'appr-restart' },
        { kind: 'state', state: 'AwaitApproval', at: snapshot.updatedAt },
      ]);
      await instance().tasks.approve('waiting', { approvalId: 'appr-restart' });
      expect((await take(reader, 1))[0]!.event).toMatchObject({ kind: 'state', state: 'Running' });
      await reader.return!();
    });
  });

  it('keeps following a task whose resubmit after the restart was refused', async () => {
    await restartable('byok-task-events-resubmit-', async ({ instance, post, restart, deviceId }) => {
      await submitRunning(instance(), post, deviceId, 'resubmitted');
      await restart();
      const reader = instance().tasks.events('resubmitted')[Symbol.asyncIterator]();
      expect((await reader.next()).value?.event).toMatchObject({ kind: 'state', state: 'Running' });
      await expect(instance().executions.submit({
        taskId: 'resubmitted', deviceId,
        payload: { instruction: 'outlive me', runtime: 'pi', session: { mode: 'fresh' }, agentRef: AGENT, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' } },
      })).rejects.toMatchObject({ code: 'agent_task_already_exists' });
      await post(createEnvelope('task.progress', progress(1, 'after the refused resubmit'), { taskId: 'resubmitted' }));
      expect((await reader.next()).value?.event).toEqual({ kind: 'agent', event: { type: 'progress', text: 'after the refused resubmit' } });
      await reader.return!();
    });
  });
});

/** In-memory stand-ins for the three sources, for cases the gate cannot produce on demand. */
function fakeSources(initial: TaskEventFacts | undefined) {
  const TENANT = tenantId(PRODUCT_ID);
  const state = { facts: initial, entries: [] as ActivityTailEntry[], floor: 0, generation: 'gen-1', reads: 0 };
  const tail = (after: number): ActivityTail => ({
    tenantId: TENANT, taskId: 'task', after,
    entries: state.entries.filter((entry) => entry.revision > after),
    cursor: { version: 1, tenantId: TENANT, taskId: 'task', generation: state.generation, revision: state.entries.at(-1)?.revision ?? state.floor },
    floor: state.floor, dropped: 0, sourceDropped: 0, capacity: 1000, byteCapacity: 4_194_304, retainedBytes: 0,
  });
  const sources: TaskEventSources = {
    readFacts: async () => state.facts,
    async readActivity(_taskId, after?: ActivityLogPosition) {
      state.reads += 1;
      if (state.entries.length === 0 && state.floor === 0) {
        if (after !== undefined) throw new ByokCloudError('activity_history_gap', 'Activity history is unavailable.');
        return undefined;
      }
      if (after === undefined) return tail(0);
      if (after.generation !== state.generation || after.revision < state.floor) {
        throw new ByokCloudError('activity_history_gap', 'Activity cursor is below the retained floor or from another generation.');
      }
      return tail(after.revision);
    },
  };
  let revision = 0;
  const append = (events: readonly AgentEventOrUnknown[]) => {
    revision += 1;
    state.entries.push({ kind: 'progress', taskId: 'task', sourceEnvelopeId: `e-${revision}`, revision, receivedAt: '2026-11-01T00:00:00.000Z', batchSeq: revision, sourceDropped: 0, events });
  };
  return { state, sources, append };
}

const FAKE_TENANT = tenantId(PRODUCT_ID);

function readFake(sources: TaskEventSources, options: { after?: string; from?: 'state' } = {}) {
  const relay = new TaskEventRelay();
  const wake = createInProcessTaskEventsWake({ fallbackMs: 20 });
  const shutdown = new AbortController();
  const deps = { relay, tenant: FAKE_TENANT, sources, wake, shutdown: shutdown.signal };
  return { relay, wake, reader: readTaskEvents(deps, 'task', options)[Symbol.asyncIterator](), shutdown };
}

const RUNNING: TaskEventFacts = { state: 'Running', at: '2026-11-01T00:00:00.000Z' };
const text = (value: string): AgentEventOrUnknown => ({ type: 'progress', text: value });

describe('readTaskEvents over its sources', () => {
  it('yields the same progress and artifacts as the activity log holds, in revision order', async () => {
    const fake = fakeSources(RUNNING);
    fake.append([text('a'), text('b')]);
    fake.state.entries.push({ kind: 'artifact', taskId: 'task', sourceEnvelopeId: 'art', revision: 2, receivedAt: '2026-11-01T00:00:00.000Z',
      artifact: { name: 'n.txt', contentType: 'text/plain', inline: 'aGk=' } });
    fake.state.entries.push({ kind: 'progress', taskId: 'task', sourceEnvelopeId: 'empty', revision: 3, receivedAt: '2026-11-01T00:00:00.000Z', batchSeq: 3, sourceDropped: 0, events: [] });
    fake.state.facts = { state: 'Complete', at: '2026-11-01T00:00:01.000Z' };
    const { reader } = readFake(fake.sources);
    const read = await take(reader, 4);
    expect(await reader.next()).toEqual({ value: undefined, done: true });
    const logged = fake.state.entries.flatMap((entry): ServerTaskEvent[] =>
      entry.kind === 'progress' ? entry.events.map((event) => ({ kind: 'agent', event })) : entry.kind === 'artifact' ? [{ kind: 'artifact', artifact: entry.artifact }] : []);
    expect(read.slice(0, 3).map((entry) => entry.event)).toEqual(logged);
    expect(read[3]!.event).toEqual({ kind: 'state', state: 'Complete', at: '2026-11-01T00:00:01.000Z' });
  });

  it('marks history dropped before the cursor once, then continues at the start of what is retained', async () => {
    const fake = fakeSources(RUNNING);
    fake.append([text('one')]);
    const { reader } = readFake(fake.sources);
    const [, one] = await take(reader, 2);
    await reader.return!();
    // Revisions 1..3 are evicted; 4 is retained.
    fake.append([text('two')]);
    fake.append([text('three')]);
    fake.append([text('four')]);
    fake.state.entries = fake.state.entries.slice(3);
    fake.state.floor = 3;
    fake.state.facts = { state: 'Complete', at: '2026-11-01T00:00:01.000Z' };
    const behind = readFake(fake.sources, { after: one!.cursor });
    const read = await collect({ [Symbol.asyncIterator]: () => behind.reader });
    expect(read.map((entry) => entry.event)).toEqual([
      { kind: 'error', reason: 'events_truncated' }, { kind: 'agent', event: text('four') }, { kind: 'state', state: 'Complete', at: '2026-11-01T00:00:01.000Z' },
    ]);
    // The marker's cursor stands at the start of what is retained.
    const fromMarker = readFake(fake.sources, { after: read[0]!.cursor });
    expect((await collect({ [Symbol.asyncIterator]: () => fromMarker.reader })).map((entry) => entry.event)).toEqual(read.slice(1).map((entry) => entry.event));
  });

  it('marks history dropped before a cursor taken while the task had no log, but not on a fresh read', async () => {
    const fake = fakeSources(RUNNING);
    const { reader } = readFake(fake.sources);
    const [running] = await take(reader, 1);
    await reader.return!();
    const watching = readFake(fake.sources, { from: 'state' });
    const [watched] = await take(watching.reader, 1);
    await watching.reader.return!();
    // Revisions 1 and 2 are written and evicted after both cursors; 3 is retained.
    fake.append([text('one')]);
    fake.append([text('two')]);
    fake.append([text('three')]);
    fake.state.entries = fake.state.entries.slice(2);
    fake.state.floor = 2;
    fake.state.facts = { state: 'Complete', at: '2026-11-01T00:00:01.000Z' };
    const complete = { kind: 'state', state: 'Complete', at: '2026-11-01T00:00:01.000Z' };
    for (const cursor of [running!.cursor, watched!.cursor]) {
      const resumed = readFake(fake.sources, { after: cursor });
      expect((await collect({ [Symbol.asyncIterator]: () => resumed.reader })).map((entry) => entry.event)).toEqual([
        { kind: 'error', reason: 'events_truncated' }, { kind: 'agent', event: text('three') }, complete,
      ]);
    }
    const fresh = readFake(fake.sources);
    expect((await collect({ [Symbol.asyncIterator]: () => fresh.reader })).map((entry) => entry.event)).toEqual([{ kind: 'agent', event: text('three') }, complete]);
  });

  it('marks removed history and yields what the stores still say', async () => {
    const fake = fakeSources(RUNNING);
    fake.append([text('gone')]);
    const { reader } = readFake(fake.sources);
    const [, gone] = await take(reader, 2);
    await reader.return!();
    fake.state.entries = [];
    fake.state.floor = 0;
    fake.state.facts = { state: 'Complete', at: '2026-11-01T00:00:01.000Z' };
    const after = readFake(fake.sources, { after: gone!.cursor });
    expect((await collect({ [Symbol.asyncIterator]: () => after.reader })).map((entry) => entry.event)).toEqual([
      { kind: 'error', reason: 'events_truncated' }, { kind: 'state', state: 'Complete', at: '2026-11-01T00:00:01.000Z' },
    ]);
  });

  it('moves to AwaitApproval with no request for a sealed approval', async () => {
    const fake = fakeSources({ state: 'AwaitApproval', at: '2026-11-01T00:00:00.000Z', approval: { revision: 1 } });
    const { reader, shutdown } = readFake(fake.sources, { from: 'state' });
    expect((await reader.next()).value?.event).toEqual({ kind: 'state', state: 'AwaitApproval', at: '2026-11-01T00:00:00.000Z' });
    const pending = reader.next();
    shutdown.abort();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it('refuses to serve sealed activity rather than dropping it', async () => {
    const fake = fakeSources(RUNNING);
    fake.state.entries.push({ kind: 'sealed-progress', taskId: 'task', sourceEnvelopeId: 's', revision: 1, receivedAt: '2026-11-01T00:00:00.000Z',
      batchSeq: 1, sourceDropped: 0, sealed: { v: 1 } as never });
    const { reader } = readFake(fake.sources);
    expect((await reader.next()).value?.event).toMatchObject({ kind: 'state', state: 'Running' });
    await expect(reader.next()).rejects.toThrow(/sealed activity/);
  });

  it('reads again on a wake and on the fallback bound, never yielding an unchanged state twice', async () => {
    const fake = fakeSources(RUNNING);
    const { relay, wake, reader } = readFake(fake.sources);
    expect((await reader.next()).value?.event).toMatchObject({ kind: 'state', state: 'Running' });
    const next = reader.next();
    wake.changed(FAKE_TENANT, 'task');
    fake.append([text('woken')]);
    wake.changed(FAKE_TENANT, 'task');
    expect((await next).value?.event).toEqual({ kind: 'agent', event: text('woken') });
    // No hint at all: the wake's fallback still finds the terminal.
    const terminal = reader.next();
    fake.state.facts = { state: 'Failed', at: '2026-11-01T00:00:02.000Z' };
    expect((await terminal).value?.event).toMatchObject({ kind: 'state', state: 'Failed' });
    expect(await reader.next()).toEqual({ value: undefined, done: true });
    relay.stop();
  });

  it('ends without reading the log when the read is stopped during its first store read', async () => {
    const fake = fakeSources(RUNNING);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const abort = new AbortController();
    const relay = new TaskEventRelay();
    const sources: TaskEventSources = { ...fake.sources, readFacts: async () => { await gate; return RUNNING; } };
    const pending = first(readTaskEvents({ relay, tenant: FAKE_TENANT, sources, wake: createInProcessTaskEventsWake(), shutdown: new AbortController().signal }, 'task', { signal: abort.signal }));
    abort.abort();
    release();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(fake.state.reads).toBe(0);
  });
});
