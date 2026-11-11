import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { hash, taskId } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { type CollaborationState, type DelegationCancelResult, DelegationError, type TurnCancelResult } from '@byok-sdk/bot-collaboration/host-kit';
import { seedCollaboration, SYNC_OPTIONS, VECTOR_NOW } from '@byok-sdk/bot-collaboration/testing';
import { DeviceBindingError } from './binding';
import { EntryRefusedError, HostedCommandEntry, UnauthenticatedError, type EntryCaller } from './entry';
import { storedKey } from './layout';
import { TEST_HOST } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedCollaborationStore } from './store';

// #793 S10: the authenticated product command entry, L's owner API for requests.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const OWNER = { id: 'owner', kind: 'human' } as const;
/** The seed of a scope: the vector team, card `c1` that stays pending, and room `r1` with the Main Bot as its one member. */
const seed = (state: CollaborationState) => {
  seedCollaboration(state);
  state.cards.c1!.expiresAt = Number.MAX_SAFE_INTEGER;
  state.team.rooms.r1 = { id: 'r1', name: 'R', members: ['main'], mode: 'mention', announcement: '', admin: 'main', visibleFrom: {}, messages: [] };
};

/**
 * A new scope, its Main Bot's device bound unless `bound` is false, and an entry whose credential is the caller itself. With
 * `coalesce`, the entry's store coalesces owner inputs in a 10 s window.
 */
async function scoped(bound = true, coalesce = false) {
  const scope = `tenant:${randomUUID()}`, synced: string[] = [];
  const target = coalesce ? new HostedCollaborationStore(opened!.pool, store().schema, { host: TEST_HOST, coalesce: { windowMs: 10_000, maxItems: 8, maxBytes: 8192 } }) : store();
  await store().seed(scope, seed);
  if (bound) await store().bindDevice(scope, 'device');
  const entry = new HostedCommandEntry<EntryCaller | undefined | 'throw'>(target, {
    authenticate: async credential => { if (credential === 'throw') throw new Error('session store down'); return credential; },
    owner: async () => 'owner',
    sync: async (at, now) => { synced.push(at); return target.sync(at, { ...SYNC_OPTIONS, now, history: undefined }); },
    now: () => VECTOR_NOW,
  });
  const as = (principal: EntryCaller['principal'] = OWNER): EntryCaller => ({ scope, principal });
  const commandKeys = async () => (await opened!.pool.query<{ key: string }>(`SELECT key FROM "${store().schema}".command WHERE scope = $1 ORDER BY key`,
    [storedKey(scope)])).rows.map(row => JSON.parse(row.key) as string);
  return { scope, entry, as, synced, commandKeys };
}

/** A scope where the Main Bot's owner Turn delegated to Bot `b` on the same device, and a sync froze B's request Turn. */
async function delegated() {
  const scope = await scoped();
  await store().seed(scope.scope, state => { state.team.bots.b = { ...state.team.bots.main!, id: 'b', name: 'B', role: 'Reviewer', mainBot: false, execution: template('device', 'b') }; });
  const root = await scope.entry.input(scope.as(), 'main', 'r1', 'Ask b');
  const evidence = { terminal: { envelope: { task_id: taskId(root, 0), type: 'task.complete', payload: { document: { delegate: [{ to: 'b', request: 'Check' }] } } } } as unknown as DeviceTerminal,
    attempt: { taskId: taskId(root, 0) } as unknown as TaskAttempt };
  await store().finish(scope.scope, root, evidence, () => VECTOR_NOW);
  await store().sync(scope.scope, { ...SYNC_OPTIONS, now: VECTOR_NOW, history: undefined });
  return { ...scope, id: hash([taskId(root, 0), 'delegate', 0]) };
}

