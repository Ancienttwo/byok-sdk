import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FrozenInput } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { homeVectors, seedCollaboration, SYNC_OPTIONS, VECTOR_NOW, type HomeCalls, type HomeSubject,
  type SyncIntentRecord } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { vectorClock } from './memory-subject.test-support';
import { openHostedCloud, SKIP_HOSTED_CLOUD, type HostedCloud } from './hosted-cloud.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedOutboxSender, type HostedHomePort, type SenderOptions } from './sender';
import { homeRowKey } from './store';

// #793 S13: the Agent home flush, through the H outbox sender.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;
type HomeRow = { next_at: string; tries: number; settled_at: string | null };

/** Bot `b` at revision 2 on `deviceId`, whose home operation for revision 2 failed, so the owner can retry it. */
function failedPersona(state: CollaborationState, deviceId = 'device'): void {
  seedCollaboration(state);
  state.team.bots.main!.execution = template(deviceId, 'main');
  state.team.bots.b = { ...state.team.bots.main!, id: 'b', name: 'B', mainBot: false, revision: '2', readyRevision: '1', execution: template(deviceId, 'b') };
  state.team.homeOperations.push({ sequence: ++state.sequence, botId: 'b', status: 'failed', error: 'conflict', retries: [], request: { deviceId,
    payload: { requestId: 'r-2', agentRef: { agentId: 'b', profileRevision: '2' }, projectionHash: 'sha256:2',
      projection: { schemaVersion: 'bot-profile.v1', name: 'B', role: 'Team owner', persona: '', model: 'default' } } } as never });
}

