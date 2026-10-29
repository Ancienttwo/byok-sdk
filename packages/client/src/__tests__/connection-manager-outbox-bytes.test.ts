import { createTestDeviceStore } from './fixtures/device-credentials';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope, MESSAGES_SEND_MAX_BODY_BYTES, type Envelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager, MAX_OUTBOX_EPHEMERAL_BYTES } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { TestServer } from './fixtures/test-server';
import { waitForOpen } from './fixtures/lifecycle-barrier';

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
    manager = new ConnectionManager({
      serverUrl: server.url, deviceId: record.deviceId, productId: 'outbox-bytes-test',
      capabilities: [], runtimes: [], auth, cursorStore: new CursorStore(storeDir), onEnvelope: () => {},
      beforeOutboundPost: batch => { if (batch.every(e => e.type !== 'conn.hello')) posts.push([...batch]); },
      longPollRetryDelayMs: 10, longPollIdleDelayMs: 10,
    });
    await manager.start();
    await waitForOpen(manager);
    return { manager, posts };
  }

  // `task.complete.summary` is unbounded text; a `task.fail` reason is capped by the schema (#1124).
  const big = (index: number, bytes: number): Envelope =>
    createEnvelope('task.complete', { sessionRef: 'outbox-bytes-session', summary: 'x'.repeat(bytes) }, { taskId: `bytes-task-${index}` });
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
    manager = new ConnectionManager({
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
    const terminal = createEnvelope('task.complete', { sessionRef: 'cap-session', summary: 't'.repeat(chunk) }, { taskId: 'cap-task' });
    for (const envelope of progresses.slice(0, 2)) manager.send(envelope);
    manager.send(terminal);
    for (const envelope of progresses.slice(2)) manager.send(envelope);
    manager.send(progresses[count - 1]!);
    manager.send(terminal);

    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.map(e => e.id)).toEqual(progresses.slice(0, dropped.length).map(e => e.id));
    expect(manager.outboxLength()).toBe(count - dropped.length + 1);

    await manager.start();
    await waitForOpen(manager);
    await vi.waitFor(() => expect(manager!.outboxLength()).toBe(0));
    const postedIds = posted.map(e => e.id);
    expect(new Set(postedIds).size).toBe(postedIds.length);
    expect(postedIds).toContain(terminal.id);
    expect(postedIds.filter(id => dropped.some(e => e.id === id))).toEqual([]);
    expect(postedIds).toContain(progresses[count - 1]!.id);
  });
});
