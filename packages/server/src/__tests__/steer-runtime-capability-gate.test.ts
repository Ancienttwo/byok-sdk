import { mkdtempSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type RuntimeId, type RuntimeInfo } from '@byok/protocol';
import type { WebSocket } from 'ws';
import { createByokServer, SqliteTaskStore, SteerRejectedError, type ByokServer, type TaskHandle } from '../index';
import { isSqliteAvailable } from '../sqlite-support';
import {
  CLAUDE_RUNTIME_INFO,
  CODEX_RUNTIME_INFO,
  connectFakeDaemon,
  connectFakeDaemonWs,
  nextEnvelope,
  PI_RUNTIME_INFO,
  send,
  startServer,
  stopServer,
  waitForTaskEvent,
} from './test-support';

const PRODUCT_ID = 'acme';

/**
 * S0 (GAP-002): `ConnectionHub.steerTask` (`hub.ts`) used to send `task.steer`
 * to ANY `Running` task. Only pi's adapter implements steering — Claude's and
 * Codex's throw on receipt, which stalls the client's redelivery cursor at
 * that seq and re-loops the same envelope forever. The fix is a task-level
 * gate over a claim-time capability snapshot
 * (`TaskSnapshot.claimedRuntimeCapabilities`, written by `onClaim`) that
 * refuses with a typed {@link SteerRejectedError} BEFORE any envelope exists.
 *
 * These tests drive the real WS/HTTP harness (same conventions as
 * `task-claim-runtime.test.ts` / `hub-approve-reject.test.ts`) rather than
 * poking the hub directly, so the whole path — `conn.hello.runtimes[]
 * .capabilities` -> `registerConnection` -> `onClaim` snapshot -> task record
 * -> gate — is exercised end to end.
 */

interface Harness {
  byok: ByokServer;
  server: HttpServer;
  ws: WebSocket;
  deviceId: string;
  accessToken: string;
  port: number;
}

/** Boot a server + one paired/connected fake daemon advertising `runtimes` in its `conn.hello`. */
async function startHarness(runtimes: RuntimeInfo[] | undefined): Promise<Harness> {
  const byok = createByokServer({ productId: PRODUCT_ID });
  const started = await startServer(byok);
  const { code } = byok.pairing.createPairingCode();
  const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID, runtimes });
  return {
    byok,
    server: started.server,
    ws: daemon.ws,
    deviceId: daemon.deviceId,
    accessToken: daemon.accessToken,
    port: started.port,
  };
}

/**
 * Dispatch a task, consume its `task.offer` off the wire, then drive it to
 * `Running` claiming `runtime`. Consuming the offer matters: every assertion
 * below about "what the device receives next" would otherwise be answered by
 * the still-queued offer rather than by the envelope under test.
 */
async function dispatchClaimedRunning(
  h: Harness,
  runtime: RuntimeId | undefined,
  instruction = 'long running task',
): Promise<TaskHandle> {
  const handle = await h.byok.dispatch({ instruction });
  const offer = await nextEnvelope(h.ws);
  expect(offer.type).toBe('task.offer');
  send(h.ws, createEnvelope('task.claim', { deviceId: h.deviceId, runtime }, { taskId: handle.taskId }));
  send(h.ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));
  await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
  return handle;
}

/**
 * Prove no `task.steer` was produced for `handle`, without racing a timer:
 * issue a `cancel` (which always sends) and assert the very next envelope the
 * device receives is that cancel. Envelopes leave through one per-device
 * outbox in `seq` order, so a steer that had been built would necessarily sit
 * ahead of the cancel here. The `envelopesOut` counter — incremented by
 * `sendToDevice`, the single outbound choke point — is checked alongside it,
 * so a steer that was somehow built but never flushed still fails this.
 */
async function expectNoSteerSent(h: Harness, handle: TaskHandle): Promise<void> {
  const outBefore = h.byok.stats().envelopesOut;
  await handle.cancel('done proving the negative');
  expect(h.byok.stats().envelopesOut).toBe(outBefore + 1); // the cancel, and nothing else

  const next = await nextEnvelope(h.ws);
  expect(next.type).toBe('task.cancel');
  expect(next.task_id).toBe(handle.taskId);
}

function asSteerRejection(err: unknown): SteerRejectedError {
  expect(err).toBeInstanceOf(SteerRejectedError);
  return err as SteerRejectedError;
}

