import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { seedCollaboration, SYNC_OPTIONS, VECTOR_NOW } from '@byok-sdk/example-bot-collaboration/test-support';
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
    owner: () => 'owner',
    sync: async (at, now) => { synced.push(at); return target.sync(at, { ...SYNC_OPTIONS, now, history: undefined }); },
    now: () => VECTOR_NOW,
  });
  const as = (principal: EntryCaller['principal'] = OWNER): EntryCaller => ({ scope, principal });
  const commandKeys = async () => (await opened!.pool.query<{ key: string }>(`SELECT key FROM "${store().schema}".command WHERE scope = $1 ORDER BY key`,
    [storedKey(scope)])).rows.map(row => JSON.parse(row.key) as string);
  return { scope, entry, as, synced, commandKeys };
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
      // An answer adds a Turn too. A command that adds none commits; the sync after it still stops at the seeded Turn `t1` of
      // that Bot, the whole-scope stall that README Device binding describes (§55a), and its error reaches the caller, as L's pass.
      await expect(entry.answer(as(), 'q1', 'Yes')).rejects.toBeInstanceOf(DeviceBindingError);
      await expect(entry.setMainBot(as(), 'main', true)).rejects.toBeInstanceOf(DeviceBindingError);
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
