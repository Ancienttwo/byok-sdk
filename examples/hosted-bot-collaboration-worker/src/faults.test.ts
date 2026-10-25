/**
 * The Worker faults of #794 D3: a lost notification, a duplicate notification, and an instance destroyed mid-request. Each
 * test starts its own instance with the fault as instance config. A kill is SIGKILL to wrangler and workerd with no grace,
 * so nothing in the Worker runs after it; the next instance has only Postgres. This is local workerd: it shows that recovery
 * needs nothing in memory, not how Cloudflare evicts an isolate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storedKey } from '@byok-sdk/example-hosted-bot-collaboration/src/layout';
import { alarmReports, openHome, RUN, until, type Home } from './worker.test-support';

/** A wait long enough for any notified pass of a local instance to have run. Nothing may change in it. */
const QUIET_MS = 3_000;
const quiet = () => new Promise(resolve => setTimeout(resolve, QUIET_MS));
const NOTIFIED = '[h-worker] notified pass';

describe.skipIf(!RUN)('H Worker faults on local workerd (#794 D3)', () => {
  let h: Home;
  beforeAll(async () => { h = await openHome(); });
  afterAll(async () => { await h?.close(); });

  it('a lost notification delays the work to the next alarm pass, which finds it in Postgres', async () => {
    const worker = await h.restart({ fault: 'drop-notify' });
    const { token } = await h.bot();
    const { turnId, task } = await h.input(token);
    await until(async () => (await h.intent(turnId))?.submission === 'delivered' || undefined);
    await h.device.waitForStart(task);
    await h.device.finish(task, {});
    // The device terminal committed in the SDK; its notification was lost too.
    await until(async () => (await h.turn(turnId))?.status === 'succeeded' || undefined);
    expect((await h.commands()).filter(id => id === task)).toHaveLength(1);
    // No notified pass ran, and nothing called /host/passes: the alarm passes offered the Turn and applied its terminal.
    expect(worker.lines(NOTIFIED)).toEqual([]);
    const reports = alarmReports(worker);
    expect(reports.some(report => report.submit.tried > 0)).toBe(true);
    expect(reports.some(report => report.reconcile.concluded > 0)).toBe(true);
  });

  it('a duplicate notification runs two passes at once: one submit, one outcome, and later passes change nothing', async () => {
    const worker = await h.restart({ fault: 'duplicate-notify' });
    const { token } = await h.bot();
    const { turnId, task } = await h.input(token);
    await until(async () => (await h.intent(turnId))?.submission === 'delivered' || undefined);
    await h.device.waitForStart(task);
    await h.device.finish(task, {});
    await until(async () => (await h.turn(turnId))?.conclusion === 'succeeded' || undefined);
    await quiet();
    const stored = await h.substrate.store.dump(h.home);
    // Two more notified-style passes at once, and the next alarm pass: the rows are settled, so nothing changes.
    const alarms = alarmReports(worker).length;
    await Promise.all([worker.passes(), worker.passes(), until(async () => alarmReports(worker).length > alarms || undefined)]);
    expect(await h.substrate.store.dump(h.home)).toBe(stored);
    expect(await h.intent(turnId)).toMatchObject({ tries: 1, conclusion: 'succeeded' });
    expect((await h.commands()).filter(id => id === task)).toHaveLength(1);
    expect(await h.mailbox(task)).toEqual(['task.offer_for_agent_with_egress_fresh']);
    expect(h.device.started.filter(entry => entry.taskId === task)).toHaveLength(1);
    // Every notification of this instance (the input, the device's claim and terminal) ran two passes.
    const notified = worker.lines(NOTIFIED).map(line => line.slice(line.indexOf(NOTIFIED) + NOTIFIED.length).trim());
    const ids = new Set(notified.map(line => line.split(' ')[0]));
    expect(ids.size).toBeGreaterThanOrEqual(2);
    for (const id of ids) expect(notified.filter(line => line.startsWith(`${id} `)).sort()).toEqual([`${id} 1/2`, `${id} 2/2`]);
  });

  it('an instance destroyed after the SDK accepted a submit: the next instance reads the offer back and submits nothing new', async () => {
    let worker = await h.restart({ fault: 'hang-after-submit', vars: { H_SUBMIT_LEASE_MS: '2000' } });
    const { token } = await h.bot();
    const { turnId, task } = await h.input(token);
    await worker.waitForOutput(`[h-fault] hang-after-submit ${task}`);
    await worker.kill();
    // The SDK holds the offer; the Host never wrote the delivery.
    expect(await h.mailbox(task)).toEqual(['task.offer_for_agent_with_egress_fresh']);
    expect(await h.intent(turnId)).toMatchObject({ tries: 1, conclusion: null });
    expect((await h.intent(turnId))?.submission).not.toBe('delivered');
    worker = await h.restart();
    // The new try waits out the dead try's lease, then the K4 frozen submit reads the offer back instead of submitting.
    await until(async () => (await worker.passes(), (await h.intent(turnId))?.submission === 'delivered' || undefined));
    expect(await h.mailbox(task)).toEqual(['task.offer_for_agent_with_egress_fresh']);
    await h.device.waitForStart(task);
    await h.device.finish(task, {});
    await until(async () => (await worker.passes(), (await h.turn(turnId))?.status === 'succeeded' || undefined));
    expect(h.device.started.filter(entry => entry.taskId === task)).toHaveLength(1);
    expect((await h.commands()).filter(id => id === task)).toHaveLength(1);
  });

  it('an instance destroyed after it read a device terminal: the next instance applies the outcome once', async () => {
    let worker = await h.restart({ fault: 'hang-after-terminal-read' });
    const { token } = await h.bot();
    const { turnId, task } = await h.input(token);
    await until(async () => (await h.intent(turnId))?.submission === 'delivered' || undefined);
    await h.device.waitForStart(task);
    await h.device.finish(task, {});
    // The device's terminal notification starts a pass, which reads the terminal and stops there.
    await worker.waitForOutput(`[h-fault] hang-after-terminal-read ${task}`);
    await worker.kill();
    expect(await h.intent(turnId)).toMatchObject({ conclusion: null });
    expect(await h.commands()).not.toContain(task);
    worker = await h.restart();
    await until(async () => (await worker.passes(), (await h.turn(turnId))?.status === 'succeeded' || undefined));
    expect(await h.intent(turnId)).toMatchObject({ tries: 1, conclusion: 'succeeded' });
    expect((await h.commands()).filter(id => id === task)).toHaveLength(1);
  });

  it('keeps no backoff between invocations: a scope whose sync throws is retried on every pass, and the others go on (H1)', async () => {
    const worker = await h.restart();
    // A scope row with no product row: its config read throws in every sync. Its due time stays in Postgres.
    const broken = `worker-broken-${Date.now()}`;
    await h.substrate.store.seed(broken, () => {});
    await h.substrate.pool.query(`UPDATE "${h.substrate.hSchema}".scope SET due_at = 1 WHERE scope = $1`, [storedKey(broken)]);
    const first = await worker.passes(), second = await worker.passes();
    for (const pass of [first, second]) expect(pass.due.failed.map(failure => failure.scope)).toContain(broken);
    // A healthy scope still runs a Turn through the same passes.
    const { token } = await h.bot();
    const { turnId, task } = await h.input(token);
    await h.device.waitForStart(task);
    await h.device.finish(task, {});
    await until(async () => (await worker.passes(), (await h.turn(turnId))?.status === 'succeeded' || undefined));
  });
});
