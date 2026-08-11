/**
 * Object manifest conformance (§12.7.4, §12.7.8).
 *
 * The manifest is the only thing standing between a failed R2 delete and either
 * a leaked object or a deleted one that a truth record still points at. So the
 * assertions here are about the state machine and the reference count, not
 * about bytes — there are no bytes at this layer.
 */
import { describe, expect, it } from 'vitest';
import { contentHash, isContentHash, isCoreError } from '@byok-sdk/core';
import { hashOf, TENANT_A } from './fixtures';
import { withComposition, type CoreCompositionFactory } from './harness';

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

export function runObjectConformance(factory: CoreCompositionFactory): void {
  describe('objects', () => {
    it('accepts only the sha256 content address form', () => {
      expect(isContentHash(`sha256:${'a'.repeat(64)}`)).toBe(true);
      expect(isContentHash(`sha256:${'A'.repeat(64)}`)).toBe(false);
      expect(isContentHash(`sha256:${'a'.repeat(63)}`)).toBe(false);
      expect(isContentHash('a'.repeat(64))).toBe(false);
      expect(isContentHash(`sha1:${'a'.repeat(40)}`)).toBe(false);
      expect(() => contentHash('not-a-hash')).toThrow(/content hash/i);
    });

    it('walks the manifest state machine', async () => {
      await withComposition(factory, async ({ stores }) => {
        const hash = hashOf(1);
        const pending = await stores.objects.putManifest(TENANT_A, {
          hash,
          byteSize: 64n,
          contentType: 'application/json',
        });
        expect(pending.state).toBe('pending');
        expect(pending.refCount).toBe(0);

        const committed = await stores.objects.commit(TENANT_A, {
          hash,
          observedByteSize: 64n,
          observedContentType: 'application/json',
        });
        expect(committed.state).toBe('committed');

        const pendingDelete = await stores.objects.markDeletePending(TENANT_A, hash);
        expect(pendingDelete.state).toBe('delete_pending');
        expect(pendingDelete.deletePendingAt).toBeTypeOf('string');

        const deleted = await stores.objects.markDeleted(TENANT_A, hash);
        expect(deleted.state).toBe('deleted');
      });
    });

    it('refuses to commit an object whose observed shape disagrees', async () => {
      await withComposition(factory, async ({ stores }) => {
        const hash = hashOf(2);
        await stores.objects.putManifest(TENANT_A, {
          hash,
          byteSize: 64n,
          contentType: 'application/json',
        });

        const mismatch = await captureError(
          stores.objects.commit(TENANT_A, {
            hash,
            observedByteSize: 65n,
            observedContentType: 'application/json',
          }),
        );
        expect(isCoreError(mismatch, 'storage_integrity_mismatch')).toBe(true);

        expect((await stores.objects.get(TENANT_A, hash))?.state).toBe('pending');
      });
    });

    it('counts references idempotently and blocks a tombstone while referenced', async () => {
      await withComposition(factory, async ({ stores }) => {
        const hash = hashOf(3);
        await stores.objects.putManifest(TENANT_A, {
          hash,
          byteSize: 32n,
          contentType: 'application/octet-stream',
        });
        await stores.objects.commit(TENANT_A, {
          hash,
          observedByteSize: 32n,
          observedContentType: 'application/octet-stream',
        });

        const reference = { hash, refKind: 'truth', refId: 'memory/notes' };
        const first = await stores.objects.addReference(TENANT_A, reference);
        const duplicate = await stores.objects.addReference(TENANT_A, reference);
        expect(first.refCount).toBe(1);
        // A retried reference write must not strand the object forever.
        expect(duplicate.refCount).toBe(1);

        const blocked = await captureError(stores.objects.markDeletePending(TENANT_A, hash));
        expect(isCoreError(blocked, 'object_state_invalid')).toBe(true);

        const released = await stores.objects.removeReference(TENANT_A, reference);
        expect(released.refCount).toBe(0);
        expect((await stores.objects.markDeletePending(TENANT_A, hash)).state).toBe(
          'delete_pending',
        );
      });
    });
  });
}
