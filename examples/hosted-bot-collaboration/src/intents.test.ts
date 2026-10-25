import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sameFrozenOffer, taskId, type FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { openHostedCloud, SKIP_HOSTED_CLOUD, type HostedCloud } from './hosted-cloud.test-support';
import { freezeIntent, HostedSubmitter, type SubmitterOptions } from './intents';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { inSchema, lockScope } from './store';

// The SDK side is the hosted composition (createByokCloud over createPostgresCloudStores) with a real daemon, paired
// over loopback HTTP. The H side is its own schema of the same Postgres. D2b ships no product entry: the tests
// freeze intents directly.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
let host: HostedCloud | undefined;
let clock = 0;
/** The scopes that the submitters' `changed` option reported, in this test. */
let reported: string[] = [];

/** The tenant port, with a count of the SDK submits that really ran. */
function sdkPort() {
  const submitted: string[] = [];
  const port: FrozenSubmitPort = {
    submit: async input => { const enqueued = await host!.port.submit(input); submitted.push(input.taskId); return enqueued; },
    offer: id => host!.port.offer(id),
  };
  return { port, submitted };
}
function submitter(port: FrozenSubmitPort, options: Partial<SubmitterOptions> = {}) {
  return new HostedSubmitter(opened!.pool, opened!.store.schema, { port: () => port, now: () => clock, leaseMs: 1000, backoffMs: 500,
    changed: scope => { reported.push(scope); }, ...options });
}
async function freeze(scope: string, turnId = randomUUID(), waitUntil = clock + 60_000) {
  await opened!.store.seed(scope, () => {});
  await opened!.store.bindDevice(scope, host!.deviceId);
  return inSchema(opened!.pool, opened!.store.schema, async client => {
    await lockScope(client, storedKey(scope));
    return freezeIntent(client, scope, { key: turnId, source: 'user', execution: template(host!.deviceId), waitUntil });
  });
}
/** The SDK mailbox rows of the task's offer. */
async function offers(task: string): Promise<number> {
  const offer = await host!.port.offer(task);
  return offer ? host!.mailboxRows(offer.messageId) : 0;
}
type Row = { submission: string; tries: number; cancel_reason: string | null; conclusion: string | null; last_error: string | null };
async function row(scope: string, task: string): Promise<Row> {
  const found = await opened!.pool.query<Row>(`SELECT submission, tries, cancel_reason, conclusion, last_error FROM "${opened!.store.schema}".intent
    WHERE scope = $1 AND task_id = $2`, [storedKey(scope), task]);
  return found.rows[0]!;
}
const update = (scope: string, task: string, set: string) =>
  opened!.pool.query(`UPDATE "${opened!.store.schema}".intent SET ${set} WHERE scope = $1 AND task_id = $2`, [storedKey(scope), task]);

