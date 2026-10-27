/**
 * #1040: an object upload above the inline frame finalizes over a
 * `createByokPool` pool. The finalize guard compares the observed size with
 * the reservation's `expected_bytes`, an int8 column, so it holds only when the
 * pool decodes int8 as bigint; `pool.test.ts` covers the refusal of a pool
 * that does not.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentHash, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { migrate } from '../migrate';
import { createPostgresCoreStores } from '../stores/core';
import { R2CloudBlobStore } from '../stores/r2-blobs';
import { createDataplaneScope, createObjectStorageScope, SKIP_DATAPLANE } from './support/dataplane';

const deploySql = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

describe.skipIf(SKIP_DATAPLANE)('object finalize over a createByokPool pool [postgres + seaweedfs]', () => {
  it('commits a 573456-byte application/octet-stream upload', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, deploySql);
      const tenant = tenantId('object-finalize-pool');
      const storage = await createObjectStorageScope();
      const core = createPostgresCoreStores({ pool: scope.pool, clock: { now: () => new Date() }, objectStorage: storage.config });
      await core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
        maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });
      const bytes = new Uint8Array(randomBytes(573_456));
      const hash = contentHash(await createWebCrypto().sha256(bytes));
      const blobs = new R2CloudBlobStore({ ...storage.config, objects: core.objects });
      await core.quota.reserve(tenant, { reservationId: 'sealed-output', kind: 'object', expectedBytes: 573_456n, contentHash: hash,
        contentType: 'application/octet-stream', ttlMs: 60_000 });
      // The finalize route reads the reservation back from the store, as here.
      const reservation = (await core.quota.readReservation(tenant, 'sealed-output'))!;
      expect(reservation.expectedBytes).toBe(573_456n);

      const grant = await blobs.createUpload(tenant, reservation);
      const put = await fetch(grant.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
      expect(put.status, await put.text()).toBe(200);
      const observed = await blobs.observeUpload(tenant, grant.blobId, reservation);
      expect(observed).toEqual({ observedByteSize: 573_456n, observedContentType: 'application/octet-stream' });

      const finalized = await core.quota.finalizeReservation(tenant, { reservationId: 'sealed-output', ...observed! });
      expect(finalized.reservation.state).toBe('committed');
      expect((await core.objects.get(tenant, hash))?.state).toBe('committed');
    } finally {
      await scope.dispose();
    }
  }, 30_000);
});
