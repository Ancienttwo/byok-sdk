import { vi } from 'vitest';
const { requestPrefix } = vi.hoisted(() => ({ requestPrefix: 'test-request:' }));
vi.mock('@byok-sdk/cloud', async original => ({ ...await original<typeof import('@byok-sdk/cloud')>(), REQUEST_RECEIPT_PREFIXES: Object.freeze([requestPrefix]) }));
import { createMutableClock } from '@byok-sdk/core';
import { ackAndCollectMailbox, runCloudRetentionConformance, type CloudCompositionFactory } from '@byok-sdk/conformance';

import { describe } from 'vitest';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createSqliteEmbeddedStores } from '..';
import { isSqliteAvailable } from '../../../sqlite-support';
const factory: CloudCompositionFactory = {
  create() {
    const clock = createMutableClock();
    const composition = createSqliteEmbeddedStores({ path: ':memory:' }, { clock, crypto: createWebCrypto() });
    return {
      stores: composition.cloud, now: () => clock.now().toISOString(), advanceTime: ms => clock.advance(ms),
      landBlobBytes: async ({ grant, bytes }) => { const result = await composition.blobContentProxy.writeContent(grant.blobId, bytes); if (!result.ok) throw new Error(result.reason); },
      commitBlob: async (tenant, reservation, observation) => { await composition.core.objects.commit(tenant, { hash: reservation.contentHash, ...observation }); },
      retireCancellationDelivery: (tenant, deviceId) => ackAndCollectMailbox(composition.core.mailbox, tenant, deviceId),
      dispose: () => composition.close(),
    };
  },
};
describe.skipIf(!(isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1'))('SQLite request mock', () => runCloudRetentionConformance('sqlite request mock', factory, { requestPrefixMock: requestPrefix }));
