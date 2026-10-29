import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash, MIN_TOMBSTONE_RETENTION_MS, taskId } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { stateOf, type CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { retainRoots } from '@byok-sdk/example-bot-collaboration/retention';
import { RETENTION_NOW, retentionVectors, type RetentionSubject } from '@byok-sdk/example-bot-collaboration/retention-vectors';
import { seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { freezeIntent } from './intents';
import { storedKey } from './layout';
import { vectorClock } from './memory-subject.test-support';
import { hostedMessageConsumer, type AgentMessageInput } from './messages';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { inSchema, lockScope } from './store';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;

/** One H retention subject per call: a new scope of the shared test schema, seeded like the memory subject. */
async function hosted(): Promise<RetentionSubject> {
  const scope = `tenant:${randomUUID()}`;
  await store().seed(scope, state => seedCollaboration(state));
  return {
    scope,
    commit: request => store().commit(scope, request, vectorClock),
    retain: (input, limits) => store().retain(scope, input, limits),
    change: edit => store().seed(scope, edit),
    stored: () => store().dump(scope),
    state: () => store().read(scope),
  };
}
const retention = (now = RETENTION_NOW, acknowledgedRoots: string[] = []) => ({ acknowledgedRoots, now, retentionMs: MIN_TOMBSTONE_RETENTION_MS });
const LIMITS = { contextTurnLimit: 1 };
const commands = async (scope: string) => (await opened!.pool.query<{ key: string }>(
  `SELECT key FROM ${table('command')} WHERE scope = $1 ORDER BY key`, [storedKey(scope)])).rows.map(row => JSON.parse(row.key) as string);

describe.skipIf(POSTGRES_URL === undefined)('H retention on real Postgres (#793 D2g)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  retentionVectors('H HostedCollaborationStore on Postgres', hosted);

  const execution = { ...template('device'), agentMessageContext: { destinationBinding: 'one' } };
  const consumer = () => hostedMessageConsumer(store(), { scopeOf: tenant => tenant, now: vectorClock });
  /** A scope whose Turn `turnId` has a frozen intent, and the SDK input of its first reply. */
  async function messaged(turnId: string) {
    const h = await hosted();
    await store().bindDevice(h.scope, 'device');
    await inSchema(opened!.pool, store().schema, async client => {
      await lockScope(client, storedKey(h.scope));
      await freezeIntent(client, h.scope, { key: turnId, source: 'user', execution, waitUntil: 60_000 });
    });
    const input = { tenant: h.scope, taskId: taskId(turnId, 0), deviceId: 'device', context: execution.agentMessageContext,
      payload: { agentRef: execution.payload.agentRef, messageId: 'one', contentHash: 'sha256:reply', body: 'Reply', contentType: 'text/markdown', byteCount: 5 },
    } as unknown as AgentMessageInput;
    return { h, input };
  }
  /** Settles `t1` of the seed and adds a newer settled root, so `t1` leaves the ContextPack window. */
  const settle = (state: CollaborationState) => {
    Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
    // The seed's question and card of t1 would keep it in the window as its Bot's newest ones.
    delete state.questions.q1; delete state.cards.c1;
    state.turns.r3 = { id: 'r3', root: 'r3', botId: 'main', source: 'user', request: 'r3', hop: 0, status: 'succeeded', conclusion: 'succeeded', reported: true, authority: 'owner' };
  };

  /** An accepted reply of `t1`, then a retention that moves `t1` with its reply and the message's command record. */
  async function acceptedAndRetained() {
    const { h, input } = await messaged('t1');
    expect(await consumer().consume(input)).toEqual({ outcome: 'accepted' });
    await h.change(settle);
    expect(await h.retain(retention(RETENTION_NOW, ['t1']), LIMITS)).toMatchObject({ archivedRoots: 1, archivedCommands: 1 });
    expect([(await h.state()).replies[input.taskId], await commands(h.scope)]).toEqual([undefined, []]);
    return { h, input };
  }
  /** A refused message (its Turn is not in the state), a retention that moves its record, and then its Turn added. */
  async function refusedAndRetained() {
    const { h, input } = await messaged('ghost');
    expect(await consumer().consume(input)).toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
    expect(await h.retain(retention(), LIMITS)).toMatchObject({ archivedCommands: 1 });
    expect(await commands(h.scope)).toEqual([]);
    await h.change(state => {
      state.turns.ghost = { id: 'ghost', root: 'ghost', botId: 'main', source: 'user', request: 'Late', hop: 0, status: 'processing', authority: 'owner' };
    });
    return { h, input };
  }

  it('(i) replays the stored disposition of a message from its moved command record (838-review L4)', async () => {
    const { h, input } = await refusedAndRetained(), stored = await h.stored();
    // The Turn exists now, so a new decision would accept: the refusal comes from the moved record.
    expect(await consumer().consume(input)).toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
    expect(await consumer().consume({ ...input, payload: { ...input.payload, contentHash: 'sha256:other' } }))
      .toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
    expect(await h.stored()).toBe(stored);
  });

  it('(ii) accepts an exact replay of an accepted message after its record expired, from the archived reply, with no commit', async () => {
    const { h, input } = await acceptedAndRetained();
    expect(await h.retain(retention(RETENTION_NOW + MIN_TOMBSTONE_RETENTION_MS), LIMITS)).toMatchObject({ expiredCommands: 1 });
    const stored = await h.stored();
    expect(await consumer().consume(input)).toEqual({ outcome: 'accepted' });
    expect(await h.stored()).toBe(stored);
  });

  it('(iii) decides a refused message again after its record expired, as L does', async () => {
    const { h, input } = await refusedAndRetained();
    expect(await h.retain(retention(RETENTION_NOW + MIN_TOMBSTONE_RETENTION_MS), LIMITS)).toMatchObject({ expiredCommands: 1 });
    expect(await consumer().consume(input)).toEqual({ outcome: 'accepted' });
    expect(await commands(h.scope)).toEqual([`${input.taskId}:one`]);
  });

  it('(iv) refuses another message for a task whose accepted reply retention moved: message_conflict', async () => {
    const { h, input } = await acceptedAndRetained(), stored = await h.stored();
    expect(await consumer().consume({ ...input, payload: { ...input.payload, messageId: 'two', contentHash: 'sha256:two' } }))
      .toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
    expect(await consumer().consume({ ...input, payload: { ...input.payload, contentHash: 'sha256:other' } }))
      .toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
    expect(await h.stored()).toBe(stored);
  });

  it('refuses a command id or a Turn id over the K4 row id limit, as L does, and writes nothing (847-review L1)', async () => {
    const h = await hosted(), long = 'x'.repeat(1025);
    let stored = await h.stored();
    await expect(h.commit({ scope: h.scope, commandId: long, command: { kind: 'input', botId: 'main', key: 'k1', request: 'Hello', sender: 'owner' } }))
      .rejects.toThrow('Invalid application row id');
    expect(await h.stored()).toBe(stored);
    expect(await h.retain(retention(), LIMITS)).toMatchObject({ archivedCommands: 0 });
    // The sync reads the tombstone of each Turn id, as K4 `isRetired` in the L sync.
    await h.change(state => {
      state.turns[long] = { id: long, root: long, botId: 'main', source: 'user', request: 'Long', hop: 0, status: 'queued', authority: 'owner' };
    });
    stored = await h.stored();
    await expect(store().sync(h.scope, { ...SYNC_OPTIONS, history: undefined })).rejects.toThrow('Invalid application row id');
    expect(await h.stored()).toBe(stored);
  });

  it('retains on a scope with no row as L retains on an empty ledger, and writes nothing (847-review L4)', async () => {
    const scope = `tenant:${randomUUID()}`;
    const empty = retainRoots(stateOf({}), retention(), LIMITS, { hasIntent: () => false, occurrenceOpen: () => false },
      { put: () => {}, expire: () => 0, retire: () => {}, isRetired: () => false });
    expect(empty).toMatchObject({ archivedRoots: 0, alreadyArchivedRoots: 0, archivedRows: 0, archivedCommands: 0, expiredCommands: 0 });
    expect(await store().retain(scope, retention(), LIMITS)).toEqual(empty);
    await expect(store().retain(scope, retention(RETENTION_NOW, ['r1']), LIMITS)).rejects.toThrow('Acknowledged root not found');
    expect((await opened!.pool.query(`SELECT 1 FROM ${table('scope')} WHERE scope = $1`, [storedKey(scope)])).rows).toEqual([]);
  });

  it('fails a queued Turn whose id retention retired, and freezes no intent for it, as the L sync does', async () => {
    const h = await hosted();
    await store().bindDevice(h.scope, 'device');
    await h.change(state => {
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'First', hop: 0, status: 'queued', authority: 'owner' };
    });
    await opened!.pool.query(`INSERT INTO ${table('retired_identity')} (scope, kind, identity) VALUES ($1, 'row', $2)`, [storedKey(h.scope), hash(['turn', 'q1'])]);
    await store().sync(h.scope, { ...SYNC_OPTIONS, history: undefined });
    expect((await h.state()).turns.q1).toMatchObject({ status: 'failed', conclusion: 'failed', reported: true });
    expect((await opened!.pool.query(`SELECT 1 FROM ${table('intent')} WHERE scope = $1`, [storedKey(h.scope)])).rows).toEqual([]);
  });
});
