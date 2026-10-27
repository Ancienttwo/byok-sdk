import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { hash, taskId, type FrozenInput } from '@byok-sdk/example-host-execution-core';
import { openHost, template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { OFFER_WAIT_MS } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { revisionOf } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { waitForTaskCleanup } from '../../basic/goal-btw.test-support';
import { openHostedCloud, SKIP_HOSTED_CLOUD, type HostedCloud } from './hosted-cloud.test-support';
import { freezeIntent, HostedSubmitter } from './intents';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedReconciler, type HostedTaskPort } from './reconcile';
import { inSchema, lockScope } from './store';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;
type Row = { tries: number; submission: string; cancel_reason: string | null; conclusion: string | null; started: boolean;
  attempt: TaskAttempt | null; terminal: DeviceTerminal | null };
const row = async (scope: string, turnId: string): Promise<Row> => (await opened!.pool.query<Row>(
  `SELECT tries, submission, cancel_reason, conclusion, started, attempt, terminal FROM ${table('intent')} WHERE scope = $1 AND key = $2`,
  [storedKey(scope), storedKey(turnId)])).rows[0]!;
const commands = async (scope: string) => (await opened!.pool.query<{ key: string }>(
  `SELECT key FROM ${table('command')} WHERE scope = $1 ORDER BY key`, [storedKey(scope)])).rows.map(found => JSON.parse(found.key) as string);
const reconciler = (port: HostedTaskPort, now?: () => number) =>
  new HostedReconciler(opened!.pool, store().schema, store(), { port: () => port, pollMs: 0, ...(now ? { now } : {}) });
/** A document that the frozen outcome schema of a Main Bot user Turn accepts. Its action writes one card projection. */
const DOCUMENT = { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] };

