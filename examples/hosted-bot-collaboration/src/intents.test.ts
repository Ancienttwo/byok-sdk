import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sameFrozenOffer, taskId, type FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { freezeIntent, HostedSubmitter, type SubmitterOptions } from './intents';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { inSchema, lockScope } from './store';

// The SDK side is a real ByokServer with a real daemon, paired over loopback HTTP (the K4 fixture, on its SQLite
// storage). The H side is a real Postgres. D2b ships no product entry: the tests freeze intents directly.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
let host: TestHost | undefined;
let clock = 0;

/** The tenant port, with a count of the SDK submits that really ran. */
function sdkPort() {
  const submitted: string[] = [];
  const port: FrozenSubmitPort = {
    submit: async input => { const enqueued = await host!.server.executions.submit(input); submitted.push(input.taskId); return enqueued; },
    offer: id => host!.server.tasks.offer(id),
  };
  return { port, submitted };
}
function submitter(port: FrozenSubmitPort, options: Partial<SubmitterOptions> = {}) {
  return new HostedSubmitter(opened!.pool, opened!.store.schema, { port: () => port, now: () => clock, leaseMs: 1000, backoffMs: 500, ...options });
}
async function freeze(scope: string, turnId = randomUUID(), waitUntil = clock + 60_000) {
  await opened!.store.seed(scope, () => {});
  return inSchema(opened!.pool, opened!.store.schema, async client => {
    await lockScope(client, storedKey(scope));
    return freezeIntent(client, scope, { turnId, execution: template(host!.deviceId), waitUntil });
  });
}
type Row = { submission: string; tries: number; cancel_reason: string | null; conclusion: string | null; last_error: string | null };
async function row(scope: string, task: string): Promise<Row> {
  const found = await opened!.pool.query<Row>(`SELECT submission, tries, cancel_reason, conclusion, last_error FROM "${opened!.store.schema}".intent
    WHERE scope = $1 AND task_id = $2`, [storedKey(scope), task]);
  return found.rows[0]!;
}
const update = (scope: string, task: string, set: string) =>
  opened!.pool.query(`UPDATE "${opened!.store.schema}".intent SET ${set} WHERE scope = $1 AND task_id = $2`, [storedKey(scope), task]);

describe.skipIf(POSTGRES_URL === undefined)('H submitter on real Postgres and a real SDK server (#793 D2b-1)', () => {
  // One SDK server for the suite. One schema for each test, because the submit scan covers the whole schema.
  beforeAll(async () => { host = await openHost({ externalCore: true }); clock = Date.now(); });
  afterAll(async () => { await host?.close(); });
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  it('freezes one intent per Turn under the stable K4 task id, and refuses another input', async () => {
    const scope = `tenant:${randomUUID()}`, turnId = randomUUID();
    const input = await freeze(scope, turnId);
    expect(input.taskId).toBe(taskId(turnId, 0));
    expect(await freeze(scope, turnId)).toEqual(input);
    await expect(inSchema(opened!.pool, opened!.store.schema, async client => {
      await lockScope(client, storedKey(scope));
      return freezeIntent(client, scope, { turnId, execution: { ...template(host!.deviceId), deviceId: 'other' }, waitUntil: clock + 60_000 });
    })).rejects.toThrow('Intent identity conflict');
  });

  it('delivers the frozen input, and the SDK readback is that input', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    expect(await submitter(port).run()).toBe(1);
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 1, last_error: null });
    const offer = await host!.server.tasks.offer(input.taskId);
    expect(offer && sameFrozenOffer(offer, input)).toBe(true);
    expect(submitted).toEqual([input.taskId]);
  });

  it('after a crash between the claim and the SDK call, submits the same task id once', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    const crashed: FrozenSubmitPort = { ...port, submit: async () => { throw new Error('crash before the SDK call'); } };
    await submitter(crashed).run();
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 1, last_error: 'crash before the SDK call' });
    expect(await submitter(port).run()).toBe(0); // the backoff holds the row
    clock += 500;
    await submitter(port).run();
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 2, last_error: null });
    expect(submitted).toEqual([input.taskId]);
    expect(await host!.server.tasks.attempt(input.taskId)).toMatchObject({ taskId: input.taskId, deviceId: host!.deviceId });
  });

  it('after a lost SDK response, reads the offer back and does not submit again', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    const lost: FrozenSubmitPort = { ...port, submit: async frozen => { await port.submit(frozen); throw new Error('lost response'); } };
    await submitter(lost).run();
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'delivered', tries: 1, last_error: null });
    expect(submitted).toEqual([input.taskId]);
  });

  it('never submits when the SDK holds another offer for the task id, and keeps the error', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope), { port, submitted } = sdkPort();
    await host!.server.executions.submit({ ...input, payload: { ...input.payload, instruction: 'Another Turn.' } });
    await submitter(port).run();
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 1, last_error: 'Offer differs from the frozen input' });
    expect(submitted).toEqual([]);
  });

  it('expires an untried row at wait_until with no SDK attempt', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope, randomUUID(), clock + 10), { port, submitted } = sdkPort();
    clock += 10;
    expect(await submitter(port).run()).toBe(1);
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'reserved', tries: 0, conclusion: 'expired' });
    expect(submitted).toEqual([]);
    expect(await host!.server.tasks.attempt(input.taskId)).toBeUndefined();
  });

  it('never submits a tried row past wait_until: it gets a cancel reason, no conclusion, and leaves the scan', async () => {
    const scope = `tenant:${randomUUID()}`, input = await freeze(scope, randomUUID(), clock + 10), { port, submitted } = sdkPort();
    await update(scope, input.taskId, `submission = 'uncertain', tries = 1`); // a crash after an earlier claim
    clock += 10;
    expect(await submitter(port).run()).toBe(1);
    expect(await row(scope, input.taskId)).toMatchObject({ submission: 'uncertain', tries: 2, cancel_reason: 'expired', conclusion: null });
    expect(submitted).toEqual([]);
    clock += 2000;
    expect(await submitter(port).run()).toBe(0);
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
});
