import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { hash, taskId, type Json } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import type { Command, DelegationTimers } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { seedCollaboration, settlementVectors, SYNC_OPTIONS, VECTOR_NOW, type SettlementSubject,
  type SyncIntentRecord } from '@byok-sdk/example-bot-collaboration/test-support';
import type { FrozenInput } from '@byok-sdk/example-host-execution-core';
import { frozenIntent, settleFacts } from './intents';
import { storedKey } from './layout';
import { vectorPorts } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedReconciler, type HostedTaskPort, type TaskEvidence } from './reconcile';
import { inSchema, lockScope } from './store';

// #793 D2f-5: the K8 delegation settlement in the H sync, and the cancel fact that a terminal's outcome freezes.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;

/** Bot `b` beside the seeded Main Bot, on the same bound device, with its persona applied. `t1` has ended. */
function team(state: CollaborationState): void {
  seedCollaboration(state);
  Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
  state.team.bots.b = { ...state.team.bots.main!, id: 'b', name: 'B', role: 'Reviewer', mainBot: false, execution: template('device', 'b') };
}
const evidence = (task: string, type: string, payload: Json = {}): TaskEvidence => ({
  terminal: { envelope: { task_id: task, type, payload } } as unknown as DeviceTerminal,
  attempt: { taskId: task } as unknown as TaskAttempt,
});

