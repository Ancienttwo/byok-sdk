import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeEnvelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealCloud, type RealCloudHandle } from './fixtures/real-cloud';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Sprint S3's falsifier, run: the daemon must not be able to tell the hosted
 * `@byok-sdk/cloud` surface from the self-hosted `@byok-sdk/server` one.
 *
 * This is deliberately the SAME shape as
 * `real-server-longpoll-only.test.ts` — same daemon construction, same
 * long-poll fallback path, same lifecycle, same assertions about what
 * `daemon.status()` reports — with only the server swapped underneath. Not one
 * line of daemon production code is involved in the difference, and the only
 * new client-side code is the fixture that boots the other implementation. If
 * this test had needed a flag, a branch, or a new client capability, the
 * hosted handler surface would have drifted from the frozen wire contract and
 * the slice would be off course.
 *
 * What differs is only what a HOST holds: cloud has no `TaskHandle`, so the
 * offer goes in through `enqueueOffer` and the result comes back out of the
 * task-attempt store and the terminal receipt.
 */
describe('a full task lifecycle over long-poll only, against the real @byok-sdk/cloud', () => {
  let cloud: RealCloudHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await cloud.close();
  });

  it('offer -> claim -> started -> progress -> complete all travel over GET /byok/events + POST /byok/messages', async () => {
    cloud = await startRealCloud({ productId: 'test-product', longPollHoldMs: 200, longPollIntervalMs: 20 });

    const workspaceRoot = await tmpDir('byok-cloud-e2e-workspace-');
    const storeDir = await tmpDir('byok-cloud-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: cloud.url, workspaceRoot, storeDir },
      [adapter],
      {
        // Fail over to long-poll after one failed WS attempt: cloud has no WS
        // endpoint at all, so waiting out a full backoff sequence proves
        // nothing this test is about.
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = await cloud.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();

    // WS never connects — the daemon settled via its ordinary long-poll
    // fallback, with no cloud-specific handling anywhere.
    expect(daemon.status().connected).toBe(false);
    expect(daemon.status().degraded).toBe(true);

    // The hosted control-plane input. Unlike the embedded server's
    // `dispatch()`, this returns no handle to await — the offer is bytes in a
    // mailbox from the moment it lands, so there is no connection to race.
    const offer = await cloud.enqueueOffer(record.deviceId, 'do it over long-poll');
    expect(offer.envelope.type).toBe('task.offer');
    expect(offer.envelope.seq).toBe(1);

    // Claim: proves the offer was received over GET /byok/events and the
    // daemon's reply reached cloud over POST /byok/messages — there is no
    // other path for either.
    await vi.waitFor(async () => {
      expect((await cloud.readTaskAttempt(offer.taskId))?.ownerDeviceId).toBe(record.deviceId);
    });
    await vi.waitFor(async () => {
      expect((await cloud.readTaskAttempt(offer.taskId))?.status).toBe('running');
    });
    expect(daemon.status().connected).toBe(false); // still false throughout — WS never came up

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'working over long-poll' });
    session.emit({ type: 'turn_end' });

    await vi.waitFor(async () => {
      expect((await cloud.readTaskAttempt(offer.taskId))?.status).toBe('complete');
    });

    // Frozen v1 round trip: the terminal cloud recorded is the daemon's own
    // envelope, and it still parses under the pinned schema.
    const terminal = await cloud.readTerminalBody(offer.taskId);
    expect(terminal).toBeDefined();
    const envelope = decodeEnvelope(terminal ?? '');
    expect(envelope.type).toBe('task.complete');
    expect(envelope.task_id).toBe(offer.taskId);
    expect(envelope.v).toBe(1);
    if (envelope.type === 'task.complete') {
      expect(envelope.payload.summary).toBe('working over long-poll');
    }

    expect(daemon.status().connected).toBe(false);
    expect(daemon.status().degraded).toBe(true);
  }, 15000);

  it('host cancellation interrupts the running session and the device acknowledges cancellation over long-poll', async () => {
    cloud = await startRealCloud({ productId: 'test-product', longPollHoldMs: 200, longPollIntervalMs: 20 });

    const workspaceRoot = await tmpDir('byok-cloud-cancel-workspace-');
    const storeDir = await tmpDir('byok-cloud-cancel-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test',
        productId: 'test-product',
        serverUrl: cloud.url,
        workspaceRoot,
        storeDir,
      },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = await cloud.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();

    const offer = await cloud.enqueueOffer(record.deviceId, 'cancel this task');
    await vi.waitFor(async () => {
      expect((await cloud.readTaskAttempt(offer.taskId))?.status).toBe('running');
    });
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

    const cancellation = await cloud.cancelTask(offer.taskId, 'operator stopped it');
    expect(cancellation.status).toBe('cancel_requested');

    const session = adapter.sessions[0]!;
    await vi.waitFor(() => expect(session.interruptCalled).toBe(true));
    await vi.waitFor(async () => {
      expect((await cloud.readTaskAttempt(offer.taskId))?.status).toBe('cancelled');
    });
    await vi.waitFor(() => expect(session.closeCalled).toBe(true));

    const terminal = await cloud.readTerminalBody(offer.taskId);
    expect(terminal).toBeDefined();
    const envelope = decodeEnvelope(terminal ?? '');
    expect(envelope.type).toBe('task.cancelled');
    expect(envelope.task_id).toBe(offer.taskId);
  }, 15000);
});
