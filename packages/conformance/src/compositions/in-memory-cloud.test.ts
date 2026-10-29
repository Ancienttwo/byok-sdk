/**
 * The in-memory composition running the complete cloud-local conformance suite.
 *
 * This file is the entire integration between the reference implementation and
 * the suite: a factory, and nothing else. Its Postgres sibling is the same size
 * — if either ever needs more than that, the port contract is what needs
 * fixing.
 */
import { createInMemoryCoreStores, createMutableClock } from '@byok-sdk/core';
import { createInMemoryCloudStores, createInMemoryBlobBytes, createWebCrypto } from '@byok-sdk/cloud';
import { ackAndCollectMailbox, runCloudConformance, type CloudCompositionFactory } from '../cloud/harness';

const inMemoryFactory: CloudCompositionFactory = {
  create() {
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const objectBytes = createInMemoryBlobBytes(clock, crypto);
  const core = createInMemoryCoreStores({ clock, objectBytes }).stores;
    const { stores, blobContentProxy } = createInMemoryCloudStores(
      clock,
      crypto,
      core.objects,
      core.mailbox,
    objectBytes,
    );
    return {
      // Exactly the certified ports, in `CLOUD_CONFORMANCE_PORTS` order: the
      // suite asserts the key set, so a composition cannot quietly hand over
      // extra surface the other compositions do not owe.
      stores: {
        activity: stores.activity,
        approvals: stores.approvals,
        agentMessageDraft: stores.agentMessageDraft,
        devices: stores.devices,
        pairingCodes: stores.pairingCodes,
        pairing: stores.pairing,
        nonces: stores.nonces,
        dedup: stores.dedup,
        tasks: stores.tasks,
        cancellations: stores.cancellations,
        receipts: stores.receipts,
        egress: stores.egress,
        proofReceipts: stores.proofReceipts,
        blobs: stores.blobs,
        rateLimiter: stores.rateLimiter,
        taskArchive: stores.taskArchive,
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
      retireCancellationDelivery: (tenant, deviceId) => ackAndCollectMailbox(core.mailbox, tenant, deviceId),
    };
  },
};

runCloudConformance('in-memory', inMemoryFactory);
