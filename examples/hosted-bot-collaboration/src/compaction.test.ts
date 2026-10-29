import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompactVetoError, hash, RetiredIntentIdentityError } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState, Turn } from '@byok-sdk/example-bot-collaboration/model';
import { seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { freezeIntent } from './intents';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { inSchema, lockScope } from './store';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;
const query = <T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[]) => opened!.pool.query<T>(text, values).then(found => found.rows);

/** A settled seed (`t1` concluded and reported, no question or card) with a bound device and the extra Turns. */
async function scoped(...turns: Turn[]): Promise<string> {
  const scope = `tenant:${randomUUID()}`;
  await store().seed(scope, state => {
    seedCollaboration(state);
    Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
    delete state.questions.q1; delete state.cards.c1;
    for (const turn of turns) state.turns[turn.id] = turn;
  });
  await store().bindDevice(scope, 'device');
  return scope;
}
const turn = (id: string, fields: Partial<Turn> = {}): Turn =>
  ({ id, root: id, botId: 'main', source: 'user', request: id, hop: 0, status: 'processing', authority: 'owner', ...fields });
const freeze = (scope: string, key: string, source: 'user' | 'routine' = 'user') => inSchema(opened!.pool, store().schema, async client => {
  await lockScope(client, storedKey(scope));
  return freezeIntent(client, scope, { key, source, execution: template('device'), waitUntil: Date.now() + 60_000 });
});
const conclude = (scope: string, key: string) =>
  query(`UPDATE ${table('intent')} SET conclusion = 'succeeded' WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(key)]);
const intentRows = (scope: string) => query<{ key: string }>(`SELECT key FROM ${table('intent')} WHERE scope = $1 ORDER BY key`, [storedKey(scope)])
  .then(rows => rows.map(row => JSON.parse(row.key) as string));
const tombstones = (scope: string) => query<{ kind: string; identity: string; expires_at: string | null }>(
  `SELECT kind, identity, expires_at FROM ${table('retired_identity')} WHERE scope = $1 ORDER BY kind, identity`, [storedKey(scope)]);
const sync = (scope: string) => store().sync(scope, { ...SYNC_OPTIONS, history: undefined });
const compact = (scope: string, acknowledgedTurnIds: string[]) => store().compactIntents(scope, { acknowledgedTurnIds });
/** A scope whose user Turn `k1` has a succeeded intent that the sync concluded and reported. */
async function settled(): Promise<string> {
  const scope = await scoped(turn('k1'));
  await freeze(scope, 'k1');
  await conclude(scope, 'k1');
  await sync(scope);
  expect((await store().read(scope)).turns.k1).toMatchObject({ status: 'succeeded', conclusion: 'succeeded', reported: true });
  return scope;
}
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  return undefined;
}

describe.skipIf(POSTGRES_URL === undefined)('H intent compaction on real Postgres (#793 S8)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  it('removes a settled intent row with a permanent intent tombstone in the same transaction, and a second call finds it compacted', async () => {
    const scope = await settled();
    expect(await intentRows(scope)).toEqual(['k1']);
    expect(await compact(scope, ['k1', 'k1'])).toEqual({ compactedIntents: 1, alreadyCompactedIntents: 0 });
    expect(await intentRows(scope)).toEqual([]);
    // K4's intent tombstone: kind `intent`, the intent id `hash(key)`, permanent.
    expect(await tombstones(scope)).toEqual([{ kind: 'intent', identity: hash('k1'), expires_at: null }]);
    const stored = await store().dump(scope);
    expect(await compact(scope, ['k1'])).toEqual({ compactedIntents: 0, alreadyCompactedIntents: 1 });
    expect(await store().dump(scope)).toBe(stored);
    // The settled Turn keeps its conclusion, and the sync freezes nothing for it.
    await sync(scope);
    expect((await store().read(scope)).turns.k1).toMatchObject({ status: 'succeeded', conclusion: 'succeeded', reported: true });
    expect(await intentRows(scope)).toEqual([]);
  });

  it('makes an expiring tombstone of the same identity permanent, as K4 retires a row', async () => {
    const scope = await settled();
    // An occurrence intent's tombstone that an owner switch brought in with its K4 expiry.
    await query(`INSERT INTO ${table('retired_identity')} (scope, kind, identity, expires_at) VALUES ($1, 'intent', $2, 5)`, [storedKey(scope), hash('k1')]);
    expect(await compact(scope, ['k1'])).toEqual({ compactedIntents: 1, alreadyCompactedIntents: 0 });
    expect(await tombstones(scope)).toEqual([{ kind: 'intent', identity: hash('k1'), expires_at: null }]);
  });

  it('refuses to freeze a Turn whose intent compaction retired, and writes nothing', async () => {
    const scope = await settled();
    await compact(scope, ['k1']);
    const stored = await store().dump(scope);
    const error = await refusal(() => freeze(scope, 'k1'));
    expect(error).toBeInstanceOf(RetiredIntentIdentityError);
    expect(error).toMatchObject({ code: 'retired_intent_identity', message: 'Retired intent identity cannot be reused' });
    expect(await store().dump(scope)).toBe(stored);
  });

  it('keeps an intent that the K8 veto refuses, and the whole call writes nothing', async () => {
    // `k2` is concluded in its intent row, but the sync has not reported its Turn yet.
    const scope = await settled();
    await store().seed(scope, state => { state.turns.k2 = turn('k2'); });
    await freeze(scope, 'k2');
    await conclude(scope, 'k2');
    const stored = await store().dump(scope);
    const error = await refusal(() => compact(scope, ['k1', 'k2']));
    expect(error).toBeInstanceOf(CompactVetoError);
    expect(error).toMatchObject({ code: 'compact_vetoed', intentKey: 'k2', message: 'Compaction refused: The Turn is not concluded and reported' });
    expect(await store().dump(scope)).toBe(stored);
    expect(await intentRows(scope)).toEqual(['k1', 'k2']);
  });

  it('refuses an intent with no conclusion, and a Turn id with no intent and no tombstone', async () => {
    // The state says `k2` is settled, but its intent row has no conclusion: the store owns that check, as K4 does.
    const scope = await scoped(turn('k2', { status: 'succeeded', conclusion: 'succeeded', reported: true }));
    await freeze(scope, 'k2');
    const stored = await store().dump(scope);
    await expect(compact(scope, ['k2'])).rejects.toThrow('Only settled intents can be compacted');
    await expect(compact(scope, ['missing'])).rejects.toThrow('Acknowledged intent not found');
    await expect(compact(scope, [''])).rejects.toThrow('Invalid acknowledged Turn id');
    expect(await store().dump(scope)).toBe(stored);
  });

  it('reads an intent tombstone by its kind: a tombstone of another kind with the same digest retires no intent', async () => {
    const scope = await scoped();
    await query(`INSERT INTO ${table('retired_identity')} (scope, kind, identity) VALUES ($1, 'row', $2), ($1, 'slot', $2)`,
      [storedKey(scope), hash('k9')]);
    await expect(compact(scope, ['k9'])).rejects.toThrow('Acknowledged intent not found');
    await query(`INSERT INTO ${table('retired_identity')} (scope, kind, identity) VALUES ($1, 'intent', $2)`, [storedKey(scope), hash('k9')]);
    expect(await compact(scope, ['k9'])).toEqual({ compactedIntents: 0, alreadyCompactedIntents: 1 });
  });

  it('never compacts a routine intent', async () => {
    const id = `occurrence:${hash('daily')}`;
    const scope = await scoped(turn(id, { source: 'routine', status: 'succeeded', conclusion: 'succeeded', reported: true }));
    await freeze(scope, id, 'routine');
    await conclude(scope, id);
    const stored = await store().dump(scope);
    await expect(compact(scope, [id])).rejects.toThrow('H does not compact routine intents');
    expect(await store().dump(scope)).toBe(stored);
    expect(await intentRows(scope)).toEqual([id]);
    expect(await tombstones(scope)).toEqual([]);
  });

  it('fails a queued Turn whose intent was retired as result_retired, before a retired Turn id, and freezes no intent, as the L sync does', async () => {
    const scope = await scoped(turn('q1', { status: 'queued' }));
    await query(`INSERT INTO ${table('retired_identity')} (scope, kind, identity) VALUES ($1, 'intent', $2), ($1, 'row', $3)`,
      [storedKey(scope), hash('q1'), hash(['turn', 'q1'])]);
    await sync(scope);
    const state: CollaborationState = await store().read(scope);
    expect(state.turns.q1).toMatchObject({ status: 'failed', conclusion: 'failed', reported: true });
    expect(state.audit).toContain('Turn result retired before sync: q1');
    const [report] = await query<{ body: { reason?: string } }>(`SELECT body FROM ${table('outbox')} WHERE scope = $1 AND key = $2`,
      [storedKey(scope), storedKey('bot-turn:q1')]);
    expect(report?.body).toMatchObject({ conclusion: 'failed', reason: 'result_retired' });
    expect(await intentRows(scope)).toEqual([]);
  });

  it('compacts nothing on a scope with no row, and writes nothing', async () => {
    const scope = `tenant:${randomUUID()}`;
    expect(await compact(scope, [])).toEqual({ compactedIntents: 0, alreadyCompactedIntents: 0 });
    await expect(compact(scope, ['k1'])).rejects.toThrow('Acknowledged intent not found');
    expect(await query(`SELECT 1 FROM ${table('scope')} WHERE scope = $1`, [storedKey(scope)])).toEqual([]);
  });
});
