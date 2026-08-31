/**
 * Cross-tenant isolation for the cloud-local ports, plus targeted assertions on
 * the two pre-tenant entry points.
 *
 * Most cases have the same shape as core's: tenant A writes, tenant B reads,
 * and tenant B must see nothing. Not "an error" — *nothing*. Returning a
 * permission error would confirm the row exists, which §12.6.2 layer 6 names as
 * the existence oracle to avoid; a tenant-first store simply addresses a
 * different key space.
 *
 * The interesting half is the two methods `ports.ts` documents as pre-tenant by
 * construction, because they are where a leak would actually happen:
 *
 * - `DeviceDirectory.resolveByDeviceId` — `POST /byok/challenge` and
 *   `POST /byok/token` carry only a deviceId. The safety argument is that the
 *   row it returns CARRIES its tenant, so the caller never compares a tenant it
 *   was handed against one it guessed. That is asserted directly below: the
 *   resolved record's `tenantId` is the owning tenant, and every subsequent
 *   lookup is tenant-first from there.
 * - `PairingEnrollment.redeemAndRegister` — the code resolves the tenant
 *   inside the one atomic enrollment operation. Asserted the same way: its
 *   returned device carries the minting tenant, and no request field can name
 *   another tenant or product.
 *
 * There is deliberately no "move a device to another tenant" test, because
 * there is deliberately no such method. If one is ever added, every assertion
 * in this file becomes conditional on it not having been called.
 */
import { describe, expect, it } from 'vitest';
import { registration, TENANT_A, TENANT_B } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

