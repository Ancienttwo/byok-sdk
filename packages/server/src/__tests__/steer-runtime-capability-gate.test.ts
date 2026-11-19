import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, TASK_STEER_TEXT_MAX_BYTES, type ClaimedExecutor, type HarnessInfo, type RuntimeCapabilities } from '@byok-sdk/protocol';
import { createByokServer, SteerRejectedError, type ByokServer, type TaskHandle } from '../index';
import {
  announceHello,
  CLAUDE_RUNTIME_INFO,
  claimAndStart,
  CODEX_RUNTIME_INFO,
  connectFakeDaemonLongPoll,
  nextEnvelope,
  PI_RUNTIME_INFO,
  sendOne,
  startServer,
  stopServer,
  type FakeLongPollDaemon,
  TEST_AGENT_DISPATCH,
  TEST_AGENT_REF,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short enough that a poll deliberately expecting nothing costs ~200ms, not ~50s. */
const SHORT_HOLD_MS = 200;
const PI: ClaimedExecutor = { id: 'pi' };
const CLAUDE: ClaimedExecutor = { id: 'claude' };
const CODEX: ClaimedExecutor = { id: 'codex' };

/**
 * S0 (GAP-002): steering used to be sent to ANY `Running` task. Only pi's
 * adapter implements steering — Claude's and Codex's throw on receipt, which
 * stalls the client's redelivery cursor at that seq and re-loops the same
 * envelope forever. The gate is a task-level check over a claim-time capability
 * snapshot (`TaskSnapshot.claimedRuntimeCapabilities`, written by the cloud
 * kernel's inbound gate at the ownership CAS) that refuses with a typed
 * {@link SteerRejectedError} BEFORE any envelope exists.
 *
 * S0/D-4 — WHERE that snapshot comes from: `task.claim.capabilities`, the
 * claiming adapter's own self-report on the very message that establishes the
 * task↔runtime binding. NOT `conn.hello.runtimes[].capabilities`, which is
 * connection-level discovery: it describes a device rather than the adapter
 * that claimed this task. The "connection-advertised capabilities cannot feed
 * the gate" describe block below is the machine-checkable guard on that
 * separation, in both directions.
 *
 * Transport: LONG-POLL ONLY (WP3B Step 2b deleted the WebSocket path), so the
 * whole path — `task.claim.capabilities` -> kernel snapshot -> task record ->
 * gate — is still exercised end to end over `POST /byok/messages` and
 * `GET /byok/events`.
 */

interface Harness {
  byok: ByokServer;
  server: HttpServer;
  daemon: FakeLongPollDaemon;
}

/**
 * Boot a server + one paired/announced fake daemon. `runtimes` is what the
 * daemon advertises in its `conn.hello` — discovery only, deliberately
 * independent of what any claim below reports; most tests here pass the
 * realistic set purely so the fixture resembles a real device.
 */
async function startHarness(runtimes: HarnessInfo[] | undefined, harnesses?: HarnessInfo[]): Promise<Harness> {
  const byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
  const started = await startServer(byok);
  const daemon = await connectFakeDaemonLongPoll(started.baseUrl, byok, { productId: PRODUCT_ID, runtimes, harnesses });
  return { byok, server: started.server, daemon };
}

/**
 * Dispatch a task, consume its `task.offer` off the wire, then drive it to
 * `Running` claiming `executor` and self-reporting `capabilities`. Consuming
 * the offer matters: every assertion below about "what the device receives
 * next" would otherwise be answered by the still-queued offer rather than by
 * the envelope under test.
 *
 * `capabilities` is passed explicitly at every call site rather than derived
 * from `executor`: the whole point of the gate is that the server never infers
 * a capability from a runtime id, so the fixture must not either.
 */
async function dispatchClaimedRunning(
  h: Harness,
  executor: ClaimedExecutor,
  capabilities: RuntimeCapabilities | undefined,
  instruction = 'long running task',
): Promise<TaskHandle> {
  const handle = await h.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: h.daemon.deviceId, instruction });
  const offer = await nextEnvelope(h.daemon);
  expect(offer.type).toBe('task.offer');
  await claimAndStart(h.byok, h.daemon, handle, executor, capabilities);
  return handle;
}

