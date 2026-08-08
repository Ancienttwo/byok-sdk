/** S4B-c retention, tombstone, crash and reconciliation matrix. */
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  tenantId,
  type Clock,
  type ContentHash,
  type TenantId,
} from '@byok/core';
import type { BlobObservation } from '@byok/cloud';
import { PostgresCloudCleanup } from '../cleanup';
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
        key: `${tenant}/sha256/${typed.slice('sha256:'.length)}`,
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

async function configurePolicy(cleanup: PostgresCloudCleanup): Promise<void> {
  await cleanup.writeRetentionPolicy(TENANT, {
    policyId: 'default',
    mailboxAckedRetentionMs: 1_000n,
    mailboxUnackedRetentionMs: 1_000n,
    requestReceiptRetentionMs: 1_000n,
    objectOrphanGraceMs: 1_000n,
  });
}

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
      await seedEntitlement(quota, 100n, 100n);
      await configurePolicy(cleanup);

      const first = await mailbox.append(TENANT, {
        deviceId: 'device-a',
        messageId: 'message-1',
        body: 'one',
        bodyHash: HASH_A,
        byteSize: 3n,
      });
      const second = await mailbox.append(TENANT, {
        deviceId: 'device-a',
        messageId: 'message-2',
        body: 'two',
        bodyHash: HASH_B,
        byteSize: 3n,
      });
      await quota.applyMailboxDelta(TENANT, { deltaBytes: 6n });
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
        `INSERT INTO device_presence (tenant_id, device_id, level, detail, observed_at, expires_at)
         VALUES ($1, 'device-a', 'idle', NULL,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.500Z')`,
        [TENANT],
      );
      clock.set('2026-01-01T00:00:02.000Z');

      const result = await cleanup.runTenant(TENANT, 'retention-1');
      expect(result.mailboxDeletedCount).toBe(1n);
      expect(result.mailboxExpiredCount).toBe(1n);
      expect(result.mailboxReleasedBytes).toBe(3n);
      expect(result.ttlRowsDeleted).toBe(3n);
      expect((await quota.readUsage(TENANT)).mailboxBytes).toBe(3n);

      const dead = await cleanup.listDeadLetters(TENANT, { deviceId: 'device-a' });
      expect(dead.messages.map((message) => message.seq)).toEqual([second.seq]);
      const replayed = await cleanup.replayDeadLetter(TENANT, {
        deviceId: 'device-a',
        seq: second.seq,
        replayMessageId: 'operator-replay-1',
      });
      expect(replayed.state).toBe('pending');
      expect(replayed.seq).toBeGreaterThan(second.seq);
      expect((await quota.readUsage(TENANT)).mailboxBytes).toBe(6n);

      const sameReplay = await cleanup.replayDeadLetter(TENANT, {
        deviceId: 'device-a',
        seq: second.seq,
        replayMessageId: 'operator-replay-1',
      });
      expect(sameReplay.seq).toBe(replayed.seq);
      expect((await quota.readUsage(TENANT)).mailboxBytes).toBe(6n);

      await cleanup.discardDeadLetter(TENANT, { deviceId: 'device-a', seq: second.seq });
      expect((await quota.readUsage(TENANT)).mailboxBytes).toBe(3n);
      expect((await cleanup.listDeadLetters(TENANT)).messages).toEqual([]);
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
      const objects = new PostgresObjectStore(scope.pool, clock);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await seedEntitlement(quota, 10n);
      await configurePolicy(cleanup);
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
      const result = await cleanup.runTenant(TENANT, 'gc-hard-limit');
      expect(result.objectsTombstoned).toBe(1n);
      expect(result.objectsDeleted).toBe(1n);
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'committed', refCount: 1 });
      expect(await objects.get(TENANT, HASH_B)).toMatchObject({ state: 'deleted' });
      expect(storage.objects.has(`${TENANT}/${HASH_A}`)).toBe(true);
      expect(storage.objects.has(`${TENANT}/${HASH_B}`)).toBe(false);
      expect(await quota.readUsage(TENANT)).toMatchObject({
        committedObjectBytes: 5n,
        objectCount: 1n,
      });

      const replay = await cleanup.runTenant(TENANT, 'gc-hard-limit');
      expect(replay).toEqual(result);
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
      const objects = new PostgresObjectStore(scope.pool, clock);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await seedEntitlement(quota, 100n);
      await configurePolicy(cleanup);
      await seedCommittedObject(quota, objects, HASH_A, 7n, 'reservation-a');
      storage.put(TENANT, HASH_A, 7n);
      clock.set('2026-01-01T00:00:02.000Z');

      storage.deleteThenFail = true;
      storage.inspectionFailure = true;
      await expect(cleanup.runTenant(TENANT, 'crash-delete')).rejects.toThrow('injected HEAD outage');
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'delete_pending' });
      expect((await quota.readUsage(TENANT)).committedObjectBytes).toBe(7n);

      storage.deleteThenFail = false;
      storage.inspectionFailure = false;
      const recovered = await cleanup.runTenant(TENANT, 'recover-delete');
      expect(recovered.objectsDeleted).toBe(1n);
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'deleted' });
      expect((await quota.readUsage(TENANT)).committedObjectBytes).toBe(0n);

      storage.put(TENANT, HASH_C, 11n, 'application/octet-stream');
      const witnessed = await cleanup.runTenant(TENANT, 'witness-orphan');
      expect(witnessed.orphanWitnessesCreated).toBe(1n);
      expect(await objects.get(TENANT, HASH_C)).toMatchObject({ state: 'pending' });
      expect(storage.objects.has(`${TENANT}/${HASH_C}`)).toBe(true);

      clock.set('2026-01-01T00:00:04.000Z');
      const collected = await cleanup.runTenant(TENANT, 'collect-witness');
      expect(collected.objectsTombstoned).toBe(1n);
      expect(collected.objectsDeleted).toBe(1n);
      expect(collected.objectReleasedBytes).toBe(0n);
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
      const objects = new PostgresObjectStore(scope.pool, clock);
      const cleanup = new PostgresCloudCleanup({ pool: scope.pool, clock, objectStorage: storage });
      await seedEntitlement(quota, 100n);
      await configurePolicy(cleanup);
      await seedCommittedObject(quota, objects, HASH_A, 7n, 'reservation-a');
      await objects.addReference(TENANT, { hash: HASH_A, refKind: 'truth', refId: 'truth-a' });

      const result = await cleanup.runTenant(TENANT, 'missing-object');
      expect(result.missingObjects).toBe(1n);
      expect(await objects.get(TENANT, HASH_A)).toMatchObject({ state: 'committed' });
      expect((await quota.readUsage(TENANT)).committedObjectBytes).toBe(7n);
    } finally {
      await scope.dispose();
    }
  });
});

describe.skipIf(SKIP_DATAPLANE)('R2 maintenance against MinIO', () => {
  it('lists tenant-prefixed objects and makes DELETE replay-safe on the independent substrate', async () => {
    const scope = await createObjectStorageScope();
    const hash = HASH_A.slice('sha256:'.length);
    const key = `${TENANT}/sha256/${hash}`;
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
