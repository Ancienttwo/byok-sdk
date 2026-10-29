import { vi } from 'vitest';
const { requestPrefix } = vi.hoisted(() => ({ requestPrefix: 'test-request:' }));
vi.mock('@byok-sdk/cloud', async original => ({ ...await original<typeof import('@byok-sdk/cloud')>(), REQUEST_RECEIPT_PREFIXES: Object.freeze([requestPrefix]) }));
import { createMutableClock } from '@byok-sdk/core';
import { runCloudRetentionConformance } from '../../../conformance/src/cloud/retention';
import { ackAndCollectMailbox, type CloudCompositionFactory } from '../../../conformance/src/cloud/harness';

vi.mock('../receipt-retention', async original => ({ ...await original<typeof import('../receipt-retention')>(), REQUEST_RECEIPT_PREFIXES: Object.freeze([requestPrefix]) }));
import { createInMemoryByokCloud } from '../composition/in-memory';
const factory: CloudCompositionFactory = {
  create() {
    const clock = createMutableClock();
    const composition = createInMemoryByokCloud({ clock });
    return {
      stores: composition.stores, now: () => clock.now().toISOString(), advanceTime: ms => clock.advance(ms),
      landBlobBytes: async ({ grant, bytes }) => { const result = await composition.blobContentProxy.writeContent(grant.blobId, bytes); if (!result.ok) throw new Error(result.reason); },
      commitBlob: async (tenant, reservation, observation) => { await composition.core.objects.commit(tenant, { hash: reservation.contentHash, ...observation }); },
      retireCancellationDelivery: (tenant, deviceId) => ackAndCollectMailbox(composition.core.mailbox, tenant, deviceId),
    };
  },
};
runCloudRetentionConformance('in-memory request mock', factory, { requestPrefixMock: requestPrefix });