export function runCloudTenantIsolationConformance(factory: CloudCompositionFactory): void {
  describe('tenant isolation', () => {
    it('does not leak activity tails', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.activity.append(TENANT_A, {
          taskId: 'task-1',
          sourceEnvelopeId: 'envelope-1',
          batchSeq: 1,
          events: [{ type: 'turn_end' }],
          dropped: 0,
          ttlMs: 300_000,
        });
        expect(await stores.activity.read(TENANT_B, 'task-1')).toBeUndefined();
      });
    });

    it('does not leak device rows or listings', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.devices.register(TENANT_A, registration('device-1'));

        expect(await stores.devices.get(TENANT_B, 'device-1')).toBeUndefined();
        expect(await stores.devices.list(TENANT_B)).toHaveLength(0);
        expect(await stores.devices.list(TENANT_A)).toHaveLength(1);
      });
    });

    it('does not let another tenant revoke a device it cannot see', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.devices.register(TENANT_A, registration('device-1'));
        await stores.devices.register(TENANT_B, registration('device-2'));

        // A no-op, not an error: revoking what you cannot address changes nothing.
        await stores.devices.revoke(TENANT_B, 'device-1');

        expect(await stores.devices.get(TENANT_A, 'device-1')).toBeDefined();
        expect(await stores.devices.list(TENANT_B)).toHaveLength(1);

        // Revocation DELETES: the owner's own revoke removes the row, and the
        // other tenant's untouched row proves the delete never reached across.
        await stores.devices.revoke(TENANT_A, 'device-1');
        expect(await stores.devices.get(TENANT_A, 'device-1')).toBeUndefined();
        expect(await stores.devices.list(TENANT_A)).toHaveLength(0);
        expect(await stores.devices.list(TENANT_B)).toHaveLength(1);
        expect((await stores.devices.get(TENANT_B, 'device-2'))?.revoked).toBe(false);
      });
    });

    it('never supersedes another tenant\'s device for an identical machine identity', async () => {
      // `DeviceRegistration.machineId` is the one registration fact that makes
      // `register` mutate rows the caller did not name. It carries no tenant of
      // its own, so the same physical machine legitimately holds an active row
      // in every tenant it pairs into — and a composition that scoped the
      // supersession by machine alone would silently revoke a stranger's
      // device. Asserted here rather than in one composition's own suite
      // because it is a property of the port, not of an implementation.
      //
      // Supersession DELETES the predecessor, so the cross-tenant assertion is
      // now the strongest form available: the stranger's row is still THERE.
      const machineId = 'a'.repeat(64);
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.devices.register(TENANT_A, registration('device-1', { machineId }));
        await stores.devices.register(TENANT_B, registration('device-2', { machineId }));
        await stores.devices.register(TENANT_B, registration('device-3', { machineId }));

        expect(await stores.devices.get(TENANT_A, 'device-1')).toBeDefined();
        expect(await stores.devices.list(TENANT_A)).toHaveLength(1);
        expect(await stores.devices.get(TENANT_B, 'device-2')).toBeUndefined();
        expect(await stores.devices.get(TENANT_B, 'device-3')).toBeDefined();
        expect(await stores.devices.list(TENANT_B)).toHaveLength(1);
      });
    });

    it('resolves a device id to a record that carries its own tenant', async () => {
      // The pre-tenant exception, asserted rather than trusted: a single-step
      // resolve whose result names the tenant is safe; a two-step "look up by
      // naked id, then compare tenants" is the pattern §12.6.2 forbids, and it
      // is unavailable here because the record already answers the question.
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.devices.register(TENANT_A, registration('device-1'));
        await stores.devices.register(TENANT_B, registration('device-2'));

        const resolved = await stores.devices.resolveByDeviceId('device-1');
        expect(resolved?.tenantId).toBe(TENANT_A);
        expect(resolved).toMatchObject({ proofKeyId: 'identity', proofKeyEpoch: 0 });
        expect((await stores.devices.resolveByDeviceId('device-2'))?.tenantId).toBe(TENANT_B);
        expect(await stores.devices.resolveByDeviceId('never-registered')).toBeUndefined();
      });
    });

    it('keeps a revocation visible to the pre-tenant resolve immediately', async () => {
      // One row, two access paths — never two copies to keep in sync. A stale
      // pre-tenant index is a revoked device that can still get a token, and
      // now that revocation deletes the row the index must lose it too:
      // the revoked device and the never-registered one resolve identically.
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.devices.register(TENANT_A, registration('device-1'));
        await stores.devices.revoke(TENANT_A, 'device-1');

        expect(await stores.devices.resolveByDeviceId('device-1')).toBeUndefined();
        expect(await stores.devices.resolveByDeviceId('never-registered')).toBeUndefined();
      });
    });

    it('enrolls a pairing code into the tenant that minted it, never another', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const expiresAt = new Date(Date.parse(handle.now()) + 600_000).toISOString();
        await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-a',
          productId: 'product-a',
          expiresAt,
        });
        await stores.pairingCodes.issue(TENANT_B, {
          code: 'code-b',
          productId: 'product-b',
          expiresAt,
        });

        expect(await stores.pairing.redeemAndRegister({
          pairingCode: 'code-a',
          deviceId: 'device-a',
          deviceName: 'device-a',
          devicePublicKey: 'pk-a',
          proofKeyId: 'identity',
          proofKeyEpoch: 0,
        })).toMatchObject({
          tenantId: TENANT_A,
          productId: 'product-a',
        });
        expect(await stores.pairing.redeemAndRegister({
          pairingCode: 'code-b',
          deviceId: 'device-b',
          deviceName: 'device-b',
          devicePublicKey: 'pk-b',
          proofKeyId: 'identity',
          proofKeyEpoch: 0,
        })).toMatchObject({
          tenantId: TENANT_B,
          productId: 'product-b',
        });
      });
    });

    it('does not let one tenant validate or consume another tenant nonce', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const nonce = await stores.nonces.issue(TENANT_A, 'device-1');

        expect(await stores.nonces.validate(TENANT_B, 'device-1', nonce)).toBe(false);
        // Consuming from the wrong tenant must not burn the real owner's nonce.
        await stores.nonces.markUsed(TENANT_B, nonce);
        expect(await stores.nonces.validate(TENANT_A, 'device-1', nonce)).toBe(true);
      });
    });

    it('keeps dedup rings separate per tenant', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-1')).toBe(false);
        expect(await stores.dedup.checkAndRecord(TENANT_B, 'device-1', 'env-1')).toBe(false);
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-1')).toBe(true);
      });
    });

    it('does not leak task attempts or let a guess touch another tenant row', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT_A, { taskId: 'task-1', deviceId: 'device-1' });

        expect(await stores.tasks.get(TENANT_B, 'task-1')).toBeUndefined();
        expect(
          await stores.tasks.claim(TENANT_B, { taskId: 'task-1', deviceId: 'device-9' }),
        ).toBeUndefined();
        expect(
          await stores.tasks.recordStatus(TENANT_B, { taskId: 'task-1', status: 'failed' }),
        ).toBeUndefined();

        // Tenant A's row is untouched, and tenant B conjured nothing.
        expect(await stores.tasks.get(TENANT_A, 'task-1')).toMatchObject({
          status: 'offered',
          deviceId: 'device-1',
        });
        expect(await stores.tasks.get(TENANT_B, 'task-1')).toBeUndefined();
      });
    });

    it('does not share receipts across tenants', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.receipts.record(TENANT_A, { key: 'terminal:task-1', body: 'a' });

        expect(await stores.receipts.get(TENANT_B, 'terminal:task-1')).toBeUndefined();
        // The same key in another tenant is a different fact, not a replay.
        const foreign = await stores.receipts.record(TENANT_B, {
          key: 'terminal:task-1',
          body: 'b',
        });
        expect(foreign.created).toBe(true);
        expect(foreign.receipt.body).toBe('b');
        expect((await stores.receipts.get(TENANT_A, 'terminal:task-1'))?.body).toBe('a');
      });
    });

    it('does not share proof receipts across tenants', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const input = {
          deviceId: 'device-1',
          requestId: 'request-1',
          operation: 'truth.write',
          resource: 'memory/key',
          bodySha256: `sha256:${'a'.repeat(64)}`,
          bodySize: 1n,
          responseStatus: 200,
          responseBody: '{}',
        } as const;
        await stores.proofReceipts.record(TENANT_A, input);
        expect(
          await stores.proofReceipts.get(TENANT_B, input.deviceId, input.requestId),
        ).toBeUndefined();
        expect((await stores.proofReceipts.record(TENANT_B, input)).created).toBe(true);
      });
    });

  });
}