describe.skipIf(SKIP_HOSTED_CLOUD)('H submitter on real Postgres and a real SDK server (#793 D2b-1)', () => {
  // One SDK server for the suite. One schema for each test, because the submit scan covers the whole schema.
  beforeAll(async () => { host = await openHostedCloud(); clock = Date.now(); });
  afterAll(async () => { await host?.close(); });
  beforeEach(async () => { opened = await openStore(); reported = []; });
  afterEach(async () => { await opened?.close(); });

  it('freezes one intent per Turn under the stable K4 task id, and refuses another input', async () => {
    const scope = `tenant:${randomUUID()}`, turnId = randomUUID();
    const input = await freeze(scope, turnId);
    expect(input.taskId).toBe(taskId(turnId, 0));
    expect(await freeze(scope, turnId)).toEqual(input);
    await expect(inSchema(opened!.pool, opened!.store.schema, async client => {
      await lockScope(client, storedKey(scope));
      return freezeIntent(client, scope, { key: turnId, source: 'user', execution: { ...template(host!.deviceId), deviceId: 'other' }, waitUntil: clock + 60_000 });
    })).rejects.toThrow('Intent identity conflict');
  });

  it('refuses a second freeze of the Turn with another source (#793 D2b-2)', async () => {
    const scope = `tenant:${randomUUID()}`, turnId = randomUUID();
    await freeze(scope, turnId);
    await expect(inSchema(opened!.pool, opened!.store.schema, async client => {
      await lockScope(client, storedKey(scope));
      return freezeIntent(client, scope, { key: turnId, source: 'bot', execution: template(host!.deviceId), waitUntil: clock + 60_000 });
    })).rejects.toThrow('Intent identity conflict');
  });

  it('delivers the frozen input, and the SDK readback is that input', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    expect(await submitter(port).run()).toEqual({ tried: 1, failed: [] });
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 1, last_error: null });
    const offer = await host!.port.offer(input.taskId);
    expect(offer && sameFrozenOffer(offer, input)).toBe(true);
    expect(submitted).toEqual([input.taskId]);
  });

  it('after a crash between the claim and the SDK call, submits the same task id once', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    const crashed: FrozenSubmitPort = { ...port, submit: async () => { throw new Error('crash before the SDK call'); } };
    await submitter(crashed).run();
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 1, last_error: 'crash before the SDK call' });
    expect(await submitter(port).run()).toEqual({ tried: 0, failed: [] }); // the backoff holds the row
    clock += 500;
    await submitter(port).run();
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 2, last_error: null });
    expect(submitted).toEqual([input.taskId]);
    expect(await host!.cloud.readTaskAttempt(host!.tenant, input.taskId)).toMatchObject({ taskId: input.taskId, deviceId: host!.deviceId });
  });

  it('after a lost SDK response, reads the offer back and does not submit again', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    const lost: FrozenSubmitPort = { ...port, submit: async frozen => { await port.submit(frozen); throw new Error('lost response'); } };
    await submitter(lost).run();
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 1, last_error: null });
    expect(submitted).toEqual([input.taskId]);
    expect(await offers(input.taskId)).toBe(1);
  });

  it('never submits when the SDK holds another offer for the task id, and keeps the error', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    await host!.port.submit({ ...input, payload: { ...input.payload, instruction: 'Another Turn.' } });
    await submitter(port).run();
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 1, last_error: 'Offer differs from the frozen input' });
    expect(submitted).toEqual([]);
  });

  it('expires an untried row at wait_until with no SDK attempt', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope, randomUUID(), clock + 10), { port, submitted } = sdkPort();
    clock += 10;
    expect(await submitter(port).run()).toEqual({ tried: 1, failed: [] });
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'reserved', tries: 0, conclusion: 'expired' });
    expect(submitted).toEqual([]);
    expect(await host!.cloud.readTaskAttempt(host!.tenant, input.taskId)).toBeUndefined();
    // No SDK call settles the Turn, so the scope goes to the deployment's sync.
    expect(reported).toEqual([scope]);
  });

  it('never submits a tried row past wait_until: it gets a cancel reason, no conclusion, and leaves the scan', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope, randomUUID(), clock + 10), { port, submitted } = sdkPort();
    await update(scope, input.taskId, `submission = 'uncertain', tries = 1`); // a crash after an earlier claim
    clock += 10;
    expect(await submitter(port).run()).toEqual({ tried: 1, failed: [] });
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 2, cancel_reason: 'expired', conclusion: null });
    expect(submitted).toEqual([]);
    clock += 2000;
    expect(await submitter(port).run()).toEqual({ tried: 0, failed: [] });
  });

  it('keeps the cancel reason of a sync cancel that lands during a stopped try (#793 D2b-2)', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope, randomUUID(), clock + 10), { port, submitted } = sdkPort();
    // The sync cancel commits between the claim and the late write, and the wait ends, so the try stops.
    const racing: FrozenSubmitPort = { ...port, offer: async id => {
      await update(scope, input.taskId, `cancel_reason = 'cancelled'`);
      clock += 10;
      return port.offer(id);
    } };
    expect(await submitter(racing).run()).toEqual({ tried: 1, failed: [] });
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 1, cancel_reason: 'cancelled', conclusion: null });
    expect(submitted).toEqual([]);
  });

  it('does not submit a claimed row that a sync cancels while its wait is still open (#793 D2b-2)', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    // The sync cancel commits between the claim and the check before the SDK call.
    const racing: FrozenSubmitPort = { ...port, offer: async id => {
      await update(scope, input.taskId, `cancel_reason = 'cancelled'`);
      return port.offer(id);
    } };
    expect(await submitter(racing).run()).toEqual({ tried: 1, failed: [] });
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 1, cancel_reason: 'cancelled', conclusion: null });
    expect(submitted).toEqual([]);
    expect(await offers(input.taskId)).toBe(0);
  });

  it('does not submit when the read before the SDK call crosses wait_until (#793 D2b-2)', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope, randomUUID(), clock + 10), { port, submitted } = sdkPort();
    // The deadline passes during the database round trip of the check before the SDK call.
    const pool = opened!.pool, slowRead = { connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, { get: (target, name) => name === 'query'
        ? (query: unknown, values?: unknown[]) => { if (String(query).includes('AS open')) clock += 10; return target.query(query as string, values); }
        : typeof Reflect.get(target, name) === 'function' ? Reflect.get(target, name).bind(target) : Reflect.get(target, name) });
    } } as unknown as pg.Pool;
    const slow = new HostedSubmitter(slowRead, opened!.store.schema, { port: () => port, now: () => clock, leaseMs: 1000, backoffMs: 500 });
    expect(await slow.run()).toEqual({ tried: 1, failed: [] });
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 1, cancel_reason: 'expired', conclusion: null });
    expect(submitted).toEqual([]);
  });

  it('submits only the FIFO head of an agent, and the next intent waits until the head concludes', async () => {
    const scope = `tenant:${randomUUID()}`, first = await freeze(scope), second = await freeze(scope), { port, submitted } = sdkPort();
    await submitter(port).run();
    expect((await row(scope, first.taskId)).submission).toBe('delivered');
    expect(await row(scope, second.taskId)).toMatchObject({ submission: 'reserved', tries: 0 });
    await submitter(port).run();
    expect(await row(scope, second.taskId)).toMatchObject({ submission: 'reserved', tries: 0 });
    await update(scope, first.taskId, `conclusion = 'succeeded'`); // D2d settles the head
    await submitter(port).run();
    expect((await row(scope, second.taskId)).submission).toBe('delivered');
    expect(submitted).toEqual([first.taskId, second.taskId]);
  });

  it('gives one SDK offer when two submitters run at once', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    await Promise.all([submitter(port).run(), submitter(port).run()]);
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 1 });
    expect(submitted).toEqual([input.taskId]);
    expect(await offers(input.taskId)).toBe(1);
  });

  it('keeps the newer try when a stale submitter fails late over a row that is not delivered', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stale: FrozenSubmitPort = { offer: async () => undefined, submit: async () => { await gate; throw new Error('stale failure'); } };
    const newer: FrozenSubmitPort = { ...port, submit: async () => { throw new Error('newer failure'); } };
    const first = submitter(stale).run();
    await vi.waitFor(async () => expect((await row(scope, input.taskId)).tries).toBe(1));
    clock += 1000; // A's lease has expired
    await submitter(newer).run();
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 2, last_error: 'newer failure' });
    release();
    await first;
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 2, last_error: 'newer failure' });
    expect(submitted).toEqual([]);
  });

  it('fences the late write of a stale submitter after its lease expires', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // A sees no offer, stalls in the submit, then fails.
    const stale: FrozenSubmitPort = { offer: async () => undefined, submit: async () => { await gate; throw new Error('stale failure'); } };
    const first = submitter(stale).run();
    await vi.waitFor(async () => expect((await row(scope, input.taskId)).tries).toBe(1));
    clock += 1000; // A's lease has expired
    await submitter(port).run();
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 2 });
    release();
    await first;
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 2, last_error: null });
    expect(submitted).toEqual([input.taskId]);
  });
  it('retries a head in backoff ahead of its follower, with a batch of 1', async () => {
    const scope = `tenant:${randomUUID()}`, head = await freeze(scope), follower = await freeze(scope), { port } = sdkPort();
    let fail = true;
    const once: FrozenSubmitPort = { ...port, submit: async input => { if (fail) { fail = false; throw new Error('first try fails'); } return port.submit(input); } };
    await submitter(once, { batch: 1 }).run();
    expect(await row(scope, head.taskId)).toMatchObject({ submission: 'uncertain', tries: 1, last_error: 'first try fails' });
    clock += 500;
    expect(await submitter(once, { batch: 1 }).run()).toEqual({ tried: 1, failed: [] });
    expect(await row(scope, head.taskId)).toMatchObject({ submission: 'delivered', tries: 2 });
    expect(await row(scope, follower.taskId)).toMatchObject({ submission: 'reserved', tries: 0 });
  });

  it('does not let the followers of one scope starve the head of another scope, with a batch of 2', async () => {
    const first = `tenant:a-${randomUUID()}`, second = `tenant:z-${randomUUID()}`, { port } = sdkPort();
    const firstHead = await freeze(first);
    for (let index = 0; index < 3; index++) await freeze(first);
    await submitter(port, { batch: 1 }).run();
    expect((await row(first, firstHead.taskId)).submission).toBe('delivered');
    const secondHead = await freeze(second);
    expect(await submitter(port, { batch: 2 }).run()).toEqual({ tried: 1, failed: [] });
    expect(await row(second, secondHead.taskId)).toMatchObject({ submission: 'delivered', tries: 1 });
  });

  it('goes on with the pass when one row cannot be tried, and writes nothing to that row', async () => {
    const bad = `tenant:a-${randomUUID()}`, good = `tenant:z-${randomUUID()}`, { port } = sdkPort();
    const refused = await freeze(bad), input = await freeze(good);
    // The scan reads the row while its scope is supported. The version changes before the claim takes the lock.
    const name = `race_${randomUUID().slice(0, 8)}`;
    const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 4, application_name: name });
    const blocker = await opened!.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM "${opened!.store.schema}".scope WHERE scope = $1 FOR UPDATE`, [storedKey(bad)]);
      const running = new HostedSubmitter(pool, opened!.store.schema, { port: () => port, now: () => clock, leaseMs: 1000, backoffMs: 500 }).run();
      await vi.waitFor(async () => expect(Number((await opened!.pool.query(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [name])).rows[0].n)).toBe(1));
      await blocker.query(`UPDATE "${opened!.store.schema}".scope SET state_version = 3 WHERE scope = $1`, [storedKey(bad)]);
      await blocker.query('COMMIT');
      const pass = await running;
      expect(pass.tried).toBe(1);
      expect(pass.failed).toMatchObject([{ scope: bad, error: { name: 'HostedStoreVersionError' } }]);
      expect(await row(bad, refused.taskId)).toMatchObject({ submission: 'reserved', tries: 0, last_error: null });
      expect((await row(good, input.taskId)).submission).toBe('delivered');
    } finally { blocker.release(); await pool.end(); }
  });

  it('leaves a scope of an unknown store version out of the scan, so it cannot fill a batch of 1', async () => {
    const bad = `tenant:a-${randomUUID()}`, good = `tenant:z-${randomUUID()}`, { port } = sdkPort();
    const refused = await freeze(bad), input = await freeze(good);
    await opened!.pool.query(`UPDATE "${opened!.store.schema}".scope SET state_version = 3 WHERE scope = $1`, [storedKey(bad)]);
    for (let pass = 0; pass < 2; pass++) await submitter(port, { batch: 1 }).run();
    expect((await row(good, input.taskId)).submission).toBe('delivered');
    expect(await row(bad, refused.taskId)).toMatchObject({ submission: 'reserved', tries: 0, last_error: null });
  });

  it('gives one SDK mailbox row when a stale submitter and a newer one both reach the SDK', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stale: FrozenSubmitPort = { ...port, submit: async frozen => { await gate; return port.submit(frozen); } };
    const first = submitter(stale).run();
    await vi.waitFor(async () => expect((await row(scope, input.taskId)).tries).toBe(1));
    clock += 1000; // A's lease has expired
    await submitter(port).run();
    release();
    await first;
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 2, last_error: null });
    expect(submitted).toEqual([input.taskId]); // the stale submit reached the SDK and was refused there
    expect(await offers(input.taskId)).toBe(1);
  });

  it('recovers a row after its submitter dies after the claim, once the lease ends', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port } = sdkPort();
    const dead: FrozenSubmitPort = { ...port, submit: () => new Promise<never>(() => {}) };
    void submitter(dead).run(); // never settles: the process is gone
    await vi.waitFor(async () => expect((await row(scope, input.taskId)).tries).toBe(1));
    expect(await submitter(port).run()).toEqual({ tried: 0, failed: [] }); // the lease holds the row
    clock += 1000;
    expect(await submitter(port).run()).toEqual({ tried: 1, failed: [] });
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 2 });
    expect(await offers(input.taskId)).toBe(1);
  });

  it('checks the lease again under the scope lock, so a submitter whose scan ran before a claim skips the row', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    const name = `lease_${randomUUID().slice(0, 8)}`;
    const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 4, application_name: name });
    const blocker = await opened!.pool.connect();
    try {
      // Hold the scope lock, so both scans read the row as due and both claims wait for the lock.
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM "${opened!.store.schema}".scope WHERE scope = $1 FOR UPDATE`, [storedKey(scope)]);
      const both = [0, 1].map(() => new HostedSubmitter(pool, opened!.store.schema, { port: () => port, now: () => clock, leaseMs: 1000 }).run());
      await vi.waitFor(async () => expect(Number((await opened!.pool.query(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [name])).rows[0].n)).toBe(2));
      await blocker.query('COMMIT');
      const passes = await Promise.all(both);
      expect(passes.map(pass => pass.tried).sort()).toEqual([0, 1]);
      expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 1 });
      expect(submitted).toEqual([input.taskId]);
    } finally { blocker.release(); await pool.end(); }
  });
});
