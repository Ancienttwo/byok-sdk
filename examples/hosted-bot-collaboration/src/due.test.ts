import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { hash, taskId, type Json } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { collaborationDue, type Command, type DelegationTimers } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { ROOM_GRACE_MS, seedCollaboration, seedRoom, SYNC_OPTIONS, VECTOR_NOW } from '@byok-sdk/example-bot-collaboration/test-support';
import { HostedDueScheduler, type DueSchedulerOptions } from './due';
import { storedKey } from './layout';
import { TEST_HOST, vectorClock } from './memory-subject.test-support';
import { openStore, POSTGRES_URL, VectorStore } from './postgres.test-support';
import type { TaskEvidence } from './reconcile';
import { HostedReplyChecker } from './replies';

// #793 S4: the scope due time that each store transaction writes, and the pass that syncs the due scopes.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const TIMERS: DelegationTimers = { cancelGraceMs: 1_000, uncertainAfterMs: 5_000 };
/** A store over the test schema with `TIMERS`, which the due time reads too. */
const store = () => new VectorStore(opened!.pool, opened!.store.schema, { host: TEST_HOST, timers: TIMERS });
const table = (name: string) => `"${opened!.store.schema}".${name}`;
const query = <T extends object>(text: string, values: unknown[]) => opened!.pool.query<T>(text, values).then(found => found.rows);
/** The seed card `c1` stays pending, so its expiry is never due in these tests. */
const LATER = Number.MAX_SAFE_INTEGER;

const dueAt = async (scope: string) => (await query<{ due_at: string | null }>(`SELECT due_at::text FROM ${table('scope')} WHERE scope = $1`,
  [storedKey(scope)]))[0]!.due_at;
const retryAt = async (scope: string) => (await query<{ retry_at: string | null }>(`SELECT retry_at::text FROM ${table('scope')} WHERE scope = $1`,
  [storedKey(scope)]))[0]!.retry_at;
/** The due time that the K8 rule gives for the stored state, in the column's text form. */
const ruleDue = async (scope: string) => {
  const due = collaborationDue(await store().read(scope), TIMERS);
  return due.length ? String(Math.min(...due)) : null;
};
const evidence = (task: string, type: string, payload: Json = {}): TaskEvidence => ({
  terminal: { envelope: { task_id: task, type, payload } } as unknown as DeviceTerminal,
  attempt: { taskId: task } as unknown as TaskAttempt,
});

/** The seed with `c1` kept pending, and bot `b` beside the Main Bot on the same bound device. `t1` has ended. */
function team(state: CollaborationState): void {
  seedCollaboration(state);
  state.cards.c1!.expiresAt = LATER;
  Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
  state.team.bots.b = { ...state.team.bots.main!, id: 'b', name: 'B', role: 'Reviewer', mainBot: false, execution: template('device', 'b') };
}

/** A scope whose Main Bot Turn delegated to `b`. `step` runs after each state change, so a test can check the due time there. */
async function delegated(step: () => Promise<void> = async () => {}) {
  const scope = `tenant:${randomUUID()}`;
  const commit = async (command: Command) => {
    const result = await store().commit(scope, { scope, commandId: randomUUID(), command }, vectorClock);
    if (result.disposition.outcome !== 'accepted') throw new Error(`Refused ${command.kind}: ${JSON.stringify(result.disposition)}`);
    return result.disposition.value;
  };
  const sync = (now = VECTOR_NOW) => store().sync(scope, { ...SYNC_OPTIONS, now, history: undefined });
  await store().seed(scope, team);
  await step();
  await store().bindDevice(scope, 'device');
  const root = await commit({ kind: 'input', botId: 'main', key: 'r1', request: 'Ask b', sender: 'owner' }) as string;
  await step();
  await sync();
  await step();
  expect(await store().finish(scope, root, evidence(taskId(root, 0), 'task.complete', { document: { delegate: [{ to: 'b', request: 'Check' }] } }),
    vectorClock)).toBe('succeeded');
  await step();
  const id = hash([taskId(root, 0), 'delegate', 0]);
  await sync();
  await step();
  /** A device claims B's request Turn: the delegation runs, and the K8 uncertain timer starts. */
  const claim = async (now = VECTOR_NOW) => {
    await query(`UPDATE ${table('intent')} SET submission = 'delivered', tries = 1, started = true WHERE scope = $1 AND key = $2`,
      [storedKey(scope), storedKey(id)]);
    return sync(now);
  };
  return { scope, id, commit, sync, claim, delegation: async () => (await store().read(scope)).delegations[id]! };
}

