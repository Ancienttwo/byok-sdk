import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { hash, MIN_TOMBSTONE_RETENTION_MS, taskId, type Json } from '@byok-sdk/example-host-execution-core';
import { inboundKey, type ChannelPort, type Delivery, type InboundMessage } from '@byok-sdk/example-bot-collaboration/channel';
import { enablePush, rememberInbound } from '@byok-sdk/example-bot-collaboration/delivery-routing';
import { RetentionRefused } from '@byok-sdk/example-bot-collaboration/retention';
import { seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { vectorPorts } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import type { TaskEvidence } from './reconcile';
import { HostedOutboxSender, type ProjectionPort, type SenderOptions } from './sender';
import { HostedCollaborationStore, type CommitPorts, type FinishPortsFactory } from './store';

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

    it('ignores the error of a claim that another sender took over while the new claim is still in flight', async () => {
      const scope = await scoped();
      await project(scope, 'bot-turn:t1', { status: 'done' });
      let fail!: () => void, finish!: () => void;
      const stale = receiver(() => new Promise<void>((_, reject) => { fail = () => reject(new Error('stale receiver')); }));
      const first = sender({ projections: stale.port }).run();
      await expect.poll(() => stale.calls.length).toBe(1);
      clock = NOW + 20_000;
      const live = receiver(() => new Promise<void>(resolve => { finish = resolve; }));
      const second = sender({ projections: live.port }).run();
      await expect.poll(() => live.calls.length).toBe(1);
      clock = NOW + 30_000;
      fail();
      expect(await first).toMatchObject({ steps: 1, failed: [{ scope, id: 'bot-turn:t1' }] });
      // The row is the live claim's: its lease and no error.
      expect(await row(scope, 'bot-turn:t1')).toEqual({ next_at: String(NOW + 40_000), tries: 2, last_error: null, settled_at: null });
      finish();
      expect(await second).toEqual({ steps: 1, failed: [] });
      expect(await row(scope, 'bot-turn:t1')).toEqual({ next_at: String(NOW + 40_000), tries: 2, last_error: null, settled_at: String(NOW + 30_000) });
    });

    it('ignores the success of a claim that another sender took over while the new claim is still in flight', async () => {
      const scope = await scoped();
      await project(scope, 'bot-turn:t1', { status: 'done' });
      let finish!: () => void, fail!: () => void;
      const stale = receiver(() => new Promise<void>(resolve => { finish = resolve; }));
      const first = sender({ projections: stale.port }).run();
      await expect.poll(() => stale.calls.length).toBe(1);
      clock = NOW + 20_000;
      const live = receiver(() => new Promise<void>((_, reject) => { fail = () => reject(new Error('live receiver')); }));
      const second = sender({ projections: live.port }).run();
      await expect.poll(() => live.calls.length).toBe(1);
      clock = NOW + 30_000;
      finish();
      expect(await first).toEqual({ steps: 1, failed: [] });
      expect(await row(scope, 'bot-turn:t1')).toEqual({ next_at: String(NOW + 40_000), tries: 2, last_error: null, settled_at: null });
      // The live claim fails, so the row backs off and is sent again.
      fail();
      expect(await second).toMatchObject({ steps: 1, failed: [{ scope, id: 'bot-turn:t1' }] });
      expect(await row(scope, 'bot-turn:t1')).toEqual({ next_at: String(NOW + 35_000), tries: 2, last_error: 'live receiver', settled_at: null });
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

  describe('deliveries', () => {
    const DIRECT = { kind: 'direct', id: 'main' } as const;
    const channel = (calls: string[] = []): ChannelPort => ({ send: async input => { calls.push(input.deliveryId); return { result: 'accepted', platformMessageId: 'p' }; } });
    /** An accepted delivery of `t1`, whose Turn has settled and left the ContextPack window, so retention can move its root. */
    const settledDelivery = (state: Parameters<Parameters<HostedCollaborationStore['seed']>[1]>[0]) => {
      seedCollaboration(state);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      delete state.questions.q1; delete state.cards.c1;
      state.turns.r3 = { id: 'r3', root: 'r3', botId: 'main', source: 'user', request: 'r3', hop: 0, status: 'succeeded', conclusion: 'succeeded', reported: true, authority: 'owner' };
      const row: Delivery = { id: 'd1', taskId: taskId('t1', 0), turnId: 't1', messageId: 'm1', body: 'b', conversation: DIRECT, channel: 'fake',
        route: { kind: 'push', pushRouteId: 'p' }, state: 'accepted', attempts: 1, platformMessageId: 'p1' };
      state.channel = { inbounds: {}, pushRoutes: {}, deliveries: { d1: row } };
    };
    // A seed writes no outbox row, so these tests add the delivery index row by hand.
    const indexRow = (scope: string, id: string, settledAt: number | null) => query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, settled_at)
      SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'delivery', $3 FROM ${table('outbox')} WHERE scope = $1`, [storedKey(scope), storedKey(id), settledAt]);
    const retain = (scope: string) => store().retain(scope, { acknowledgedRoots: ['t1'], now: NOW, retentionMs: MIN_TOMBSTONE_RETENTION_MS }, { contextTurnLimit: 1 });

    it('refuses to retain a root while a delivery outbox row of it is unsettled (E7), and moves it once the row settled', async () => {
      const scope = `tenant:${randomUUID()}`;
      await store().seed(scope, settledDelivery);
      await indexRow(scope, 'd1', null);
      const before = await store().dump(scope);
      const refusal = await retain(scope).then(() => undefined, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(RetentionRefused);
      expect(refusal).toMatchObject({ code: 'protected_root', root: 't1', message: 'Retention refused: A delivery outbox row of the root is not settled' });
      expect(await store().dump(scope)).toBe(before);
      await query(`UPDATE ${table('outbox')} SET settled_at = $2 WHERE scope = $1`, [storedKey(scope), NOW]);
      expect(await retain(scope)).toMatchObject({ archivedRoots: 1 });
      expect((await store().read(scope)).channel!.deliveries.d1).toBeUndefined();
    });

    it('settles a delivery row whose entity retention archived, and fails a row with no entity anywhere', async () => {
      const scope = `tenant:${randomUUID()}`;
      await store().seed(scope, settledDelivery);
      await indexRow(scope, 'd1', NOW);
      expect(await retain(scope)).toMatchObject({ archivedRoots: 1 });
      await query(`UPDATE ${table('outbox')} SET settled_at = NULL WHERE scope = $1`, [storedKey(scope)]);
      await indexRow(scope, 'ghost', null);
      const calls: string[] = [];
      clock = NOW + 1;
      const pass = await sender({ projections: receiver().port, channel: channel(calls) }).run();
      expect(pass).toMatchObject({ steps: 1, failed: [{ scope, id: 'ghost', error: new Error('Delivery not found') }] });
      expect(calls).toEqual([]);
      expect(await row(scope, 'd1')).toMatchObject({ settled_at: String(NOW + 1) });
      expect(await row(scope, 'ghost')).toMatchObject({ settled_at: null, next_at: String(NOW + 1 + 5_000) });
    });

    const ports = (extra: Partial<CommitPorts> = {}): FinishPortsFactory => (state, publish) => ({ ...vectorPorts(state, publish), now: () => NOW, ...extra });
    const MESSAGE: InboundMessage = { channel: 'fake', platformMessageId: 'in1', conversation: DIRECT, sender: { id: 'owner', kind: 'human' }, text: 'Do it',
      mentions: [], replyRoute: { kind: 'reply', channel: 'fake', inboundId: 'in1', token: 'secret', expiresAt: NOW + 600_000 } };
    /** A channel store whose owner message `MESSAGE` has a Turn with a frozen intent, as the K8 receive command and a sync leave it. */
    async function received() {
      const channelStore = new HostedCollaborationStore(opened!.pool, store().schema, { channel: true });
      const scope = `tenant:${randomUUID()}`;
      await channelStore.seed(scope, state => seedCollaboration(state));
      await channelStore.bindDevice(scope, 'device');
      // A push route exists too: a view that missed a concluded intent, or saw a conclusion too early, would choose the other route.
      const unused = () => { throw new Error('Unused route port'); };
      await channelStore.commit(scope, { scope, commandId: randomUUID(), command: { kind: 'enable_push_route', conversation: DIRECT, channel: 'fake', target: 't', owner: 'owner' } },
        (state, publish) => ports({ routes: { enable: (conversation, name, target, owner) => enablePush(state, conversation, name, target, owner, NOW).id,
          revoke: unused, resend: unused } })(state, publish));
      const commit = await channelStore.commit(scope, { scope, commandId: hash(['receive', inboundKey(MESSAGE)]),
        command: { kind: 'receive', inbound: 'owner_input', key: inboundKey(MESSAGE), botId: 'main', request: MESSAGE.text, sender: 'owner' } },
      (state, publish) => ports({ remember: root => rememberInbound(state, MESSAGE, root) })(state, publish));
      const turnId = (commit.disposition as { value: string }).value;
      await channelStore.sync(scope, { ...SYNC_OPTIONS, now: NOW, history: undefined });
      return { channelStore, scope, turnId };
    }
    const TIMES = { leaseMs: 20_000, readback: false, readbackMs: 30_000 };
    /** Delivery `d1` of `turnId` on the push route, claimed with attempt 1, and its index row with the claim's lease. */
    async function claimed(channelStore: HostedCollaborationStore, scope: string, turnId: string) {
      await channelStore.seed(scope, state => {
        const push = Object.keys(state.channel!.pushRoutes)[0]!;
        state.channel!.deliveries.d1 = { id: 'd1', taskId: taskId(turnId, 0), turnId, messageId: 'm1', body: 'b', conversation: DIRECT, channel: 'fake',
          route: { kind: 'push', pushRouteId: push }, state: 'sending', attempts: 1 };
      });
      await indexRow(scope, 'd1', null);
      await query(`UPDATE ${table('outbox')} SET next_at = $3 WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey('d1'), NOW + TIMES.leaseMs]);
    }

    it('keeps a claimed delivery for a sender whose scan saw it due before the claim, until the claim lease passed (D1)', async () => {
      const { channelStore, scope, turnId } = await received();
      await claimed(channelStore, scope, turnId);
      expect(await channelStore.claimDelivery(scope, 'd1', NOW + TIMES.leaseMs - 1, TIMES)).toEqual({ kind: 'none' });
      expect((await channelStore.read(scope)).channel!.deliveries.d1).toMatchObject({ state: 'sending', attempts: 1 });
      expect(await row(scope, 'd1')).toMatchObject({ next_at: String(NOW + TIMES.leaseMs) });
      expect(await channelStore.claimDelivery(scope, 'd1', NOW + TIMES.leaseMs, TIMES)).toEqual({ kind: 'none' });
      expect((await channelStore.read(scope)).channel!.deliveries.d1).toMatchObject({ state: 'unknown', attempts: 1, code: 'interrupted' });
    });

    it('bounds a readback by the send deadline: a hung readback leaves the row unknown, waits readbackMs, and the pass goes on', async () => {
      const { channelStore, scope, turnId } = await received();
      await claimed(channelStore, scope, turnId);
      // The claim's lease has passed: it becomes unknown, due for a readback at once.
      clock = NOW + TIMES.leaseMs;
      expect(await channelStore.claimDelivery(scope, 'd1', clock, { ...TIMES, readback: true })).toEqual({ kind: 'none' });
      // A projection of another scope is due after it in the same pass.
      const other = await scoped('b');
      await project(other, 'bot-turn:t9', { status: 'done' });
      await query(`UPDATE ${table('outbox')} SET next_at = $2 WHERE scope = $1`, [storedKey(other), clock + 1]);
      clock += 1;
      const to = receiver(), hung: ChannelPort = { send: async () => { throw new Error('Unused send'); }, readback: () => new Promise(() => {}) };
      const pass = await sender({ projections: to.port, channel: hung, sendTimeoutMs: 50 }).run();
      expect(pass.failed).toEqual([{ scope, id: 'd1', error: expect.objectContaining({ message: 'send_timeout' }) }]);
      expect(to.calls.map(call => call.id)).toContain('bot-turn:t9');
      expect((await channelStore.read(scope)).channel!.deliveries.d1).toMatchObject({ state: 'unknown', attempts: 1, code: 'interrupted' });
      expect(await row(scope, 'd1')).toMatchObject({ next_at: String(clock + 30_000), settled_at: null });
    });

    it('drops a reply token at a delivery settle once the intent of its root concluded, before a sync ends the Turn', async () => {
      const { channelStore, scope, turnId } = await received();
      await claimed(channelStore, scope, turnId);
      // The owner cancels the Turn: its untried intent concludes in the commit, and the Turn ends at the next sync.
      await channelStore.commit(scope, { scope, commandId: randomUUID(), command: { kind: 'cancel_turn', turnId } }, ports());
      expect((await channelStore.read(scope)).channel!.inbounds[inboundKey(MESSAGE)]!.reply).toMatchObject({ token: 'secret' });
      await channelStore.finishDelivery(scope, 'd1', 1, { result: { result: 'accepted', platformMessageId: 'p1' } }, NOW + 1, TIMES);
      const state = await channelStore.read(scope);
      expect(state.turns[turnId]).toMatchObject({ status: 'processing' });
      expect(state.turns[turnId]!.conclusion).toBeUndefined();
      expect(state.channel!.inbounds[inboundKey(MESSAGE)]!.reply!.token).toBeUndefined();
    });

    it('queues a terminal outcome delivery on the reply route of its inbound, with intent conclusions read before the terminal writes', async () => {
      const { channelStore, scope, turnId } = await received();
      const document: Json = { confirmable_action: [{ action: 'send_message', summary: 'Send it', draft: { text: 'hi' } }] };
      const evidence = { terminal: { envelope: { task_id: taskId(turnId, 0), type: 'task.complete', payload: { document } } } as unknown as DeviceTerminal,
        attempt: { taskId: taskId(turnId, 0) } as unknown as TaskAttempt } satisfies TaskEvidence;
      expect(await channelStore.finish(scope, turnId, evidence, ports())).toBe('succeeded');
      const deliveries = Object.values((await channelStore.read(scope)).channel!.deliveries);
      expect(deliveries).toMatchObject([{ turnId, body: 'Send it', route: { kind: 'reply', inboundId: inboundKey(MESSAGE) }, state: 'pending' }]);
      expect(await row(scope, deliveries[0]!.id)).toEqual({ next_at: '0', tries: 0, last_error: null, settled_at: null });
    });
  });
});
