import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueue, HostLedger, project, taskId, type FrozenInput } from '@byok-sdk/example-host-execution-core';
import { stateOf, type CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { syncTurn } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { seedCollaboration, SYNC_OPTIONS, syncVectors, type SyncIntentRecord, type SyncSubject } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { vectorPorts } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;

/** One H sync subject per call: a new scope of the shared test schema, seeded like the memory subject. */
async function hosted(): Promise<SyncSubject> {
  const scope = `tenant:${randomUUID()}`, pool = opened!.pool;
  await store().seed(scope, state => seedCollaboration(state));
  return {
    scope,
    commit: request => store().commit(scope, request, vectorPorts),
    stored: () => store().dump(scope),
    state: () => store().read(scope),
    change: edit => store().seed(scope, edit),
    sync: () => store().sync(scope, { ...SYNC_OPTIONS, history: undefined }),
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
/** A concluded Turn `t1`, a queued user Turn `q1` and a queued continuation `q2`. */
function queueTurns(state: CollaborationState): void {
  Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
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

  it('refuses a routine Turn before D2f, and writes nothing', async () => {
    const h = await hosted();
    await h.change(state => {
      queueTurns(state);
      state.turns.r1 = { id: 'r1', root: 'r1', botId: 'main', source: 'routine', request: 'Daily', hop: 0, status: 'queued', authority: 'owner' };
    });
    const before = await h.stored();
    await expect(h.sync()).rejects.toThrow('H has no routine Turns before #793 D2f');
    expect(await h.stored()).toBe(before);
  });
});
