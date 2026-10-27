/**
 * The clock of #794 D3 (H4) on local workerd: the `HostClock` alarm alone runs routine slots and due steps on time. Each
 * test reaches its subject with `drop-notify` on, and calls no `/host/passes`, so only an alarm pass can do the work. Each
 * test has its own scope, device and instance, and arms the clock once through the cron trigger; a restart keeps the
 * instance's storage dir, so the clock keeps its alarm with no new arm.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTINE_LATE_AFTER_MS } from '@byok-sdk/example-bot-collaboration/routines';
import { storedKey } from '@byok-sdk/example-hosted-bot-collaboration/src/layout';
import { alarmReports, openHome, RUN, until, type Home, type WorkerOptions } from './worker.test-support';

/** The default `H_CLOCK_MS`: the tests run the clock as a deployment would. */
const CLOCK_MS = 10_000;
/** A routine slot is at least this far from the outcome that creates it, so the restart that follows is done before it. */
const LEAD_MS = 30_000;
/** The longest wait for a slot: up to a minute to the next whole minute after the lead, then the late bound. */
const SLOT_WAIT_MS = LEAD_MS + 60_000 + ROUTINE_LATE_AFTER_MS;
const ROUTINE_TEST_MS = SLOT_WAIT_MS + 120_000;
const COALESCE = { vars: { H_COALESCE_WINDOW_MS: '5000' } } satisfies Omit<WorkerOptions, 'persist'>;

let h: Home | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

/** The next whole UTC minute at least `LEAD_MS` away, as a daily schedule and its epoch time. */
function nextSlot() {
  const at = Math.ceil((Date.now() + LEAD_MS) / 60_000) * 60_000, date = new Date(at);
  return { at, schedule: { minute: date.getUTCMinutes(), hour: date.getUTCHours(), tz: 'UTC' } };
}

/** An owner Turn whose outcome creates one daily routine. Returns its first slot. */
async function routine(home: Home): Promise<number> {
  const { token } = await home.bot();
  const { turnId, task } = await home.input(token, 'Create a routine');
  await home.device.waitForStart(task);
  const slot = nextSlot();
  await home.device.finish(task, { create_routine: [{ localId: 'new_routine_1', schedule: slot.schedule, prompt: 'Clock report' }] });
  await until(async () => (await home.turn(turnId))?.status === 'succeeded' || undefined);
  expect(await home.routines()).toEqual([{ nextAt: slot.at }]);
  return slot.at;
}
const occurrenceOf = async (home: Home, plannedAt: number) =>
  (await home.occurrences()).find(occurrence => occurrence.plannedAt === plannedAt);
const fired = (home: Home) => alarmReports(home.worker).reduce((sum, report) => sum + report.routines.fired, 0);

/**
 * An owner input that the coalescing policy holds in an open batch, because the Bot runs `busyBot`'s Turn. The scope's due
 * time is the batch's seal time, so the due scheduler is what seals it.
 */
async function heldInput(home: Home, token: string) {
  const { turnId } = await home.input(token, `Held ${Date.now()}`);
  const batch = (await home.substrate.store.read(home.home)).inputBatches?.[turnId];
  expect(batch).toMatchObject({ state: 'open' });
  const [scope] = (await home.substrate.pool.query<{ due_at: string | null }>(
    `SELECT due_at::text FROM "${home.substrate.hSchema}".scope WHERE scope = $1`, [storedKey(home.home)])).rows;
  expect(Number(scope?.due_at)).toBe(batch!.sealAt);
  return { turnId, sealAt: batch!.sealAt };
}
const sealed = (home: Home, turnId: string) => until(async () => {
  const batch = (await home.substrate.store.read(home.home)).inputBatches?.[turnId];
  return batch?.state === 'sealed' ? { reason: batch.sealReason, seenAt: Date.now() } : undefined;
}, 90_000);
/** The due scheduler of an alarm pass synced a due scope. A report prints after its commits, so the seal can come first. */
const dueSyncedByAlarm = (home: Home) =>
  until(async () => alarmReports(home.worker).some(report => report.due.synced > 0) || undefined, 3 * CLOCK_MS);
/**
 * Waits for an alarm pass that synced no changed scope: the reconciler has read back the running Turn. A pass also seals
 * due batches when it syncs a scope it changed, so a seal after this comes from the due scheduler.
 */
async function settled(home: Home) {
  const seen = alarmReports(home.worker).length;
  await until(async () => alarmReports(home.worker).slice(seen).some(report => report.synced.length === 0) || undefined, 3 * CLOCK_MS);
}
/** A Main Bot whose first Turn runs on the device and stays running, so the Bot is busy. */
async function busyBot(home: Home) {
  const { token } = await home.bot();
  const { task } = await home.input(token, 'Keep running');
  await home.device.waitForStart(task);
  return token;
}

