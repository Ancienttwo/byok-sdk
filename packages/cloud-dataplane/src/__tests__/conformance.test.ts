/**
 * The Postgres composition running the complete cloud-local conformance suite.
 *
 * This file is the entire integration between the durable implementation and
 * the suite: a factory, and nothing else — the same size as the in-memory
 * sibling in `@byok-sdk/conformance`. If it ever needs more than that, the port
 * contract is what needs fixing, not this file. Not one assertion in
 * `runCloudConformance` knows which composition it is running against, and any
 * that needed to would be evidence of a port-contract bug to escalate.
 *
 * Each test gets a fresh schema, migrated from empty by the real runner over
 * the real `deploy/sql/` files. That makes "fresh install + migrate-up" (sprint
 * S4A.5) a property of every single test rather than a step someone remembers,
 * and it means the DDL under review is the DDL under test.
 *
 * The composition lives here rather than beside the in-memory entry because the
 * dependency direction has to stay one-way: `conformance → core + cloud`, and
 * `cloud-dataplane --devDep--> conformance`. Putting this file in the suite
 * package would make the suite depend on an adapter — the same cycle that
 * moving `CORE_PORT_*` into core's shipped source was meant to break.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import {
  CLOUD_CAPABILITIES,
  createByokCloud,
  createHmacTokenSigner,
  createWebCrypto,
  fullCapabilityDeclaration,
} from '@byok-sdk/cloud';
import { decodeEnvelope } from '@byok-sdk/protocol';
import { runCloudConformance, type CloudCompositionFactory } from '@byok-sdk/conformance';
import { migrate } from '../migrate';
import { createPostgresCloudStores } from '../stores/index';
import { createPostgresCoreStores } from '../stores/core/index';
import {
  createDataplaneScope,
  createObjectStorageScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const OFFER_TENANT = tenantId('tenant-offer-sequence');

const postgresFactory: CloudCompositionFactory = {
  async create() {
    const scope = await createDataplaneScope();
    await migrate(scope.pool, DEPLOY_SQL);
    // A real bucket on the real MinIO, not a stand-in: the blobs dimension
    // asserts what a grant does, and a grant nobody could redeem would be a
    // pass with nothing behind it.
    const objectStorage = await createObjectStorageScope();

    const clock = createMutableClock();
    const stores = createPostgresCloudStores({
      pool: scope.pool,
      clock,
      crypto: createWebCrypto(),
      objectStorage: objectStorage.config,
    });
    const core = createPostgresCoreStores({ pool: scope.pool, clock });

    return {
      stores,
      now: () => clock.now().toISOString(),
      advanceTime: (ms: number) => {
        clock.advance(ms);
      },
      // A device redeems a grant by PUTting straight at the object store, and
      // so does this: nothing in the composition is in the byte path, which is
      // the fact the narrowed port exists to express. The signed headers must
      // be sent verbatim or MinIO refuses the body.
      landBlobBytes: async ({ grant, declaration, bytes }) => {
        const response = await globalThis.fetch(grant.uploadUrl, {
          method: 'PUT',
          body: bytes,
          headers: { 'content-type': declaration.contentType },
        });
        if (!response.ok) {
          throw new Error(`the object store refused the upload: HTTP ${response.status} ${await response.text()}`);
        }
      },
      commitBlob: async (tenant, reservation, observation) => {
        await core.objects.commit(tenant, {
          hash: reservation.contentHash,
          ...observation,
        });
      },
      dispose: () => scope.dispose(),
    };
  },
};

if (SKIP_DATAPLANE) {
  // `runCloudConformance` opens its own `describe`, so the skip has to be
  // declared here rather than wrapped around it — and it says why.
  describe.skip(`cloud conformance [postgres] — ${SKIP_REASON}`, () => {
    it('needs a dataplane substrate', () => undefined);
  });
} else {
  runCloudConformance('postgres', postgresFactory);
}

describe.skipIf(SKIP_DATAPLANE)('Postgres offer delivery composition', () => {
  it('persists the exact sequence encoded into an offer envelope', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const objectStorage = await createObjectStorageScope();
      const clock = createMutableClock();
      const crypto = createWebCrypto();
      const core = createPostgresCoreStores({ pool: scope.pool, clock });
      const stores = createPostgresCloudStores({
        pool: scope.pool,
        clock,
        crypto,
        objectStorage: objectStorage.config,
      });
      const full = fullCapabilityDeclaration();
      const cloud = createByokCloud({
        core,
        cloud: stores,
        crypto,
        tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(7), clock),
        clock,
        capabilities: {
          ...full,
          capabilities: full.capabilities.filter(
            (capability) => capability !== CLOUD_CAPABILITIES.blobsContentProxy,
          ),
        },
      });

      const first = await cloud.enqueueOffer(OFFER_TENANT, 'device-offer-sequence', {
        payload: { instruction: 'prove the sequence boundary', policy: { mode: 'auto' } },
      });
      const second = await cloud.enqueueOffer(OFFER_TENANT, 'device-offer-sequence', {
        payload: { instruction: 'prove the next sequence too', policy: { mode: 'auto' } },
      });
      const page = await core.mailbox.readAfter(OFFER_TENANT, {
        deviceId: 'device-offer-sequence',
        afterSeq: 0,
      });

      expect([first.seq, second.seq]).toEqual([1, 2]);
      expect(page.messages.map((message) => message.seq)).toEqual([first.seq, second.seq]);
      expect(page.messages.map((message) => decodeEnvelope(message.body).seq)).toEqual([
        first.seq,
        second.seq,
      ]);
      await expect(cloud.readTaskAttempt(OFFER_TENANT, first.taskId)).resolves.toMatchObject({
        status: 'offered',
      });
      await expect(cloud.readTaskAttempt(OFFER_TENANT, second.taskId)).resolves.toMatchObject({
        status: 'offered',
      });
    } finally {
      await scope.dispose();
    }
  });
});
