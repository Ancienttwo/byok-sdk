import { BLOB_RESERVATION_TTL_MS } from '#byok-embedded-blob-storage';
import { ByokCoreError, contentHash, isCoreError, type ContentHash, type TenantId } from '@byok-sdk/core';
import type { InputImageBlobRef } from '@byok-sdk/protocol';
import type { FacadeStoreComposition } from './stores.js';

function hasImageSignature(bytes: Uint8Array, type: InputImageBlobRef['mediaType']): boolean {
  const matches = (signature: readonly number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  switch (type) {
    case 'image/png': return matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg': return matches([0xff, 0xd8, 0xff]);
    case 'image/gif': return matches([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || matches([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    case 'image/webp': return matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8);
  }
}

export function createImageUploader({ core: { quota }, cloud: { blobs }, embeddedBlobs, crypto }: FacadeStoreComposition, tenant: TenantId) {
  const pending = new Map<ContentHash, Promise<InputImageBlobRef>>();
  return async (bytes: Uint8Array, contentType: InputImageBlobRef['mediaType']): Promise<InputImageBlobRef> => {
    if (!hasImageSignature(bytes, contentType)) {
      throw new ByokCoreError('storage_integrity_mismatch', 'Image bytes do not have the declared content type signature.');
    }
    const hash = contentHash(await crypto.sha256(bytes));
    const size = bytes.byteLength;
    // A matching repeat refreshes grace, including after a concurrent commit.
    const previous = pending.get(hash);
    const upload = (async () => {
      await previous?.catch(() => undefined);
      const ref = (blobId: string): InputImageBlobRef => ({ mediaType: contentType, blob: { blobId, contentHash: hash, size, contentType } });
      const reuse = () => embeddedBlobs.reuseCommitted(tenant, hash, size, contentType);
      const existing = await reuse();
      if (existing !== undefined) return ref(existing);

      const reservationId = `blob_${crypto.randomUuid()}`;
      const reservation = await quota.reserve(tenant, {
        reservationId, kind: 'object', expectedBytes: BigInt(size), contentHash: hash, contentType, ttlMs: BLOB_RESERVATION_TTL_MS,
      });
      try {
        const blobId = await embeddedBlobs.writeReserved(tenant, reservation, bytes);
        const observed = await blobs.observeUpload(tenant, blobId, reservation);
        if (observed === undefined) throw new ByokCoreError('storage_integrity_mismatch', 'Image upload did not match its reservation.');
        await quota.finalizeReservation(tenant, { reservationId, ...observed });
        return ref(blobId);
      } catch (error) {
        await quota.abortReservation(tenant, reservationId).catch(() => undefined);
        if (isCoreError(error, 'object_state_invalid')) {
          const committed = await reuse();
          if (committed !== undefined) return ref(committed);
        }
        throw error;
      }
    })();
    pending.set(hash, upload);
    try { return await upload; }
    finally { if (pending.get(hash) === upload) pending.delete(hash); }
  };
}
