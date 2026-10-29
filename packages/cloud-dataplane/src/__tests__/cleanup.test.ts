import { createByokCloud, createInProcessMailboxWake, createWebCrypto, createHmacTokenSigner, type MaintenanceReport } from '@byok-sdk/cloud';
import { createPostgresCoreStores } from '../stores/core';
import { createPostgresCloudStores } from '../stores';
/** S4B-c retention, tombstone, crash and reconciliation matrix. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  tenantId,
  type Clock,
  type ContentHash,
  type TenantId,
} from '@byok-sdk/core';
import type { BlobObservation } from '@byok-sdk/cloud';
import { createEnvelope, decodeEnvelope, encodeEnvelope } from '@byok-sdk/protocol';
import type { PoolClient } from 'pg';
import type { ByokPool } from '../pool';
import { PostgresCloudCleanup } from '../cleanup';
import { PostgresRetentionPolicyStore } from '../stores/retention-policy';
import { migrate } from '../migrate';
import { PostgresMailboxStore } from '../stores/core/mailbox';
import { PostgresObjectStore } from '../stores/core/objects';
import { PostgresQuotaStore } from '../stores/core/quota';
import {
  R2ObjectMaintenanceStore,
  type R2DeleteResult,
  type R2ListedObject,
  type R2ObjectMaintenance,
  type R2ObjectPage,
} from '../stores/r2-blobs';
import {
  createDataplaneScope,
  createObjectStorageScope,
  SKIP_DATAPLANE,
} from './support/dataplane';
import { fileURLToPath } from 'node:url';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-cleanup');
const HASH_A = contentHash(`sha256:${'a'.repeat(64)}`);
const HASH_B = contentHash(`sha256:${'b'.repeat(64)}`);
const HASH_C = contentHash(`sha256:${'c'.repeat(64)}`);

function opaqueBody(body: string, bodyHash: ContentHash) {
  return () => ({
    body,
    bodyHash,
    byteSize: BigInt(new TextEncoder().encode(body).length),
  });
}

function replayableOffer(seed: number) {
  return (seq: number) => {
    const body = encodeEnvelope(
      createEnvelope(
        'task.offer',
        {
          instruction: `cleanup offer ${seed}`,
          agentRef: { agentId: `agent-cleanup-${seed}`, profileRevision: 'rev-1' },
          session: { mode: 'resume', sessionRef: `session-cleanup-${seed}` },
        },
        {
          id: `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`,
          ts: '2026-01-01T00:00:00.000Z',
          taskId: `task-cleanup-${seed}`,
          seq,
        },
      ),
    );
    const bytes = new TextEncoder().encode(body);
    return {
      body,
      bodyHash: contentHash(`sha256:${createHash('sha256').update(bytes).digest('hex')}`),
      byteSize: BigInt(bytes.length),
    };
  };
}

class MutableClock implements Clock {
  #instant: Date;

  constructor(iso: string) {
    this.#instant = new Date(iso);
  }

  now(): Date {
    return new Date(this.#instant);
  }

  set(iso: string): void {
    this.#instant = new Date(iso);
  }
}

class FakeObjectMaintenance implements R2ObjectMaintenance {
  readonly objects = new Map<string, BlobObservation>();
  readonly failingDeletes = new Set<ContentHash>();
  deleteThenFail = false;
  inspectionFailure = false;

  put(tenant: TenantId, hash: ContentHash, byteSize: bigint, contentType = 'text/plain'): void {
    this.objects.set(`${tenant}/${hash}`, {
      observedByteSize: byteSize,
      observedContentType: contentType,
    });
  }

  async inspectObject(tenant: TenantId, hash: ContentHash): Promise<BlobObservation | undefined> {
    if (this.inspectionFailure) throw new Error('injected HEAD outage');
    return this.objects.get(`${tenant}/${hash}`);
  }

  async deleteObject(tenant: TenantId, hash: ContentHash): Promise<R2DeleteResult> {
    if (this.failingDeletes.has(hash)) throw new Error(`injected DELETE failure for ${hash}`);
    const key = `${tenant}/${hash}`;
    const present = this.objects.delete(key);
    if (this.deleteThenFail) throw new Error('injected response loss after DELETE');
    return present ? 'deleted' : 'absent';
  }

  async listTenantObjects(
    tenant: TenantId,
    _continuationToken?: string,
    limit = 100,
  ): Promise<R2ObjectPage> {
    if (this.inspectionFailure) throw new Error('injected LIST outage');
    const objects: R2ListedObject[] = [];
    for (const [key, observation] of this.objects) {
      const [owner, hash] = key.split('/');
      if (owner !== tenant || hash === undefined) continue;
      const typed = hash as ContentHash;
      objects.push({
        key: `tenants/${tenant}/objects/sha256/${typed.slice('sha256:'.length)}`,
        hash: typed,
        byteSize: observation.observedByteSize,
      });
    }
    return { objects: objects.slice(0, limit) };
  }
}

async function seedEntitlement(
  quota: PostgresQuotaStore,
  hardLimitBytes = 100n,
  mailboxLimitBytes = 100n,
): Promise<void> {
  await quota.writeEntitlement(TENANT, {
    version: 1n,
    hardLimitBytes,
    maxObjectBytes: hardLimitBytes,
    maxInlineBytes: hardLimitBytes,
    mailboxLimitBytes,
    retentionPolicyId: 'default',
  });
}

async function seedCommittedObject(
  quota: PostgresQuotaStore,
  objects: PostgresObjectStore,
  hash: ContentHash,
  byteSize: bigint,
  reservationId: string,
): Promise<void> {
  await quota.reserve(TENANT, {
    reservationId,
    kind: 'object',
    expectedBytes: byteSize,
    contentHash: hash,
    contentType: 'text/plain',
    ttlMs: 86_400_000,
  });
  await objects.putManifest(TENANT, { hash, byteSize, contentType: 'text/plain' });
  await quota.finalizeReservation(TENANT, {
    reservationId,
    observedByteSize: byteSize,
    observedContentType: 'text/plain',
  });
}

async function configurePolicy(pool: ByokPool, clock: Clock): Promise<void> {
  await new PostgresRetentionPolicyStore(pool, clock).writeRetentionPolicy(TENANT, {
    policyId: 'default',
    mailboxAckedRetentionMs: 1_000n,
    mailboxUnackedRetentionMs: 1_000n,
    mailboxDeadLetterRetentionMs: 1_000n,
    requestReceiptRetentionMs: 1_000n,
    objectOrphanGraceMs: 1_000n,
  });
}

function interceptCleanupDelete(pool: ByokPool, beforeDelete: () => Promise<void>): ByokPool {
  let intercepted = false;
  return interceptClientQueries(pool, async (sql) => {
    if (!intercepted && sql.includes('WITH acked AS')) {
      intercepted = true;
      await beforeDelete();
    }
  });
}

// Built on the real pool so it still carries the createByokPool brand.
function interceptClientQueries(
  pool: ByokPool,
  beforeQuery: (sql: string) => Promise<void>,
): ByokPool {
  return Object.assign(Object.create(pool) as ByokPool, {
    query: async (...args: unknown[]) => { const query = args[0]; const sql = typeof query === 'string' ? query : ((query as { text?: string } | undefined)?.text ?? ''); await beforeQuery(sql); return Reflect.apply(pool.query, pool, args); },
    connect: async (): Promise<PoolClient> => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(clientTarget, clientProperty) {
          if (clientProperty === 'query') {
            return async (...args: unknown[]) => {
              const query = args[0];
              const sql =
                typeof query === 'string'
                  ? query
                  : ((query as { readonly text?: string } | undefined)?.text ?? '');
              await beforeQuery(sql);
              return Reflect.apply(clientTarget.query, clientTarget, args);
            };
          }
          const value: unknown = Reflect.get(clientTarget, clientProperty, clientTarget);
          return typeof value === 'function' ? value.bind(clientTarget) : value;
        },
      });
    },
  });
}

async function maintenanceCloud(pool: ByokPool, clock: Clock, storage: R2ObjectMaintenance) {
  const objectStorage = (await createObjectStorageScope()).config;
  const core = createPostgresCoreStores({ pool, clock, objectStorage });
  return createByokCloud({
    mailboxWake: createInProcessMailboxWake(),
    core: { ...core, objects: new PostgresObjectStore(pool, clock, storage) },
    cloud: await createPostgresCloudStores({ rateLimit: { tokensPerSecond: 1_000, burst: 1_000 }, pool, clock, crypto: createWebCrypto(), objectStorage }),
    clock, crypto: createWebCrypto(), tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(7), clock),
    capabilities: { schema: 'byok-capabilities-v1', version: 1, capabilities: [] },
  });
}
function step(report: MaintenanceReport, name: string) {
  const result = report.steps.find(entry => entry.step === name);
  if (result === undefined) throw new Error('Missing maintenance step ' + name);
  return result;
}
const bounds = (clock: Clock) => ({ now: clock.now().toISOString(), limit: 100, ackedBefore: new Date(clock.now().getTime() - 1000).toISOString(), expireUnackedBefore: new Date(clock.now().getTime() - 1000).toISOString(), reapDeadLettersBefore: new Date(clock.now().getTime() - 2000).toISOString() });
const objectBounds = (clock: Clock, limit = 100) => ({ now: clock.now().toISOString(), limit, orphanBefore: new Date(clock.now().getTime() - 1000).toISOString() });

describe.skipIf(SKIP_DATAPLANE)('Postgres cloud cleanup', () => {
  it('retires acked mail atomically and exposes explicit dead-letter replay/discard', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await seedEntitlement(quota, 2_000n, 2_000n);
      await configurePolicy(scope.pool, clock);

      const first = await mailbox.append(TENANT, {
        deviceId: 'device-a',
        messageId: 'message-1',
        admission: 'limited',
        materialize: replayableOffer(1),
      });
      const second = await mailbox.append(TENANT, {
        deviceId: 'device-a',
        messageId: 'message-2',
        admission: 'limited',
        materialize: replayableOffer(2),
      });
      await mailbox.recordDelivery(TENANT, { deviceId: 'device-a', deliveredSeq: first.seq });
      await mailbox.advanceCursor(TENANT, { deviceId: 'device-a', ackedSeq: first.seq });
      await scope.pool.query(
        `INSERT INTO auth_nonce (tenant_id, device_id, nonce, expires_at, used)
         VALUES ($1, 'device-a', 'expired-nonce', '2026-01-01T00:00:00.500Z', false)`,
        [TENANT],
      );
      await scope.pool.query(
        `INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at)
         VALUES ($1, 'old-receipt', '{}', '2026-01-01T00:00:00.000Z')`,
        [TENANT],
      );
      await scope.pool.query(
        `INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at)
         VALUES ($1, 'pairing-completion:v1:durable-code', '{}', '2026-01-01T00:00:00.000Z')`,
        [TENANT],
      );
      await scope.pool.query(
        `INSERT INTO device_presence (tenant_id, device_id, level, detail, observed_at, expires_at)
         VALUES ($1, 'device-a', 'idle', NULL,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.500Z')`,
        [TENANT],
      );
      await scope.pool.query(
        `INSERT INTO approval_timeline_tail
           (tenant_id, task_id, entries, next_revision, dropped, capacity, expires_at)
         VALUES ($1, 'task-expired-approval', '[]'::jsonb, 1, 0, 50,
                 '2026-01-01T00:00:00.500Z')`,
        [TENANT],
      );
      clock.set('2026-01-01T00:00:02.000Z');

      const cloud = await maintenanceCloud(scope.pool, clock, storage);
      const result = await cloud.runMaintenance({ tenant: TENANT, now: clock.now().toISOString(), policy: await new PostgresRetentionPolicyStore(scope.pool, clock).readRetentionPolicy(TENANT) });
      expect(step(result, 'mailbox')).toMatchObject({ removed: 1, expired: 1, releasedBytes: 0n });
      // Nonce, presence and approval tail. Request receipts are no longer
      // swept by hosted cleanup (#411), so `old-receipt` is retained below.
      for (const name of ['nonces', 'presence', 'approvals']) expect(step(result, name)).toMatchObject({ status: 'ok', removed: 1 });
      // The dead letter is retained for inspection but holds no quota (#1115).
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(0n);
      await expect(scope.pool.query(
        `SELECT key FROM device_request_receipts
          WHERE tenant_id = $1 AND key = 'pairing-completion:v1:durable-code'`,
        [TENANT],
      )).resolves.toMatchObject({ rows: [{ key: 'pairing-completion:v1:durable-code' }] });
      await expect(scope.pool.query(
        `SELECT key FROM device_request_receipts WHERE tenant_id = $1 AND key = 'old-receipt'`,
        [TENANT],
      )).resolves.toMatchObject({ rows: [{ key: 'old-receipt' }] });

      const dead = await cleanup.listDeadLetters(TENANT, { deviceId: 'device-a' });
      expect(dead.messages.map((message) => message.seq)).toEqual([second.seq]);
      const replayed = await cleanup.replayDeadLetter(TENANT, {
        deviceId: 'device-a',
        seq: second.seq,
        replayMessageId: 'operator-replay-1',
      });
      expect(replayed.state).toBe('pending');
      expect(replayed.seq).toBeGreaterThan(second.seq);
      expect(decodeEnvelope(replayed.body).seq).toBe(replayed.seq);
      expect(replayed.body).not.toBe(second.body);
      const replayedBytes = new TextEncoder().encode(replayed.body);
      expect(replayed.byteSize).toBe(BigInt(replayedBytes.length));
      expect(replayed.bodyHash).toBe(
        contentHash(`sha256:${createHash('sha256').update(replayedBytes).digest('hex')}`),
      );
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(replayed.byteSize);

      const sameReplay = await cleanup.replayDeadLetter(TENANT, {
        deviceId: 'device-a',
        seq: second.seq,
        replayMessageId: 'operator-replay-1',
      });
      expect(sameReplay.seq).toBe(replayed.seq);
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(replayed.byteSize);

      // The source is the device's only dead letter, so it is the floor.
      await expect(cleanup.discardDeadLetter(TENANT, { deviceId: 'device-a', seq: second.seq }))
        .rejects.toMatchObject({ code: 'cleanup_dead_letter_is_recovery_floor' });
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(replayed.byteSize);
      expect((await cleanup.listDeadLetters(TENANT)).messages.map((message) => message.seq)).toEqual([second.seq]);
    } finally {
      await scope.dispose();
    }
  });

  it('reports zero released mailbox bytes while deleting rows after a concurrent ACK', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      await seedEntitlement(quota, 100n, 100n);

      const first = await mailbox.append(TENANT, {
        deviceId: 'device-race',
        messageId: 'message-race-1',
        admission: 'limited',
        materialize: opaqueBody('one', HASH_A),
      });
      const second = await mailbox.append(TENANT, {
        deviceId: 'device-race',
        messageId: 'message-race-2',
        admission: 'limited',
        materialize: opaqueBody('two', HASH_B),
      });
      await mailbox.recordDelivery(TENANT, { deviceId: 'device-race', deliveredSeq: first.seq });
      await mailbox.advanceCursor(TENANT, { deviceId: 'device-race', ackedSeq: first.seq });

      const collector = new PostgresMailboxStore( interceptCleanupDelete(scope.pool, async () => {
          await scope.pool.query(
            `UPDATE outbox SET state = 'acked'
              WHERE tenant_id = $1 AND device_id = 'device-race' AND seq = $2`,
            [TENANT, second.seq],
          );
        }),
        clock,
      );
      clock.set('2026-01-01T00:00:02.000Z');

      const result = await collector.collectExpired(TENANT, bounds(clock));
      expect(result.removed).toBe(2);
      expect(result.releasedBytes).toBe(0n);
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(0n);
    } finally {
      await scope.dispose();
    }
  });

  it('refuses to discard a device floor dead letter and still discards one below it (#1115)', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: new FakeObjectMaintenance() });
      await seedEntitlement(quota, 20_000n, 20_000n);
      for (let n = 1; n <= 2; n++) {
        await mailbox.append(TENANT, { deviceId: 'device-discard', messageId: `discard-${n}`, admission: 'limited', materialize: replayableOffer(60 + n) });
      }
      clock.set('2026-01-01T00:00:02.000Z');
      expect(await mailbox.collectExpired(TENANT, bounds(clock))).toMatchObject({ expired: 2 });
      const floor = async () => (await mailbox.readAfter(TENANT, { deviceId: 'device-discard', afterSeq: 0 })).recoverableFrom;
      const deadSeqs = async () => (await cleanup.listDeadLetters(TENANT, { deviceId: 'device-discard' })).messages.map(message => message.seq);
      expect(await floor()).toBe(3);

      await expect(cleanup.discardDeadLetter(TENANT, { deviceId: 'device-discard', seq: 2 }))
        .rejects.toMatchObject({ name: 'CloudCleanupError', code: 'cleanup_dead_letter_is_recovery_floor' });
      expect(await deadSeqs()).toEqual([1, 2]);
      expect(await floor()).toBe(3);

      expect(await cleanup.discardDeadLetter(TENANT, { deviceId: 'device-discard', seq: 1 })).toMatchObject({ seq: 1, state: 'expired' });
      expect(await deadSeqs()).toEqual([2]);
      expect(await floor()).toBe(3);
      await expect(cleanup.discardDeadLetter(TENANT, { deviceId: 'device-discard', seq: 1 }))
        .rejects.toMatchObject({ code: 'cleanup_dead_letter_not_found' });
      await expect(cleanup.discardDeadLetter(TENANT, { deviceId: 'device-discard', seq: 2 }))
        .rejects.toMatchObject({ code: 'cleanup_dead_letter_is_recovery_floor' });
      expect(await floor()).toBe(3);
    } finally {
      await scope.dispose();
    }
  });

  it('lists dead letters until their grace passes, then reaps all but each device floor row (#1115)', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: new FakeObjectMaintenance() });
      await seedEntitlement(quota, 20_000n, 20_000n);
      for (let n = 1; n <= 3; n++) {
        await mailbox.append(TENANT, { deviceId: 'device-reap', messageId: `reap-${n}`, admission: 'limited', materialize: replayableOffer(40 + n) });
      }
      await mailbox.append(TENANT, { deviceId: 'device-reap-other', messageId: 'reap-other-1', admission: 'limited', materialize: replayableOffer(50) });
      const floor = async (deviceId: string) => (await mailbox.readAfter(TENANT, { deviceId, afterSeq: 0 })).recoverableFrom;
      const deadSeqs = async () => (await cleanup.listDeadLetters(TENANT)).messages.map(message => `${message.deviceId}/${message.seq}`);

      clock.set('2026-01-01T00:00:02.000Z');
      expect(await mailbox.collectExpired(TENANT, bounds(clock))).toEqual({ removed: 0, expired: 4, releasedBytes: 0n, more: false });
      expect(await deadSeqs()).toEqual(['device-reap/1', 'device-reap/2', 'device-reap/3', 'device-reap-other/1']);
      expect([await floor('device-reap'), await floor('device-reap-other')]).toEqual([4, 2]);
      // A replay before the reap: the clone records its source seq as plain
      // provenance (no foreign key), so reaping the source leaves it intact.
      const replayed = await cleanup.replayDeadLetter(TENANT, { deviceId: 'device-reap', seq: 2, replayMessageId: 'reap-replay' });
      expect(replayed).toMatchObject({ seq: 4, state: 'pending' });

      clock.set('2026-01-01T00:00:03.000Z');
      // Two sweeps race over the same snapshot; neither may take a floor row.
      const swept = await Promise.all([mailbox.collectExpired(TENANT, bounds(clock)), mailbox.collectExpired(TENANT, bounds(clock))]);
      expect(swept.reduce((sum, result) => sum + result.removed, 0)).toBe(2);
      expect(swept.every(result => result.expired === 0 && !result.more)).toBe(true);
      expect(await deadSeqs()).toEqual(['device-reap/3', 'device-reap-other/1']);
      expect([await floor('device-reap'), await floor('device-reap-other')]).toEqual([4, 2]);
      await expect(scope.pool.query(
        `SELECT seq::int AS seq, state, replay_source_seq::int AS source FROM outbox
          WHERE tenant_id = $1 AND device_id = 'device-reap' ORDER BY seq`,
        [TENANT],
      )).resolves.toMatchObject({ rows: [{ seq: 3, state: 'expired', source: null }, { seq: 4, state: 'pending', source: 2 }] });
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(replayed.byteSize);
      // The reaped source is gone for replay too; the clone already delivered it.
      await expect(cleanup.replayDeadLetter(TENANT, { deviceId: 'device-reap', seq: 2, replayMessageId: 'reap-replay' }))
        .rejects.toMatchObject({ code: 'cleanup_dead_letter_not_found' });

      // Once the clone expires it becomes the floor, and the old floor row is
      // reaped only after its own grace — never before the floor has moved up.
      clock.set('2026-01-01T00:00:04.000Z');
      expect(await mailbox.collectExpired(TENANT, bounds(clock))).toEqual({ removed: 0, expired: 1, releasedBytes: 0n, more: true });
      expect(await floor('device-reap')).toBe(5);
      expect(await mailbox.collectExpired(TENANT, bounds(clock))).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: false });
      expect(await deadSeqs()).toEqual(['device-reap/4', 'device-reap-other/1']);
      expect([await floor('device-reap'), await floor('device-reap-other')]).toEqual([5, 2]);
    } finally {
      await scope.dispose();
    }
  });

  it('serializes one replay id across different dead-letter rows', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      await seedEntitlement(quota, 2_000n, 2_000n);

      const first = await mailbox.append(TENANT, {
        deviceId: 'device-replay-race',
        messageId: 'expired-race-1',
        admission: 'limited',
        materialize: replayableOffer(3),
      });
      const second = await mailbox.append(TENANT, {
        deviceId: 'device-replay-race',
        messageId: 'expired-race-2',
        admission: 'limited',
        materialize: replayableOffer(4),
      });

      const cleanup = new PostgresCloudCleanup({
        pool: interceptClientQueries(scope.pool, async (sql) => {
          if (!sql.includes('WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3')) {
            return;
          }
          arrivals += 1;
          if (arrivals === 2) releaseBarrier();
          await barrier;
        }),
        clock,
        objectStorage: storage,
      });
      await configurePolicy(scope.pool, clock);
      clock.set('2026-01-01T00:00:02.000Z');
      await mailbox.collectExpired(TENANT, bounds(clock));

      const outcomes = await Promise.allSettled([
        cleanup.replayDeadLetter(TENANT, {
          deviceId: 'device-replay-race',
          seq: first.seq,
          replayMessageId: 'shared-operator-replay',
        }),
        cleanup.replayDeadLetter(TENANT, {
          deviceId: 'device-replay-race',
          seq: second.seq,
          replayMessageId: 'shared-operator-replay',
        }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: { code: 'cleanup_invalid_input' },
      });
      const fulfilled = outcomes.find(
        (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof cleanup.replayDeadLetter>>> =>
          outcome.status === 'fulfilled',
      );
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(fulfilled!.value.byteSize);
    } finally {
      releaseBarrier();
      await scope.dispose();
    }
  });

  it('resolves a normal append that wins the replay id after the pre-lock check', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    let releaseAllocation!: () => void;
    let allocationReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      allocationReached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseAllocation = resolve;
    });
    let intercepted = false;
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      await seedEntitlement(quota, 2_000n, 2_000n);
      const original = await mailbox.append(TENANT, {
        deviceId: 'device-append-replay-race',
        messageId: 'expired-append-race',
        admission: 'limited',
        materialize: replayableOffer(5),
      });
      const expirer = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await configurePolicy(scope.pool, clock);
      clock.set('2026-01-01T00:00:02.000Z');
      await mailbox.collectExpired(TENANT, bounds(clock));

      const cleanup = new PostgresCloudCleanup({
        pool: interceptClientQueries(scope.pool, async (sql) => {
          if (!intercepted && sql.includes('pg_advisory_xact_lock')) {
            intercepted = true;
            allocationReached();
            await barrier;
          }
        }),
        clock,
        objectStorage: storage,
      });
      const replay = cleanup.replayDeadLetter(TENANT, {
        deviceId: 'device-append-replay-race',
        seq: original.seq,
        replayMessageId: 'shared-append-replay-id',
      });
      await reached;
      const winner = await mailbox.append(TENANT, {
        deviceId: 'device-append-replay-race',
        messageId: 'shared-append-replay-id',
        admission: 'limited',
        materialize: replayableOffer(5),
      });
      releaseAllocation();

      await expect(replay).rejects.toMatchObject({ code: 'cleanup_invalid_input' });
      await expect(
        mailbox.append(TENANT, {
          deviceId: 'device-append-replay-race',
          messageId: 'after-shared-append-replay-id',
          admission: 'limited',
          materialize: replayableOffer(6),
        }),
      ).resolves.toMatchObject({ seq: winner.seq + 1 });
    } finally {
      releaseAllocation();
      await scope.dispose();
    }
  });

  it('refuses a new object reservation once the manifest is tombstoned', async () => {
    const storage = new FakeObjectMaintenance();
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const objects = new PostgresObjectStore(scope.pool, clock, storage);
      await seedEntitlement(quota, 100n);
      await objects.putManifest(TENANT, {
        hash: HASH_A,
        byteSize: 5n,
        contentType: 'text/plain',
      });
      await objects.markDeletePending(TENANT, HASH_A);

      await expect(
        quota.reserve(TENANT, {
          reservationId: 'reservation-after-tombstone',
          kind: 'object',
          expectedBytes: 5n,
          contentHash: HASH_A,
          contentType: 'text/plain',
          ttlMs: 86_400_000,
        }),
      ).rejects.toMatchObject({ code: 'object_state_invalid' });
      expect((await quota.readUsage(TENANT)).reservedBytes).toBe(0n);
    } finally {
      await scope.dispose();
    }
  });

  it('rotates past a poison delete tombstone instead of starving later objects', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const objects = new PostgresObjectStore(scope.pool, clock, storage);
      const cleanup = new PostgresCloudCleanup({
        pool: scope.pool,
        clock,
        objectStorage: storage,
        batchSize: 1,
      });
      await seedEntitlement(quota, 100n);
      await configurePolicy(scope.pool, clock);
      await seedCommittedObject(quota, objects, HASH_A, 5n, 'reservation-poison-a');
      await seedCommittedObject(quota, objects, HASH_B, 5n, 'reservation-poison-b');
      storage.put(TENANT, HASH_A, 5n);
      storage.put(TENANT, HASH_B, 5n);
      storage.failingDeletes.add(HASH_A);
      clock.set('2026-01-01T00:00:02.000Z');

      const collector = new PostgresObjectStore(scope.pool, clock, storage);
      await expect(collector.collectExpired(TENANT, objectBounds(clock, 1))).rejects.toMatchObject({ failedRows: 1, committed: { removed: 0, expired: 0, releasedBytes: 0n }, more: true });
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'delete_pending' });

      const retry = await collector.collectExpired(TENANT, objectBounds(clock, 1)).catch(error => error);
      // The first pass selected a fresh row, so one failed retry precedes the fresh-only pass.
      expect(retry).toMatchObject({ failedRows: 1, committed: { removed: 0, expired: 0, releasedBytes: 0n }, more: true });
      expect(await collector.collectExpired(TENANT, objectBounds(clock, 1))).toMatchObject({ removed: 1, releasedBytes: 5n, more: true });
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'delete_pending' });
      expect(await objects.get(TENANT, HASH_B)).toMatchObject({ state: 'deleted' });
      expect(storage.objects.has(`${TENANT}/${HASH_B}`)).toBe(false);
    } finally {
      await scope.dispose();
    }
  });

  it('keeps reads/reference deletes available at hard limit and GC never evicts referenced data', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const objects = new PostgresObjectStore(scope.pool, clock, storage);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await seedEntitlement(quota, 10n);
      await configurePolicy(scope.pool, clock);
      await seedCommittedObject(quota, objects, HASH_A, 5n, 'reservation-a');
      await seedCommittedObject(quota, objects, HASH_B, 5n, 'reservation-b');
      storage.put(TENANT, HASH_A, 5n);
      storage.put(TENANT, HASH_B, 5n);
      await objects.addReference(TENANT, {
        hash: HASH_A,
        refKind: 'truth',
        refId: 'truth-a',
      });

      await expect(
        quota.reserve(TENANT, {
          reservationId: 'over-limit',
          kind: 'object',
          expectedBytes: 1n,
          contentHash: HASH_C,
          contentType: 'text/plain',
          ttlMs: 86_400_000,
        }),
      ).rejects.toMatchObject({ code: 'storage_quota_exceeded' });
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'committed' });
      await objects.removeReference(TENANT, {
        hash: HASH_A,
        refKind: 'truth',
        refId: 'truth-a',
      });
      await objects.addReference(TENANT, {
        hash: HASH_A,
        refKind: 'truth',
        refId: 'truth-a',
      });

      clock.set('2026-01-01T00:00:02.000Z');
      const collector = new PostgresObjectStore(scope.pool, clock, storage);
      const result = await collector.collectExpired(TENANT, objectBounds(clock));
      expect(result).toMatchObject({ removed: 1, releasedBytes: 5n });
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'committed', refCount: 1 });
      expect(await objects.get(TENANT, HASH_B)).toMatchObject({ state: 'deleted' });
      expect(storage.objects.has(`${TENANT}/${HASH_A}`)).toBe(true);
      expect(storage.objects.has(`${TENANT}/${HASH_B}`)).toBe(false);
      expect(await quota.readUsage(TENANT)).toMatchObject({
        committedObjectBytes: 5n,
        objectCount: 1n,
      });

      const replay = await collector.collectExpired(TENANT, objectBounds(clock));
      expect(replay).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
      expect((await quota.readUsage(TENANT)).committedObjectBytes).toBe(5n);

      await scope.pool.query(
        `UPDATE storage_usage
            SET committed_object_bytes = 99, object_count = 9
          WHERE tenant_id = $1`,
        [TENANT],
      );
      await expect(cleanup.rebuildObjectUsage(TENANT)).resolves.toMatchObject({
        committedObjectBytes: 5n,
        objectCount: 1n,
      });
    } finally {
      await scope.dispose();
    }
  });

  it('recovers DELETE response loss and makes untracked R2 keys wait a fresh grace', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const objects = new PostgresObjectStore(scope.pool, clock, storage);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await seedEntitlement(quota, 100n);
      await configurePolicy(scope.pool, clock);
      await seedCommittedObject(quota, objects, HASH_A, 7n, 'reservation-a');
      storage.put(TENANT, HASH_A, 7n);
      clock.set('2026-01-01T00:00:02.000Z');

      storage.deleteThenFail = true;
      storage.inspectionFailure = true;
      const collector = new PostgresObjectStore(scope.pool, clock, storage);
      await expect(collector.collectExpired(TENANT, objectBounds(clock))).rejects.toMatchObject({ failedRows: 1, committed: { removed: 0, expired: 0, releasedBytes: 0n }, more: true, cause: { message: 'injected response loss after DELETE' } });
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'delete_pending' });
      expect((await quota.readUsage(TENANT)).committedObjectBytes).toBe(7n);

      storage.deleteThenFail = false;
      storage.inspectionFailure = false;
      const recovered = await collector.collectExpired(TENANT, objectBounds(clock));
      expect(recovered.removed).toBe(1);
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'deleted' });
      expect((await quota.readUsage(TENANT)).committedObjectBytes).toBe(0n);

      storage.put(TENANT, HASH_C, 11n, 'application/octet-stream');
      const witnessed = await cleanup.reconcileObjectStorage(TENANT);
      expect(witnessed.orphanWitnessesCreated).toBe(1n);
      expect(await objects.get(TENANT, HASH_C)).toMatchObject({ state: 'pending' });
      expect(storage.objects.has(`${TENANT}/${HASH_C}`)).toBe(true);

      clock.set('2026-01-01T00:00:04.000Z');
      const collected = await collector.collectExpired(TENANT, objectBounds(clock));
      expect(collected).toMatchObject({ removed: 1, releasedBytes: 0n });
      expect(await objects.get(TENANT, HASH_C)).toMatchObject({ state: 'deleted' });
    } finally {
      await scope.dispose();
    }
  });

  it('detects a missing committed object without rewriting manifest or usage', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const objects = new PostgresObjectStore(scope.pool, clock, storage);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await seedEntitlement(quota, 100n);
      await configurePolicy(scope.pool, clock);
      await seedCommittedObject(quota, objects, HASH_A, 7n, 'reservation-a');
      await objects.addReference(TENANT, { hash: HASH_A, refKind: 'truth', refId: 'truth-a' });

      const result = await cleanup.reconcileObjectStorage(TENANT);
      expect(result.missingObjects).toBe(1n);
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'committed' });
      expect((await quota.readUsage(TENANT)).committedObjectBytes).toBe(7n);
    } finally {
      await scope.dispose();
    }
  });

  it('commits retention for acked mail appended only through the production path (#411)', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await seedEntitlement(quota, 2_000n, 2_000n);
      await configurePolicy(scope.pool, clock);

      // No manual accounting: the rows are the only record of their bytes.
      const first = await mailbox.append(TENANT, {
        deviceId: 'device-production',
        messageId: 'production-1',
        admission: 'limited',
        materialize: replayableOffer(11),
      });
      const second = await mailbox.append(TENANT, {
        deviceId: 'device-production',
        messageId: 'production-2',
        admission: 'limited',
        materialize: replayableOffer(12),
      });
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(first.byteSize + second.byteSize);
      await mailbox.recordDelivery(TENANT, { deviceId: 'device-production', deliveredSeq: first.seq });
      await mailbox.advanceCursor(TENANT, { deviceId: 'device-production', ackedSeq: first.seq });
      clock.set('2026-01-01T00:00:02.000Z');

      const result = await mailbox.collectExpired(TENANT, bounds(clock));
      expect(result).toMatchObject({
        removed: 1, expired: 1, releasedBytes: 0n,
      });
      // The dead letter is retained until its grace passes, but it holds no
      // quota (#1115).
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(0n);
      // The outbox rows are the only mailbox byte record: 0025 dropped the
      // retired storage_usage counter (#387).
      const usageColumns = await scope.pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'storage_usage' ORDER BY column_name",
      );
      expect(usageColumns.rows.map((row) => row.column_name)).toEqual([
        'committed_inline_bytes', 'committed_object_bytes', 'object_count', 'tenant_id', 'updated_at',
      ]);

      await expect(cleanup.discardDeadLetter(TENANT, { deviceId: 'device-production', seq: second.seq }))
        .rejects.toMatchObject({ code: 'cleanup_dead_letter_is_recovery_floor' });
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(0n);
    } finally {
      await scope.dispose();
    }
  });

  it('refuses a limited append over mailboxLimitBytes without consuming a seq (#411)', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      await seedEntitlement(quota, 2_000n, 10n);

      await expect(
        mailbox.append(TENANT, {
          deviceId: 'device-limit',
          messageId: 'over-limit-offer',
          admission: 'limited',
          materialize: replayableOffer(13),
        }),
      ).rejects.toMatchObject({ code: 'storage_quota_exceeded' });
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(0n);

      const fits = await mailbox.append(TENANT, {
        deviceId: 'device-limit',
        messageId: 'fits',
        admission: 'limited',
        materialize: opaqueBody('0123456789', HASH_A),
      });
      expect(fits.seq).toBe(1);
      await expect(
        mailbox.append(TENANT, {
          deviceId: 'device-limit',
          messageId: 'one-byte-over',
          admission: 'limited',
          materialize: opaqueBody('x', HASH_B),
        }),
      ).rejects.toMatchObject({ code: 'storage_quota_exceeded' });
      // A replay of the existing id answers before the limit is consulted.
      await expect(
        mailbox.append(TENANT, {
          deviceId: 'device-limit',
          messageId: 'fits',
          admission: 'limited',
          materialize: opaqueBody('0123456789', HASH_A),
        }),
      ).resolves.toMatchObject({ seq: fits.seq });
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(10n);
      const stream = await scope.pool.query<{ readonly next_seq: bigint }>(
        'SELECT next_seq FROM device_stream WHERE tenant_id = $1 AND device_id = $2',
        [TENANT, 'device-limit'],
      );
      expect(stream.rows[0]?.next_seq).toBe(2n);
    } finally {
      await scope.dispose();
    }
  });

  it('keeps every SDK request-receipt family through hosted retention (#411)', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await seedEntitlement(quota, 2_000n, 2_000n);
      await configurePolicy(scope.pool, clock);

      // One key per family the SDK writes. Until #412 classifies which ones
      // are TTL-bound requests, none of them may be swept.
      const agent = JSON.stringify(['device-a', 'agent-1', 1, 'request-1']);
      const keys = [
        'task-offer:message-1',
        'task-offer-delivered:message-1',
        'task:task-1:terminal',
        'agent-message-offer:device-a:task-1',
        `agent-content-request:${agent}`,
        `agent-content-receipt:${agent}`,
        `agent-home-projection-request:${agent}`,
        `agent-home-projection-completion:${agent}`,
        `agent-input-preparation-request:${agent}`,
        `agent-input-preparation-completion:${agent}`,
        'pairing-completion:v1:durable-code',
      ];
      for (const key of keys) {
        await scope.pool.query(
          `INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at)
           VALUES ($1, $2, '{}', '2026-01-01T00:00:00.000Z')`,
          [TENANT, key],
        );
      }
      // Traffic that makes the retention transaction actually commit: an acked
      // row past its retention used to roll the whole sweep back.
      const acked = await mailbox.append(TENANT, {
        deviceId: 'device-a',
        messageId: 'receipt-family-traffic',
        admission: 'limited',
        materialize: replayableOffer(14),
      });
      await mailbox.recordDelivery(TENANT, { deviceId: 'device-a', deliveredSeq: acked.seq });
      await mailbox.advanceCursor(TENANT, { deviceId: 'device-a', ackedSeq: acked.seq });
      clock.set('2026-01-01T00:00:02.000Z');

      const cloud = await maintenanceCloud(scope.pool, clock, storage);
      const result = await cloud.runMaintenance({ tenant: TENANT, now: clock.now().toISOString(), policy: await new PostgresRetentionPolicyStore(scope.pool, clock).readRetentionPolicy(TENANT) });
      expect(step(result, 'mailbox')).toMatchObject({ status: 'ok', removed: 1 });
      expect(step(result, 'receipts')).toMatchObject({ status: 'ok', removed: 0 });
      const retained = await scope.pool.query<{ readonly key: string }>(
        'SELECT key FROM device_request_receipts WHERE tenant_id = $1 ORDER BY key',
        [TENANT],
      );
      expect(retained.rows.map((row) => row.key)).toEqual([...keys].sort());
    } finally {
      await scope.dispose();
    }
  });

  it('admits a dead-letter replay against the mailbox limit and fails closed without an entitlement', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    const storage = new FakeObjectMaintenance();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await seedEntitlement(quota, 2_000n, 2_000n);
      await configurePolicy(scope.pool, clock);
      const original = await mailbox.append(TENANT, {
        deviceId: 'device-replay-limit',
        messageId: 'replay-limit-original',
        admission: 'limited',
        materialize: replayableOffer(15),
      });
      clock.set('2026-01-01T00:00:02.000Z');
      await mailbox.collectExpired(TENANT, bounds(clock));

      // The dead letter holds no quota (#1115); a limit one byte short of the
      // clone (same seq width, so same size) is what refuses it.
      await quota.writeEntitlement(TENANT, {
        version: 2n,
        hardLimitBytes: 2_000n,
        maxObjectBytes: 2_000n,
        maxInlineBytes: 2_000n,
        mailboxLimitBytes: original.byteSize - 1n,
        retentionPolicyId: 'default',
      });
      const replay = {
        deviceId: 'device-replay-limit',
        seq: original.seq,
        replayMessageId: 'replay-limit-operator',
      };
      await expect(cleanup.replayDeadLetter(TENANT, replay)).rejects.toMatchObject({
        code: 'storage_quota_exceeded',
      });

      await scope.pool.query('DELETE FROM storage_entitlement WHERE tenant_id = $1', [TENANT]);
      await expect(cleanup.replayDeadLetter(TENANT, replay)).rejects.toMatchObject({
        code: 'storage_entitlement_missing',
      });
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(0n);
      const stream = await scope.pool.query<{ readonly next_seq: bigint }>(
        'SELECT next_seq FROM device_stream WHERE tenant_id = $1 AND device_id = $2',
        [TENANT, 'device-replay-limit'],
      );
      expect(stream.rows[0]?.next_seq).toBe(BigInt(original.seq + 1));
    } finally {
      await scope.dispose();
    }
  });

  it('refuses to replay a wire v3 dead letter under v4 and keeps it until an operator discards it below the floor (#925)', async () => {
    const scope = await createDataplaneScope(4);
    const clock = new MutableClock('2026-01-01T00:00:00.000Z');
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: new FakeObjectMaintenance() });
      for (const seq of [1, 2]) {
        const body = JSON.stringify({ v: 3, id: `v3-dead-letter-${seq}`, ts: clock.now().toISOString(), type: 'task.cancel', task_id: 'task-v3', seq, payload: {} });
        await scope.pool.query(
          `INSERT INTO outbox (tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at)
           VALUES ($1, 'device-v3', $2, $3, $4, $5, $6, 'expired', $7)`,
          [TENANT, seq, `v3-dead-letter-${seq}`, body, `sha256:${'0'.repeat(64)}`, body.length, clock.now()],
        );
      }
      const rows = () => scope.pool.query('SELECT * FROM outbox WHERE tenant_id = $1 ORDER BY seq', [TENANT]).then((result) => result.rows);
      const before = await rows();

      await expect(cleanup.replayDeadLetter(TENANT, { deviceId: 'device-v3', seq: 1, replayMessageId: 'v3-replay' }))
        .rejects.toMatchObject({ code: 'cleanup_invalid_input' });
      expect(await rows()).toEqual(before);

      await cleanup.discardDeadLetter(TENANT, { deviceId: 'device-v3', seq: 1 });
      expect(await rows()).toEqual(before.slice(1));
      await expect(cleanup.discardDeadLetter(TENANT, { deviceId: 'device-v3', seq: 2 }))
        .rejects.toMatchObject({ code: 'cleanup_dead_letter_is_recovery_floor' });
      expect(await rows()).toEqual(before.slice(1));
    } finally {
      await scope.dispose();
    }
  });
});

describe.skipIf(SKIP_DATAPLANE)('R2 maintenance against SeaweedFS', () => {
  it('lists tenant-prefixed objects and makes DELETE replay-safe on the independent substrate', async () => {
    const scope = await createObjectStorageScope();
    const hash = HASH_A.slice('sha256:'.length);
    const key = `tenants/${TENANT}/objects/sha256/${hash}`;
    const planted = await scope.client.fetch(
      `${scope.config.endpoint}/${scope.bucket}/${key}`,
      { method: 'PUT', body: 'bytes', headers: { 'content-type': 'text/plain' } },
    );
    expect(planted.ok).toBe(true);

    const store = new R2ObjectMaintenanceStore(scope.config);
    const page = await store.listTenantObjects(TENANT, undefined, 10);
    expect(page.objects).toContainEqual({ key, hash: HASH_A, byteSize: 5n });
    await expect(store.deleteObject(TENANT, HASH_A)).resolves.toBe('deleted');
    // S3-compatible stores may answer 204 even when the key is already absent;
    // either way the operation is a successful idempotent DELETE.
    await expect(store.deleteObject(TENANT, HASH_A)).resolves.toBe('deleted');
  });
});
