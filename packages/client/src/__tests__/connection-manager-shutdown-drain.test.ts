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
 * Finding F5(b) (cross-model adversarial review): `ConnectionManager.stop()`
 * used to set `stopped = true` and close both transports immediately,
 * never waiting for the shared outbox (Design B) to actually finish
 * draining first. A `task.fail` `TaskRunner.shutdownTask` had JUST pushed
 * (via `send()`'s fire-and-forget `void this.drainOutbox()`) could still be
 * sitting unsent — e.g. mid long-poll retry backoff, or simply not yet
 * picked up — and `stop()` would proceed regardless, after which nothing
 * ever drains it again: silently lost, even though `TaskRunner` believed it
 * had been sent (see `create-daemon.ts`'s `performControlShutdown`, which is
 * the one caller that now opts into the bounded wait via `stop(drainTimeoutMs)`).
 *
 * Exercised directly against `ConnectionManager` (mirrors
 * `connection-manager-revocation-outbox.test.ts`'s own convention) against
 * the lightweight `TestServer` stub, with `LongPollClient.prototype.postBatch`
 * mocked to simulate a genuinely STALLED `POST /byok/messages` — the exact
 * "stalled long-poll POST during shutdown" scenario this finding names.
 */
describe('ConnectionManager.stop(drainTimeoutMs) — bounded outbox drain before closing (finding F5(b))', () => {
  let server: TestServer;
  let connection: ConnectionManager | undefined;

  afterEach(async () => {
    await connection?.stop();
    await server.close();
    vi.restoreAllMocks();
  });

  async function startDegraded(prefix: string): Promise<{ deviceId: string }> {
    server = await TestServer.start();
    server.setRejectWs(true); // force long-poll from the very first attempt
    const storeDir = await tmpDir(prefix);
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
      wsFailureThreshold: 1,
      longPollRetryDelayMs: 20,
      longPollIdleDelayMs: 20,
    });

    await connection.start();
    await connection.waitForAck();
    expect(connection.isTransportDegraded()).toBe(true);
    return { deviceId: record.deviceId };
  }

  it('a stalled long-poll POST during shutdown: stop(drainTimeoutMs) returns within its bound (not hung indefinitely) and honestly reports the undelivered envelope via outboxLength() — it never claims delivery that did not happen', async () => {
    const { deviceId } = await startDegraded('byok-shutdown-drain-stalled-store-');

    // Simulates a genuinely stalled POST /byok/messages — a promise that
    // never settles, exactly the "stalled long-poll POST during shutdown"
    // scenario this finding names (not merely a slow-but-eventually-ok one).
    vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(() => new Promise(() => {}));

    connection!.send(createEnvelope('task.fail', { reason: 'daemon shutting down: test', retryable: true }, { taskId: 'task-stalled-1' }));
    expect(connection!.outboxLength()).toBe(1);

    const startedAt = Date.now();
    await connection!.stop(100); // bounded — must not wait for the stalled POST to ever resolve
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2000); // bounded by drainTimeoutMs, nowhere near "hung forever"
    // Honest audit read: the envelope genuinely never left the outbox —
    // outboxLength() must say so, not silently report 0/"delivered".
    expect(connection!.outboxLength()).toBe(1);
  });

  it('a fast (non-stalled) drain: stop(drainTimeoutMs) waits for the outbox to actually empty and returns promptly once it does, well under the bound', async () => {
    const { deviceId } = await startDegraded('byok-shutdown-drain-fast-store-');
    void deviceId;

    connection!.send(createEnvelope('task.fail', { reason: 'daemon shutting down: test', retryable: true }, { taskId: 'task-fast-1' }));

    const startedAt = Date.now();
    await connection!.stop(5000);
    const elapsedMs = Date.now() - startedAt;

    expect(connection!.outboxLength()).toBe(0); // genuinely drained, not just timed out
    expect(elapsedMs).toBeLessThan(2000); // did not wait out the full 5s bound
  });

  it('omitting drainTimeoutMs preserves the exact prior (unbounded-wait-free) behavior for every other existing caller', async () => {
    const { deviceId } = await startDegraded('byok-shutdown-drain-default-store-');
    void deviceId;

    vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(() => new Promise(() => {}));
    connection!.send(createEnvelope('task.fail', { reason: 'x', retryable: true }, { taskId: 'task-default-1' }));

    const startedAt = Date.now();
    await connection!.stop(); // no drainTimeoutMs at all
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500); // returns essentially immediately, exactly like before this fix
    expect(connection!.outboxLength()).toBe(1); // still queued — this call path never claimed otherwise either
  });
});