/** A seeded scope that is due at `at`: its card `c1` expires then. */
async function stuck(prefix: string, at = VECTOR_NOW): Promise<string> {
  const scope = `tenant:${prefix}-${randomUUID()}`;
  await store().seed(scope, state => { team(state); state.cards.c1!.expiresAt = at; });
  return scope;
}

describe.skipIf(POSTGRES_URL === undefined)('H scope due time and due scheduler (#793 S4)', () => {
  // One schema for each test, because a pass covers the whole schema.
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  let clock = VECTOR_NOW;
  beforeEach(() => { clock = VECTOR_NOW; });
  const synced: Array<{ scope: string; now: number }> = [];
  beforeEach(() => { synced.length = 0; });
  const sync: DueSchedulerOptions['sync'] = (scope, now) => {
    synced.push({ scope, now });
    return store().sync(scope, { ...SYNC_OPTIONS, now, history: undefined });
  };
  /** A deployment sync that leaves the scope as it is: it returns the stored due time, as a sync whose step H does not run. */
  const unchanged: DueSchedulerOptions['sync'] = async (scope, now) => {
    synced.push({ scope, now });
    return { dueAt: Number(await dueAt(scope)) };
  };
  const scheduler = (options: Partial<DueSchedulerOptions> = {}) =>
    new HostedDueScheduler(opened!.pool, store(), { now: () => clock, sync, backoffMs: 10_000, ...options });

  describe('the due time', () => {
    it('is the earliest time of the K8 rule after each seed, commit, sync and finish', async () => {
      let checks = 0;
      const h = await delegated(async () => {
        const scope = (await query<{ scope: string }>(`SELECT scope FROM ${table('scope')}`, []))[0]!.scope;
        expect(await dueAt(JSON.parse(scope) as string)).toBe(await ruleDue(JSON.parse(scope) as string));
        checks++;
      });
      expect(checks).toBe(5);
      expect(await dueAt(h.scope)).toBe(String(LATER));
      // The sync result is the value that the sync wrote.
      expect(await h.claim()).toEqual({ dueAt: VECTOR_NOW + TIMERS.uncertainAfterMs });
      expect(await dueAt(h.scope)).toBe(String(VECTOR_NOW + TIMERS.uncertainAfterMs));
    });

    it('moves with a commit outside any sync, with the timers of the store: a cancel starts the cancel grace', async () => {
      const h = await delegated();
      await h.claim();
      await h.commit({ kind: 'cancel_delegation', delegationId: h.id });
      expect(await h.delegation()).toMatchObject({ cancel: { requestedAt: VECTOR_NOW } });
      expect(await dueAt(h.scope)).toBe(String(VECTOR_NOW + TIMERS.cancelGraceMs));
      expect(await dueAt(h.scope)).toBe(await ruleDue(h.scope));
    });

    it('stays as it was after a command that throws, which writes nothing', async () => {
      const h = await delegated();
      await h.claim();
      const before = await store().dump(h.scope);
      await expect(h.commit({ kind: 'cancel_delegation', delegationId: 'absent' })).rejects.toThrow('Delegation not found');
      expect(await store().dump(h.scope)).toBe(before);
      expect(await dueAt(h.scope)).toBe(String(VECTOR_NOW + TIMERS.uncertainAfterMs));
    });

    it('does not rewrite the scope row when the time stays the same', async () => {
      const h = await delegated();
      await h.claim();
      const version = async () => (await query<{ xmin: string }>(`SELECT xmin::text FROM ${table('scope')} WHERE scope = $1`, [storedKey(h.scope)]))[0]!.xmin;
      const before = await version();
      expect(await h.sync()).toEqual({ dueAt: VECTOR_NOW + TIMERS.uncertainAfterMs });
      expect(await version()).toBe(before);
    });

    it('is null when the rule gives no time', async () => {
      const scope = `tenant:${randomUUID()}`;
      await store().seed(scope, state => { team(state); state.cards.c1!.state = 'expired'; });
      expect(await dueAt(scope)).toBeNull();
      await store().seed(scope, state => { state.cards.c1!.state = 'pending'; });
      expect(await dueAt(scope)).toBe(String(LATER));
    });

    it('refuses a negative due time', async () => {
      const scope = await stuck('a');
      await expect(query(`UPDATE ${table('scope')} SET due_at = -1 WHERE scope = $1`, [storedKey(scope)])).rejects.toThrow('check constraint');
    });
  });

  describe('the due scheduler', () => {
    it('syncs a scope once its due time comes, at the clock it reads, and the sync clears the time', async () => {
      const h = await delegated();
      await h.claim();
      const due = VECTOR_NOW + TIMERS.uncertainAfterMs;
      clock = due - 1;
      expect(await scheduler().run()).toEqual({ synced: 0, stalled: [], failed: [] });
      // The pass reads the clock once to select, then again for each sync.
      const reads = [due, due + 7];
      expect(await scheduler({ now: () => reads.shift()! }).run()).toEqual({ synced: 1, stalled: [], failed: [] });
      expect(synced).toEqual([{ scope: h.scope, now: due + 7 }]);
      expect(await h.delegation()).toMatchObject({ status: 'uncertain', uncertainSince: due + 7 });
      expect(await dueAt(h.scope)).toBe(String(LATER));
      clock = due + 7;
      expect(await scheduler().run()).toEqual({ synced: 0, stalled: [], failed: [] });
    });

    it('reports a scope that its sync leaves due as stalled, and syncs it again only after the backoff', async () => {
      const scope = await stuck('a'), pass = scheduler({ sync: unchanged });
      expect(await pass.run()).toEqual({ synced: 1, stalled: [scope], failed: [] });
      expect(await pass.run()).toEqual({ synced: 0, stalled: [], failed: [] });
      // The backoff is `scope.retry_at` (#794 H1), so a new scheduler instance waits too.
      expect(await retryAt(scope)).toBe(String(VECTOR_NOW + 10_000));
      expect(await scheduler({ sync: unchanged }).run()).toEqual({ synced: 0, stalled: [], failed: [] });
      clock += 10_000 - 1;
      expect(await pass.run()).toEqual({ synced: 0, stalled: [], failed: [] });
      clock += 1;
      expect(await pass.run()).toEqual({ synced: 1, stalled: [scope], failed: [] });
      expect(synced.map(entry => entry.now)).toEqual([VECTOR_NOW, VECTOR_NOW + 10_000]);
    });

    it('reports a sync that throws as failed, does not count it, and tries it again after the backoff', async () => {
      const scope = await stuck('a'), error = new Error('boom');
      let fail = true;
      const pass = scheduler({ sync: async (at, now) => { if (fail) throw error; return unchanged(at, now); } });
      expect(await pass.run()).toEqual({ synced: 0, stalled: [], failed: [{ scope, error }] });
      expect(await pass.run()).toEqual({ synced: 0, stalled: [], failed: [] });
      expect(await scheduler({ sync: unchanged }).run()).toEqual({ synced: 0, stalled: [], failed: [] });
      fail = false;
      clock += 10_000;
      expect(await pass.run()).toEqual({ synced: 1, stalled: [scope], failed: [] });
    });

    it('clears the backoff in the store write that moves the due time, so the new work is due at once (#794 H1)', async () => {
      const scope = await stuck('a');
      expect(await scheduler({ sync: unchanged }).run()).toEqual({ synced: 1, stalled: [scope], failed: [] });
      expect(await retryAt(scope)).toBe(String(VECTOR_NOW + 10_000));
      // The store's own sync expires the card, which moves the due time.
      await store().sync(scope, { ...SYNC_OPTIONS, now: VECTOR_NOW, history: undefined });
      expect(await dueAt(scope)).not.toBe(String(VECTOR_NOW));
      expect(await retryAt(scope)).toBeNull();
    });

    it('syncs at most a batch in due order, and backed-off scopes do not fill the next batch', async () => {
      // `c` is due first.
      const [a, b, c] = [await stuck('a'), await stuck('b'), await stuck('c', VECTOR_NOW - 1)];
      const pass = scheduler({ batch: 2, sync: unchanged });
      expect(await pass.run()).toEqual({ synced: 2, stalled: [c, a], failed: [] });
      expect(await pass.run()).toEqual({ synced: 1, stalled: [b], failed: [] });
      expect(await pass.run()).toEqual({ synced: 0, stalled: [], failed: [] });
    });

    it('seals a due input batch in one scheduled sync, which clears the time (#793 S1)', async () => {
      const policy = { windowMs: 1000, maxItems: 2, maxBytes: 8192 };
      const coalescing = new VectorStore(opened!.pool, opened!.store.schema, { host: TEST_HOST, timers: TIMERS, coalesce: policy });
      const scope = `tenant:${randomUUID()}`;
      await coalescing.seed(scope, state => {
        team(state);
        state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'First', hop: 0, status: 'queued', authority: 'owner' };
      });
      await coalescing.bindDevice(scope, 'device');
      await coalescing.sync(scope, { ...SYNC_OPTIONS, history: undefined });
      const result = await coalescing.commit(scope, { scope, commandId: 'k1', command: { kind: 'input', botId: 'main', key: 'k1', request: 'Say k1', sender: 'owner' } }, vectorClock);
      expect(result.disposition.outcome).toBe('accepted');
      expect(await dueAt(scope)).toBe(String(VECTOR_NOW + 1000));
      clock = VECTOR_NOW + 1000;
      const pass = new HostedDueScheduler(opened!.pool, coalescing, { now: () => clock, backoffMs: 10_000,
        sync: (at, now) => coalescing.sync(at, { ...SYNC_OPTIONS, now, history: undefined }) });
      expect(await pass.run()).toEqual({ synced: 1, stalled: [], failed: [] });
      const batch = Object.values((await coalescing.read(scope)).inputBatches ?? {})[0];
      expect(batch).toMatchObject({ state: 'sealed' });
      expect(await dueAt(scope)).toBe(String(LATER));
      expect(await pass.run()).toEqual({ synced: 0, stalled: [], failed: [] });
    });

    it('runs a due reply check in the deployment sync before the store sync, which clears the check time (#793 S7)', async () => {
      const h = await delegated();
      expect(await store().finish(h.scope, h.id, evidence(taskId(h.id, 0), 'task.complete', { document: {} }), vectorClock)).toBe('succeeded');
      await h.sync();
      expect(await dueAt(h.scope)).toBe(String(VECTOR_NOW));
      // The store sync alone does not read the reply, so the scope stays due.
      expect(await scheduler().run()).toEqual({ synced: 1, stalled: [h.scope], failed: [] });
      // The stalled scope waits out its backoff, which a new scheduler instance keeps (#794 H1).
      clock += 10_000;
      const checker = new HostedReplyChecker(store(), { port: () => ({ agentMessage: async () => ({ disposition: { outcome: 'held' } }) }), now: () => clock });
      const pass = scheduler({ sync: async (scope, now) => { await checker.check(scope, now); return sync(scope, now); } });
      expect(await pass.run()).toEqual({ synced: 1, stalled: [], failed: [] });
      expect(await h.delegation()).toMatchObject({ status: 'reply_held' });
      expect(await dueAt(h.scope)).toBe(String(LATER));
      expect(await pass.run()).toEqual({ synced: 0, stalled: [], failed: [] });
    });

    it('advances a room at a seat deadline in one scheduled sync, and the time moves to the next seat (#793 S6)', async () => {
      const scope = `tenant:${randomUUID()}`, deadline = VECTOR_NOW + ROOM_GRACE_MS;
      await store().seed(scope, state => { seedCollaboration(state); seedRoom(state); });
      await store().bindDevice(scope, 'device');
      await store().sync(scope, { ...SYNC_OPTIONS, history: undefined });
      expect(await dueAt(scope)).toBe(String(deadline));
      clock = deadline;
      expect(await scheduler().run()).toEqual({ synced: 1, stalled: [], failed: [] });
      const team = (await store().read(scope)).team, round = Object.values(team.rounds)[0]!;
      expect(round.seats.map(id => team.seats[id]!.status)).toEqual(['busy', 'queued']);
      expect(await dueAt(scope)).toBe(String(deadline + ROOM_GRACE_MS));
      expect(await scheduler().run()).toEqual({ synced: 0, stalled: [], failed: [] });
    });

    it('expires a due card in one scheduled sync, which clears the time (#793 S5)', async () => {
      const scope = `tenant:${randomUUID()}`;
      await store().seed(scope, state => { team(state); state.cards.c1!.expiresAt = VECTOR_NOW + 10; });
      expect(await dueAt(scope)).toBe(String(VECTOR_NOW + 10));
      clock = VECTOR_NOW + 10;
      expect(await scheduler().run()).toEqual({ synced: 1, stalled: [], failed: [] });
      expect((await store().read(scope)).cards.c1).toMatchObject({ state: 'expired' });
      expect(await dueAt(scope)).toBeNull();
      expect(await scheduler().run()).toEqual({ synced: 0, stalled: [], failed: [] });
    });

    it('skips a scope of an unsupported store version', async () => {
      const scope = await stuck('a');
      await query(`UPDATE ${table('scope')} SET state_version = 99 WHERE scope = $1`, [storedKey(scope)]);
      expect(await scheduler().run()).toEqual({ synced: 0, stalled: [], failed: [] });
    });
  });
});