describe.skipIf(!RUN)('the Host clock on local workerd (#794 D3, H4)', () => {
  it('fires a routine slot from an alarm pass, inside the K8 late bound, and offers its Turn', async () => {
    h = await openHome();
    await h.worker.armClock();
    const slot = await routine(h);
    await h.restart({ fault: 'drop-notify' });
    const occurrence = await until(() => occurrenceOf(h!, slot), SLOT_WAIT_MS);
    expect(occurrence.trigger).toBe('scheduled');
    expect(occurrence.recordedAt - slot).toBeLessThan(ROUTINE_LATE_AFTER_MS);
    // A pass prints its report after its commits, so the occurrence can be seen first.
    await until(async () => fired(h!) > 0 || undefined, 3 * CLOCK_MS);
    expect(fired(h)).toBe(1);
    // The same alarm pass froze and offered the routine Turn, and the device started it.
    const [intent] = await until(async () => {
      const intents = await h!.routineIntents();
      return intents[0]?.submission === 'delivered' ? intents : undefined;
    });
    expect(await h.mailbox(intent!.task)).toEqual([{ type: 'task.offer', session: 'fresh', egress: true }]);
    await h.device.waitForStart(intent!.task);
  }, ROUTINE_TEST_MS);

  it('a duplicate alarm runs two passes at once: one occurrence, one routine Turn, one offer', async () => {
    h = await openHome();
    await h.worker.armClock();
    const slot = await routine(h);
    await h.restart({ fault: 'drop-notify,duplicate-alarm' });
    await until(() => occurrenceOf(h!, slot), SLOT_WAIT_MS);
    const [intent] = await until(async () => {
      const intents = await h!.routineIntents();
      return intents[0]?.submission === 'delivered' ? intents : undefined;
    });
    // Two more alarms, each with two passes, after the fire.
    const after = alarmReports(h.worker).length;
    await until(async () => alarmReports(h!.worker).length >= after + 4 || undefined, 4 * CLOCK_MS);
    expect((await h.occurrences()).filter(occurrence => occurrence.plannedAt === slot)).toHaveLength(1);
    expect(fired(h)).toBe(1);
    expect(await h.routineIntents()).toHaveLength(1);
    expect(await h.mailbox(intent!.task)).toEqual([{ type: 'task.offer', session: 'fresh', egress: true }]);
    expect(h.worker.lines('[h-clock] alarm pass').filter(line => / 2\/2 /u.test(line)).length).toBeGreaterThanOrEqual(2);
  }, ROUTINE_TEST_MS);

  it('an instance lost mid-alarm, after the routine Turn was offered: the stored alarm of the next instance reads it back', async () => {
    h = await openHome();
    await h.worker.armClock();
    const slot = await routine(h);
    let worker = await h.restart({ fault: 'drop-notify,hang-after-submit', vars: { H_SUBMIT_LEASE_MS: '2000' } });
    await worker.waitForOutput('[h-fault] hang-after-submit', SLOT_WAIT_MS);
    const [intent] = await h.routineIntents();
    expect(worker.lines('[h-fault] hang-after-submit')).toEqual([expect.stringContaining(intent!.task)]);
    await worker.kill();
    // The fire committed and the SDK holds the offer; the Host never wrote the delivery.
    expect((await h.occurrences()).filter(occurrence => occurrence.plannedAt === slot)).toHaveLength(1);
    expect(await h.mailbox(intent!.task)).toEqual([{ type: 'task.offer', session: 'fresh', egress: true }]);
    expect((await h.routineIntents())[0]).toMatchObject({ tries: 1, conclusion: null });
    expect((await h.routineIntents())[0]?.submission).not.toBe('delivered');
    worker = await h.restart({ fault: 'drop-notify' });
    await until(async () => (await h!.routineIntents())[0]?.submission === 'delivered' || undefined);
    expect(alarmReports(worker).some(report => report.submit.tried > 0)).toBe(true);
    expect((await h.occurrences()).filter(occurrence => occurrence.plannedAt === slot)).toHaveLength(1);
    expect(await h.routineIntents()).toHaveLength(1);
    expect(await h.mailbox(intent!.task)).toEqual([{ type: 'task.offer', session: 'fresh', egress: true }]);
    await h.device.waitForStart(intent!.task);
    expect(h.device.started.filter(entry => entry.taskId === intent!.task)).toHaveLength(1);
  }, ROUTINE_TEST_MS);

  it('seals a coalesced input batch from an alarm pass, within a minute of its seal time', async () => {
    h = await openHome(COALESCE);
    await h.worker.armClock();
    const token = await busyBot(h);
    await h.restart({ ...COALESCE, fault: 'drop-notify' });
    await settled(h);
    const { turnId, sealAt } = await heldInput(h, token);
    const seal = await sealed(h, turnId);
    expect(seal.reason).toBe('window');
    expect(seal.seenAt - sealAt).toBeLessThan(60_000);
    await dueSyncedByAlarm(h);
  }, 240_000);

  it('lost alarms leave a due batch open; the next alarm after them seals it from Postgres', async () => {
    h = await openHome(COALESCE);
    await h.worker.armClock();
    const token = await busyBot(h);
    await settled(h);
    const worker = await h.restart({ ...COALESCE, fault: 'drop-notify,drop-alarm' });
    const { turnId, sealAt } = await heldInput(h, token);
    // Two alarms after the seal time, both dropped.
    const dropped = () => worker.lines('[h-clock] alarm dropped').length;
    await until(async () => Date.now() > sealAt || undefined, 2 * CLOCK_MS);
    const due = dropped();
    await until(async () => dropped() >= due + 2 || undefined, 3 * CLOCK_MS);
    expect((await h.substrate.store.read(h.home)).inputBatches?.[turnId]).toMatchObject({ state: 'open' });
    await h.restart({ ...COALESCE, fault: 'drop-notify' });
    expect((await sealed(h, turnId)).reason).toBe('window');
    await dueSyncedByAlarm(h);
  }, 240_000);
});
