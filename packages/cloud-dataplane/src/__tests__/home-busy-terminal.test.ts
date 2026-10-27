import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { ByokPool } from '../pool';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createByokCloud, createHmacTokenSigner, createInProcessMailboxWake, createWebCrypto, fullCapabilityDeclaration } from '@byok-sdk/cloud';
import { createEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { handleInboundEnvelope } from '../../../cloud/src/inbound';
import { tenantStoresFor } from '../../../cloud/src/tenant-stores';
import { migrate } from '../migrate';
import { createPostgresCloudStores } from '../stores';
import { createPostgresCoreStores } from '../stores/core';
import { createDataplaneScope, createObjectStorageScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const tenant = tenantId('home-busy-terminal');
const other = tenantId('home-busy-terminal-other');
const deviceId = 'device-busy';

describe.skipIf(SKIP_DATAPLANE)(`Postgres home-busy terminal — ${SKIP_REASON}`, () => {
  it.each(['agent_home_writer_busy', 'agent_home_reader_busy', undefined] as const)(
    'preserves code %s through a fresh Postgres composition', async (code) => {
      const scope = await createDataplaneScope();
      let restarted: ByokPool | undefined;
      try {
        await migrate(scope.pool, DEPLOY_SQL);
        const clock = createMutableClock();
        const crypto = createWebCrypto();
        const { config: objectStorage } = await createObjectStorageScope();
        const declared = fullCapabilityDeclaration();
        const capabilities = { ...declared, capabilities: declared.capabilities.filter(cap => cap !== 'blobs.contentproxy') };
        async function open(pool: ByokPool) {
          const core = createPostgresCoreStores({ pool, clock, objectStorage });
          const stores = await createPostgresCloudStores({ pool, clock, crypto, objectStorage });
          const mailboxWake = createInProcessMailboxWake();
          const cloud = createByokCloud({
            core, cloud: stores, mailboxWake, clock, crypto,
            tokenSigner: createHmacTokenSigner(new Uint8Array(32), clock),
            capabilities,
          });
          const bound = tenantStoresFor({ kind: 'device', tenantId: tenant, productId: 'busy', deviceId },
            { core, cloud: stores, mailboxWake });
          return { cloud, stores, bound };
        }
        const first = await open(scope.pool);
        const taskId = 'declined-task';
        await first.stores.tasks.open(tenant, { taskId, deviceId });
        const payload = { reason: 'display only', retryable: true, ...(code === undefined ? {} : { code }) };
        const terminal = createEnvelope('task.decline', payload, { taskId });
        expect(await handleInboundEnvelope(first.bound, deviceId, terminal).then(r => r.outcome)).toBe('accepted');
        const beforeRestart = await first.cloud.readDeviceTerminal(tenant, taskId);
        expect(beforeRestart).toMatchObject({ envelope: terminal });
        restarted = scope.openRestartPool();
        const afterRestart = await open(restarted);
        expect(await afterRestart.cloud.readDeviceTerminal(tenant, taskId)).toEqual(beforeRestart);
        const result = await afterRestart.cloud.readTaskResult(tenant, taskId);
        expect(result).toMatchObject({ state: 'failed', ...payload });
        if (code === undefined) expect(result).not.toHaveProperty('code');
        expect(await afterRestart.cloud.readDeviceTerminal(other, taskId)).toBeUndefined();
      } finally {
        await restarted?.end();
        await scope.dispose();
      }
    },
  );
});
