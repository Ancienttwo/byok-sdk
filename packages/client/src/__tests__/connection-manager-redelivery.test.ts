import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { DeviceStore } from '../daemon/store';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Finding F3 (at-most-once redelivery): the old code persisted the
 * redelivery cursor BEFORE `onEnvelope` even ran (fire-and-forget handler
 * dispatch) — a handler that then failed left a redelivery-proof envelope
 * permanently marked processed, so a reconnect's redelivery of that exact
 * envelope would be silently deduped away as "already seen", and nothing
 * would ever retry it.
 *
 * Exercised directly against `ConnectionManager` (bypassing `TaskRunner`)
 * with a fake `onEnvelope` that throws on its first call and succeeds on a
 * second — this gives precise, deterministic control over "the handler
 * fails once" without depending on some real handler's internals
 * happening to fail on cue. Uses the lightweight `TestServer` stub (not the
 * real `@byok-sdk/server`, unlike the sibling F2 test) since nothing here
 * depends on the real server's own redelivery timing — the stub's
 * `server.send(...)` after a reconnect is this suite's established way to
 * simulate "the server just redelivered this" (see `daemon-reconnect.test.ts`).
 */
describe('cursor only advances after the handler succeeds (finding F3)', () => {
  let server: TestServer;
  let connection: ConnectionManager | undefined;

  afterEach(async () => {
    await connection?.stop();
    await server.close();
  });

  it('a handler that throws once leaves the cursor unadvanced, so the same envelope is safely reprocessed on redelivery and only then advances it', async () => {
    server = await TestServer.start();
    const storeDir = await tmpDir('byok-cm-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const cursorStore = new CursorStore(storeDir);

    const received: Envelope[] = [];
    // Counts only `task.offer` calls — `onEnvelope` also fires for `conn.ack`
    // (F2: it's just never cursor-tracked), which would otherwise throw off
    // this test's "exactly once, then again on redelivery" expectations.
    let offerCallCount = 0;
    let shouldThrow = true;

    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: async (envelope) => {
        if (envelope.type !== 'task.offer') return;
        offerCallCount += 1;
        if (shouldThrow) {
          shouldThrow = false; // throws exactly once
          throw new Error('simulated transient handler failure');
        }
        received.push(envelope);
      },
      backoff: { baseMs: 20, maxMs: 100, factor: 2 },
    });

    await connection.start();
    await connection.waitForAck();

    const taskId = 'task-flaky-handler';
    // `server.nextSeq()` (not a hardcoded literal): `conn.ack` already
    // consumed seq 1 during the handshake above, so this must be strictly
    // higher — a colliding/lower seq here would trip the (correct) F2 dedupe
    // check before `onEnvelope` is ever reached, which is a different
    // finding than the one this test is isolating.
    const offerSeq = server.nextSeq();
    const offer = createEnvelope(
      'task.offer',
      { instruction: 'x', policy: { mode: 'auto' } },
      { taskId, seq: offerSeq },
    );
    server.send(offer);

    // The handler ran (and threw) exactly once so far.
    await vi.waitFor(() => expect(offerCallCount).toBe(1));
    expect(received).toHaveLength(0);

    // The cursor must NOT have advanced past the failed envelope — nothing
    // persisted on disk yet for this (serverUrl, deviceId) pair.
    await vi.waitFor(async () => {
      const persisted = await cursorStore.load(server.url, record.deviceId);
      expect(persisted).toBeUndefined();
    });

    // Simulate the server redelivering the same envelope after a reconnect
    // (same seq, same content — exactly what `packages/server`'s hub.ts
    // retains and resends unchanged from its outbox ring).
    server.send(offer);

    await vi.waitFor(() => expect(offerCallCount).toBe(2));
    expect(received.map((e) => e.type)).toEqual(['task.offer']);

    // Now that the handler succeeded, the cursor advances and persists.
    await vi.waitFor(async () => {
      const persisted = await cursorStore.load(server.url, record.deviceId);
      expect(persisted).toBe(offerSeq);
    });
  });

  it('tracks agent.egress.ack and agent.content.read while excluding conn.ack, then retries a failed content read', async () => {
    server = await TestServer.start();
    const storeDir = await tmpDir('byok-cm-content-cursor-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const cursorStore = new CursorStore(storeDir);
    let contentAttempts = 0;

    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: async (envelope) => {
        if (envelope.type === 'agent.content.read') {
          contentAttempts += 1;
          if (contentAttempts === 1) throw new Error('transient content receipt failure');
        }
      },
      backoff: { baseMs: 20, maxMs: 100, factor: 2 },
    });
    await connection.start();
    await connection.waitForAck();

    // The handshake's conn.ack has a seq but must never be cursor-tracked.
    await expect(cursorStore.load(server.url, record.deviceId)).resolves.toBeUndefined();

    const ackSeq = server.nextSeq();
    server.send(createEnvelope('agent.egress.ack', {
      agentRef: { agentId: 'agent-cursor', profileRevision: 'profile-1' },
      sessionRef: 'session-cursor',
      policyRevision: 'policy-cursor',
      eventId: '00000000-0000-4000-8000-000000000001',
      cursor: 1,
      receiptId: '00000000-0000-4000-8000-000000000002',
    }, { seq: ackSeq }));
    await vi.waitFor(async () => {
      await expect(cursorStore.load(server.url, record.deviceId)).resolves.toBe(ackSeq);
    });

    const contentSeq = server.nextSeq();
    const content = createEnvelope('agent.content.read', {
      requestId: '00000000-0000-4000-8000-000000000003',
      surface: 'workspace',
      actor: { kind: 'user', id: 'actor-cursor' },
      agentRef: { agentId: 'agent-cursor', profileRevision: 'profile-1' },
      sessionRef: 'session-cursor',
      runtime: 'pi',
      cwd: '/tmp/agent-cursor',
      policyRevision: 'policy-cursor',
      target: 'notes/readme.md',
      mimeType: 'text/plain',
      decodeAs: 'utf8',
      policy: { maxBytes: 1024, allowedMimeTypes: ['text/plain'] },
    }, { seq: contentSeq });
    server.send(content);
    await vi.waitFor(() => expect(contentAttempts).toBe(1));
    await expect(cursorStore.load(server.url, record.deviceId)).resolves.toBe(ackSeq);

    server.send(content);
    await vi.waitFor(() => expect(contentAttempts).toBe(2));
    await vi.waitFor(async () => {
      await expect(cursorStore.load(server.url, record.deviceId)).resolves.toBe(contentSeq);
    });
  });
});
