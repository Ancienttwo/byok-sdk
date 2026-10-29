import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentHash, createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createSqliteEmbeddedStores } from '..';
import { isSqliteAvailable } from '../../../sqlite-support';
const tenant = tenantId('sqlite-byte-retention');
async function setup() {
  const clock = createMutableClock();
  const crypto = createWebCrypto();
  const composition = createSqliteEmbeddedStores({ path: ':memory:' }, { clock, crypto });
  const bytes = new TextEncoder().encode('retained bytes');
  const hash = contentHash(await crypto.sha256(bytes));
  await composition.core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1000n, maxObjectBytes: 100n, maxInlineBytes: 100n, mailboxLimitBytes: 100n, retentionPolicyId: 'test' });
  const reservation = await composition.core.quota.reserve(tenant, { reservationId: 'one', kind: 'object', expectedBytes: BigInt(bytes.length), contentHash: hash, contentType: 'text/plain', ttlMs: 60_000 });
  const grant = await composition.cloud.blobs.createUpload(tenant, reservation);
  expect(await composition.blobContentProxy.writeContent(grant.blobId, bytes)).toEqual({ ok: true });
  await composition.core.quota.finalizeReservation(tenant, { reservationId: 'one', observedByteSize: BigInt(bytes.length), observedContentType: 'text/plain' });
  clock.advance(1);
  return { ...composition, clock, hash, grant, size: BigInt(bytes.length), input: { now: clock.now().toISOString(), orphanBefore: clock.now().toISOString(), limit: 1 } };
}
afterEach(() => vi.restoreAllMocks());
describe.skipIf(!(isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1'))('SQLite physical object retention', () => {
  it('preserves committed deletion counts when the final remainder query fails', async () => {
    const composition = await setup();
    const prepare = DatabaseSync.prototype.prepare;
    const hook = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql) {
      if (sql.startsWith('SELECT 1 FROM object_manifest m WHERE')) throw new Error('injected remainder query failure');
      return prepare.call(this, sql);
    });
    try {
      const failure = await composition.core.objects.collectExpired(tenant, composition.input).then(
        () => { throw new Error('Expected the remainder probe to fail.'); }, error => error,
      );
      hook.mockRestore();
      expect(await composition.blobContentProxy.readContent(composition.grant.blobId)).toBeUndefined();
      expect(await composition.core.quota.readUsage(tenant)).toMatchObject({ committedObjectBytes: 0n, objectCount: 0n });
      expect(failure).toMatchObject({ failedRows: 0, committed: { removed: 1, expired: 0, releasedBytes: composition.size } });
      expect(failure.more).toBeUndefined();
    } finally { hook.mockRestore(); await composition.close(); }
  });
  it('commits bytes, manifest and process-local accounting together', async () => {
    const composition = await setup();
    try {
      expect(await composition.core.objects.collectExpired(tenant, composition.input)).toEqual({ removed: 1, expired: 0, releasedBytes: composition.size, more: false });
      expect(await composition.blobContentProxy.readContent(composition.grant.blobId)).toBeUndefined();
      expect(await composition.core.quota.readUsage(tenant)).toMatchObject({ committedObjectBytes: 0n, objectCount: 0n });
    } finally { await composition.close(); }
  });
  it('leaves bytes and ledger untouched when SQL COMMIT fails', async () => {
    const composition = await setup();
    const exec = DatabaseSync.prototype.exec;
    let commits = 0;
    let fail = true;
    const hook = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql) { if (sql === 'COMMIT' && ++commits === 2 && fail) { fail = false; throw new Error('injected COMMIT failure'); } return exec.call(this, sql); });
    try {
      await expect(composition.core.objects.collectExpired(tenant, composition.input)).rejects.toMatchObject({ committed: { removed: 0, releasedBytes: 0n }, failedRows: 1 });
      expect(await composition.core.quota.readUsage(tenant)).toMatchObject({ committedObjectBytes: composition.size, objectCount: 1n });
      expect(await composition.blobContentProxy.readContent(composition.grant.blobId)).toBeDefined();
      hook.mockRestore();
      expect(await composition.core.objects.collectExpired(tenant, composition.input)).toMatchObject({ removed: 1, releasedBytes: composition.size });
    } finally { hook.mockRestore(); await composition.close(); }
  });
  it('rechecks a tombstone after a concurrent legal revival before deleting bytes', async () => {
    const composition = await setup();
    try {
      await composition.core.objects.markDeletePending(tenant, composition.hash);
      const collecting = composition.core.objects.collectExpired(tenant, composition.input);
      const revival = composition.core.objects.commit(tenant, { hash: composition.hash, observedByteSize: composition.size, observedContentType: 'text/plain' });
      await revival;
      expect(await collecting).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
      expect(await composition.blobContentProxy.readContent(composition.grant.blobId)).toBeDefined();
      expect(await composition.core.quota.readUsage(tenant)).toMatchObject({ committedObjectBytes: composition.size, objectCount: 1n });
    } finally { await composition.close(); }
  });
});