/**
 * Prove no `task.steer` was produced for `handle`, without racing a timer:
 * issue a `cancel` (which always sends) and assert the very next envelope the
 * device receives is that cancel. Envelopes leave through one per-device
 * mailbox in `seq` order, so a steer that had been built would necessarily sit
 * ahead of the cancel here.
 *
 * The pre-fold version also checked `stats().envelopesOut` around the cancel.
 * That counter is gone (WP3B: server -> daemon envelopes are durable mailbox
 * rows the kernel owns, and a second count of them here would be a weaker
 * authority over a fact the mailbox holds exactly), so the ordering claim is
 * the whole assertion now — and it is the one that could actually catch a
 * steer that was built.
 */
async function expectNoSteerSent(h: Harness, handle: TaskHandle): Promise<void> {
  await handle.cancel('done proving the negative');

  const next = await nextEnvelope(h.daemon);
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
    await harness?.byok.close();
    if (harness) await stopServer(harness.server);
    harness = undefined;
  });

  it('pi (claim reports steer = true) claimed and Running: steer succeeds and the task.steer envelope reaches the device', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, PI, PI_RUNTIME_INFO.capabilities);

    const { messageId } = await handle.steer('keep going');

    const envelope = await nextEnvelope(harness.daemon);
    expect(envelope.type).toBe('task.steer');
    expect(envelope.task_id).toBe(handle.taskId);
    // The id a later `steer_refused` names is the enqueued envelope's own id.
    expect(envelope.id).toBe(messageId);
    if (envelope.type !== 'task.steer' || envelope.payload.sealed !== undefined) throw new Error('unreachable');
    expect(envelope.payload.text).toBe('keep going');
  });

  it('refuses steer text over TASK_STEER_TEXT_MAX_BYTES UTF-8 bytes before anything is enqueued, even for a steerable Running task', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, PI, PI_RUNTIME_INFO.capabilities);
    // 21,845 three-byte chars plus 2 ASCII: 65,537 bytes in 21,847 UTF-16 units.
    const text = '\u20ac'.repeat(21_845) + 'ab';
    expect(new TextEncoder().encode(text).length).toBe(TASK_STEER_TEXT_MAX_BYTES + 1);

    await expect(handle.steer(text)).rejects.toMatchObject({ code: 'coordination_input_invalid' });

    await expectNoSteerSent(harness, handle);
  });

  it('claude (claim reports steer = false) claimed and Running: rejected with steer_unsupported_runtime, and the device receives no task.steer at all', async () => {
    harness = await startHarness([CLAUDE_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, CLAUDE, CLAUDE_RUNTIME_INFO.capabilities);

    const err = asSteerRejection(await handle.steer('please stop').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');
    expect(err.executor).toEqual(CLAUDE);
    expect(err.state).toBe('Running');

    await expectNoSteerSent(harness, handle);
  });

  it('codex (claim reports steer = false) claimed and Running: same fail-closed rejection as claude', async () => {
    harness = await startHarness([CODEX_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, CODEX, CODEX_RUNTIME_INFO.capabilities);

    const err = asSteerRejection(await handle.steer('please stop').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');
    expect(err.executor).toEqual(CODEX);

    await expectNoSteerSent(harness, handle);
  });

  it('fail-closed on unknown: a task.claim carrying NO capabilities leaves the snapshot undefined, and a steer for it is refused rather than sent', async () => {
    // A pre-D-4 daemon: `task.claim.capabilities` is optional on the wire, so
    // it claims pi and reports nothing about what pi can do. "This server does
    // not know" must refuse — assuming "steerable, because it says pi" is
    // exactly what produces a permanent cursor stall against a build where
    // that isn't true.
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, PI, undefined);

    expect((await harness.byok.tasks.get(handle.taskId))?.claimedExecutor).toEqual(PI);
    expect((await harness.byok.tasks.get(handle.taskId))?.claimedRuntimeCapabilities).toBeUndefined();

    const err = asSteerRejection(await handle.steer('keep going').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');

    await expectNoSteerSent(harness, handle);
  });

  it('fail-closed on unknown: a capabilities block that simply omits `steer` is refused — absent is not true', async () => {
    // Every field of `RuntimeCapabilities` is individually optional, so a
    // partial self-report is well-formed on the wire. The gate requires a
    // POSITIVE `steer === true`; anything else, including a block that reports
    // other flags but says nothing about steering, refuses.
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, PI, { resume: true, approvalInteractive: false });

    expect((await harness.byok.tasks.get(handle.taskId))?.claimedRuntimeCapabilities).toEqual({
      resume: true,
      approvalInteractive: false,
    });

    const err = asSteerRejection(await handle.steer('keep going').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');

    await expectNoSteerSent(harness, handle);
  });

  it('a Claimed (not yet started) task is task_not_running — the state gate fires before the capability gate even for a steerable runtime', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await harness.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: harness.daemon.deviceId, instruction: 'claimed but not started' });
    const claim = await sendOne(
      harness.daemon,
      createEnvelope(
        'task.claim',
        { agentRef: TEST_AGENT_REF, deviceId: harness.daemon.deviceId, executor: PI, capabilities: PI_RUNTIME_INFO.capabilities },
        { taskId: handle.taskId },
      ),
    );
    expect(claim).toMatchObject({ status: 200, body: { accepted: 1 } });
    expect((await harness.byok.tasks.get(handle.taskId))?.state).toBe('Claimed');

    const err = asSteerRejection(await handle.steer('too early').catch((e: unknown) => e));
    expect(err.code).toBe('task_not_running');
    expect(err.state).toBe('Claimed');
  });

  it('a terminal task is task_terminal, NOT task_not_running — terminal wins over both later gates even for a steerable runtime', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, PI, PI_RUNTIME_INFO.capabilities);
    await handle.cancel('changed my mind');
    await handle.result();
    expect((await harness.byok.tasks.get(handle.taskId))?.state).toBe('Cancelled');

    const err = asSteerRejection(await handle.steer('too late').catch((e: unknown) => e));
    expect(err.code).toBe('task_terminal');
    expect(err.state).toBe('Cancelled');
  });

  it('the gate is per-task, not per-device: one device running two tasks gets a steerable one only where the claim said so', async () => {
    harness = await startHarness([PI_RUNTIME_INFO, CLAUDE_RUNTIME_INFO]);

    const claudeTask = await dispatchClaimedRunning(harness, CLAUDE, CLAUDE_RUNTIME_INFO.capabilities, 'runs on claude');
    expect((await harness.byok.tasks.get(claudeTask.taskId))?.claimedRuntimeCapabilities?.steer).toBe(false);
    const err = asSteerRejection(await claudeTask.steer('nope').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');
    await expectNoSteerSent(harness, claudeTask);

    const piTask = await dispatchClaimedRunning(harness, PI, PI_RUNTIME_INFO.capabilities, 'runs on pi');
    expect((await harness.byok.tasks.get(piTask.taskId))?.claimedRuntimeCapabilities?.steer).toBe(true);
    await piTask.steer('keep going');
    const envelope = await nextEnvelope(harness.daemon);
    expect(envelope.type).toBe('task.steer');
    expect(envelope.task_id).toBe(piTask.taskId);
  });

  it('a custom harness that reports steer = true on its claim is steerable, though no built-in runtime names it', async () => {
    // A custom harness claims as `{ kind: 'harness' }`, never as a runtime —
    // but capabilities are a self-report any adapter can make honestly, and
    // the client sends them ungated for exactly this reason. The gate reads
    // capabilities, never the executor, so this must steer.
    // The kernel admits a harness claim only for a harness the device declared.
    harness = await startHarness([], [{ id: 'acme.custom', capabilities: { steer: true, resume: false, selectionModes: ['device-default'], effort: false } }]);
    const custom: ClaimedExecutor = { id: 'acme.custom' };
    const handle = await dispatchClaimedRunning(harness, custom, { steer: true, resume: false });

    expect((await harness.byok.tasks.get(handle.taskId))?.claimedExecutor).toEqual(custom);
    await handle.steer('keep going');

    const envelope = await nextEnvelope(harness.daemon);
    expect(envelope.type).toBe('task.steer');
    expect(envelope.task_id).toBe(handle.taskId);
  });
});

