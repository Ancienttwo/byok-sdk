/**
 * Cross-tenant isolation, one assertion per port (sprint T1/I7).
 *
 * Every case has the same shape: tenant A writes, tenant B reads, and tenant B
 * must see nothing. Not "an error" — *nothing*. Returning a permission error
 * would confirm the row exists, which §12.6.2 layer 6 names as the existence
 * oracle to avoid; a tenant-first store simply addresses a different key space.
 *
 * There is deliberately no "move to another tenant" test, because there is
 * deliberately no such method. If one is ever added, every assertion in this
 * file becomes conditional on it not having been called.
 */
import { describe, expect, it } from 'vitest';
import { ENTITLEMENT, hashOf, TENANT_A, TENANT_B } from './fixtures';
import { withComposition, type CoreCompositionFactory } from './harness';

export function runTenantIsolationConformance(factory: CoreCompositionFactory): void {
  describe('tenant isolation', () => {
    it('does not leak mailbox rows or cursors', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.mailbox.append(TENANT_A, {
          deviceId: 'device-1',
          messageId: 'msg-1',
          materialize: () => ({ body: '{}', bodyHash: hashOf(1), byteSize: 2n }),
        });
        await stores.mailbox.advanceCursor(TENANT_A, { deviceId: 'device-1', ackedSeq: 1 });

        const page = await stores.mailbox.readAfter(TENANT_B, {
          deviceId: 'device-1',
          afterSeq: 0,
        });
        expect(page.messages).toHaveLength(0);
        expect((await stores.mailbox.readCursor(TENANT_B, 'device-1')).ackedSeq).toBe(0);
      });
    });

    it('does not leak board items or advance another tenant board_seq', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.board.create(TENANT_A, {
          itemId: 'item-1',
          channel: 'support',
          title: 'A',
        });
        await stores.board.create(TENANT_A, {
          itemId: 'item-2',
          channel: 'support',
          title: 'A2',
        });

        expect(await stores.board.get(TENANT_B, 'item-1')).toBeUndefined();
        expect((await stores.board.list(TENANT_B, { afterSeq: 0 })).items).toHaveLength(0);

        const foreign = await stores.board.create(TENANT_B, {
          itemId: 'item-1',
          channel: 'support',
          title: 'B',
        });
        // Per-tenant sequence: tenant B starts at 1 even though tenant A is at 2.
        expect(foreign.boardSeq).toBe(1);
        expect(foreign.title).toBe('B');
        expect((await stores.board.get(TENANT_A, 'item-1'))?.title).toBe('A');
      });
    });

    it('does not leak truth records or manifests', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.truth.writeTerminal(TENANT_A, {
          taskId: 'task-1',
          contentHash: hashOf(1),
          byteSize: 10n,
          body: { kind: 'object', hash: hashOf(1) },
        });

        expect(
          await stores.truth.getRecord(TENANT_B, {
            kind: 'task.terminal',
            recordKey: 'task-1',
          }),
        ).toBeUndefined();
        expect(await stores.truth.listManifest(TENANT_B, {})).toHaveLength(0);

        // The same task id in another tenant is a different fact, not a conflict.
        const foreign = await stores.truth.writeTerminal(TENANT_B, {
          taskId: 'task-1',
          contentHash: hashOf(2),
          byteSize: 11n,
          body: { kind: 'object', hash: hashOf(2) },
        });
        expect(foreign.contentHash).toBe(hashOf(2));
      });
    });

    it('does not leak presence hints', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.presence.publish(TENANT_A, {
          deviceId: 'device-1',
          level: 'working',
          ttlMs: 60_000,
          minimumIntervalMs: 0,
        });
        expect(await stores.presence.read(TENANT_B, 'device-1')).toBeUndefined();
        expect(await stores.presence.list(TENANT_B)).toHaveLength(0);
      });
    });

    it('does not share object manifests across tenants', async () => {
      await withComposition(factory, async ({ stores }) => {
        const hash = hashOf(9);
        await stores.objects.putManifest(TENANT_A, {
          hash,
          byteSize: 16n,
          contentType: 'application/json',
        });
        await stores.objects.commit(TENANT_A, {
          hash,
          observedByteSize: 16n,
          observedContentType: 'application/json',
        });

        // Same bytes, different tenant: a separate manifest row, never a shared one.
        expect(await stores.objects.get(TENANT_B, hash)).toBeUndefined();
        expect(await stores.objects.list(TENANT_B, {})).toHaveLength(0);
        const foreign = await stores.objects.putManifest(TENANT_B, {
          hash,
          byteSize: 16n,
          contentType: 'application/json',
        });
        expect(foreign.state).toBe('pending');
      });
    });

    it('does not leak entitlement, usage, or reservations', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        await stores.quota.reserve(TENANT_A, {
          reservationId: 'res-1',
          kind: 'object',
          expectedBytes: 300n,
          contentHash: hashOf(1),
          contentType: 'application/octet-stream',
          ttlMs: 60_000,
        });

        expect(await stores.quota.readEntitlement(TENANT_B)).toBeUndefined();
        const usage = await stores.quota.readUsage(TENANT_B);
        expect(usage.reservedBytes).toBe(0n);
        expect(usage.committedObjectBytes).toBe(0n);
        await expect(stores.quota.abortReservation(TENANT_B, 'res-1')).rejects.toMatchObject({
          code: 'storage_reservation_not_found',
        });
      });
    });
  });
}
