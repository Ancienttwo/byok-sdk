import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RETRY, enqueue, hash, HostLedger, project, taskId, type FrozenInput } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { stateOf, type CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { syncTurn, type Command } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { cardVectors, seedCollaboration, SYNC_OPTIONS, syncVectors, type CardSubject, type SyncIntentRecord, type SyncSubject } from '@byok-sdk/example-bot-collaboration/test-support';
import { freezeIntent, type IntentFreeze } from './intents';
import { storedKey } from './layout';
import { VECTOR_ROUTINES, vectorClock } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { inSchema, lockScope, type OutcomeRoutinePorts } from './store';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;

/** One H sync subject per call: a new scope of the shared test schema, seeded like the memory subject. */
async function hosted(): Promise<SyncSubject> {
  const scope = `tenant:${randomUUID()}`, pool = opened!.pool;
  await store().seed(scope, state => seedCollaboration(state));
  // The seeded Bot runs on `device`, so a freeze needs its H binding (#793 D2e).
  await store().bindDevice(scope, 'device');
  return {
    scope,
    commit: request => store().commit(scope, request, vectorClock),
    stored: () => store().dump(scope),
    state: () => store().read(scope),
    change: edit => store().seed(scope, edit),
    sync: async () => { await store().sync(scope, { ...SYNC_OPTIONS, history: undefined }); },
    intent: async turnId => {
      const found = await pool.query<{ key: string; source: SyncIntentRecord['source']; input: FrozenInput; wait_until: string }>(
        `SELECT key, source, input, wait_until::text FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId)]);
      const row = found.rows[0];
      if (!row) return undefined;
      const { taskId: _, ...execution } = row.input;
      return { key: JSON.parse(row.key) as string, source: row.source, waitUntil: Number(row.wait_until), execution };
    },
    concludeIntent: async (turnId, conclusion) => {
      await pool.query(`UPDATE ${table('intent')} SET conclusion = $3 WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId), conclusion]);
    },
    projection: async id => (await pool.query<{ body: never }>(`SELECT body FROM ${table('outbox')} WHERE scope = $1 AND key = $2 AND kind = 'projection'`,
      [storedKey(scope), storedKey(id)])).rows.map(row => row.body),
  };
}
/** The H card subject (#793 S5): the H sync subject, whose sync runs at a given time. */
async function hostedCards(): Promise<CardSubject> {
  const subject = await hosted();
  return { ...subject, sync: async now => { await store().sync(subject.scope, { ...SYNC_OPTIONS, now, history: undefined }); } };
}
/** A concluded Turn `t1`, a queued user Turn `q1` and a queued continuation `q2`. Card `c1` stays pending in the H sync. */
function queueTurns(state: CollaborationState): void {
  Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
  state.cards.c1!.expiresAt = Number.MAX_SAFE_INTEGER;
  state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'First', hop: 0, status: 'queued', authority: 'owner' };
  state.turns.q2 = { id: 'q2', root: 'q1', botId: 'main', source: 'continuation', request: 'Next', hop: 0, status: 'queued', authority: 'owner' };
}
const intentRow = async (scope: string, turnId: string) => (await opened!.pool.query<{ source: string; input: string; wait_until: string;
  cancel_reason: string | null; conclusion: string | null }>(
  `SELECT source, input::text, wait_until::text, cancel_reason, conclusion FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId)])).rows[0];

describe.skipIf(POSTGRES_URL === undefined)('H sync step on real Postgres (#793 D2b-2)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  syncVectors('H HostedCollaborationStore on Postgres', hosted);
  cardVectors('H HostedCollaborationStore on Postgres', hostedCards);

  it('freezes a decided card\'s action_result Turn in the same sync that adds it: the new Turn starts another round', async () => {
    const h = await hostedCards(), result = hash(['action_result', 'c1']);
    await h.change(state => {
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      state.cards.c1!.expiresAt = Number.MAX_SAFE_INTEGER;
    });
    await h.commit({ scope: h.scope, commandId: 'decide', command: { kind: 'decide', cardId: 'c1', decision: 'rejected' } });
    await h.sync(SYNC_OPTIONS.now);
    expect((await h.state()).turns[result]).toMatchObject({ source: 'action_result' });
    expect(await h.intent(result)).toMatchObject({ key: result });
  });

  it('freezes the same input bytes as K4 enqueue in an L ledger, from the same rule step, with the same state', async () => {
    const h = await hosted();
    await h.change(queueTurns);
    await h.sync();
    // L writes a freeze step with K4 `enqueue` (syncTurnInLedger). The first sync of these Turns reads no intent.
    const root = mkdtempSync(join(tmpdir(), 'h-parity-')), ledger = new HostLedger(join(root, 'host.sqlite'), 'product:parity');
    try {
      ledger.transaction(s => {
        const state = stateOf(s.application);
        seedCollaboration(state);
        queueTurns(state);
        for (const turn of Object.values(state.turns)) {
          const step = syncTurn(state, turn, { intent: () => undefined, executionStarted: () => false, retired: () => undefined },
            SYNC_OPTIONS, (id, value) => project(s, id, value));
          if (step?.kind === 'freeze') enqueue(s, ledger.tenant, step.input);
        }
      });
      const l = ledger.snapshot();
      for (const turnId of ['q1', 'q2']) {
        const intent = l.intents[Object.keys(l.intents).find(id => l.intents[id]!.key === turnId)!]!, row = (await intentRow(h.scope, turnId))!;
        expect(row.input, turnId).toBe(JSON.stringify(l.executions[taskId(turnId, 0)]!.input));
        expect([row.source, Number(row.wait_until)], turnId).toEqual([intent.source, intent.waitUntil]);
      }
      expect(Object.keys(l.intents)).toHaveLength(2);
      expect(JSON.stringify(await h.state())).toBe(JSON.stringify(stateOf(l.application)));
    } finally {
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cancels and concludes the never-tried intent of an archived Bot, the next sync reports its Turn, and a third changes nothing', async () => {
    const h = await hosted();
    await h.change(queueTurns);
    await h.sync();
    await h.change(state => { state.team.bots.main!.archived = true; });
    const archived = await h.stored();
    await h.sync();
    // The cancel changes only intent rows, so this also shows that the stored bytes cover them.
    expect(await h.stored()).not.toBe(archived);
    // No submit tried these rows, so no SDK attempt can exist: the cancel write concludes them, as K4 queuedExpiry does.
    expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: 'cancelled', conclusion: 'cancelled' });
    expect(await intentRow(h.scope, 'q2')).toMatchObject({ cancel_reason: 'cancelled', conclusion: 'cancelled' });
    await h.sync();
    const state = await h.state();
    for (const turnId of ['q1', 'q2']) {
      expect(state.turns[turnId], turnId).toMatchObject({ status: 'failed', conclusion: 'cancelled', reported: true });
      expect(await h.projection(`bot-turn:${turnId}`), turnId).toHaveLength(1);
    }
    const stored = await h.stored();
    await h.sync();
    expect(await h.stored()).toBe(stored);
  });

  it('keeps the started intent of an archived Bot open, as L does, and cancels only the never-tried one (#793 D2d)', async () => {
    const h = await hosted();
    await h.change(queueTurns);
    await h.sync();
    // The reconciliation saw a claim of q1: L reads the same fact from the K4 execution (K8 commit.ts executionStarted).
    await opened!.pool.query(`UPDATE ${table('intent')} SET submission = 'delivered', tries = 1, started = true WHERE scope = $1 AND key = $2`,
      [storedKey(h.scope), storedKey('q1')]);
    await h.change(state => { state.team.bots.main!.archived = true; });
    await h.sync();
    expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: null, conclusion: null });
    expect(await intentRow(h.scope, 'q2')).toMatchObject({ cancel_reason: 'cancelled', conclusion: 'cancelled' });
    const state = await h.state();
    expect([state.turns.q1!.status, state.turns.q1!.conclusion]).toEqual(['processing', undefined]);
  });

  it('refuses a freeze input with a K4 retry policy, and writes nothing (#793 D2d option A)', async () => {
    const h = await hosted();
    const before = await h.stored();
    await expect(inSchema(opened!.pool, store().schema, async client => {
      await lockScope(client, storedKey(h.scope));
      return freezeIntent(client, h.scope, { key: 'r1', source: 'user', waitUntil: 1, execution: template('device'), retry: DEFAULT_RETRY } as IntentFreeze);
    })).rejects.toThrow('H intents have no retry policy');
    expect(await h.stored()).toBe(before);
  });

  it('in history mode, freezes a Turn only with its own history rows', async () => {
    const h = await hosted();
    await h.change(queueTurns);
    await store().sync(h.scope, { ...SYNC_OPTIONS, historyMode: true, history: new Map([['q1', { rows: [], digest: 'digest-q1' }]]) });
    const state = await h.state();
    expect([state.turns.q1!.status, state.turns.q1!.historyDigest]).toEqual(['processing', 'digest-q1']);
    expect([state.turns.q2!.status, state.turns.q2!.historyDigest]).toEqual(['queued', undefined]);
    expect(await intentRow(h.scope, 'q1')).toBeDefined();
    expect(await intentRow(h.scope, 'q2')).toBeUndefined();
  });

  it('runs to a fixed point: one sync cancels the untried intent of an archived Bot and ends its Turn, as the L pass drains again (#793 D2f-3)', async () => {
    const h = await hosted();
    await h.change(queueTurns);
    await h.sync();
    expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: null, conclusion: null });
    await h.change(state => { state.team.bots.main!.archived = true; });
    await h.sync();
    expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: 'cancelled', conclusion: 'cancelled' });
    expect((await h.state()).turns.q1).toMatchObject({ status: 'failed', conclusion: 'cancelled', reported: true });
  });

  describe('cancel_turn of a Turn with a frozen intent runs the K4 cancel in its commit, as L does (#793 D2f-4)', () => {
    const cancel = (h: SyncSubject, turnId: string) => h.commit({ scope: h.scope, commandId: `cancel-${turnId}`, command: { kind: 'cancel_turn', turnId } });
    async function frozen() {
      const h = await hosted();
      await h.change(queueTurns);
      await h.sync();
      expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: null, conclusion: null });
      return h;
    }

    it('concludes an untried intent cancelled in the commit, and the next sync ends its Turn', async () => {
      const h = await frozen();
      await cancel(h, 'q1');
      expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: 'cancelled', conclusion: 'cancelled' });
      expect((await h.state()).turns.q1).toMatchObject({ status: 'processing' });
      await h.sync();
      expect((await h.state()).turns.q1).toMatchObject({ status: 'failed', conclusion: 'cancelled', reported: true });
    });

    it('keeps a tried intent open with its cancel reason, for the reconciliation to check its attempt', async () => {
      const h = await frozen();
      await opened!.pool.query(`UPDATE ${table('intent')} SET tries = 1, submission = 'uncertain' WHERE scope = $1 AND key = $2`,
        [storedKey(h.scope), storedKey('q1')]);
      await cancel(h, 'q1');
      expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: 'cancelled', conclusion: null });
      expect((await h.state()).turns.q1).toMatchObject({ status: 'processing' });
    });
  });

  describe('a delegation cancel fact is delivered in its commit, as L settleChain delivers it (#793 D2f-4)', () => {
    /** `q1` is the current chain Turn of delegation `d1`, with a frozen intent. */
    const chain = (status: 'running' | 'uncertain') => (state: CollaborationState) => {
      state.turns.q1!.delegationId = 'd1';
      state.batches.b1 = { id: 'b1', delegationIds: ['d1'], slots: [] };
      state.delegations.d1 = { id: 'd1', root: 'q1', fromBotId: 'main', fromTurnId: 't1', fromTaskId: 'task-t1', index: 0, toBotId: 'main',
        request: 'First', hop: 0, requestTurnId: 'q1', chainTurnIds: ['q1'], batch: 'b1', status, revision: 0 };
    };
    async function delegated(status: 'running' | 'uncertain', tried = false) {
      const h = await hosted();
      await h.change(queueTurns);
      await h.sync();
      await h.change(chain(status));
      if (tried) await opened!.pool.query(`UPDATE ${table('intent')} SET tries = 1, submission = 'uncertain' WHERE scope = $1 AND key = $2`,
        [storedKey(h.scope), storedKey('q1')]);
      return h;
    }
    const commit = (h: SyncSubject, command: Command) => h.commit({ scope: h.scope, commandId: randomUUID(), command });

    it('cancel_turn of an open chain Turn concludes its untried intent cancelled, and marks the fact delivered', async () => {
      const h = await delegated('running');
      await commit(h, { kind: 'cancel_turn', turnId: 'q1' });
      expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: 'cancelled', conclusion: 'cancelled' });
      expect((await h.state()).delegations.d1).toMatchObject({ cancel: { targetTurnId: 'q1', delivered: true } });
    });

    it('cancel_delegation keeps a tried intent open with its cancel reason, and marks the fact delivered', async () => {
      const h = await delegated('running', true);
      await commit(h, { kind: 'cancel_delegation', delegationId: 'd1' });
      expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: 'cancelled', conclusion: null });
      expect((await h.state()).delegations.d1).toMatchObject({ cancel: { targetTurnId: 'q1', delivered: true } });
    });

    it('abandon_delegation concludes the untried intent of its open chain Turn cancelled, and marks the fact delivered', async () => {
      const h = await delegated('uncertain');
      await commit(h, { kind: 'abandon_delegation', delegationId: 'd1' });
      expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: 'cancelled', conclusion: 'cancelled' });
      expect((await h.state()).delegations.d1).toMatchObject({ verdict: 'abandoned', cancel: { targetTurnId: 'q1', delivered: true } });
    });

    it('reads the committed intents of an outcome from the store, and ignores them in the caller ports', async () => {
      const h = await hosted();
      await inSchema(opened!.pool, store().schema, async client => {
        await lockScope(client, storedKey(h.scope));
        await freezeIntent(client, h.scope, { key: 'q1', source: 'user', execution: template('device'), waitUntil: Date.now() + 60_000 });
      });
      // The chain exists before the seed runs again, so the frozen schema of `t1` offers its Main Bot cancel.
      await h.change(state => {
        state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'First', hop: 0, status: 'processing', authority: 'owner' };
        chain('running')(state);
        seedCollaboration(state);
      });
      const stubbed = { ...VECTOR_ROUTINES, committed: { intent: () => undefined } } as OutcomeRoutinePorts;
      await store().commitIn(h.scope, { scope: h.scope, commandId: 'task-t1', command: { kind: 'outcome', turnId: 't1', taskId: 'task-t1',
        document: { cancel_delegation: [{ delegationId: 'd1' }] } } }, vectorClock, stubbed);
      // With the stub, K8 would end the chain Turn itself and resolve the delegation while its intent kept running.
      const state = await h.state();
      expect(state.delegations.d1).toMatchObject({ status: 'running', cancel: { targetTurnId: 'q1', delivered: false, reason: 'main_bot_cancelled' } });
      expect(state.delegations.d1!.verdict).toBeUndefined();
      expect(state.turns.q1).toMatchObject({ status: 'processing' });
      expect(await intentRow(h.scope, 'q1')).toMatchObject({ cancel_reason: null, conclusion: null });
    });
  });

  it('refuses a routine Turn that has no occurrence row, and writes nothing (#793 D2f)', async () => {
    const h = await hosted();
    await h.change(state => {
      queueTurns(state);
      const id = `occurrence:${hash('no occurrence row')}`;
      state.turns[id] = { id, root: id, botId: 'main', source: 'routine', request: 'Daily', hop: 0, status: 'queued', authority: 'owner' };
    });
    const before = await h.stored();
    await expect(h.sync()).rejects.toThrow('Host occurrence not found');
    expect(await h.stored()).toBe(before);
  });
});
