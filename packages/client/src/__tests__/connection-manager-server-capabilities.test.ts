import { FRESH_OFFER } from './fixtures/fresh-offer';
import { freshTestAgentRef } from './fixtures/test-agent';
import { createTestDeviceStore } from './fixtures/device-credentials';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope, MAX_MESSAGES_PER_BATCH, type Envelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager, type OutboundSettlement } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { LongPollClient } from '../daemon/long-poll-transport';
import { TestServer } from './fixtures/test-server';
import { waitForOpen } from './fixtures/lifecycle-barrier';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Finding R2 (cross-model re-review, new P1): `ConnectionManager
 * .serverCapabilities` must never persist across a failed poll — a daemon
 * that once learned e.g. `approval_resolved` must not keep believing it
 * applies when a responder no longer confirms it. Concretely,
 * `TaskRunner.sendApprovalResolved` gates
 * `task.approval_resolved` on this list; sending it to a server that
 * doesn't understand it over the long-poll `POST /byok/messages` path gets
 * a batch-level 400 (`MessagesSendRequestSchema`, protocol §8.2), which
 * `ConnectionManager.drainOutbox`'s retry-the-same-batch-forever loop then
 * head-of-line blocks every envelope queued behind it on, permanently.
 *
 * `TaskRunner`'s own gating logic (already correct, unit-tested directly in
 * `task-runner-approval-resolved.test.ts` — see its "capability absent"
 * case) is NOT what's under test here: this suite proves the thing THAT
 * gate actually depends on — `ConnectionManager.getServerCapabilities()`
 * itself — follows only the current poll response's explicit advertisement.
 */
describe('ConnectionManager.getServerCapabilities follows the current transport advertisement', () => {
  let server: TestServer;
  let connection: ConnectionManager | undefined;

  afterEach(async () => {
    await connection?.stop();
    await server.close();
  });

  async function connectAndAck(): Promise<void> {
    server = await TestServer.start();
    server.setAckCapabilities(['approval_resolved', 'mailbox-read-ahead']);
    const storeDir = await tmpDir('byok-server-caps-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const cursorStore = new CursorStore(storeDir);

    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: () => {},
    });
    await connection.start();
    await waitForOpen(connection);
  }

  it('capabilities are present immediately after a real poll response advertises them', async () => {
    await connectAndAck();
    expect(connection!.getServerCapabilities()).toEqual(['approval_resolved', 'mailbox-read-ahead']);
  });

  it('a response that advertises fewer capabilities replaces the prior advertisement', async () => {
    await connectAndAck();
    expect(connection!.getServerCapabilities()).toEqual(['approval_resolved', 'mailbox-read-ahead']);

    // The responder withdraws `approval_resolved`; the old advertisement must
    // not leak into its responses. A later explicit advertisement is covered below.
    server.setAckCapabilities([]);

    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual(['mailbox-read-ahead']));
    // Held across a real wait, not just caught mid-flicker.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(connection!.getServerCapabilities()).toEqual(['mailbox-read-ahead']);
  });

  it('a later poll response can advertise capabilities again', async () => {
    await connectAndAck();
    server.setAckCapabilities([]);
    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual(['mailbox-read-ahead']));
    server.setAckCapabilities(['approval_resolved', 'mailbox-read-ahead']);
    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual(['approval_resolved', 'mailbox-read-ahead']), { timeout: 5000 });
    expect(connection!.isOpen()).toBe(true);
  });

  it('an events response publishes capabilities before its envelopes reach the handler', async () => {
    server = await TestServer.start();
    server.setAckCapabilities(['approval_resolved', 'mailbox-read-ahead']);
    const storeDir = await tmpDir('byok-server-caps-degraded-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const cursorStore = new CursorStore(storeDir);
    let capabilitiesSeenByHandler: readonly string[] | undefined;
    server.pushLongPollEvent(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(),  instruction: 'prove capability ordering', ...FRESH_OFFER },
        { taskId: 'task-capability-order', seq: 1 },
      ),
    );

    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: () => {
        capabilitiesSeenByHandler = connection?.getServerCapabilities();
      },
      longPollRetryDelayMs: 20,
      longPollIdleDelayMs: 20,
    });
    await connection.start();
    await waitForOpen(connection);
    await vi.waitFor(() => expect(capabilitiesSeenByHandler).toEqual(['approval_resolved', 'mailbox-read-ahead']));
    expect(connection.getServerCapabilities()).toEqual(['approval_resolved', 'mailbox-read-ahead']);

    server.setFailEventsPolls(true);
    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual([]));
  });

  it('publishes the exact daemon conn.hello snapshot before task messages', async () => {
    server = await TestServer.start();
    const storeDir = await tmpDir('byok-agent-capability-longpoll-');
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const postBatch = vi.spyOn(LongPollClient.prototype, 'postBatch');

    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: ['agent-home-contract'],
      runtimes: [],
      auth,
      cursorStore: new CursorStore(storeDir),
      onEnvelope: () => {},
      longPollRetryDelayMs: 20,
      longPollIdleDelayMs: 20,
    });
    await connection.start();
    await waitForOpen(connection);
    connection.send(createEnvelope('task.fail', { reason: 'ordered after hello' }, { taskId: 'task-after-hello' }));

    await vi.waitFor(() => {
      expect(postBatch.mock.calls.flatMap(([batch]) => batch).some((envelope) => envelope.type === 'task.fail')).toBe(true);
    });
    const flattened = postBatch.mock.calls.flatMap(([batch]) => batch);
    const helloIndex = flattened.findIndex((envelope) => envelope.type === 'conn.hello');
    const terminalIndex = flattened.findIndex((envelope) => envelope.type === 'task.fail');
    expect(helloIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(helloIndex);
    expect(flattened[helloIndex]).toMatchObject({
      type: 'conn.hello',
      payload: {
        deviceId: record.deviceId,
        productId: 'test-product',
        capabilities: ['agent-home-contract'],
      },
    });
  });

  it('stop() also clears capabilities (defensive — nothing left to gate a send against)', async () => {
    await connectAndAck();
    expect(connection!.getServerCapabilities()).toEqual(['approval_resolved', 'mailbox-read-ahead']);
    await connection!.stop();
    expect(connection!.getServerCapabilities()).toEqual([]);
  });
});

