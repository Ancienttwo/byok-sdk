/**
 * The H Host as a Worker on local workerd (#794 D3, Worker row): the authenticated command entry, a pass, a device process, a
 * pass, and the cron trigger. One substrate, one device process and one scope for the file; each test seeds its own Agent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openHome, RUN, until, type Home } from './worker.test-support';

describe.skipIf(!RUN)('H Host on local workerd (#794 D3)', () => {
  let h: Home;
  beforeAll(async () => { h = await openHome(); });
  afterAll(async () => { await h?.close(); });

  it('runs one owner Turn: the entry commits, a pass offers it, the device runs it, a pass applies the terminal once', async () => {
    const { token } = await h.bot();
    const { turnId, task } = await h.input(token);
    await until(async () => (await h.worker.passes(), (await h.intent(turnId))?.submission === 'delivered' || undefined));
    await h.device.waitForStart(task);
    await h.device.finish(task, {});
    await until(async () => (await h.worker.passes(), (await h.turn(turnId))?.status === 'succeeded' || undefined));
    expect(await h.intent(turnId)).toMatchObject({ tries: 1, submission: 'delivered', conclusion: 'succeeded' });
    expect(await h.commands()).toContain(task);
    expect(await h.mailbox(task)).toEqual(['task.offer_for_agent_with_egress_fresh']);
  });

  it('rejects a request with no valid owner session, and writes nothing', async () => {
    await h.bot();
    const before = await h.substrate.store.dump(h.home);
    expect((await h.worker.input('not-a-session', 'main', 'k', 'Hello')).status).toBe(401);
    expect(await h.substrate.store.dump(h.home)).toBe(before);
  });

  it('runs the scheduled handler on the cron route', async () => {
    await h.worker.cron();
    await h.worker.waitForOutput('[h-worker] scheduled pass');
  });
});
