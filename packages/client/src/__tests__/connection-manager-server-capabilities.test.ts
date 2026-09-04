import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { LongPollClient } from '../daemon/long-poll-transport';
import { DeviceStore } from '../daemon/store';
import { TestServer } from './fixtures/test-server';

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
    server.setAckCapabilities(['approval_resolved']);
    const storeDir = await tmpDir('byok-server-caps-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
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
    await connection.waitForConnection();
  }

  it('capabilities are present immediately after a real poll response advertises them', async () => {
    await connectAndAck();
    expect(connection!.getServerCapabilities()).toEqual(['approval_resolved']);
  });

  it('a response that omits capabilities clears the prior advertisement and keeps it empty', async () => {
    await connectAndAck();
    expect(connection!.getServerCapabilities()).toEqual(['approval_resolved']);

    // Model an N-1 HTTP responder. The old advertisement must not leak into
    // its responses; a later response's explicit advertisement is covered
    // below.
    server.setAdvertiseLongPollCapabilities(false);

    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual([]));
    // Held empty across a real wait, not just caught mid-flicker.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(connection!.getServerCapabilities()).toEqual([]);
  });

  it('a later poll response can advertise capabilities again', async () => {
    await connectAndAck();
    server.setAdvertiseLongPollCapabilities(false);
    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual([]));
    server.setAdvertiseLongPollCapabilities(true);
    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual(['approval_resolved']), { timeout: 5000 });
    expect(connection!.isConnected()).toBe(true);
  });

  it('an events response publishes capabilities before its envelopes reach the handler', async () => {
    server = await TestServer.start();
    server.setAckCapabilities(['approval_resolved']);
    const storeDir = await tmpDir('byok-server-caps-degraded-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const cursorStore = new CursorStore(storeDir);
    let capabilitiesSeenByHandler: readonly string[] | undefined;
    server.pushLongPollEvent(
      createEnvelope(
        'task.offer',
        { instruction: 'prove capability ordering', policy: { mode: 'auto' } },
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
    await connection.waitForConnection();
    await vi.waitFor(() => expect(capabilitiesSeenByHandler).toEqual(['approval_resolved']));
    expect(connection.getServerCapabilities()).toEqual(['approval_resolved']);

    server.setFailEventsPolls(true);
    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual([]));
  });

  it('publishes the exact daemon conn.hello snapshot before task messages', async () => {
    server = await TestServer.start();
    const storeDir = await tmpDir('byok-agent-capability-longpoll-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
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
    await connection.waitForConnection();
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

  it('an N-1 long-poll responder that omits capabilities remains fail-closed', async () => {
    server = await TestServer.start();
    server.setAckCapabilities(['approval_resolved']);
    server.setAdvertiseLongPollCapabilities(false);
    const storeDir = await tmpDir('byok-server-caps-old-long-poll-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');

    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore: new CursorStore(storeDir),
      onEnvelope: () => {},
      longPollRetryDelayMs: 20,
      longPollIdleDelayMs: 20,
    });
    await connection.start();
    await connection.waitForConnection();
    await vi.waitFor(() =>
      expect(server.httpRequests.some((request) => request.pathname === '/byok/events')).toBe(true),
    );
    expect(connection.getServerCapabilities()).toEqual([]);
  });

  it('stop() also clears capabilities (defensive — nothing left to gate a send against)', async () => {
    await connectAndAck();
    expect(connection!.getServerCapabilities()).toEqual(['approval_resolved']);
    await connection!.stop();
    expect(connection!.getServerCapabilities()).toEqual([]);
  });
});