describe('draft outbox gating after the current session handshake', () => {
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

  async function setup(capabilities: string[]) {
    const instance = await TestServer.start();
    server = instance;
    instance.setAckCapabilities(capabilities);
    const storeDir = await tmpDir('byok-draft-outbox-');
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
    const complete = createEnvelope('task.complete', { summary: body, sessionRef: 'draft-session' }, { taskId });
    return { server: instance, manager, settled, queued, beforePost, draft, publish, complete };
  }

  it.each([false, true])('re-gates a failed mixed batch when the next session supports drafts: %s', async supportsDrafts => {
    const f = await setup(['agent-message-draft']);
    const drafts = [f.draft(0, '你好'), f.draft(6, '!')];
    const batch = [...drafts, f.publish, f.complete];
    const expected = supportsDrafts ? batch : [f.publish, f.complete];
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
    expect(f.manager.getServerCapabilities()).toContain('agent-message-draft');
    expect(f.manager.outboxLength()).toBe(batch.length);
    expect(f.server.received.filter(e => e.task_id === taskId)).toEqual([]);
    f.server.setAckCapabilities(supportsDrafts ? ['agent-message-draft'] : []);
    releaseFailure();

    await f.server.waitFor(e => e.id === f.complete.id);
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    expect(helloPosts).toBe(2);
    expect(f.manager.getServerCapabilities().includes('agent-message-draft')).toBe(supportsDrafts);
    expect(attempts[1]).toEqual(expected);
    expect(f.server.received.filter(e => e.task_id === taskId)).toEqual(expected);
    expect(f.server.received.filter(e => e.type === 'agent.message.draft')).toEqual(supportsDrafts ? drafts : []);
    // The server holds acceptance: only the filtered in-flight batch counts.
    expect(f.manager.outboxLength()).toBe(expected.length);
    expect(f.beforePost.mock.calls.map(([posted]) => posted)).toEqual([batch, expected]);
    releaseAcceptance();
    await vi.waitFor(() => expect(f.manager.outboxLength()).toBe(0));
    expect(f.settled.filter(s => s.envelope.task_id === taskId).map(s => s.envelope)).toEqual(expected);
    expect(f.queued.mock.calls.map(([envelope]) => envelope)).toEqual(batch);
    expect(attempts).toHaveLength(2);
    expect(helloPosts).toBe(2);
    expect(f.manager.isOpen()).toBe(true);
  });

  it('drops absent-capability drafts at drain, skips an empty batch, and retains no drafts for later advertisement', async () => {
    const f = await setup([]);
    const drafts = Array.from({ length: MAX_MESSAGES_PER_BATCH + 1 }, (_, offset) => f.draft(offset, 'x'));
    const expected = [f.publish, f.complete];
    const postBatch = vi.spyOn(LongPollClient.prototype, 'postBatch');
    for (const envelope of [...drafts, ...expected]) f.manager.send(envelope);
    expect(f.manager.outboxLength()).toBe(drafts.length + expected.length);
    expect(f.queued).toHaveBeenCalledTimes(drafts.length + expected.length);
    await f.manager.start();
    await f.server.waitFor(e => e.id === f.complete.id);
    await vi.waitFor(() => expect(f.manager.outboxLength()).toBe(0));
    expect(f.server.received.filter(e => e.task_id === taskId)).toEqual(expected);
    expect(f.beforePost.mock.calls.map(([batch]) => batch)).toEqual([expected]);
    expect(f.settled.filter(s => s.envelope.task_id === taskId).map(s => s.envelope)).toEqual(expected);
    expect(postBatch.mock.calls.map(([batch]) => batch.map(e => e.type))).toEqual([
      ['conn.hello'], ['agent.message.publish', 'task.complete'],
    ]);

    // A later advertisement must not resurrect drafts removed from the outbox.
    f.server.setAckCapabilities(['agent-message-draft']);
    await vi.waitFor(() => expect(f.manager.getServerCapabilities()).toContain('agent-message-draft'));
    const later = createEnvelope('task.fail', { reason: 'drain barrier' }, { taskId: 'after-draft-drop' });
    f.manager.send(later);
    await f.server.waitFor(e => e.id === later.id);
    await vi.waitFor(() => expect(f.manager.outboxLength()).toBe(0));
    expect(f.server.received.filter(e => e.type === 'agent.message.draft')).toEqual([]);
    expect(f.settled.some(s => s.envelope.type === 'agent.message.draft')).toBe(false);
    expect(f.beforePost.mock.calls.map(([batch]) => batch)).toEqual([expected, [later]]);
  });
});
