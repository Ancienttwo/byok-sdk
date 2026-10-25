import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { DEVICE_NOT_BOUND } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { seedCollaboration, SYNC_OPTIONS, VECTOR_NOW } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedCollaborationStore } from './store';

// #956: H answers K8's `deviceRefusal` from its device bindings, so a Turn of a refused device waits and the scope syncs.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const table = (name: string) => `"${opened!.store.schema}".${name}`;
const SYNC = { ...SYNC_OPTIONS, history: undefined };
/** Model `default` runs on `other`, model `moved` on `device`. */
const MODELS = { default: template('other', 'main'), moved: template('device', 'main') };

describe.skipIf(POSTGRES_URL === undefined)('H device hold on real Postgres (#956)', () => {
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  const hostStore = () => new HostedCollaborationStore(opened!.pool, opened!.store.schema, { host: () => ({ models: MODELS, readOnlyToolsets: [] }) });
  const intents = async (scope: string) => (await opened!.pool.query<{ key: string }>(`SELECT key FROM ${table('intent')} WHERE scope = $1 ORDER BY ordinal`,
    [storedKey(scope)])).rows.map(row => JSON.parse(row.key) as string);
  const dueAt = async (scope: string) => (await opened!.pool.query<{ due_at: string | null }>(`SELECT due_at::text FROM ${table('scope')} WHERE scope = $1`,
    [storedKey(scope)])).rows[0]!.due_at;
  const queued = (state: CollaborationState, id: string, botId: string) => {
    state.turns[id] = { id, root: id, botId, source: 'user', request: 'Hello', hop: 0, status: 'queued', authority: 'owner' };
  };
  /**
   * The seeded Main Bot on `other`, which has no binding, and a ready Bot `b2` on `device`, which is bound. Each has one
   * queued Turn. `team` seeds an external team.
   */
  async function scoped(store: HostedCollaborationStore, team: 'local' | 'external' = 'local'): Promise<string> {
    const scope = `tenant:${randomUUID()}`;
    await store.seed(scope, state => {
      seedCollaboration(state, team);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      state.team.bots.main!.execution = template('other', 'main');
      state.team.bots.b2 = { ...structuredClone(state.team.bots.main!), id: 'b2', name: 'b2', role: 'Helper', mainBot: false,
        execution: template('device', 'b2') };
      queued(state, 'q1', 'main');
      queued(state, 'q2', 'b2');
    });
    await store.bindDevice(scope, 'device');
    return scope;
  }

  it('holds the Turn of the refused device and freezes the other Bot\'s Turn in the same sync', async () => {
    const store = hostStore(), scope = await scoped(store);
    await store.sync(scope, SYNC);
    const state = await store.read(scope);
    expect([state.turns.q1!.held, state.turns.q2!.held]).toEqual([DEVICE_NOT_BOUND, undefined]);
    expect(await intents(scope)).toEqual(['q2']);
    expect(state.audit).toEqual([`Turn held ${DEVICE_NOT_BOUND} unbound: q1`]);
    // A held Turn on a refused device adds no due time, so the scope does not spin.
    expect(await dueAt(scope)).toBeNull();
    await store.sync(scope, SYNC);
    expect((await store.read(scope)).audit).toHaveLength(1);
  });

  it('makes the scope due at once when the device is bound, and the next sync freezes the held Turn', async () => {
    const store = hostStore(), scope = await scoped(store);
    await store.sync(scope, SYNC);
    await store.bindDevice(scope, 'other');
    expect(await dueAt(scope)).toBe('0');
    // Another transaction of the scope keeps the wake, because the due time is a projection of the state and the bindings.
    await store.seed(scope, () => {});
    expect(await dueAt(scope)).toBe('0');
    await store.sync(scope, SYNC);
    expect((await store.read(scope)).turns.q1).not.toHaveProperty('held');
    expect(await intents(scope)).toEqual(['q2', 'q1']);
    expect(await dueAt(scope)).toBeNull();
  });

  it('makes the scope due at once when a team_snapshot archives the Bot of a held Turn, and the next sync ends it', async () => {
    const store = hostStore(), scope = await scoped(store, 'external');
    // b2 runs on the unbound device here. A snapshot keeps a Bot's device (K8 `updateBot`), so it releases a held Turn only
    // by archiving its Bot.
    await store.seed(scope, state => { state.team.bots.b2!.execution = template('other', 'b2'); state.team.bots.main!.execution = template('device', 'main'); });
    await store.sync(scope, SYNC);
    expect((await store.read(scope)).turns.q2!.held).toBe(DEVICE_NOT_BOUND);
    expect(await dueAt(scope)).toBeNull();
    const snapshot = { revision: 2, bots: [{ id: 'main', name: 'Main', role: 'Team owner', persona: '', model: 'default', mainBot: true }] };
    expect((await store.commit(scope, { scope, commandId: randomUUID(), command: { kind: 'team_snapshot', snapshot } }, () => VECTOR_NOW))
      .disposition.outcome).toBe('accepted');
    expect((await store.read(scope)).team.bots.b2!.archived).toBe(true);
    expect(await dueAt(scope)).toBe('0');
    await store.sync(scope, SYNC);
    expect((await store.read(scope)).turns.q2).toMatchObject({ status: 'failed', conclusion: 'cancelled' });
    expect(await dueAt(scope)).toBeNull();
  });
});
