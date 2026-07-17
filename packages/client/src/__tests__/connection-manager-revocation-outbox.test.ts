import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
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
 * Finding P3 (wave-3 regression, both reviewers): `enterRevoked()` stopped
 * WS/long-poll receive but never stopped the outbox drain. `postBatch`
 * catches the `DeviceRevokedError` a revoked device gets on every send,
 * returns `false`, and (pre-fix) `drainOutbox` just unshifts the batch back
 * and retries forever — every `longPollRetryDelayMs`, via a timer that
 * (pre-fix) also isn't unref'd, keeping the Node process alive indefinitely
 * even though the device can never recover without a fresh `pair()`. Before
 * Wave 3's shared-outbox unification, the old per-transport `flushOutbox`
 * exited outright on `DeviceRevokedError`; this restores that behavior for
 * the new shared drain.
 *
 * Exercised directly against `ConnectionManager` (like
 * `connection-manager-redelivery.test.ts`) against the lightweight
 * `TestServer` stub — real auth/revocation enforcement (genuine 401s off
 * `revokeDevice`), no need for the real server's redelivery semantics here.
 */
describe('a revoked device stops draining its outbox instead of retrying forever (finding P3)', () => {
  let server: TestServer;
  let connection: ConnectionManager | undefined;

  afterEach(async () => {
    await connection?.stop();
    await server.close();
  });

  it('drainOutbox stops calling postBatch once revocation is discovered, even with envelopes still queued', async () => {
    server = await TestServer.start();
    server.setRejectWs(true); // force long-poll from the very first attempt

    const storeDir = await tmpDir('byok-revoke-outbox-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    const cursorStore = new CursorStore(storeDir);

    const postBatchSpy = vi.spyOn(LongPollClient.prototype, 'postBatch');

    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: () => {},
      wsFailureThreshold: 1,
      longPollRetryDelayMs: 20,
      longPollIdleDelayMs: 20,
    });

    await connection.start();
    await connection.waitForAck();
    expect(connection.isTransportDegraded()).toBe(true);

    // Revoke server-side, THEN queue outbound envelopes — the drain's very
    // first attempt discovers revocation (401 on the send, then on the
    // renewal it triggers), exactly like a real mid-session revocation.
    server.revokeDevice(record.deviceId);
    connection.send(createEnvelope('task.claim', { deviceId: record.deviceId }, { taskId: 'task-revoked-1' }));
    connection.send(createEnvelope('task.claim', { deviceId: record.deviceId }, { taskId: 'task-revoked-2' }));

    await vi.waitFor(() => expect(connection?.isRevoked()).toBe(true), { timeout: 2000 });
    await vi.waitFor(() => expect(postBatchSpy.mock.calls.length).toBeGreaterThanOrEqual(1));

    const callsAfterRevocationDetected = postBatchSpy.mock.calls.length;

    // Give a runaway retry loop (pre-fix: every 20ms, forever) plenty of
    // room to prove itself — many multiples of longPollRetryDelayMs.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(postBatchSpy.mock.calls.length).toBe(callsAfterRevocationDetected);
  });
});
