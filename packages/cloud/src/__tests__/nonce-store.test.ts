import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { createWebCrypto } from '../crypto/web-crypto';
import { InMemoryNonceStore } from '../stores/in-memory/nonces';

describe('InMemoryNonceStore atomic nonce consumption', () => {
  it('admits one winner when two callers race the same valid nonce', async () => {
    const store = new InMemoryNonceStore(createMutableClock(), createWebCrypto());
    const tenant = tenantId('nonce-race');
    const nonce = await store.issue(tenant, 'device-a');

    const consumed = await Promise.all([
      store.consumeIfValid(tenant, 'device-a', nonce),
      store.consumeIfValid(tenant, 'device-a', nonce),
    ]);

    expect(consumed.filter(Boolean)).toHaveLength(1);
  });

  it('rejects replay, expired, and wrong tenant or device consumption', async () => {
    const clock = createMutableClock();
    const store = new InMemoryNonceStore(clock, createWebCrypto());
    const tenant = tenantId('nonce-owner');
    const otherTenant = tenantId('nonce-other');
    const nonce = await store.issue(tenant, 'device-a');

    expect(await store.consumeIfValid(otherTenant, 'device-a', nonce)).toBe(false);
    expect(await store.consumeIfValid(tenant, 'device-b', nonce)).toBe(false);
    expect(await store.consumeIfValid(tenant, 'device-a', nonce)).toBe(true);
    expect(await store.consumeIfValid(tenant, 'device-a', nonce)).toBe(false);

    const expiring = await store.issue(tenant, 'device-a');
    clock.advance(5 * 60 * 1000 + 1);
    expect(await store.consumeIfValid(tenant, 'device-a', expiring)).toBe(false);
  });
});