describe.skipIf(POSTGRES_URL === undefined)('H authenticated command entry on real Postgres (#793 S10)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  it('commits owner input under L\'s command id, syncs the scope, and replays a retry with nothing written', async () => {
    const { scope, entry, as, synced, commandKeys } = await scoped();
    const id = await entry.input(as(), 'main', 'k1', 'Hello');
    expect(id).toBe(hash(['user', 'main', 'k1']));
    expect(await commandKeys()).toEqual([hash(['input', 'main', 'k1'])]);
    expect(synced).toEqual([scope]);
    // The sync froze the Turn's intent.
    const intent = await opened!.pool.query(`SELECT 1 FROM "${store().schema}".intent WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(id)]);
    expect(intent.rows).toHaveLength(1);
    const before = await store().dump(scope);
    expect(await entry.input(as(), 'main', 'k1', 'Hello')).toBe(id);
    expect(await store().dump(scope)).toBe(before);
  });

  it.each([['no session', undefined], ['a session check that throws', 'throw'], ['an empty scope', { scope: '', principal: OWNER }]] as const)(
    'refuses %s with UnauthenticatedError, and writes and syncs nothing', async (_name, credential) => {
      const { scope, entry, synced } = await scoped(), before = await store().dump(scope);
      await expect(entry.input(credential as never, 'main', 'k1', 'Hello')).rejects.toBeInstanceOf(UnauthenticatedError);
      expect(await store().dump(scope)).toBe(before);
      expect(synced).toEqual([]);
    });

  it('refuses a bot principal and a non-owner human on an owner command after their audit lines, and adds no Turn', async () => {
    const { scope, entry, as, synced } = await scoped();
    await expect(entry.input(as({ id: 'own-bot', kind: 'bot' }), 'main', 'k1', 'Hello')).rejects.toMatchObject({ code: 'not_owner' });
    await expect(entry.cancelTurn(as({ id: 'mallory', kind: 'human' }), 't1')).rejects.toBeInstanceOf(EntryRefusedError);
    const state = await store().read(scope);
    expect(state.audit).toEqual(['Action refused not_owner: input main bot:own-bot', 'Action refused not_owner: cancelTurn t1 human:mallory']);
    expect(Object.keys(state.turns)).toEqual(['t1']);
    expect(synced).toEqual([]);
  });

  it('lets the owner switch a Bot to auto with a bot-autonomy projection, and refuses a non-owner with an audit line (#1229)', async () => {
    const { scope, entry, as } = await scoped();
    await entry.setBotAutonomy(as(), 'main', 'observe');
    await entry.setBotAutonomy(as(), 'main', 'auto');
    expect((await store().read(scope)).team.bots.main!.autonomy).toBe('auto');
    const keys = (await opened!.pool.query<{ key: string }>(`SELECT key FROM "${store().schema}".outbox WHERE scope = $1`, [storedKey(scope)])).rows.map(r => JSON.parse(r.key) as string);
    expect(keys.filter(key => key.startsWith('bot-autonomy:main:'))).toHaveLength(2);
    const before = await store().dump(scope);
    await expect(entry.setBotAutonomy(as({ id: 'mallory', kind: 'human' }), 'main', 'observe')).rejects.toMatchObject({ code: 'not_owner' });
    const state = await store().read(scope);
    expect(state.audit).toEqual(['Action refused not_owner: setBotAutonomy main human:mallory']);
    expect(state.team.bots.main!.autonomy).toBe('auto');
    expect(before).not.toBe(await store().dump(scope));
  });

  it('refuses an unverified principal after its audit line', async () => {
    const { scope, entry, as } = await scoped();
    await expect(entry.roomInput(as({ id: '', kind: 'human' }), 'r1', 'k1', 'Hi')).rejects.toMatchObject({ code: 'unverified_sender',
      message: 'unverified_sender: roomInput needs a verified principal' });
    expect((await store().read(scope)).audit).toEqual(['Action refused unverified_sender: roomInput r1']);
  });

  it('takes room input from a verified human with its mentions, and from a bot principal with none (R5)', async () => {
    const { scope, entry, as } = await scoped();
    const human = await entry.roomInput(as({ id: 'alice', kind: 'human' }), 'r1', 'k1', 'Main?', ['main']);
    expect(human).toBe(hash(['room-input', 'r1', 'k1']));
    const bot = await entry.roomInput(as({ id: 'own-bot', kind: 'bot' }), 'r1', 'k2', 'Background', ['main']);
    const team = (await store().read(scope)).team;
    expect(team.rounds[human]!.seats).toHaveLength(1);
    expect(team.rounds[bot]!.seats).toEqual([]);
    expect(team.rooms.r1!.messages.map(row => row.from)).toEqual(['alice', 'own-bot']);
  });

  it.each([['unbound', false], ['revoked', true]] as const)(
    'rolls back a commit that adds a Turn or a seat for a Bot whose device is %s, and syncs nothing', async (reason, bound) => {
      const { scope, entry, as, synced } = await scoped(bound);
      if (reason === 'revoked') await store().revokeDevice(scope, 'device', VECTOR_NOW);
      const before = await store().dump(scope);
      await expect(entry.input(as(), 'main', 'k1', 'Hello')).rejects.toMatchObject({ name: DeviceBindingError.name, reason });
      await expect(entry.roomInput(as(), 'r1', 'k1', 'Main?', ['main'])).rejects.toBeInstanceOf(DeviceBindingError);
      expect(await store().dump(scope)).toBe(before);
      expect(synced).toEqual([]);
      // An answer adds a Turn too. A command that adds none commits, and the sync after it holds the seeded Turn `t1` of that
      // Bot (#956) instead of stopping the scope.
      await expect(entry.answer(as(), 'q1', 'Yes')).rejects.toBeInstanceOf(DeviceBindingError);
      await entry.setMainBot(as(), 'main', true);
      expect((await store().read(scope)).turns.t1).toMatchObject({ held: 'device_not_bound' });
      expect((await store().read(scope)).revision).toBe(1);
      expect(synced).toEqual([scope]);
    });

  it('refuses an input that joins an open batch of a Bot whose device was revoked, and writes nothing', async () => {
    const { scope, entry, as } = await scoped(true, true);
    const batch = await entry.input(as(), 'main', 'k1', 'First');
    expect((await store().read(scope)).inputBatches?.[batch]).toMatchObject({ state: 'open', inputIds: [expect.any(String)] });
    await store().revokeDevice(scope, 'device', VECTOR_NOW);
    const before = await store().dump(scope);
    await expect(entry.input(as(), 'main', 'k2', 'Second')).rejects.toMatchObject({ name: DeviceBindingError.name, reason: 'revoked' });
    expect(await store().dump(scope)).toBe(before);
  });

  it('cancels an open batch of a Bot whose device was revoked: the Turn that the cancel seals is concluded, so it needs no device', async () => {
    const { scope, entry, as } = await scoped(true, true);
    const batch = await entry.input(as(), 'main', 'k1', 'First');
    const inputId = (await store().read(scope)).inputBatches![batch]!.inputIds[0]!;
    await store().revokeDevice(scope, 'device', VECTOR_NOW);
    await entry.cancelTurn(as(), inputId);
    const state = await store().read(scope);
    expect(state.inputBatches![batch]).toMatchObject({ state: 'sealed', sealReason: 'cancel' });
    expect(Object.values(state.turns).filter(turn => turn.id !== 't1')).toEqual([expect.objectContaining({ status: 'failed', conclusion: 'cancelled' })]);
  });

  it('answers a repeated delegation cancel as L does: one commit, then cancel_pending and already_settled with nothing written', async () => {
    const { scope, entry, as, id } = await delegated();
    const intent = () => opened!.pool.query<{ cancel_reason: string | null; conclusion: string | null; tries: number }>(
      `SELECT cancel_reason, conclusion, tries FROM "${store().schema}".intent WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(id)]).then(r => r.rows[0]);
    // A tried intent keeps its cancel reason until its terminal, so the cancel stays pending.
    await opened!.pool.query(`UPDATE "${store().schema}".intent SET submission = 'uncertain', tries = 1 WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(id)]);
    await expect(entry.cancelDelegation(as(), id)).resolves.toEqual({ delegationId: id, result: 'cancelled' });
    const committed = await store().dump(scope), row = await intent();
    expect(row).toMatchObject({ cancel_reason: 'cancelled' });
    await expect(entry.cancelDelegation(as(), id)).resolves.toEqual({ delegationId: id, result: 'cancel_pending' });
    expect(await store().dump(scope)).toBe(committed);
    expect(await intent()).toEqual(row);
    await opened!.pool.query(`UPDATE "${store().schema}".intent SET conclusion = 'cancelled' WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(id)]);
    await store().sync(scope, { ...SYNC_OPTIONS, now: VECTOR_NOW, history: undefined });
    const settled = await store().dump(scope);
    await expect(entry.cancelDelegation(as(), id)).resolves.toEqual({ delegationId: id, result: 'already_settled', verdict: 'cancelled' });
    expect(await store().dump(scope)).toBe(settled);
  });

  it('refuses a delegation cancel with a DelegationError code, and writes nothing', async () => {
    const { scope, entry, as, id } = await delegated();
    await store().seed(scope, state => { state.delegations[id]!.status = 'reply_held'; });
    const before = await store().dump(scope);
    await expect(entry.cancelDelegation(as(), id)).rejects.toMatchObject({ name: 'DelegationError', key: id, code: 'not_cancellable' });
    await expect(entry.cancelDelegation(as(), 'missing')).rejects.toBeInstanceOf(DelegationError);
    await expect(entry.cancelDelegation(as(), 'missing')).rejects.toMatchObject({ key: 'missing', code: 'unknown_delegation' });
    expect(await store().dump(scope)).toBe(before);
  });

  it('answers a repeated Turn cancel: cancelled once, then already_settled with the conclusion and nothing written', async () => {
    const { scope, entry, as, synced } = await scoped();
    const id = await entry.input(as(), 'main', 'k1', 'Hello');
    await expect(entry.cancelTurn(as(), id)).resolves.toEqual({ turnId: id, result: 'cancelled' });
    const before = await store().dump(scope), syncs = synced.length;
    await expect(entry.cancelTurn(as(), id)).resolves.toEqual({ turnId: id, result: 'already_settled', conclusion: 'cancelled' });
    expect(await store().dump(scope)).toBe(before);
    expect(synced).toHaveLength(syncs);
  });

  it('returns the results of L as types, and offers the four owner actions', () => {
    type Entry = HostedCommandEntry<unknown>;
    expectTypeOf<Awaited<ReturnType<Entry['cancelTurn']>>>().toEqualTypeOf<TurnCancelResult>();
    expectTypeOf<Awaited<ReturnType<Entry['cancelDelegation']>>>().toEqualTypeOf<DelegationCancelResult>();
    expectTypeOf<Pick<Entry, 'setBotAutonomy' | 'cancelTurn' | 'cancelDelegation' | 'abandonDelegation'>>().not.toBeNever();
  });

  it('throws another decision for a decided card after the sync, as L', async () => {
    const { scope, entry, as, synced } = await scoped();
    await entry.decide(as(), 'c1', 'rejected');
    expect((await store().read(scope)).cards.c1).toMatchObject({ state: 'rejected' });
    await expect(entry.decide(as(), 'c1', 'confirmed')).rejects.toThrow();
    expect(synced).toEqual([scope, scope]);
    expect((await store().read(scope)).cards.c1).toMatchObject({ state: 'rejected' });
  });

  it('runs keyless owner commands with a new command id at each call', async () => {
    const { scope, entry, as, commandKeys } = await scoped();
    await entry.setMainBot(as(), 'main', true);
    await entry.setMainBot(as(), 'main', true);
    expect(await commandKeys()).toEqual([]);
    expect((await store().read(scope)).revision).toBe(2);
  });
});