/**
 * S0/D-4 structural guard. The gate has exactly ONE input, and this block is
 * what makes "exactly one" machine-checkable rather than a comment: it drives
 * the connection layer and the claim layer to DISAGREE, in both directions,
 * and asserts the claim wins every time.
 *
 * The negative direction is the important one. Before D-4 the snapshot was
 * looked up in the connection's `conn.hello` runtimes, so "hello says pi can
 * steer" was sufficient to open the gate. If anyone reintroduces that lookup —
 * as a source, or as a fallback for when the claim carries nothing — that test
 * goes green-to-red immediately, at the exact behavior that matters, instead of
 * surfacing later as a deployment that mysteriously cannot steer.
 */
describe('S0/D-4: connection-advertised capabilities cannot feed the steer gate', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.byok.close();
    if (harness) await stopServer(harness.server);
    harness = undefined;
  });

  it('conn.hello advertises pi with steer = true, but the claim carries no capabilities: STILL refused, and the snapshot stays undefined', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    expect(PI_RUNTIME_INFO.capabilities?.steer).toBe(true); // the connection layer really is offering a `true` to fall back to

    const handle = await dispatchClaimedRunning(harness, PI, undefined);

    // Nothing was harvested from the connection: not at claim time...
    expect((await harness.byok.tasks.get(handle.taskId))?.claimedExecutor).toEqual(PI);
    expect((await harness.byok.tasks.get(handle.taskId))?.claimedRuntimeCapabilities).toBeUndefined();

    // ...and not at steer time either.
    const err = asSteerRejection(await handle.steer('keep going').catch((e: unknown) => e));
    expect(err.code).toBe('steer_unsupported_runtime');
    expect(err.executor).toEqual(PI);

    await expectNoSteerSent(harness, handle);
  });

  it('conn.hello advertises pi with steer = false, but the claim reports steer = true: ALLOWED — the claim is the authority, not a second opinion', async () => {
    harness = await startHarness([{ id: 'pi', capabilities: { ...PI_RUNTIME_INFO.capabilities, steer: false } }]);

    const handle = await dispatchClaimedRunning(harness, PI, { steer: true, resume: true });

    expect((await harness.byok.tasks.get(handle.taskId))?.claimedRuntimeCapabilities?.steer).toBe(true);
    await handle.steer('keep going');

    const envelope = await nextEnvelope(harness.daemon);
    expect(envelope.type).toBe('task.steer');
    expect(envelope.task_id).toBe(handle.taskId);
  });

  it('a device that advertised NO runtimes at all still steers when its claim says so — device discovery is irrelevant to the task gate', async () => {
    // A daemon whose authenticated `conn.hello` snapshot has no runtime
    // capability data anywhere and must still be steerable on the strength of
    // its own claim. This is the regression the D-4 amendment exists for; the
    // end-to-end version is the client suite's `real-server-longpoll-steer`.
    harness = await startHarness(undefined);

    const handle = await dispatchClaimedRunning(harness, PI, PI_RUNTIME_INFO.capabilities);

    expect((await harness.byok.tasks.get(handle.taskId))?.claimedRuntimeCapabilities?.steer).toBe(true);
    await handle.steer('keep going');

    const envelope = await nextEnvelope(harness.daemon);
    expect(envelope.type).toBe('task.steer');
    expect(envelope.task_id).toBe(handle.taskId);
  });
});

