/**
 * The in-memory composition running the complete cloud-local conformance suite.
 *
 * This file is the entire integration between the reference implementation and
 * the suite: a factory, and nothing else. Its Postgres sibling is the same size
 * — if either ever needs more than that, the port contract is what needs
 * fixing.
 */
import { createInMemoryCoreStores, createMutableClock } from '@byok-sdk/core';
import { createInMemoryCloudStores, createWebCrypto } from '@byok-sdk/cloud';
import { runCloudConformance, type CloudCompositionFactory } from '../cloud/harness';

const inMemoryFactory: CloudCompositionFactory = {
  create() {
    const clock = createMutableClock();
    const core = createInMemoryCoreStores({ clock }).stores;
    const { stores, blobContentProxy } = createInMemoryCloudStores(
      clock,
      createWebCrypto(),
      core.objects,
    );
    return {
      // Exactly the certified ports, in `CLOUD_CONFORMANCE_PORTS` order: the
      // suite asserts the key set, so a composition cannot quietly hand over
      // extra surface the other compositions do not owe.
      stores: {
        devices: stores.devices,
        pairingCodes: stores.pairingCodes,
        nonces: stores.nonces,
        dedup: stores.dedup,
        tasks: stores.tasks,
        receipts: stores.receipts,
        proofReceipts: stores.proofReceipts,
        blobs: stores.blobs,
        rateLimiter: stores.rateLimiter,
      },
      now: () => clock.now().toISOString(),
      advanceTime: (ms: number) => {
        clock.advance(ms);
      },
      // This composition IS the byte path — the proxy and the blob store share
      // one registry — so redeeming a grant is a direct write through it.
      landBlobBytes: async ({ grant, bytes }) => {
        const result = await blobContentProxy.writeContent(grant.blobId, bytes);
        if (!result.ok) throw new Error(`in-memory write refused the bytes: ${result.reason}`);
      },
      commitBlob: async (tenant, reservation, observation) => {
        await core.objects.commit(tenant, {
          hash: reservation.contentHash,
          ...observation,
        });
      },
    };
  },
};

runCloudConformance('in-memory', inMemoryFactory);
