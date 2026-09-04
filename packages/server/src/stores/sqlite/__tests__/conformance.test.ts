import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMutableClock } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import {
  runCloudConformance,
  runCoreConformance,
  type CloudCompositionFactory,
  type CoreCompositionFactory,
} from '@byok-sdk/conformance';
import { createSqliteEmbeddedStores } from '..';
import { isSqliteAvailable } from '../../../sqlite-support';

function temporaryDatabase(): { readonly path: string; remove(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-conformance-'));
  return {
    path: join(directory, 'stores.sqlite'),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const coreFactory: CoreCompositionFactory = {
  create() {
    const database = temporaryDatabase();
    const clock = createMutableClock();
    const composition = createSqliteEmbeddedStores(
      { path: database.path },
      { clock, crypto: createWebCrypto() },
    );
    return {
      stores: composition.core,
      now: () => clock.now().toISOString(),
      advanceTime: (ms) => clock.advance(ms),
      dispose: async () => {
        await composition.close();
        database.remove();
      },
    };
  },
};

const cloudFactory: CloudCompositionFactory = {
  create() {
    const database = temporaryDatabase();
    const clock = createMutableClock();
    const composition = createSqliteEmbeddedStores(
      { path: database.path },
      { clock, crypto: createWebCrypto() },
    );
    const stores = composition.cloud;
    return {
      stores: {
        activity: stores.activity,
        approvals: stores.approvals,
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
      },
      now: () => clock.now().toISOString(),
      advanceTime: (ms) => clock.advance(ms),
      landBlobBytes: async ({ grant, bytes }) => {
        const result = await composition.blobContentProxy.writeContent(grant.blobId, bytes);
        if (!result.ok) throw new Error(`SQLite write refused the bytes: ${result.reason}`);
      },
      commitBlob: async (tenant, reservation, observation) => {
        await composition.core.objects.commit(tenant, {
          hash: reservation.contentHash,
          ...observation,
        });
      },
      dispose: async () => {
        await composition.close();
        database.remove();
      },
    };
  },
};

if (isSqliteAvailable()) {
  runCoreConformance('server SQLite embedded', coreFactory);
  runCloudConformance('server SQLite embedded', cloudFactory);
}