describe.skipIf(SKIP_HOSTED_CLOUD)('H reconciliation on a real SDK server and daemon (#793 D2d)', () => {
  let host: HostedCloud | undefined;
  // One SDK server for the suite. One schema for each test, because the scans cover the whole schema.
  beforeAll(async () => { host = await openHostedCloud(); });
  afterAll(async () => { await host?.close(); });
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  /**
   * A user Turn of the Main Bot, frozen by the sync rule with the real clock and delivered to the daemon. The suite shares
   * one SDK tenant, so each test has its own Turn id and task id, and its own Agent, so no Agent home of an earlier test is busy.
   */
  async function delivered(agentId = randomUUID()) {
    const scope = `tenant:${randomUUID()}`, turnId = `u-${randomUUID()}`;
    await store().seed(scope, state => {
      seedCollaboration(state);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      state.team.bots.main!.execution = template(host!.deviceId, agentId);
      state.turns[turnId] = { id: turnId, root: turnId, botId: 'main', source: 'user', request: 'First', hop: 0, status: 'queued', authority: 'owner' };
    });
    await store().bindDevice(scope, host!.deviceId);
    await store().sync(scope, { ...SYNC_OPTIONS, history: undefined, now: Date.now() });
    expect(await new HostedSubmitter(opened!.pool, store().schema, { port: () => host!.port }).run()).toEqual({ tried: 1, failed: [] });
    return { scope, turnId, task: taskId(turnId, 0) };
  }
  async function session(task: string) {
    await vi.waitFor(() => expect(host!.adapter.sessions.has(task)).toBe(true), { timeout: 5000 });
    return host!.adapter.sessions.get(task)!;
  }
  const terminal = (task: string) => vi.waitFor(async () => expect(await host!.port.deviceTerminal(task)).toBeDefined(), { timeout: 5000 });

  it('applies a completed outcome once under the command id taskId, and the next sync reports the Turn', async () => {
    const { scope, turnId, task } = await delivered(), run = await session(task);
    await run.finish(DOCUMENT);
    await terminal(task);
    expect(await reconciler(host!.port).run()).toEqual({ concluded: 1, failed: [] });
    expect(await row(scope, turnId)).toMatchObject({ conclusion: 'succeeded', started: true, tries: 1,
      attempt: { taskId: task, deviceId: host!.deviceId }, terminal: { envelope: { task_id: task, type: 'task.complete' } } });
    const state = await store().read(scope);
    expect([state.revision, await commands(scope), state.turns[turnId]!.outcome]).toEqual([1, [task], DOCUMENT]);
    await store().sync(scope, { ...SYNC_OPTIONS, history: undefined, now: Date.now() });
    expect((await store().read(scope)).turns[turnId]).toMatchObject({ status: 'succeeded', conclusion: 'succeeded' });
    await waitForTaskCleanup(host!.daemon, run);
  });

  it('a device restart replays the same terminal: one command record, the outcome applied once, generation 0', async () => {
    const { scope, turnId, task } = await delivered(), run = await session(task);
    await run.finish(DOCUMENT);
    await terminal(task);
    // Both passes store the attempt, so wait until it is final.
    await vi.waitFor(async () => expect((await host!.port.attempt(task))?.status).toBe('complete'), { timeout: 5000 });
    await reconciler(host!.port).run();
    const stored = await store().dump(scope);
    // The same terminal reaches a new reconciler again, as after a restart that lost the conclusion write.
    await opened!.pool.query(`UPDATE ${table('intent')} SET conclusion = NULL WHERE scope = $1`, [storedKey(scope)]);
    expect(await reconciler(host!.port).run()).toEqual({ concluded: 1, failed: [] });
    expect(await store().dump(scope)).toBe(stored);
    expect([revisionOf(await store().read(scope)), await commands(scope)]).toEqual([1, [task]]);
    expect(await host!.port.offer(taskId(turnId, 1))).toBeUndefined();
    await waitForTaskCleanup(host!.daemon, run);
  });

  it('concludes a busy decline as declined at generation 0, as L does (drift guard 1)', async () => {
    const agentId = randomUUID(), writer = `external-writer-${randomUUID()}`;
    await host!.port.submit({ ...template(host!.deviceId, agentId), taskId: writer });
    const external = await session(writer);
    const { scope, turnId, task } = await delivered(agentId);
    await vi.waitFor(async () => expect(await host!.port.deviceTerminal(task))
      .toMatchObject({ envelope: { type: 'task.decline', payload: { code: 'agent_home_writer_busy' } } }), { timeout: 5000 });
    expect(await reconciler(host!.port).run()).toEqual({ concluded: 1, failed: [] });
    expect(await row(scope, turnId)).toMatchObject({ conclusion: 'declined', tries: 1 });
    expect(await host!.port.offer(taskId(turnId, 1))).toBeUndefined();
    await external.finish({ text: 'done' });
    await waitForTaskCleanup(host!.daemon, external);

    // L: K4 enqueues a K8 Turn with the sync rule's wait and the default retry policy, and gives the same conclusion.
    const l = await openHost();
    try {
      await l.server.executions.submit({ ...template(l.deviceId), taskId: 'external-writer' });
      await vi.waitFor(() => expect(l.adapter.sessions.has('external-writer')).toBe(true), { timeout: 5000 });
      await l.core.enqueue({ key: 'busy', source: 'user', execution: template(l.deviceId), waitUntil: Date.now() + OFFER_WAIT_MS });
      await vi.waitFor(async () => { await l.core.drain(); expect(l.core.intent('busy')?.conclusion).toBe('declined'); }, { timeout: 5000 });
      expect(l.core.intent('busy')).toMatchObject({ generation: 0, attempts: 1 });
      expect(await l.server.tasks.offer(taskId('busy', 1))).toBeUndefined();
    } finally {
      await l.close();
    }
  });
});