describe.skipIf(POSTGRES_URL === undefined)('H Agent home flush on real Postgres (#793 S13)', () => {
  // One schema for each test, because a sender pass covers the whole schema.
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  let clock = VECTOR_NOW;
  beforeEach(() => { clock = VECTOR_NOW; });
  const sender = (options: Partial<SenderOptions> = {}) => new HostedOutboxSender(opened!.pool, store(), { projections: { deliver: async () => {} },
    now: () => clock, leaseMs: 20_000, sendTimeoutMs: 10_000, backoffMs: 5_000, ...options });
  const rows = async (scope: string) => (await opened!.pool.query<HomeRow & { key: string }>(`SELECT key, next_at::text, tries, settled_at::text
    FROM ${table('outbox')} WHERE scope = $1 AND kind = 'home' ORDER BY ordinal`, [storedKey(scope)])).rows;

  /**
   * The H home subject in a new scope: `flushHomes` is one sender pass at `now` with `calls` as the home port. A seed writes no
   * outbox row, so `change` adds the row that a commit's home index writes for each new pending operation.
   */
  async function homeSubject(): Promise<HomeSubject> {
    const scope = `tenant:${randomUUID()}`, pool = opened!.pool;
    await store().seed(scope, state => seedCollaboration(state));
    await store().bindDevice(scope, 'device');
    return {
      scope,
      commit: request => store().commit(scope, request, vectorClock),
      stored: () => store().dump(scope),
      state: () => store().read(scope),
      change: async edit => {
        await store().seed(scope, edit);
        for (const op of (await store().read(scope)).team.homeOperations.filter(row => row.status === 'pending')) {
          await pool.query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, next_at) SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'home', $3
            FROM ${table('outbox')} WHERE scope = $1 ON CONFLICT DO NOTHING`, [storedKey(scope), homeRowKey(op.sequence), op.retryAt ?? 0]);
        }
      },
      sync: async () => { await store().sync(scope, { ...SYNC_OPTIONS, history: undefined }); },
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
      flushHomes: async (now, calls) => { clock = now; await sender({ homes: () => calls }).run(); },
    };
  }

  homeVectors('H HostedCollaborationStore on Postgres', homeSubject);

  /** A scope where `retry_persona` committed a new pending operation for Bot `b`, through the store's own home index. */
  async function retried() {
    const scope = `tenant:${randomUUID()}`;
    await store().seed(scope, failedPersona);
    await store().bindDevice(scope, 'device');
    await store().commit(scope, { scope, commandId: randomUUID(), command: { kind: 'retry_persona', botId: 'b' } }, vectorClock);
    const op = (await store().read(scope)).team.homeOperations.find(row => row.status === 'pending')!;
    const reads: string[] = [], enqueued: string[] = [];
    const calls = (status?: 'applied'): HomeCalls => ({
      read: async request => {
        reads.push(request.payload.requestId);
        return status && { deviceId: request.deviceId, agentRef: request.payload.agentRef, requestId: request.payload.requestId,
          projectionHash: request.payload.projectionHash, status };
      },
      enqueue: async request => { enqueued.push(request.payload.requestId); },
    });
    return { scope, op, reads, enqueued, calls };
  }

  it('indexes a committed pending operation with a due home row, leases it, and settles it when applied, reporting the scope', async () => {
    const h = await retried();
    expect(await rows(h.scope)).toEqual([{ key: homeRowKey(h.op.sequence), next_at: '0', tries: 0, settled_at: null }]);
    const changed: string[] = [];
    await sender({ homes: () => h.calls('applied'), changed: scope => { changed.push(scope); } }).run();
    expect((await store().read(h.scope)).team.homeOperations.find(row => row.sequence === h.op.sequence)).toMatchObject({ status: 'applied' });
    expect(await rows(h.scope)).toEqual([{ key: homeRowKey(h.op.sequence), next_at: String(VECTOR_NOW + 20_000), tries: 0, settled_at: String(VECTOR_NOW) }]);
    expect(changed).toEqual([h.scope]);
  });

  it('moves the row to retryAt after an enqueue, so the next flush runs at retryAt, not at each pass', async () => {
    const h = await retried();
    await sender({ homes: () => h.calls() }).run();
    expect(h.enqueued).toEqual([h.op.request.payload.requestId]);
    expect(await rows(h.scope)).toMatchObject([{ next_at: String(VECTOR_NOW + 1000), settled_at: null }]);
    clock = VECTOR_NOW + 999;
    expect(await sender({ homes: () => h.calls() }).run()).toEqual({ steps: 0, failed: [] });
    expect(h.enqueued).toHaveLength(1);
  });

  it('flushes once when two senders run on one operation: the lease holds the second', async () => {
    const h = await retried();
    let release!: () => void, reads = 0;
    const slow: HomeCalls = { read: () => { reads++; return new Promise(resolve => { release = () => resolve(undefined); }); }, enqueue: async () => {} };
    const first = sender({ homes: () => slow }).run();
    await expect.poll(() => reads).toBe(1);
    await sender({ homes: () => slow }).run();
    expect(reads).toBe(1);
    release();
    await first;
    expect(reads).toBe(1);
  });

  it('defers an operation whose Bot has an open intent by backoffMs, and leaves the operation unchanged', async () => {
    const h = await retried();
    // Bot `b` runs at its current revision, so its Turn freezes while the operation is pending.
    await store().seed(h.scope, state => { state.team.bots.b!.readyRevision = state.team.bots.b!.revision; });
    await store().commit(h.scope, { scope: h.scope, commandId: randomUUID(), command: { kind: 'input', botId: 'b', key: 'k', request: 'Work', sender: 'owner' } }, vectorClock);
    await store().sync(h.scope, { ...SYNC_OPTIONS, history: undefined });
    expect((await opened!.pool.query(`SELECT 1 FROM ${table('intent')} WHERE scope = $1 AND conclusion IS NULL
      AND input->'payload'->'agentRef'->>'agentId' = 'b'`, [storedKey(h.scope)])).rows).toHaveLength(1);
    const operation = async () => (await store().read(h.scope)).team.homeOperations.find(row => row.sequence === h.op.sequence);
    const before = await operation();
    expect((await sender({ homes: () => h.calls('applied') }).run()).failed).toEqual([]);
    expect(h.reads).toEqual([]);
    expect(await rows(h.scope)).toMatchObject([{ next_at: String(VECTOR_NOW + 5_000), settled_at: null }]);
    expect(await operation()).toEqual(before);
  });

  it('keeps an operation pending with the error when a read outlasts sendTimeoutMs, and reports the failure', async () => {
    const h = await retried();
    const hung: HomeCalls = { read: () => new Promise(() => {}), enqueue: async () => {} };
    const pass = await sender({ sendTimeoutMs: 20, homes: () => hung }).run();
    expect(pass.failed).toEqual([{ scope: h.scope, id: ['home', h.op.sequence], error: expect.objectContaining({ message: 'send_timeout' }) }]);
    expect((await store().read(h.scope)).team.homeOperations.find(row => row.sequence === h.op.sequence)).toMatchObject({ status: 'pending', error: 'send_timeout' });
  });

  it('fails a home row in a Host with no home port, and waits backoffMs before it looks again', async () => {
    const h = await retried();
    const pass = await sender().run();
    expect(pass.failed).toEqual([{ scope: h.scope, id: ['home', h.op.sequence], error: new Error('The Host has no Agent home port for a home operation') }]);
    expect(await rows(h.scope)).toMatchObject([{ next_at: String(VECTOR_NOW + 5_000), tries: 0, settled_at: null }]);
  });
});

describe.skipIf(SKIP_HOSTED_CLOUD)('H Agent home flush on a real SDK server and daemon (#793 S13)', () => {
  let host: HostedCloud | undefined;
  beforeAll(async () => { opened = await openStore(); host = await openHostedCloud(); });
  afterAll(async () => { await host?.close(); await opened?.close(); });

  it('readies a Bot through the real enqueueAgentHomeProjection and the paired daemon, and its Turn then freezes', { timeout: 60_000 }, async () => {
    const { cloud, tenant, deviceId } = host!, scope = `tenant:${randomUUID()}`;
    await store().seed(scope, state => failedPersona(state, deviceId));
    await store().bindDevice(scope, deviceId);
    await store().commit(scope, { scope, commandId: randomUUID(), command: { kind: 'retry_persona', botId: 'b' } }, vectorClock);
    // The SDK calls of the tenant, as a deployment binds the sender's home port.
    const homes: HostedHomePort = {
      read: request => cloud.getAgentHomeProjectionStatus(tenant, request.deviceId, { requestId: request.payload.requestId,
        agentRef: request.payload.agentRef, projectionHash: request.payload.projectionHash }),
      enqueue: request => cloud.enqueueAgentHomeProjection(tenant, request.deviceId, request.payload),
    };
    let clock = VECTOR_NOW;
    const changed: string[] = [];
    const sender = new HostedOutboxSender(opened!.pool, store(), { projections: { deliver: async () => {} }, homes: () => homes, now: () => clock,
      changed: changedScope => { changed.push(changedScope); } });
    const bot = async () => (await store().read(scope)).team.bots.b!;
    // Each pass moves the clock an hour, so each row of the scope is due; the daemon applies the operation in between.
    await expect.poll(async () => { clock += 3_600_000; await sender.run(); const b = await bot(); return b.readyRevision === b.revision; },
      { timeout: 20_000, interval: 200 }).toBe(true);
    expect(changed).toContain(scope);
    const turn = await store().commit(scope, { scope, commandId: randomUUID(), command: { kind: 'input', botId: 'b', key: 'k', request: 'Work', sender: 'owner' } }, vectorClock);
    await store().sync(scope, { ...SYNC_OPTIONS, history: undefined });
    const turnId = (turn.disposition as { value: string }).value;
    expect((await opened!.pool.query(`SELECT 1 FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId)])).rows).toHaveLength(1);
  });
});
