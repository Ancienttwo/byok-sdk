import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresNonceStore } from '../stores/nonces';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

describe.skipIf(SKIP_DATAPLANE)('PostgresNonceStore atomic nonce consumption', () => {
  it('admits one winner across separate database clients for one nonce', async () => {
    const scope = await createDataplaneScope(2);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const store = new PostgresNonceStore(scope.pool, clock, createWebCrypto());
      const tenant = tenantId('postgres-nonce-race');
      const nonce = await store.issue(tenant, 'device-a');

      const restartPool = scope.openRestartPool(1);
      try {
        const restarted = new PostgresNonceStore(restartPool, clock, createWebCrypto());
        const consumed = await Promise.all([
          store.consumeIfValid(tenant, 'device-a', nonce),
          restarted.consumeIfValid(tenant, 'device-a', nonce),
        ]);

        expect(consumed.filter(Boolean)).toHaveLength(1);
      } finally {
        await restartPool.end();
      }
    } finally {
      await scope.dispose();
    }
  });

  it('rejects replay, expiry, and a wrong tenant or device', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const store = new PostgresNonceStore(scope.pool, clock, createWebCrypto());
      const tenant = tenantId('postgres-nonce-owner');
      const otherTenant = tenantId('postgres-nonce-other');
      const nonce = await store.issue(tenant, 'device-a');

      expect(await store.consumeIfValid(otherTenant, 'device-a', nonce)).toBe(false);
      expect(await store.consumeIfValid(tenant, 'device-b', nonce)).toBe(false);
      expect(await store.consumeIfValid(tenant, 'device-a', nonce)).toBe(true);
      expect(await store.consumeIfValid(tenant, 'device-a', nonce)).toBe(false);

      const expiring = await store.issue(tenant, 'device-a');
      clock.advance(5 * 60 * 1000 + 1);
      expect(await store.consumeIfValid(tenant, 'device-a', expiring)).toBe(false);
    } finally {
      await scope.dispose();
    }
  });
});