describe("S0 (GAP-002): task.steer is gated by the claimed runtime's capability snapshot", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    harness?.ws.terminate();
    harness?.byok.stop();
    if (harness) await stopServer(harness.server);
    harness = undefined;
  });

  it('pi (capabilities.steer = true) claimed and Running: steer succeeds and the task.steer envelope reaches the device', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, 'pi');

    await handle.steer('keep going');

    const envelope = await nextEnvelope(harness.ws);
    expect(envelope.type).toBe('task.steer');
    expect(envelope.task_id).toBe(handle.taskId);
    if (envelope.type !== 'task.steer') throw new Error('unreachable');
    expect(envelope.payload.text).toBe('keep going');
  });

  it('claude (capabilities.steer = false) claimed and Running: rejected with steer_unsupported_runtime, and the device receives no task.steer at all', async () => {
    harness = await startHarness([CLAUDE_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, 'claude');

    const err = asSteerRejection(await handle.steer('please stop').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');
    expect(err.runtime).toBe('claude');
    expect(err.state).toBe('Running');

    await expectNoSteerSent(harness, handle);
  });

  it('codex (capabilities.steer = false) claimed and Running: same fail-closed rejection as claude', async () => {
    harness = await startHarness([CODEX_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, 'codex');

    const err = asSteerRejection(await handle.steer('please stop').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');
    expect(err.runtime).toBe('codex');

    await expectNoSteerSent(harness, handle);
  });

  it('fail-closed on unknown: a conn.hello whose RuntimeInfo carries NO capabilities leaves the snapshot undefined, and a steer for it is refused rather than sent', async () => {
    // A pre-S0 daemon: `RuntimeInfo.capabilities` is optional on the wire, so
    // it reports pi with no capability block at all. "This server does not
    // know" must refuse — assuming "steerable, because it says pi" is exactly
    // what produces a permanent cursor stall against a build where that
    // isn't true.
    harness = await startHarness([{ id: 'pi' }]);
    const handle = await dispatchClaimedRunning(harness, 'pi');

    expect(harness.byok.tasks.get(handle.taskId)?.claimedRuntime).toBe('pi');
    expect(harness.byok.tasks.get(handle.taskId)?.claimedRuntimeCapabilities).toBeUndefined();

    const err = asSteerRejection(await handle.steer('keep going').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');

    await expectNoSteerSent(harness, handle);
  });

  it('fail-closed on unknown: a legacy runtime-less task.claim (no runtime reported at all) is refused the same way', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, undefined);

    expect(harness.byok.tasks.get(handle.taskId)?.claimedRuntimeCapabilities).toBeUndefined();

    const err = asSteerRejection(await handle.steer('keep going').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');
    expect(err.runtime).toBeUndefined();

    await expectNoSteerSent(harness, handle);
  });

  it('a Claimed (not yet started) task is task_not_running — the state gate fires before the capability gate even for a steerable runtime', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await harness.byok.dispatch({ instruction: 'claimed but not started' });
    send(harness.ws, createEnvelope('task.claim', { deviceId: harness.deviceId, runtime: 'pi' }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');

    const err = asSteerRejection(await handle.steer('too early').catch((e: unknown) => e));
    expect(err.code).toBe('task_not_running');
    expect(err.state).toBe('Claimed');
  });

  it('a terminal task is task_terminal, NOT task_not_running — terminal wins over both later gates even for a steerable runtime', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, 'pi');
    await handle.cancel('changed my mind');
    await handle.result();
    expect(harness.byok.tasks.get(handle.taskId)?.state).toBe('Cancelled');

    const err = asSteerRejection(await handle.steer('too late').catch((e: unknown) => e));
    expect(err.code).toBe('task_terminal');
    expect(err.state).toBe('Cancelled');
  });

  it('the gate is per-runtime, not per-device: a device advertising BOTH pi and claude gets a steerable task only for the runtime it actually claimed', async () => {
    harness = await startHarness([PI_RUNTIME_INFO, CLAUDE_RUNTIME_INFO]);

    const claudeTask = await dispatchClaimedRunning(harness, 'claude', 'runs on claude');
    expect(harness.byok.tasks.get(claudeTask.taskId)?.claimedRuntimeCapabilities?.steer).toBe(false);
    const err = asSteerRejection(await claudeTask.steer('nope').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');
    await expectNoSteerSent(harness, claudeTask);

    const piTask = await dispatchClaimedRunning(harness, 'pi', 'runs on pi');
    expect(harness.byok.tasks.get(piTask.taskId)?.claimedRuntimeCapabilities?.steer).toBe(true);
    await piTask.steer('keep going');
    const envelope = await nextEnvelope(harness.ws);
    expect(envelope.type).toBe('task.steer');
    expect(envelope.task_id).toBe(piTask.taskId);
  });
});

describe('S0 (GAP-002): claim-time capability snapshot on the task record', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    harness?.ws.terminate();
    harness?.byok.stop();
    if (harness) await stopServer(harness.server);
    harness = undefined;
  });

  it("the Offered -> Claimed transition records the claiming connection's advertised capabilities verbatim, alongside claimedRuntime", async () => {
    harness = await startHarness([PI_RUNTIME_INFO, CLAUDE_RUNTIME_INFO]);
    const handle = await harness.byok.dispatch({ instruction: 'snapshot me' });
    send(harness.ws, createEnvelope('task.claim', { deviceId: harness.deviceId, runtime: 'pi' }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');

    const snapshot = harness.byok.tasks.get(handle.taskId);
    expect(snapshot?.claimedRuntime).toBe('pi');
    expect(snapshot?.claimedRuntimeCapabilities).toEqual(PI_RUNTIME_INFO.capabilities);
  });

  it('a reconnect advertising a DIFFERENT capability set does not retroactively change an already-running task: the snapshot is frozen at claim time', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, 'pi');

    // Same device, brand-new connection, now honestly reporting a pi build
    // that cannot steer (downgrade/reinstall). A live capability read would
    // flip this running task to unsteerable mid-flight; the snapshot must not.
    harness.ws.terminate();
    const reconnected = await connectFakeDaemonWs(harness.port, {
      deviceId: harness.deviceId,
      accessToken: harness.accessToken,
      productId: PRODUCT_ID,
      runtimes: [{ id: 'pi', capabilities: { ...PI_RUNTIME_INFO.capabilities, steer: false } }],
    });
    harness.ws = reconnected.ws;

    expect(harness.byok.tasks.get(handle.taskId)?.claimedRuntimeCapabilities?.steer).toBe(true);
    await expect(handle.steer('still steerable')).resolves.toBeUndefined();
  });
});

