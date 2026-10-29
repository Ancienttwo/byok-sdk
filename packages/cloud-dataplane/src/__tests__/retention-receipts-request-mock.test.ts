import type { BodyInit } from 'undici';
import { vi } from 'vitest';
const { requestPrefix } = vi.hoisted(() => ({ requestPrefix: 'test-request:' }));
vi.mock('@byok-sdk/cloud', async original => ({ ...await original<typeof import('@byok-sdk/cloud')>(), REQUEST_RECEIPT_PREFIXES: Object.freeze([requestPrefix]) }));
import { createMutableClock } from '@byok-sdk/core';
import { conformanceMailbox, runCloudRetentionConformance, type CloudCompositionFactory } from '@byok-sdk/conformance';

import { describe } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createDataplaneScope, createObjectStorageScope, SKIP_DATAPLANE } from './support/dataplane';
import { migrate } from '../migrate';
import { createPostgresCloudStores } from '../stores';
import { createPostgresCoreStores } from '../stores/core/index';
const deploySql = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const factory: CloudCompositionFactory = {
  async create() {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, deploySql);
      const clock = createMutableClock();
      const objectStorage = await createObjectStorageScope();
      const stores = await createPostgresCloudStores({ rateLimit: { tokensPerSecond: 1_000, burst: 1_000 }, pool: scope.pool, clock, crypto: createWebCrypto(), objectStorage: objectStorage.config });
      return {
        stores, now: () => clock.now().toISOString(), advanceTime: ms => clock.advance(ms),
        landBlobBytes: async ({ grant, bytes, reservation }) => { const response = await fetch(grant.uploadUrl, { method: 'PUT', headers: { 'content-type': reservation.contentType, 'content-length': String(bytes.byteLength) }, body: bytes as unknown as BodyInit }); if (!response.ok) throw new Error('PUT refused'); },
        commitBlob: async () => { throw new Error('Receipt/TTL retention does not commit blobs.'); },
        retireCancellationDelivery: async () => { throw new Error('Receipt/TTL retention does not retire cancellations.'); },
        mailbox: conformanceMailbox(createPostgresCoreStores({ pool: scope.pool, clock, objectStorage: objectStorage.config })),
        dispose: scope.dispose,
      };
    } catch (cause) { await scope.dispose(); throw cause; }
  },
};
describe.skipIf(SKIP_DATAPLANE)('PG request mock', () => runCloudRetentionConformance('postgres request mock', factory, { requestPrefixMock: requestPrefix }));