/** A scope where the Main Bot's owner Turn delegated to `b`, and a sync froze B's request Turn. */
async function delegated() {
  const scope = `tenant:${randomUUID()}`;
  await store().seed(scope, team);
  await store().bindDevice(scope, 'device');
  const commit = async (command: Command) => {
    const result = await store().commit(scope, { scope, commandId: randomUUID(), command }, vectorPorts);
    if (result.disposition.outcome !== 'accepted') throw new Error(`Refused ${command.kind}: ${JSON.stringify(result.disposition)}`);
    return result.disposition.value;
  };
  const sync = (now = VECTOR_NOW, timers?: DelegationTimers) => store().sync(scope, { ...SYNC_OPTIONS, now, history: undefined, ...(timers ? { timers } : {}) });
  const finish = (turnId: string, type: string, payload: Json = {}) => store().finish(scope, turnId, evidence(taskId(turnId, 0), type, payload), vectorPorts);
  const root = await commit({ kind: 'input', botId: 'main', key: 'r1', request: 'Ask b', sender: 'owner' }) as string;
  await sync();
  expect(await finish(root, 'task.complete', { document: { delegate: [{ to: 'b', request: 'Check' }] } })).toBe('succeeded');
  const id = hash([taskId(root, 0), 'delegate', 0]);
  await sync();
  const row = async (turnId: string) => (await opened!.pool.query<{ tries: number; started: boolean; cancel_reason: string | null; conclusion: string | null }>(
    `SELECT tries, started, cancel_reason, conclusion FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId)])).rows[0];
  const set = (turnId: string, columns: string) => opened!.pool.query(`UPDATE ${table('intent')} SET ${columns} WHERE scope = $1 AND key = $2`,
    [storedKey(scope), storedKey(turnId)]);
  const state = () => store().read(scope);
  return { scope, root, id, commit, sync, finish, row, set, state, delegation: async () => (await state()).delegations[id]!,
    stored: () => store().dump(scope) };
}

/**
 * The shared K8 settlement vectors on H, in a new scope of the test schema: `settle` is `store.sync`, and the fact edits write
 * the intent row columns that `settleFacts` reads, as the L subject writes the K4 ledger that K8 `intentFacts` reads.
 */
async function settlementSubject(): Promise<SettlementSubject> {
  const scope = `tenant:${randomUUID()}`, pool = opened!.pool;
  await store().seed(scope, state => seedCollaboration(state));
  await store().bindDevice(scope, 'device');
  const set = (turnId: string, columns: string, values: unknown[] = []) =>
    pool.query(`UPDATE ${table('intent')} SET ${columns} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId), ...values]);
  return {
    scope,
    commit: request => store().commit(scope, request, vectorPorts),
    stored: () => store().dump(scope),
    state: () => store().read(scope),
    change: edit => store().seed(scope, edit),
    sync: () => store().sync(scope, { ...SYNC_OPTIONS, history: undefined }),
    settle: (now, timers) => store().sync(scope, { ...SYNC_OPTIONS, now, history: undefined, ...(timers ? { timers } : {}) }),
    intent: async turnId => {
      const row = (await pool.query<{ key: string; source: SyncIntentRecord['source']; input: FrozenInput; wait_until: string }>(
        `SELECT key, source, input, wait_until::text FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId)])).rows[0];
      if (!row) return undefined;
      const { taskId: _, ...execution } = row.input;
      return { key: JSON.parse(row.key) as string, source: row.source, waitUntil: Number(row.wait_until), execution };
    },
    concludeIntent: async (turnId, conclusion) => { await set(turnId, 'conclusion = $3', [conclusion]); },
    projection: async id => (await pool.query<{ body: never }>(`SELECT body FROM ${table('outbox')} WHERE scope = $1 AND key = $2 AND kind = 'projection'`,
      [storedKey(scope), storedKey(id)])).rows.map(row => row.body),
    submit: async turnId => { await set(turnId, `submission = 'uncertain', tries = 1`); },
    claim: async turnId => { await set(turnId, `submission = 'delivered', tries = 1, started = true`); },
    terminal: async (turnId, type, payload) => { await set(turnId, 'terminal = $3::json', [JSON.stringify({ envelope: { task_id: taskId(turnId, 0), type, payload } })]); },
    conclude: async (turnId, conclusion, cancelReason) => {
      await set(turnId, 'conclusion = $3, cancel_reason = coalesce($4, cancel_reason)', [conclusion, cancelReason ?? null]);
    },
  };
}

describe.skipIf(POSTGRES_URL === undefined)('H delegation settlement (#793 D2f-5)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  settlementVectors('H HostedCollaborationStore on Postgres', settlementSubject);

  const TIMERS: DelegationTimers = { cancelGraceMs: 1_000, uncertainAfterMs: 5_000 };
  const unit = (state: CollaborationState, id: string) => state.units[hash([id, 'B'])]!.state;
  /** One more sync writes nothing: each verdict, fact and join happens once. */
  const settled = async (h: Awaited<ReturnType<typeof delegated>>, now = VECTOR_NOW, timers?: DelegationTimers) => {
    const before = await h.stored();
    await h.sync(now, timers);
    expect(await h.stored()).toBe(before);
  };

  it('gives each chain end that did not succeed its K8 verdict at the next sync, and the same sync freezes the report to A', async () => {
    const cases: Array<[string, (h: Awaited<ReturnType<typeof delegated>>) => Promise<unknown>, { verdict: string; reason?: string }, 'spent' | 'released']> = [
      ['a failed terminal', h => h.finish(h.id, 'task.fail'), { verdict: 'failed' }, 'spent'],
      ['a busy decline', h => h.finish(h.id, 'task.decline', { code: 'agent_home_writer_busy' }), { verdict: 'failed', reason: 'busy' }, 'released'],
      ['a decline with no code', h => h.finish(h.id, 'task.decline'), { verdict: 'failed', reason: 'busy' }, 'released'],
      ['another decline', h => h.finish(h.id, 'task.decline', { code: 'model_unavailable' }), { verdict: 'failed', reason: 'model_unavailable' }, 'released'],
      ['an expiry', h => h.set(h.id, `conclusion = 'expired'`), { verdict: 'expired' }, 'released'],
      ['a cancel that raced the wait deadline', h => h.set(h.id, `cancel_reason = 'expired', conclusion = 'cancelled'`),
        { verdict: 'expired', reason: 'claim_raced_deadline' }, 'released'],
      ['a cancel', h => h.set(h.id, `conclusion = 'cancelled'`), { verdict: 'cancelled', reason: 'user_cancelled' }, 'released'],
    ];
    for (const [name, conclude, verdict, units] of cases) {
      const h = await delegated();
      await conclude(h);
      expect(await h.delegation(), name).not.toHaveProperty('verdict');
      await h.sync();
      const state = await h.state(), d = state.delegations[h.id]!;
      expect(d, name).toMatchObject({ ...verdict, status: 'resolved', replyTurnId: hash(['bot_reply', h.id]) });
      if (!verdict.reason) expect(d.reason, name).toBeUndefined();
      // A decline terminal is not a run, so its unit is released; a failed terminal spent it (K8 settleDelegations).
      expect(unit(state, h.id), name).toBe(units);
      expect(state.turns[d.replyTurnId!], name).toMatchObject({ source: 'bot_reply', botId: 'main', replies: [expect.objectContaining(verdict)] });
      expect(await h.row(d.replyTurnId!), name).toMatchObject({ conclusion: null });
      await settled(h);
    }
  });

  it('spends the B unit at the first observed claim, and the delegation runs, with one new projection', async () => {
    const h = await delegated();
    const before = (await h.state()).budgets[(await h.delegation()).root]!;
    await h.set(h.id, `submission = 'delivered', tries = 1, started = true`);
    await h.sync();
    const state = await h.state();
    expect(unit(state, h.id)).toBe('spent');
    // A spent unit leaves the reservation and counts as a delegation of the root (K8 claimUnit).
    expect(state.budgets[state.delegations[h.id]!.root]).toMatchObject({ reserved: before.reserved! - 1, delegation: before.delegation + 1 });
    expect(state.delegations[h.id]).toMatchObject({ status: 'running', revision: 2, claimed: { turnId: h.id, at: VECTOR_NOW } });
    const projections = await opened!.pool.query<{ key: string; body: { status: string } }>(`SELECT key, body FROM ${table('outbox')}
      WHERE scope = $1 AND kind = 'projection' AND key LIKE $2 ORDER BY ordinal`, [storedKey(h.scope), `"delegation:${h.id}:%`]);
    expect(projections.rows.map(row => [JSON.parse(row.key), row.body.status])).toEqual([[`delegation:${h.id}:1`, 'queued'], [`delegation:${h.id}:2`, 'running']]);
    await settled(h);
  });

  it('releases the units of a concluded chain end that never started, and the root reserves less', async () => {
    const h = await delegated();
    const root = (await h.delegation()).root, before = (await h.state()).budgets[root]!.reserved!;
    await h.set(h.id, `conclusion = 'expired'`);
    await h.sync();
    const state = await h.state();
    expect(unit(state, h.id)).toBe('released');
    expect(state.budgets[root]!.reserved).toBeLessThan(before);
    await settled(h);
  });

  it('refuses a delegation whose target Bot was archived (target_archived): one sync cancels its untried intent and resolves it', async () => {
    const h = await delegated();
    await store().seed(h.scope, state => { state.team.bots.b!.archived = true; });
    await h.sync();
    expect(await h.row(h.id)).toMatchObject({ cancel_reason: 'cancelled', conclusion: 'cancelled' });
    expect(await h.delegation()).toMatchObject({ verdict: 'refused', reason: 'target_archived', cancel: { reason: 'target_archived', delivered: true } });
    await settled(h);
  });

  it('delivers the target_archived cancel of a tried target in the sync, and resolves it at the sync after its conclusion', async () => {
    const h = await delegated();
    await h.set(h.id, `submission = 'uncertain', tries = 1`);
    await store().seed(h.scope, state => { state.team.bots.b!.archived = true; });
    await h.sync();
    expect(await h.row(h.id)).toMatchObject({ cancel_reason: 'cancelled', conclusion: null });
    const d = await h.delegation();
    expect(d).toMatchObject({ cancel: { reason: 'target_archived', delivered: true } });
    expect(d).not.toHaveProperty('verdict');
    await settled(h);
    // The reconciliation concludes the target.
    await h.set(h.id, `conclusion = 'cancelled'`);
    await h.sync();
    expect(await h.delegation()).toMatchObject({ verdict: 'refused', reason: 'target_archived' });
    await settled(h);
  });

  it('shows a delivered cancel with no conclusion as uncertain once the cancel grace passed, with the timers of the sync options', async () => {
    const h = await delegated();
    await h.set(h.id, `submission = 'uncertain', tries = 1`);
    await store().seed(h.scope, state => { state.team.bots.b!.archived = true; });
    await h.sync(VECTOR_NOW, TIMERS);
    await h.sync(VECTOR_NOW + TIMERS.cancelGraceMs - 1, TIMERS);
    expect((await h.delegation()).status).not.toBe('uncertain');
    await h.sync(VECTOR_NOW + TIMERS.cancelGraceMs, TIMERS);
    expect(await h.delegation()).toMatchObject({ status: 'uncertain', uncertainSince: VECTOR_NOW + TIMERS.cancelGraceMs });
    expect(await h.delegation()).not.toHaveProperty('verdict');
    await settled(h, VECTOR_NOW + TIMERS.cancelGraceMs, TIMERS);
  });

  /** A claimed chain end with no conclusion, shown `uncertain` once `uncertainAfterMs` passed. */
  async function uncertainClaim() {
    const h = await delegated();
    await h.set(h.id, `submission = 'delivered', tries = 1, started = true`);
    await h.sync(VECTOR_NOW, TIMERS);
    await h.sync(VECTOR_NOW + TIMERS.uncertainAfterMs - 1, TIMERS);
    expect((await h.delegation()).status).toBe('running');
    await h.sync(VECTOR_NOW + TIMERS.uncertainAfterMs, TIMERS);
    expect(await h.delegation()).toMatchObject({ status: 'uncertain', uncertainSince: VECTOR_NOW + TIMERS.uncertainAfterMs });
    return h;
  }
  it('shows a claimed chain end with no conclusion as uncertain once uncertainAfterMs passed', async () => {
    const h = await uncertainClaim();
    await settled(h, VECTOR_NOW + TIMERS.uncertainAfterMs, TIMERS);
  });

  it('writes a terminal that comes after the verdict of an ended delegation to the audit list only, once', async () => {
    const h = await uncertainClaim();
    await h.commit({ kind: 'abandon_delegation', delegationId: h.id });
    expect(await h.delegation()).toMatchObject({ verdict: 'abandoned', lateTurnId: h.id, cancel: { delivered: true } });
    expect(await h.row(h.id)).toMatchObject({ cancel_reason: 'cancelled', conclusion: null });
    await h.set(h.id, `conclusion = 'cancelled'`);
    await h.sync(VECTOR_NOW + TIMERS.uncertainAfterMs, TIMERS);
    const state = await h.state();
    expect(state.audit.filter(line => line.includes(h.id))).toEqual([`Delegation terminal after verdict: ${h.id} ${taskId(h.id, 0)}`]);
    expect(state.delegations[h.id]).not.toHaveProperty('lateTurnId');
    expect(state.delegations[h.id]).toMatchObject({ verdict: 'abandoned' });
    await settled(h, VECTOR_NOW + TIMERS.uncertainAfterMs, TIMERS);
  });

  describe('a Main Bot cancel that a terminal outcome freezes is delivered in that terminal transaction, as L delivers it after its drain', () => {
    /** The Main Bot's next owner Turn cancels the open delegation in its outcome. */
    async function cancelled(tried: boolean) {
      const h = await delegated();
      if (tried) await h.set(h.id, `submission = 'uncertain', tries = 1`);
      const order = await h.commit({ kind: 'input', botId: 'main', key: 'r2', request: 'Stop the review', sender: 'owner' }) as string;
      await h.sync();
      expect(await h.finish(order, 'task.complete', { document: { cancel_delegation: [{ delegationId: h.id }] } })).toBe('succeeded');
      return h;
    }

    it('concludes an untried target cancelled in the finish, and the next sync resolves cancelled (main_bot_cancelled)', async () => {
      const h = await cancelled(false);
      expect(await h.row(h.id)).toMatchObject({ cancel_reason: 'cancelled', conclusion: 'cancelled' });
      expect(await h.delegation()).toMatchObject({ cancel: { reason: 'main_bot_cancelled', delivered: true } });
      expect(await h.delegation()).not.toHaveProperty('verdict');
      await h.sync();
      expect(await h.delegation()).toMatchObject({ verdict: 'cancelled', reason: 'main_bot_cancelled' });
      await settled(h);
    });

    it('keeps a tried target open with its cancel reason, and resolves at the sync after its conclusion', async () => {
      const h = await cancelled(true);
      expect(await h.row(h.id)).toMatchObject({ cancel_reason: 'cancelled', conclusion: null });
      expect(await h.delegation()).toMatchObject({ cancel: { reason: 'main_bot_cancelled', delivered: true } });
      await h.sync();
      const open = await h.delegation();
      expect(open).not.toHaveProperty('verdict');
      expect(open.status).not.toBe('uncertain');
      await h.set(h.id, `conclusion = 'cancelled'`);
      await h.sync();
      expect(await h.delegation()).toMatchObject({ verdict: 'cancelled', reason: 'main_bot_cancelled' });
      await settled(h);
    });
  });

  it('refuses delegation timers that L refuses, before it reads or writes', async () => {
    const h = await delegated(), before = await h.stored();
    for (const [timers, message] of [[{ cancelGraceMs: 0, uncertainAfterMs: 5_000 }, 'Invalid delegation timers'],
      [{ cancelGraceMs: 1_000, uncertainAfterMs: 0 }, 'Invalid delegation timers'], [{ cancelGraceMs: -1, uncertainAfterMs: 5_000 }, 'Time must be'],
      [{ cancelGraceMs: 1_000, uncertainAfterMs: Number.NaN }, 'Time must be'], [{ cancelGraceMs: 1.5, uncertainAfterMs: 5_000 }, 'Time must be']] as const) {
      await expect(h.sync(VECTOR_NOW, timers), JSON.stringify(timers)).rejects.toThrow(message);
    }
    expect(await h.stored()).toBe(before);
    await expect(h.sync(VECTOR_NOW, { cancelGraceMs: 1, uncertainAfterMs: 1 })).resolves.toBeUndefined();
  });

  it('writes nothing when the settlement throws', async () => {
    const h = await delegated();
    await h.set(h.id, `submission = 'delivered', tries = 1, started = true`);
    // The projection id of the running revision exists with another value.
    await opened!.pool.query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, body) SELECT $1, $2, coalesce(max(ordinal) + 1, 0),
      'projection', '{"other":true}'::json FROM ${table('outbox')} WHERE scope = $1`, [storedKey(h.scope), storedKey(`delegation:${h.id}:2`)]);
    const before = await h.stored();
    await expect(h.sync()).rejects.toThrow('Projection identity conflict');
    expect(await h.stored()).toBe(before);
  });

  describe('with its own schema, because a reconciler pass covers the whole schema', () => {
    let shared: typeof opened;
    beforeEach(async () => { shared = opened; opened = await openStore(); });
    afterEach(async () => { await opened?.close(); opened = shared; });

    it('gives the verdict at the sync of the scope that the reconciler reports for its conclusion', async () => {
      const h = await delegated();
      await h.set(h.id, `submission = 'delivered', tries = 1`);
      const input = await inSchema(opened!.pool, store().schema, client => frozenIntent(client, h.scope, taskId(h.id, 0)), true);
      const task = input!.input.taskId;
      // The SDK side of B's task: the frozen offer, a claimed attempt and a busy decline.
      const port: HostedTaskPort = {
        offer: async () => ({ taskId: task, deviceId: input!.input.deviceId, type: 'task.offer_for_agent_with_egress_fresh',
          payload: structuredClone(input!.input.payload), delivered: true, messageId: `offer-${task}` }) as never,
        attempt: async () => ({ taskId: task, deviceId: input!.input.deviceId, agentRef: input!.input.payload.agentRef, status: 'complete',
          ownerDeviceId: input!.input.deviceId, updatedAt: 'now' }) as TaskAttempt,
        deviceTerminal: async () => ({ envelope: { task_id: task, type: 'task.decline', payload: { code: 'agent_home_writer_busy' } }, recordedAt: 'now' }) as never,
        cancel: async () => { throw new Error('Unused cancel'); },
      };
      const reported: string[] = [];
      const reconciler = new HostedReconciler(opened!.pool, store().schema, store(), { port: () => port, ports: vectorPorts, pollMs: 0,
        now: () => VECTOR_NOW, changed: scope => { reported.push(scope); } });
      expect(await reconciler.run()).toEqual({ concluded: 1, failed: [] });
      expect(reported).toEqual([h.scope]);
      expect(await h.delegation()).not.toHaveProperty('verdict');
      // The Host syncs each reported scope.
      for (const scope of reported) await store().sync(scope, { ...SYNC_OPTIONS, now: VECTOR_NOW, history: undefined });
      expect(await h.delegation()).toMatchObject({ verdict: 'failed', reason: 'busy', status: 'resolved' });
      await settled(h);
    });
  });

  it('reads the settlement facts from the intent rows as K8 intentFacts reads them from the L ledger', async () => {
    const h = await delegated();
    const facts = async () => inSchema(opened!.pool, store().schema, async client => {
      await lockScope(client, storedKey(h.scope));
      const read = await settleFacts(client, h.scope, [h.id, h.root, 'none']);
      return { started: [read.started(h.id), read.started(h.root), read.started('none')], decline: read.declineCode(h.id),
        intent: read.intent(h.id), offered: (() => { try { return read.offeredTo(h.id); } catch (error) { return (error as Error).message; } })() };
    });
    // The root has a complete terminal: a start. B has no claim and no terminal yet.
    expect(await facts()).toEqual({ started: [false, true, false], decline: undefined, intent: { taskId: taskId(h.id, 0) },
      offered: 'offeredTo is not a settlement fact' });
    const terminal = (type: string, payload: Json) => h.set(h.id, `terminal = '${JSON.stringify({ envelope: { task_id: taskId(h.id, 0), type, payload } })}'::json`);
    await terminal('task.decline', { code: 'model_unavailable' });
    expect(await facts()).toMatchObject({ started: [false, true, false], decline: 'model_unavailable' });
    await terminal('task.decline', {});
    expect(await facts()).toMatchObject({ started: [false, true, false], decline: undefined });
    await terminal('task.fail', { code: 'model_unavailable' });
    expect(await facts()).toMatchObject({ started: [true, true, false], decline: undefined });
    await h.set(h.id, `terminal = NULL, started = true`);
    expect(await facts()).toMatchObject({ started: [true, true, false], decline: undefined });
  });
});
