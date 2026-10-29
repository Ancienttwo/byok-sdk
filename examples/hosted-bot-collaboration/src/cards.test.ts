import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrozenInput } from '@byok-sdk/server/execution-core';
import { CONNECTOR_OUTCOME_UNKNOWN } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { cardCallVectors, seedCollaboration, SYNC_OPTIONS, VECTOR_NOW, type CardCallSubject, type SyncIntentRecord } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { vectorClock } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedOutboxSender, type CardConnector, type SenderOptions } from './sender';
import { cardRowKey } from './store';

// #793 S12: the connector call of a confirmed card, through the H outbox sender.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;
type CardRow = { next_at: string; tries: number; settled_at: string | null };

describe.skipIf(POSTGRES_URL === undefined)('H card calls on real Postgres (#793 S12)', () => {
  // One schema for each test, because a sender pass covers the whole schema.
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  let clock = VECTOR_NOW;
  beforeEach(() => { clock = VECTOR_NOW; });
  const sender = (options: Partial<SenderOptions> = {}) => new HostedOutboxSender(opened!.pool, store(), { projections: { deliver: async () => {} },
    now: () => clock, leaseMs: 20_000, sendTimeoutMs: 10_000, connectorTimeoutMs: 10_000, backoffMs: 5_000, ...options });

  /**
   * The H card subject in a new scope: `sync` is `store.sync` at a given time, and `callCards` is one sender pass with
   * `connector`, as L's `flushCards`.
   */
  async function cardSubject(): Promise<CardCallSubject> {
    const scope = `tenant:${randomUUID()}`, pool = opened!.pool;
    await store().seed(scope, state => seedCollaboration(state));
    await store().bindDevice(scope, 'device');
    return {
      scope,
      commit: request => store().commit(scope, request, vectorClock),
      stored: () => store().dump(scope),
      state: () => store().read(scope),
      change: edit => store().seed(scope, edit),
      sync: async now => { await store().sync(scope, { ...SYNC_OPTIONS, now, history: undefined }); },
      intent: async turnId => {
        const row = (await pool.query<{ key: string; source: SyncIntentRecord['source']; input: FrozenInput; wait_until: string }>(
          `SELECT key, source, input, wait_until::text FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId)])).rows[0];
        if (!row) return undefined;
        const { taskId: _, ...execution } = row.input;
        return { key: JSON.parse(row.key) as string, source: row.source, waitUntil: Number(row.wait_until), execution };
      },
      concludeIntent: async (turnId, conclusion) => {
        await pool.query(`UPDATE ${table('intent')} SET conclusion = $3 WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId), conclusion]);
      },
      projection: async id => (await pool.query<{ body: never }>(`SELECT body FROM ${table('outbox')} WHERE scope = $1 AND key = $2 AND kind = 'projection'`,
        [storedKey(scope), storedKey(id)])).rows.map(row => row.body),
      callCards: async connector => { await sender({ connector }).run(); },
    };
  }

  cardCallVectors('H HostedCollaborationStore on Postgres', cardSubject);

  /** A scope whose card `c1` was confirmed by a command, so its card row exists. */
  async function confirmed() {
    const subject = await cardSubject();
    await subject.change(state => {
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      state.cards.c1!.expiresAt = VECTOR_NOW + 60_000;
    });
    await subject.commit({ scope: subject.scope, commandId: 'decide', command: { kind: 'decide', cardId: 'c1', decision: 'confirmed' } });
    const row = async () => (await opened!.pool.query<CardRow>(`SELECT next_at::text, tries, settled_at::text FROM ${table('outbox')}
      WHERE scope = $1 AND key = $2 AND kind = 'card'`, [storedKey(subject.scope), cardRowKey('c1')])).rows;
    const card = async () => (await subject.state()).cards.c1!;
    return { subject, row, card };
  }

  it('indexes a confirmed card with a due card row, claims it before the call, and settles it with the card', async () => {
    const h = await confirmed();
    expect(await h.row()).toEqual([{ next_at: '0', tries: 0, settled_at: null }]);
    let during: CardRow[] | undefined;
    const changed: string[] = [];
    await sender({ connector: async () => { during = await h.row(); return { sent: true }; }, changed: scope => { changed.push(scope); } }).run();
    expect(during).toEqual([{ next_at: String(VECTOR_NOW + 20_000), tries: 1, settled_at: null }]);
    expect(await h.row()).toEqual([{ next_at: String(VECTOR_NOW + 20_000), tries: 1, settled_at: String(VECTOR_NOW) }]);
    expect(changed).toEqual([h.subject.scope]);
  });

  it('indexes no row for a pending or rejected card', async () => {
    const subject = await cardSubject();
    await subject.commit({ scope: subject.scope, commandId: 'decide', command: { kind: 'decide', cardId: 'c1', decision: 'rejected' } });
    expect((await opened!.pool.query(`SELECT 1 FROM ${table('outbox')} WHERE kind = 'card'`)).rows).toEqual([]);
  });

  it('calls once when two senders run on one card: the lease holds the second', async () => {
    const h = await confirmed();
    let release!: () => void, calls = 0;
    const slow: CardConnector = () => { calls++; return new Promise(resolve => { release = () => resolve({ sent: true }); }); };
    const first = sender({ connector: slow }).run();
    await expect.poll(() => calls).toBe(1);
    expect(await sender({ connector: slow }).run()).toEqual({ steps: 0, failed: [] });
    release();
    expect(await first).toEqual({ steps: 1, failed: [] });
    expect(calls).toBe(1);
    expect(await h.card()).toMatchObject({ result: { sent: true }, conclusion: 'succeeded' });
  });

  it('ends the card as a timeout when the connector outlasts connectorTimeoutMs, and aborts its signal', async () => {
    const h = await confirmed();
    let signal: AbortSignal | undefined;
    await sender({ connectorTimeoutMs: 20, connector: (_id, _action, _draft, given) => { signal = given; return new Promise(() => {}); } }).run();
    expect(signal?.aborted).toBe(true);
    expect(await h.card()).toMatchObject({ error: CONNECTOR_OUTCOME_UNKNOWN, conclusion: 'failed' });
  });

  it('ends the card as a timeout, with no call, when an earlier claim\'s lease passed with no settle (owner Q3 A)', async () => {
    const h = await confirmed();
    // The state after a crash between the claim and the settle: the claim committed, the settle never ran.
    await opened!.pool.query(`UPDATE ${table('outbox')} SET tries = 1, next_at = $3 WHERE scope = $1 AND key = $2`,
      [storedKey(h.subject.scope), cardRowKey('c1'), VECTOR_NOW + 20_000]);
    let calls = 0;
    const connector: CardConnector = async () => { calls++; return {}; };
    expect(await sender({ connector }).run()).toEqual({ steps: 0, failed: [] });
    clock = VECTOR_NOW + 20_000;
    const changed: string[] = [];
    expect(await sender({ connector, changed: scope => { changed.push(scope); } }).run()).toEqual({ steps: 1, failed: [] });
    expect(calls).toBe(0);
    expect(await h.card()).toMatchObject({ error: CONNECTOR_OUTCOME_UNKNOWN, conclusion: 'failed' });
    expect(await h.row()).toEqual([{ next_at: String(VECTOR_NOW + 40_000), tries: 2, settled_at: String(VECTOR_NOW + 20_000) }]);
    expect(changed).toEqual([h.subject.scope]);
  });

  it('ignores the settle of a claim that another sender ended after its lease', async () => {
    const h = await confirmed();
    let release!: () => void, calls = 0;
    const slow: CardConnector = () => { calls++; return new Promise(resolve => { release = () => resolve({ sent: true }); }); };
    const first = sender({ connector: slow }).run();
    await expect.poll(() => calls).toBe(1);
    clock = VECTOR_NOW + 20_000;
    await sender({ connector: slow }).run();
    expect(await h.card()).toMatchObject({ error: CONNECTOR_OUTCOME_UNKNOWN });
    release();
    await first;
    expect(calls).toBe(1);
    expect(await h.card()).toMatchObject({ error: CONNECTOR_OUTCOME_UNKNOWN, conclusion: 'failed' });
    expect(await h.card()).not.toHaveProperty('result');
  });

  it('fails a card row in a Host with no connector, and waits backoffMs before it looks again', async () => {
    const h = await confirmed();
    const pass = await sender().run();
    expect(pass.failed).toEqual([{ scope: h.subject.scope, id: ['card', 'c1'], error: new Error('The Host has no connector for a card call') }]);
    expect(await h.row()).toEqual([{ next_at: String(VECTOR_NOW + 5_000), tries: 0, settled_at: null }]);
  });

  it('settles the row of a card that is gone, with no call', async () => {
    const h = await confirmed();
    await store().seed(h.subject.scope, state => { delete state.cards.c1; });
    let calls = 0;
    expect(await sender({ connector: async () => { calls++; return {}; } }).run()).toEqual({ steps: 0, failed: [] });
    expect(calls).toBe(0);
    expect(await h.row()).toEqual([{ next_at: '0', tries: 0, settled_at: String(VECTOR_NOW) }]);
  });

  it('refuses a connector timeout that is not a positive integer, and, with a connector, a lease that is not longer', () => {
    const connector: CardConnector = async () => ({});
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => sender({ connectorTimeoutMs: bad })).toThrow('The outbox lease must be longer than the connector timeout');
    expect(() => sender({ connector, connectorTimeoutMs: 20_000 })).toThrow('The outbox lease must be longer than the connector timeout');
    expect(() => sender({ connector, connectorTimeoutMs: 19_999 })).not.toThrow();
    expect(() => sender({ connectorTimeoutMs: 20_000 })).not.toThrow();
  });
});