// node:sqlite requires Node 22.5+ and shipped behind a flag until later in
// the 22.x line — gate on ACTUAL availability, mirroring
// `sqlite-task-store.test.ts`'s own convention, so this skips cleanly on the
// Node 20 leg instead of failing.
const sqliteReady = isSqliteAvailable();

describe.skipIf(!sqliteReady)('S0 (GAP-002): the capability snapshot survives a SqliteTaskStore roundtrip', () => {
  it('a task claimed against a SqliteTaskStore reads its claimedRuntimeCapabilities back from a freshly reopened store', async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'byok-steer-gate-')), 'tasks.db');

    const store = new SqliteTaskStore({ path: dbPath });
    const byok = createByokServer({ productId: PRODUCT_ID, taskStore: store });
    const started = await startServer(byok);
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, {
      productId: PRODUCT_ID,
      runtimes: [PI_RUNTIME_INFO],
    });

    const handle = await byok.dispatch({ instruction: 'persist my capabilities' });
    send(daemon.ws, createEnvelope('task.claim', { deviceId: daemon.deviceId, runtime: 'pi' }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');

    daemon.ws.terminate();
    byok.stop();
    await stopServer(started.server);
    store.close();

    // A brand-new store instance against the same file — the restart story.
    const reopened = new SqliteTaskStore({ path: dbPath });
    const record = reopened.get(handle.taskId);
    expect(record?.claimedRuntime).toBe('pi');
    expect(record?.claimedRuntimeCapabilities).toEqual(PI_RUNTIME_INFO.capabilities);
    reopened.close();
  });

  it('a record with no snapshot round-trips as undefined (not null, not an empty object) so the gate still fails closed after a restart', async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'byok-steer-gate-')), 'tasks.db');

    const store = new SqliteTaskStore({ path: dbPath });
    store.create({ taskId: 'task_legacy', instruction: 'pre-S0 record', policy: { mode: 'confirm' } });
    store.transition('task_legacy', 'Claimed', { deviceId: 'dev_1', claimedRuntime: 'pi' });
    store.close();

    const reopened = new SqliteTaskStore({ path: dbPath });
    const record = reopened.get('task_legacy');
    expect(record?.claimedRuntime).toBe('pi');
    expect(record?.claimedRuntimeCapabilities).toBeUndefined();
    reopened.close();
  });
});
