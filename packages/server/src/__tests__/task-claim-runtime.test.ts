import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import {
  connectFakeDaemonLongPoll,
  sendOne,
  startServer,
  stopServer,
  waitForServerEvent,
  type FakeLongPollDaemon,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short enough that a poll expecting nothing answers in ~200ms instead of ~50s. */
const SHORT_HOLD_MS = 200;

/**
 * M5 (claimed runtime, docs/protocol.md §3.1): `task.claim` optionally carries
 * `runtime` — the ACTUAL adapter the daemon selected — snapshotted by the cloud
 * kernel's inbound gate at the `offered -> claimed` ownership CAS and read back
 * through `TaskSnapshot.claimedRuntime`.
 *
 * The pre-fold counterpart `TaskSnapshot.runtime` (the merely REQUESTED
 * runtime) is gone: it was dispatch INPUT the host already holds and the kernel
 * does not persist (ADR-028), so the "requested field stays untouched" half of
 * each case below has no field left to assert on. What survives — that the
 * claim's own report is recorded independently of what was requested — is
 * pinned by the two dispatch shapes below, one with a requested runtime and one
 * without.
 */
describe('M5 (claimed runtime): task.claim.runtime -> TaskSnapshot.claimedRuntime', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function startWithDaemon(): Promise<{ byok: ByokServer; daemon: FakeLongPollDaemon }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });
    return { byok: instance, daemon };
  }

  it('an offer dispatched with NO requested runtime (auto-select): task.claim.runtime sets claimedRuntime', async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ instruction: 'auto-select this' });

    const claimEnvelope = createEnvelope(
      'task.claim',
      { deviceId: daemon.deviceId, runtime: 'pi' },
      { taskId: handle.taskId },
    );
    const claim = await sendOne(daemon, claimEnvelope);
    expect(claim).toEqual({
      status: 200,
      body: { outcomes: [{ id: claimEnvelope.id, outcome: 'accepted' }] },
    });

    const snapshot = await instance.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Claimed');
    expect(snapshot?.claimedRuntime).toBe('pi');
  });

  it('an offer dispatched WITH a requested runtime: task.claim.runtime is recorded independently as claimedRuntime', async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ instruction: 'explicit runtime', runtime: 'claude' });

    const claimEnvelope = createEnvelope(
      'task.claim',
      { deviceId: daemon.deviceId, runtime: 'claude' },
      { taskId: handle.taskId },
    );
    const claim = await sendOne(daemon, claimEnvelope);
    expect(claim).toEqual({
      status: 200,
      body: { outcomes: [{ id: claimEnvelope.id, outcome: 'accepted' }] },
    });

    expect((await instance.tasks.get(handle.taskId))?.claimedRuntime).toBe('claude');
  });

  it("compat: a legacy daemon's task.claim with NO runtime field leaves claimedRuntime absent and the claim still succeeds normally", async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ instruction: 'legacy daemon claim' });

    // A pre-M5-batch-2 daemon's task.claim payload never had a `runtime` key.
    const claimEnvelope = createEnvelope(
      'task.claim',
      { deviceId: daemon.deviceId },
      { taskId: handle.taskId },
    );
    const claim = await sendOne(daemon, claimEnvelope);
    expect(claim).toEqual({
      status: 200,
      body: { outcomes: [{ id: claimEnvelope.id, outcome: 'accepted' }] },
    });

    const snapshot = await instance.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Claimed'); // nothing breaks
    expect(snapshot?.claimedRuntime).toBeUndefined();
  });

  it('the task.state ByokServerEvent fired on Offered -> Claimed carries claimedRuntime, mirroring the snapshot', async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ instruction: 'observe the server event' });
    await sendOne(
      daemon,
      createEnvelope('task.claim', { deviceId: daemon.deviceId, runtime: 'codex' }, { taskId: handle.taskId }),
    );

    const event = await waitForServerEvent(
      instance,
      (e) => e.kind === 'task.state' && e.taskId === handle.taskId && e.state === 'Claimed',
    );
    if (event.kind !== 'task.state') throw new Error('unreachable');
    expect(event.claimedRuntime).toBe('codex');
    expect(event.claimedRuntime).toBe((await instance.tasks.get(handle.taskId))?.claimedRuntime);
  });
});
