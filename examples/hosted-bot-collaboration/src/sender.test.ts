import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '@byok-sdk/example-host-execution-core';
import { seedCollaboration } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedOutboxSender, type ProjectionPort, type SenderOptions } from './sender';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;
const query = <T extends object>(text: string, values: unknown[]) => opened!.pool.query<T>(text, values).then(found => found.rows);
const NOW = Date.UTC(2026, 0, 1);

/** A receiver that logs each call and settles it with `answer`. */
function receiver(answer: (id: string) => Promise<void> = async () => {}) {
  const calls: Array<{ scope: string; id: string; value: Json }> = [];
  const port: ProjectionPort = { deliver: async (scope, id, value) => { calls.push({ scope, id, value }); await answer(id); } };
  return { calls, port };
}
type OutboxRow = { next_at: string; tries: number; last_error: string | null; settled_at: string | null };

describe.skipIf(POSTGRES_URL === undefined)('H outbox sender on real Postgres (#793 D2b-out-2)', () => {
  // One schema for each test, because a pass covers the whole schema.
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  let clock = NOW;
  beforeEach(() => { clock = NOW; });
  const sender = (options: Partial<SenderOptions> & Pick<SenderOptions, 'projections'>) =>
    new HostedOutboxSender(opened!.pool, store(), { now: () => clock, leaseMs: 20_000, sendTimeoutMs: 10_000, backoffMs: 5_000, ...options });

  async function scoped(prefix = 'a'): Promise<string> {
    const scope = `tenant:${prefix}-${randomUUID()}`;
    await store().seed(scope, state => seedCollaboration(state));
    return scope;
  }
  /** A projection row as a commit writes it: the next ordinal of the scope, due now. */
  const project = (scope: string, id: string, value: Json) => query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, body)
    SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'projection', $3::json FROM ${table('outbox')} WHERE scope = $1`, [storedKey(scope), storedKey(id), JSON.stringify(value)]);
  const row = async (scope: string, id: string) => (await query<OutboxRow>(`SELECT next_at::text, tries, last_error, settled_at::text
    FROM ${table('outbox')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(id)]))[0];

  describe('outbox DDL (pending owner §54a)', () => {
    it('refuses tries or a last error on a delivery row, and a projection row with no body', async () => {
      const scope = await scoped();
      const insert = (kind: string, body: string | null, tries: number, error: string | null) => query(`INSERT INTO ${table('outbox')}
        (scope, key, ordinal, kind, body, tries, last_error) VALUES ($1, $2, 0, $3, $4::json, $5, $6)`, [storedKey(scope), storedKey(randomUUID()), kind, body, tries, error]);
      await expect(insert('delivery', null, 1, null)).rejects.toThrow('check constraint');
      await expect(insert('delivery', null, 0, 'boom')).rejects.toThrow('check constraint');
      await expect(insert('projection', null, 0, null)).rejects.toThrow('check constraint');
      await expect(insert('delivery', null, 0, null)).resolves.toBeDefined();
    });
  });

  describe('projections', () => {
    it('sends a due projection once, and settles its row', async () => {
      const scope = await scoped(), to = receiver();
      await project(scope, 'bot-turn:t1', { status: 'done' });
      expect(await sender({ projections: to.port }).run()).toEqual({ steps: 1, failed: [] });
      expect(to.calls).toEqual([{ scope, id: 'bot-turn:t1', value: { status: 'done' } }]);
      expect(await row(scope, 'bot-turn:t1')).toEqual({ next_at: String(NOW + 20_000), tries: 1, last_error: null, settled_at: String(NOW) });
      clock += 60_000;
      expect(await sender({ projections: to.port }).run()).toEqual({ steps: 0, failed: [] });
      expect(to.calls).toHaveLength(1);
    });

    it('sends the same value again after a claim whose sender never settled it, once the lease passed', async () => {
      const scope = await scoped(), to = receiver();
      await project(scope, 'card:c1:pending', { state: 'pending' });
      // The state after a crash between the receiver call and the settle: the claim committed, the settle never ran.
      await query(`UPDATE ${table('outbox')} SET tries = 1, next_at = $2 WHERE scope = $1`, [storedKey(scope), NOW + 20_000]);
      expect(await sender({ projections: to.port }).run()).toEqual({ steps: 0, failed: [] });
      clock = NOW + 20_000;
      await sender({ projections: to.port }).run();
      expect(to.calls).toEqual([{ scope, id: 'card:c1:pending', value: { state: 'pending' } }]);
      expect(await row(scope, 'card:c1:pending')).toMatchObject({ tries: 2, settled_at: String(NOW + 20_000) });
    });

    it('ignores the settle of a claim that another sender took over after its lease', async () => {
      const scope = await scoped();
      await project(scope, 'bot-turn:t1', { status: 'done' });
      let release!: () => void;
      const slow = receiver(() => new Promise<void>(resolve => { release = resolve; }));
      const first = sender({ projections: slow.port }).run();
      await expect.poll(() => slow.calls.length).toBe(1);
      clock = NOW + 20_000;
      const second = receiver();
      expect(await sender({ projections: second.port }).run()).toEqual({ steps: 1, failed: [] });
      expect(await row(scope, 'bot-turn:t1')).toMatchObject({ tries: 2, settled_at: String(NOW + 20_000) });
      clock = NOW + 30_000;
      release();
      expect(await first).toEqual({ steps: 1, failed: [] });
      expect(await row(scope, 'bot-turn:t1')).toEqual({ next_at: String(NOW + 40_000), tries: 2, last_error: null, settled_at: String(NOW + 20_000) });
    });

    it('keeps a projection whose receiver throws, with its error, and sends it again after the backoff', async () => {
      const scope = await scoped();
      await project(scope, 'bot-turn:t1', { status: 'done' });
      const broken = receiver(async () => { throw new Error('receiver down'); });
      const pass = await sender({ projections: broken.port }).run();
      expect(pass).toMatchObject({ steps: 1, failed: [{ scope, id: 'bot-turn:t1' }] });
      expect(await row(scope, 'bot-turn:t1')).toEqual({ next_at: String(NOW + 5_000), tries: 1, last_error: 'receiver down', settled_at: null });
      clock = NOW + 4_999;
      expect(await sender({ projections: broken.port }).run()).toEqual({ steps: 0, failed: [] });
      clock = NOW + 5_000;
      const to = receiver();
      await sender({ projections: to.port }).run();
      expect(await row(scope, 'bot-turn:t1')).toEqual({ next_at: String(NOW + 25_000), tries: 2, last_error: null, settled_at: String(NOW + 5_000) });
    });

    it('makes one claim when two senders race on one row', async () => {
      const scope = await scoped(), to = receiver();
      await project(scope, 'bot-turn:t1', { status: 'done' });
      const passes = await Promise.all([sender({ projections: to.port }).run(), sender({ projections: to.port }).run()]);
      expect(to.calls).toHaveLength(1);
      expect(passes.map(pass => pass.steps).sort()).toEqual([0, 1]);
    });

    it('sends the rows of a scope in insertion order, and a failed row does not stop the later rows', async () => {
      const scope = await scoped();
      for (const id of ['p1', 'p2', 'p3']) await project(scope, id, { id });
      const to = receiver(async id => { if (id === 'p1') throw new Error('first fails'); });
      const pass = await sender({ projections: to.port }).run();
      expect(to.calls.map(call => call.id)).toEqual(['p1', 'p2', 'p3']);
      expect(pass).toMatchObject({ steps: 3, failed: [{ id: 'p1' }] });
    });

    it('leaves out a scope of an unknown store version before the batch limit', async () => {
      const [old, healthy] = [await scoped('a'), await scoped('b')];
      await project(old, 'p-old', { id: 'old' });
      await project(healthy, 'p-new', { id: 'new' });
      await query(`UPDATE ${table('scope')} SET state_version = 99 WHERE scope = $1`, [storedKey(old)]);
      const to = receiver();
      expect(await sender({ projections: to.port, batch: 1 }).run()).toEqual({ steps: 1, failed: [] });
      expect(to.calls.map(call => call.id)).toEqual(['p-new']);
    });

    it('refuses a lease that is not longer than the send timeout', () => {
      expect(() => sender({ projections: receiver().port, leaseMs: 10_000 })).toThrow('The outbox lease must be longer than the send timeout');
      expect(() => sender({ projections: receiver().port, leaseMs: 10_001 })).not.toThrow();
    });
  });
});
