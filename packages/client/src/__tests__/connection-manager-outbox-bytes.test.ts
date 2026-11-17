import { createTestDeviceStore } from './fixtures/device-credentials';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope, MESSAGES_SEND_MAX_BODY_BYTES, type Envelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager, MAX_OUTBOX_EPHEMERAL_BYTES, type OutboundSettlement } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { TestServer } from './fixtures/test-server';
import { openBarrier } from './fixtures/lifecycle-barrier';

/** The outbound drain cuts each POST before its encoded body passes the server's request-body ceiling. */
describe('drainOutbox chunks outbound sends by encoded bytes', () => {
  let server: TestServer;
  let manager: ConnectionManager | undefined;
  const roots: string[] = [];

  afterEach(async () => {
    await manager?.stop();
    await server.close();
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  async function open(): Promise<{ manager: ConnectionManager; posts: Envelope[][] }> {
    server = await TestServer.start();
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-outbox-bytes-'));
    roots.push(storeDir);
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const posts: Envelope[][] = [];
    const opens = openBarrier();
    manager = new ConnectionManager({
      onStateChange: opens.onStateChange, onHalted: opens.onHalted,
      serverUrl: server.url, deviceId: record.deviceId, productId: 'outbox-bytes-test',
      capabilities: [], runtimes: [], auth, cursorStore: new CursorStore(storeDir), onEnvelope: () => {},
      beforeOutboundPost: batch => { if (batch.every(e => e.type !== 'conn.hello')) posts.push([...batch]); },
      longPollRetryDelayMs: 10, longPollIdleDelayMs: 10,
    });
    await manager.start();
    await opens.waitForOpen(manager);
    return { manager, posts };
  }

  // `task.complete.summary` is unbounded text; a `task.fail` reason is capped by the schema (#1124).
  const big = (index: number, bytes: number): Envelope =>
    createEnvelope('task.complete', { sessionRef: 'outbox-bytes-session', summary: 'x'.repeat(bytes), executor: { kind: 'runtime', runtimeId: 'pi' } }, { taskId: `bytes-task-${index}` });
  const bodyBytes = (batch: Envelope[]): number => Buffer.byteLength(JSON.stringify({ messages: batch }));

  it('splits a queue whose encoded size passes the body limit into several in-limit posts, in order', async () => {
    const f = await open();
    const sent = Array.from({ length: 5 }, (_, index) => big(index, 600 * 1024));
    for (const envelope of sent) f.manager.send(envelope);
    await vi.waitFor(() => expect(f.manager.outboxLength()).toBe(0));
    expect(f.posts.length).toBeGreaterThan(1);
    expect(f.posts.every(batch => bodyBytes(batch) <= MESSAGES_SEND_MAX_BODY_BYTES)).toBe(true);
    expect(f.posts.flat().map(e => e.id)).toEqual(sent.map(e => e.id));
  });

  it('posts a single envelope above the body limit alone', async () => {
    const f = await open();
    const small = big(0, 10);
    const oversize = big(1, MESSAGES_SEND_MAX_BODY_BYTES + 1);
    const after = big(2, 10);
    for (const envelope of [small, oversize, after]) f.manager.send(envelope);
    await vi.waitFor(() => expect(f.manager.outboxLength()).toBe(0));
    expect(f.posts.map(batch => batch.map(e => e.id))).toEqual([[small.id], [oversize.id], [after.id]]);
  });
});

/** #1121: an outage cannot grow the outbox without bound; only progress-like envelopes are ever dropped. */
describe('the outbox drops its oldest ephemeral envelopes past its byte cap', () => {
  let server: TestServer;
  let manager: ConnectionManager | undefined;
  const roots: string[] = [];

  afterEach(async () => {
    await manager?.stop();
    await server.close();
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  it('keeps every terminal and the newest progress, drops the oldest progress, and dedups by id', async () => {
    server = await TestServer.start();
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-outbox-cap-'));
    roots.push(storeDir);
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const posted: Envelope[] = [];
    const dropped: Envelope[] = [];
    const opens = openBarrier();
    manager = new ConnectionManager({
      onStateChange: opens.onStateChange, onHalted: opens.onHalted,
      serverUrl: server.url, deviceId: record.deviceId, productId: 'outbox-cap-test',
      capabilities: [], runtimes: [], auth, cursorStore: new CursorStore(storeDir), onEnvelope: () => {},
      beforeOutboundPost: batch => { for (const e of batch) if (e.type !== 'conn.hello') posted.push(e); },
      onOutboundDropped: envelope => dropped.push(envelope),
      longPollRetryDelayMs: 10, longPollIdleDelayMs: 10,
    });
    // Not started: nothing drains, as during an outage.
    const chunk = 512 * 1024;
    const progress = (seq: number): Envelope =>
      createEnvelope('task.progress', { seq, events: [{ type: 'progress', text: 'p'.repeat(chunk) }] }, { taskId: 'cap-task', seq });
    const count = Math.ceil(MAX_OUTBOX_EPHEMERAL_BYTES / chunk) + 3;
    const progresses = Array.from({ length: count }, (_, index) => progress(index + 1));
    const terminal = createEnvelope('task.complete', { sessionRef: 'cap-session', summary: 't'.repeat(chunk), executor: { kind: 'runtime', runtimeId: 'pi' } }, { taskId: 'cap-task' });
    for (const envelope of progresses.slice(0, 2)) manager.send(envelope);
    manager.send(terminal);
    for (const envelope of progresses.slice(2)) manager.send(envelope);
    manager.send(progresses[count - 1]!);
    manager.send(terminal);

    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.map(e => e.id)).toEqual(progresses.slice(0, dropped.length).map(e => e.id));
    expect(manager.outboxLength()).toBe(count - dropped.length + 1);

    await manager.start();
    await opens.waitForOpen(manager);
    await vi.waitFor(() => expect(manager!.outboxLength()).toBe(0));
    const postedIds = posted.map(e => e.id);
    expect(new Set(postedIds).size).toBe(postedIds.length);
    expect(postedIds).toContain(terminal.id);
    expect(postedIds.filter(id => dropped.some(e => e.id === id))).toEqual([]);
    expect(postedIds).toContain(progresses[count - 1]!.id);
  });
});

describe('draft outbox after a failed post', () => {
  let server: TestServer | undefined;
  let connection: ConnectionManager | undefined;
  const roots: string[] = [];
  const releases: Array<() => void> = [];
  const agentRef = { agentId: 'draft-outbox-agent', profileRevision: '1' };
  const taskId = 'draft-outbox-task';

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await connection?.stop();
    await server?.close();
    connection = undefined;
    server = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  async function setup() {
    const instance = await TestServer.start();
    server = instance;
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-draft-outbox-'));
    roots.push(storeDir);
    const auth = new AuthManager({ serverUrl: instance.url, store: createTestDeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const settled: OutboundSettlement[] = [];
    const queued = vi.fn();
    const beforePost = vi.fn();
    const manager = new ConnectionManager({
      serverUrl: instance.url, deviceId: record.deviceId, productId: 'draft-outbox-test',
      capabilities: [], runtimes: [], auth, cursorStore: new CursorStore(storeDir), onEnvelope: () => {},
      onOutboundQueued: queued, beforeOutboundPost: beforePost,
      onOutboundSettled: async batch => { settled.push(...batch); },
      longPollRetryDelayMs: 10, longPollIdleDelayMs: 10,
    });
    connection = manager;
    const body = '你好!';
    const draft = (offset: number, text: string) => createEnvelope('agent.message.draft', {
      agentRef, revision: 1, offset, text,
    }, { taskId });
    const publish = createEnvelope('agent.message.publish', {
      agentRef, sessionRef: 'draft-session', contract: 'draft.v1',
      messageId: '10000000-0000-4000-8000-000000000506', cursor: 1,
      contentType: 'text/plain', body, byteCount: Buffer.byteLength(body),
      contentHash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    }, { taskId });
    const complete = createEnvelope('task.complete', {
      summary: body, sessionRef: 'draft-session', executor: { kind: 'runtime', runtimeId: 'pi' },
    }, { taskId });
    return { server: instance, manager, settled, queued, beforePost, draft, publish, complete };
  }

  it('resends a failed mixed batch, drafts included, on the next session', async () => {
    const f = await setup();
    const drafts = [f.draft(0, '你好'), f.draft(6, '!')];
    const batch = [...drafts, f.publish, f.complete];
    const attempts: Envelope[][] = [];
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
    releases.push(releaseFailure);
    const releaseAcceptance = f.server.holdNextMessagesResponse(e => e.id === f.complete.id);
    releases.push(releaseAcceptance);
    const nativeFetch = globalThis.fetch;
    let helloPosts = 0;
    vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(`${f.server.url}/byok/messages`) && typeof init?.body === 'string') {
        const messages = (JSON.parse(init.body) as { messages: Envelope[] }).messages;
        if (messages.some(e => e.type === 'conn.hello')) helloPosts += 1;
        else {
          attempts.push(messages);
          if (attempts.length === 1) {
            await failureGate;
            // The failed request never reaches either server session.
            throw new TypeError('injected messages route failure');
          }
        }
      }
      return nativeFetch(input, init);
    }) as typeof fetch);

    // Queue a single mixed batch before the first handshake opens the drain.
    for (const envelope of batch) f.manager.send(envelope);
    expect(f.manager.outboxLength()).toBe(batch.length);
    await f.manager.start();
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]).toEqual(batch);
    expect(f.manager.outboxLength()).toBe(batch.length);
    expect(f.server.received.filter(e => e.task_id === taskId)).toEqual([]);
    releaseFailure();

    await f.server.waitFor(e => e.id === f.complete.id);
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    expect(helloPosts).toBe(2);
    expect(attempts[1]).toEqual(batch);
    expect(f.server.received.filter(e => e.task_id === taskId)).toEqual(batch);
    expect(f.server.received.filter(e => e.type === 'agent.message.draft')).toEqual(drafts);
    // The server holds acceptance: the in-flight batch still counts.
    expect(f.manager.outboxLength()).toBe(batch.length);
    expect(f.beforePost.mock.calls.map(([posted]) => posted)).toEqual([batch, batch]);
    releaseAcceptance();
    await vi.waitFor(() => expect(f.manager.outboxLength()).toBe(0));
    expect(f.settled.filter(s => s.envelope.task_id === taskId).map(s => s.envelope)).toEqual(batch);
    expect(f.queued.mock.calls.map(([envelope]) => envelope)).toEqual(batch);
    expect(attempts).toHaveLength(2);
    expect(helloPosts).toBe(2);
    expect(f.manager.isOpen()).toBe(true);
  });
});
