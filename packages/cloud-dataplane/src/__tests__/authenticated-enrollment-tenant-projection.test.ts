import { fileURLToPath } from 'node:url';
import {
  CLOUD_CAPABILITIES,
  createByokCloud,
  createHmacTokenSigner,
  createWebCrypto,
  fullCapabilityDeclaration,
} from '@byok-sdk/cloud';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { PairResponseSchema } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { createPostgresCoreStores } from '../stores/core/index';
import { PostgresDeviceDirectory } from '../stores/devices';
import { createPostgresCloudStores } from '../stores/index';
import {
  createDataplaneScope,
  createObjectStorageScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-enrollment-projection');
const OTHER_TENANT = tenantId('tenant-enrollment-projection-other');

if (SKIP_DATAPLANE) {
  describe.skip(`Postgres authenticated enrollment tenant projection — ${SKIP_REASON}`, () => {
    it('needs a real Postgres/MinIO substrate', () => undefined);
  });
} else {
  describe('Postgres authenticated enrollment tenant projection', () => {
    it('projects the redeemed tenant through the real handler and reads the exact row after restart', async () => {
      const scope = await createDataplaneScope(2);
      let restartedPool: ReturnType<typeof scope.openRestartPool> | undefined;
      try {
        await migrate(scope.pool, DEPLOY_SQL);
        const clock = createMutableClock();
        const crypto = createWebCrypto();
        const objectStorage = await createObjectStorageScope();
        const stores = createPostgresCloudStores({
          pool: scope.pool,
          clock,
          crypto,
          objectStorage: objectStorage.config,
        });
        const capabilities = fullCapabilityDeclaration();
        const cloud = createByokCloud({
          core: createPostgresCoreStores({ pool: scope.pool, clock }),
          cloud: stores,
          crypto,
          tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(17), clock),
          clock,
          capabilities: {
            ...capabilities,
            capabilities: capabilities.capabilities.filter(
              (capability) => capability !== CLOUD_CAPABILITIES.blobsContentProxy,
            ),
          },
        });

        const pairing = await cloud.createPairingCode(TENANT, { productId: 'stage-a-product' });
        const body = JSON.stringify({
          pairingCode: pairing.code,
          deviceName: 'Stage A host',
          devicePublicKey: 'stage-a-public-key',
          tenantId: OTHER_TENANT,
        });
        const response = await cloud.fetch(new Request('http://cloud.test/byok/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }));
        expect(response.status).toBe(200);
        const paired = PairResponseSchema.parse(await response.json());
        expect(paired.tenantId).toBe(TENANT);

        const replay = await cloud.fetch(new Request('http://cloud.test/byok/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }));
        expect(replay.status).toBe(200);
        const replayed = PairResponseSchema.parse(await replay.json());
        expect(replayed).toMatchObject({
          tenantId: TENANT,
          deviceId: paired.deviceId,
        });

        restartedPool = scope.openRestartPool(2);
        const restartedDevices = new PostgresDeviceDirectory(restartedPool, clock);
        await expect(restartedDevices.get(TENANT, paired.deviceId)).resolves.toMatchObject({
          tenantId: TENANT,
          productId: 'stage-a-product',
          deviceId: paired.deviceId,
        });
        await expect(restartedDevices.get(OTHER_TENANT, paired.deviceId)).resolves.toBeUndefined();
      } finally {
        await restartedPool?.end();
        await scope.dispose();
      }
    });
  });
}
