import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { DeviceStore } from '../daemon/store';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Finding R2 (cross-model re-review, new P1): `ConnectionManager
 * .serverCapabilities` used to persist across a WS disconnect / degradation
 * to long-poll — a daemon that once learned e.g. `approval_resolved` from an
 * earlier handshake kept believing it applied indefinitely, even once
 * connected to (or degraded against) something that never actually
 * confirmed that. Concretely, `TaskRunner.sendApprovalResolved` gates
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
 * itself — follows only the CURRENT transport's explicit advertisement:
 * empty before confirmation, populated by WS ack or long-poll response, and
 * never inherited across a transport switch.
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
      backoff: { baseMs: 20, maxMs: 50, factor: 2 },
    });
    await connection.start();
    await connection.waitForAck();
  }

  it('ack: capabilities are present immediately after a real conn.ack advertises them', async () => {
    await connectAndAck();
    expect(connection!.getServerCapabilities()).toEqual(['approval_resolved']);
  });

  it('WS drop: capabilities are cleared to [] once the acked connection ends, and STAY empty (not a transient blip)', async () => {
    await connectAndAck();
    expect(connection!.getServerCapabilities()).toEqual(['approval_resolved']);

    // Prevent any reconnect from re-acking so the cleared state is
    // observed deterministically, not as a transient window a fast test
    // backoff could race straight past (daemon-reconnect.test.ts's own doc
    // comment documents this exact "close->reconnect->ack can complete
    // faster than a poll interval" hazard for the identical fixture).
    server.setRejectWs(true);
    // Model an N-1 HTTP responder behind the degraded route. The old WS
    // advertisement must be cleared and must not leak across the switch;
    // a new responder's explicit long-poll advertisement is covered below.
    server.setAdvertiseLongPollCapabilities(false);
    server.dropConnection();

    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual([]));
    // Held empty across a real wait, not just caught mid-flicker.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(connection!.getServerCapabilities()).toEqual([]);
  });

  it('reconnect + fresh ack: capabilities are present again after a NEW handshake', async () => {
    await connectAndAck();
    server.setRejectWs(true);
    server.dropConnection();
    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual([]));

    server.setRejectWs(false);
    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual(['approval_resolved']), { timeout: 5000 });
    expect(connection!.isConnected()).toBe(true);
  });

  it('a connection that degrades to long-poll learns capabilities from the current poll response without a WS ack', async () => {
    server = await TestServer.start();
    server.setAckCapabilities(['approval_resolved']); // would be advertised IF a WS handshake ever completed
    server.setRejectWs(true); // force long-poll from the very first attempt — no ack ever happens
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
      wsFailureThreshold: 1,
      longPollRetryDelayMs: 20,
      longPollIdleDelayMs: 20,
    });
    await connection.start();
    await connection.waitForAck();

    expect(connection.isTransportDegraded()).toBe(true);
    await vi.waitFor(() => expect(capabilitiesSeenByHandler).toEqual(['approval_resolved']));
    expect(connection.getServerCapabilities()).toEqual(['approval_resolved']);

    server.setFailEventsPolls(true);
    await vi.waitFor(() => expect(connection!.getServerCapabilities()).toEqual([]));
  });

  it('an N-1 long-poll responder that omits capabilities remains fail-closed', async () => {
    server = await TestServer.start();
    server.setAckCapabilities(['approval_resolved']);
    server.setAdvertiseLongPollCapabilities(false);
    server.setRejectWs(true);
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
      wsFailureThreshold: 1,
      longPollRetryDelayMs: 20,
      longPollIdleDelayMs: 20,
    });
    await connection.start();
    await connection.waitForAck();

    expect(connection.isTransportDegraded()).toBe(true);
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