describe('S0 (GAP-002): claim-time capability snapshot on the task record', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.byok.close();
    if (harness) await stopServer(harness.server);
    harness = undefined;
  });

  it("the Offered -> Claimed transition records the claim's own reported capabilities verbatim, alongside claimedExecutor", async () => {
    harness = await startHarness([PI_RUNTIME_INFO, CLAUDE_RUNTIME_INFO]);
    const handle = await harness.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: harness.daemon.deviceId, instruction: 'snapshot me' });
    const claim = await sendOne(
      harness.daemon,
      createEnvelope(
        'task.claim',
        { agentRef: TEST_AGENT_REF, deviceId: harness.daemon.deviceId, executor: PI, capabilities: PI_RUNTIME_INFO.capabilities },
        { taskId: handle.taskId },
      ),
    );
    expect(claim).toMatchObject({ status: 200, body: { accepted: 1 } });

    const snapshot = await harness.byok.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Claimed');
    expect(snapshot?.claimedExecutor).toEqual(PI);
    expect(snapshot?.claimedRuntimeCapabilities).toEqual({ steer: true, resume: true, approvalInteractive: false });
  });

  it('a re-announcement advertising a DIFFERENT capability set does not retroactively change an already-running task: the snapshot is frozen at claim time', async () => {
    harness = await startHarness([PI_RUNTIME_INFO]);
    const handle = await dispatchClaimedRunning(harness, PI, PI_RUNTIME_INFO.capabilities);

    // Same device, a fresh `conn.hello`, now honestly reporting a pi build that
    // cannot steer (downgrade/reinstall). Over long-poll there is no socket to
    // drop, so re-announcing replaces the durable capability snapshot.
    // A live capability read would flip
    // this running task to unsteerable mid-flight; the snapshot must not.
    await announceHello(harness.daemon, {
      productId: PRODUCT_ID,
      runtimes: [{ id: 'pi', capabilities: { ...PI_RUNTIME_INFO.capabilities, steer: false } }],
    });

    expect((await harness.byok.tasks.get(handle.taskId))?.claimedRuntimeCapabilities?.steer).toBe(true);
    await expect(handle.steer('still steerable')).resolves.toEqual({ messageId: expect.any(String) });
  });
});