/** An SDK tenant in memory: the offer, the attempt and the terminal of each task, and each cancel call. */
function fakePort() {
  const offers = new Map<string, unknown>(), attempts = new Map<string, TaskAttempt>(), terminals = new Map<string, DeviceTerminal>();
  const cancels: string[] = [];
  /** Runs inside the SDK call, after its read: another pass or a clock step lands while the call is in flight. */
  const during: { attempt?: () => void | Promise<void>; terminal?: () => void | Promise<void> } = {};
  const port: HostedTaskPort = {
    offer: async id => offers.get(id) as never,
    attempt: async id => { const found = attempts.get(id); await during.attempt?.(); return found; },
    deviceTerminal: async id => { const found = terminals.get(id); await during.terminal?.(); return found; },
    cancel: async (id, reason) => {
      cancels.push(`${id}:${reason}`);
      const attempt = attempts.get(id)!;
      attempts.set(id, { ...attempt, status: attempt.ownerDeviceId ? attempt.status : 'cancelled', cancellation: { requestedAt: 'now', reason } });
    },
  };
  return {
    port, cancels, attempts, terminals, during,
    deliver(input: FrozenInput, rest: Partial<TaskAttempt> = {}) {
      offers.set(input.taskId, { taskId: input.taskId, deviceId: input.deviceId, type: 'task.offer',
        payload: structuredClone(input.payload), delivered: true, messageId: `offer-${input.taskId}` });
      attempts.set(input.taskId, { taskId: input.taskId, deviceId: input.deviceId, agentRef: input.payload.agentRef, status: 'offered',
        updatedAt: 'now', ...rest } as TaskAttempt);
    },
    complete(input: FrozenInput, document: unknown) {
      terminals.set(input.taskId, { envelope: { task_id: input.taskId, type: 'task.complete', payload: { document } }, recordedAt: 'now' } as never);
    },
  };
}

