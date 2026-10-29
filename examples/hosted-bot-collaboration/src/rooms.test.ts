import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FrozenInput } from '@byok-sdk/server/execution-core';
import { ROOM_GRACE_MS, roomVectors, seedCollaboration, seedRoom, SYNC_OPTIONS, VECTOR_NOW, type RoomSubject,
  type SyncIntentRecord } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { vectorClock } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';

// #793 S6: the K8 room step in the H sync, with the seat facts from the intent rows.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;

/** A new scope of the test schema, seeded like the L subject, whose Bots run on the bound device `device`. */
async function hostedRooms(): Promise<RoomSubject> {
  const scope = `tenant:${randomUUID()}`, pool = opened!.pool;
  await store().seed(scope, state => seedCollaboration(state));
  await store().bindDevice(scope, 'device');
  const set = (turnId: string, columns: string, values: unknown[] = []) =>
    pool.query(`UPDATE ${table('intent')} SET ${columns} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId), ...values]);
  const row = async (turnId: string) => (await pool.query<{ key: string; source: SyncIntentRecord['source']; input: FrozenInput; wait_until: string;
    cancel_reason: string | null }>(`SELECT key, source, input, wait_until::text, cancel_reason FROM ${table('intent')} WHERE scope = $1 AND key = $2`,
  [storedKey(scope), storedKey(turnId)])).rows[0];
  return {
    scope,
    commit: request => store().commit(scope, request, vectorClock),
    stored: () => store().dump(scope),
    state: () => store().read(scope),
    change: edit => store().seed(scope, edit),
    sync: async now => { await store().sync(scope, { ...SYNC_OPTIONS, now, history: undefined }); },
    intent: async turnId => {
      const found = await row(turnId);
      if (!found) return undefined;
      const { taskId: _, ...execution } = found.input;
      return { key: JSON.parse(found.key) as string, source: found.source, waitUntil: Number(found.wait_until), execution };
    },
    concludeIntent: async (turnId, conclusion) => { await set(turnId, 'conclusion = $3', [conclusion]); },
    projection: async id => (await pool.query<{ body: never }>(`SELECT body FROM ${table('outbox')} WHERE scope = $1 AND key = $2 AND kind = 'projection'`,
      [storedKey(scope), storedKey(id)])).rows.map(found => found.body),
    // The reconciliation's claim fact (D2d), which the seat facts read as `started`.
    claim: async turnId => { await set(turnId, `submission = 'delivered', tries = 1, started = true`); },
    cancelReason: async turnId => (await row(turnId))?.cancel_reason ?? undefined,
  };
}

describe.skipIf(POSTGRES_URL === undefined)('H room step (#793 S6)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  roomVectors('H HostedCollaborationStore on Postgres', hostedRooms);

  /** The room vectors' seed: one round whose first seat is `b`'s. */
  async function room() {
    const subject = await hostedRooms();
    await subject.change(seedRoom);
    const round = Object.values((await subject.state()).team.rounds)[0]!;
    const intent = async (turnId: string) => (await opened!.pool.query<{ tries: number; cancel_reason: string | null; conclusion: string | null }>(
      `SELECT tries, cancel_reason, conclusion FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(subject.scope), storedKey(turnId)])).rows[0];
    return { subject, first: round.seats[0]!, second: round.seats[1]!, intent };
  }

  it('concludes an untried cancelled seat intent in the same sync, as the L drain does after the cancel', async () => {
    const { subject, first, intent } = await room();
    await subject.sync(VECTOR_NOW);
    await subject.sync(VECTOR_NOW + ROOM_GRACE_MS);
    expect(await intent(first)).toEqual({ tries: 0, cancel_reason: 'cancelled', conclusion: 'cancelled' });
  });

  it('keeps a tried cancelled seat intent open with its cancel reason, for the reconciliation to check its attempt', async () => {
    const { subject, first, intent } = await room();
    await subject.sync(VECTOR_NOW);
    await opened!.pool.query(`UPDATE ${table('intent')} SET submission = 'uncertain', tries = 1 WHERE scope = $1 AND key = $2`,
      [storedKey(subject.scope), storedKey(first)]);
    await subject.sync(VECTOR_NOW + ROOM_GRACE_MS);
    expect(await intent(first)).toEqual({ tries: 1, cancel_reason: 'cancelled', conclusion: null });
  });

  it('runs the room step again when a Turn step releases a seat, so the next seat gets its Turn in the same sync', async () => {
    const { subject, first, second } = await room();
    // A room request over the current-request limit blocks each seat Turn in its Turn step, which releases the seat.
    await subject.change(state => { state.team.rooms.r!.messages[0]!.text = 'x'.repeat(70_000); });
    await subject.sync(VECTOR_NOW);
    const state = await subject.state();
    expect([state.team.seats[first], state.team.seats[second]]).toMatchObject([{ status: 'blocked', released: true }, { status: 'blocked', released: true }]);
    expect(Object.values(state.team.rounds)[0]).toMatchObject({ closed: true });
  });

  it('writes nothing when the room step throws', async () => {
    const { subject } = await room();
    // Seats whose round is gone: the seat facts load, then the rule throws.
    await subject.change(state => { state.team.rounds = {}; });
    const before = await subject.stored();
    await expect(subject.sync(VECTOR_NOW)).rejects.toThrow();
    expect(await subject.stored()).toBe(before);
  });
});