describe.skipIf(POSTGRES_URL === undefined)('H reconciliation edge cases on real Postgres (#793 D2d)', () => {
  let clock = 0;
  beforeAll(() => { clock = 1_000_000; });
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  /** A seeded scope with Turn `q1`, and its intent tried once and delivered. The submit lease ends at `clock + lease`. */
  async function tried(edit: (state: CollaborationState) => void = () => {}, lease = 0) {
    const scope = `tenant:${randomUUID()}`;
    await store().seed(scope, state => {
      seedCollaboration(state);
      state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'First', hop: 0, status: 'processing', authority: 'owner' };
      state.schemas.q1 = state.schemas.t1!;
      edit(state);
    });
    await store().bindDevice(scope, 'device');
    const input = await inSchema(opened!.pool, store().schema, async client => {
      await lockScope(client, storedKey(scope));
      return freezeIntent(client, scope, { key: 'q1', source: 'user', execution: template('device'), waitUntil: clock + 60_000 });
    });
    await opened!.pool.query(`UPDATE ${table('intent')} SET submission = 'delivered', tries = 1, next_at = $2 WHERE scope = $1`,
      [storedKey(scope), clock + lease]);
    return { scope, input };
  }
  const run = (port: HostedTaskPort) => reconciler(port, () => clock).run();

  it('concludes cancelled with no outcome when the attempt has a cancellation, even after task.complete', async () => {
    const { scope, input } = await tried(), sdk = fakePort();
    sdk.deliver(input, { status: 'complete', ownerDeviceId: 'device', cancellation: { requestedAt: 'now' } });
    sdk.complete(input, DOCUMENT);
    expect(await run(sdk.port)).toEqual({ concluded: 1, failed: [] });
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: 'cancelled', terminal: { envelope: { type: 'task.complete' } } });
    expect([revisionOf(await store().read(scope)), await commands(scope)]).toEqual([0, []]);
  });

  it('reports a scope where the pass recorded a first claim with no conclusion, and not a claim recorded before (#793 D2f-5)', async () => {
    const { scope, input } = await tried(), sdk = fakePort();
    const changed: string[] = [], pass = () => new HostedReconciler(opened!.pool, store().schema, store(),
      { port: () => sdk.port, pollMs: 0, now: () => clock, changed: reported => { changed.push(reported); } }).run();
    sdk.deliver(input);
    expect(await pass()).toEqual({ concluded: 0, failed: [] });
    expect(changed).toEqual([]);
    sdk.deliver(input, { status: 'claimed', ownerDeviceId: 'device' });
    expect(await pass()).toEqual({ concluded: 0, failed: [] });
    expect(changed).toEqual([scope]);
    expect(await row(scope, 'q1')).toMatchObject({ started: true, conclusion: null });
    expect(await pass()).toEqual({ concluded: 0, failed: [] });
    expect(changed).toEqual([scope]);
  });

  it('lets a throw from the changed callback propagate, after the conclusion committed (#793 D2f-5)', async () => {
    const { scope, input } = await tried(), sdk = fakePort();
    sdk.deliver(input, { status: 'complete', ownerDeviceId: 'device', cancellation: { requestedAt: 'now' } });
    sdk.complete(input, DOCUMENT);
    const throwing = new HostedReconciler(opened!.pool, store().schema, store(), { port: () => sdk.port, pollMs: 0, now: () => clock,
      changed: () => { throw new Error('Host sync refused'); } });
    await expect(throwing.run()).rejects.toThrow('Host sync refused');
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: 'cancelled' });
  });

  it('cancels the SDK task of a sync-cancelled tried row, and concludes cancelled once the attempt is cancelled unclaimed', async () => {
    const { scope, input } = await tried(), sdk = fakePort();
    sdk.deliver(input);
    await opened!.pool.query(`UPDATE ${table('intent')} SET cancel_reason = 'cancelled' WHERE scope = $1`, [storedKey(scope)]);
    expect(await run(sdk.port)).toEqual({ concluded: 1, failed: [] });
    expect(sdk.cancels).toEqual([`${input.taskId}:cancelled`]);
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: 'cancelled', started: false, attempt: { status: 'cancelled' } });
  });

  it('expires a delivered task that no device claimed, past its wait', async () => {
    const { scope, input } = await tried(), sdk = fakePort();
    sdk.deliver(input);
    expect(await run(sdk.port)).toEqual({ concluded: 0, failed: [] });
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: null, cancel_reason: null, attempt: { status: 'offered' } });
    clock += 60_000;
    expect(await run(sdk.port)).toEqual({ concluded: 1, failed: [] });
    expect(sdk.cancels).toEqual([`${input.taskId}:expired`]);
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: 'expired', cancel_reason: 'expired' });
  });

  it('keeps waiting past the wait when an earlier pass saw the claim, as K4 started does', async () => {
    const { scope, input } = await tried(), sdk = fakePort();
    sdk.deliver(input, { status: 'claimed', ownerDeviceId: 'device' });
    await run(sdk.port);
    expect(await row(scope, 'q1')).toMatchObject({ started: true, conclusion: null });
    clock += 60_000;
    expect(await run(sdk.port)).toEqual({ concluded: 0, failed: [] });
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: null, cancel_reason: null });
    expect(sdk.cancels).toEqual([]);
  });

  it('skips a cancelled row with no attempt while its submit lease holds it, and concludes it after the lease', async () => {
    const { scope } = await tried(() => {}, 1000), sdk = fakePort();
    await opened!.pool.query(`UPDATE ${table('intent')} SET cancel_reason = 'cancelled' WHERE scope = $1`, [storedKey(scope)]);
    expect(await run(sdk.port)).toEqual({ concluded: 0, failed: [] });
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: null });
    clock += 1000;
    expect(await run(sdk.port)).toEqual({ concluded: 1, failed: [] });
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: 'cancelled' });
    expect(sdk.cancels).toEqual([]);
  });

  it('does not expire a row whose claim another pass saw after this pass read the row', async () => {
    const { scope, input } = await tried(), sdk = fakePort();
    sdk.deliver(input, { status: 'claimed', ownerDeviceId: 'device' });
    clock += 60_000;
    // This pass read `started = false`. Another pass records the claim while this pass waits for the terminal read.
    sdk.during.terminal = async () => {
      sdk.during.terminal = undefined;
      await opened!.pool.query(`UPDATE ${table('intent')} SET started = true WHERE scope = $1`, [storedKey(scope)]);
    };
    expect(await run(sdk.port)).toEqual({ concluded: 0, failed: [] });
    expect(await row(scope, 'q1')).toMatchObject({ started: true, cancel_reason: null, conclusion: null });
    expect(sdk.cancels).toEqual([]);
  });

  it('keeps a cancelled row open when its submit lease ends only after the attempt read', async () => {
    const { scope } = await tried(() => {}, 1000), sdk = fakePort();
    await opened!.pool.query(`UPDATE ${table('intent')} SET cancel_reason = 'cancelled' WHERE scope = $1`, [storedKey(scope)]);
    clock += 999;
    // The read sees no attempt while the lease holds the row; the lease ends before the conclusion takes the lock.
    sdk.during.attempt = () => { clock += 1; };
    expect(await run(sdk.port)).toEqual({ concluded: 0, failed: [] });
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: null });
    sdk.during.attempt = undefined;
    expect(await run(sdk.port)).toEqual({ concluded: 1, failed: [] });
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: 'cancelled' });
  });

  it.each(['attempt', 'offer'])('throws on another %s identity, and writes no evidence', async field => {
    const { scope, input } = await tried(), sdk = fakePort();
    sdk.deliver(field === 'offer' ? { ...input, payload: { ...input.payload, instruction: 'Another Turn.' } } : input,
      field === 'attempt' ? { deviceId: 'other' } : {});
    sdk.complete(input, DOCUMENT);
    const pass = await run(sdk.port);
    expect([pass.concluded, pass.failed.map(failure => (failure.error as Error).message)])
      .toEqual([0, [field === 'attempt' ? 'Attempt identity conflict' : 'Offer differs from the frozen input']]);
    expect(await row(scope, 'q1')).toMatchObject({ conclusion: null, attempt: null, terminal: null });
    expect([revisionOf(await store().read(scope)), await commands(scope)]).toEqual([0, []]);
  });

  it('reports each scope where the pass committed a conclusion, once, in the order of its first one (#793 D2f-5)', async () => {
    /** A scope with tried rows `keys`, seeded and frozen as `tried` does, each with its own task id. */
    async function scope(prefix: string, ...keys: string[]) {
      const scope = `tenant:${prefix}-${randomUUID()}`;
      await store().seed(scope, state => {
        seedCollaboration(state);
        for (const key of keys) {
          state.turns[key] = { id: key, root: key, botId: 'main', source: 'user', request: 'First', hop: 0, status: 'processing', authority: 'owner' };
          state.schemas[key] = state.schemas.t1!;
        }
      });
      await store().bindDevice(scope, 'device');
      const inputs = [];
      for (const key of keys) inputs.push(await inSchema(opened!.pool, store().schema, async client => {
        await lockScope(client, storedKey(scope));
        return freezeIntent(client, scope, { key, source: 'user', execution: template('device'), waitUntil: clock + 60_000 });
      }));
      await opened!.pool.query(`UPDATE ${table('intent')} SET submission = 'delivered', tries = 1, next_at = $2 WHERE scope = $1`, [storedKey(scope), clock]);
      return { scope, inputs };
    }
    const cancel = (scope: string) => opened!.pool.query(`UPDATE ${table('intent')} SET cancel_reason = 'cancelled' WHERE scope = $1`, [storedKey(scope)]);
    const sdk = fakePort();
    // a: two rows conclude. b: an attempt of another device throws before any write. c: the terminal transaction throws and
    // rolls back. d: a delivered row with no terminal stays open. e: one row concludes.
    const a = await scope('a', 'a1', 'a2'), b = await scope('b', 'b1'), c = await scope('c', 'c1'), d = await scope('d', 'd1'), e = await scope('e', 'e1');
    await cancel(a.scope); await cancel(e.scope);
    sdk.deliver(b.inputs[0]!, { deviceId: 'other' });
    sdk.deliver(c.inputs[0]!, { status: 'complete', ownerDeviceId: 'device' });
    sdk.complete(c.inputs[0]!, DOCUMENT);
    await opened!.pool.query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, body) VALUES ($1, $2, 0, 'projection', '{"other":true}'::json)`,
      [storedKey(c.scope), storedKey(`card:${hash([taskId('c1', 0), 'confirmable_action', 0])}`)]);
    sdk.deliver(d.inputs[0]!);
    const changed: string[] = [];
    const pass = await new HostedReconciler(opened!.pool, store().schema, store(),
      { port: () => sdk.port, pollMs: 0, now: () => clock, changed: scope => { changed.push(scope); } }).run();
    expect([pass.concluded, pass.failed.map(failure => [failure.turnId, (failure.error as Error).message])])
      .toEqual([3, [['b1', 'Attempt identity conflict'], ['c1', 'Projection identity conflict']]]);
    // c committed its first claim before its terminal transaction rolled back, so the Host syncs it too.
    expect(changed).toEqual([a.scope, c.scope, e.scope]);
    expect(await row(c.scope, 'c1')).toMatchObject({ conclusion: null, terminal: null });
    expect(await row(d.scope, 'd1')).toMatchObject({ conclusion: null });
  });
});
