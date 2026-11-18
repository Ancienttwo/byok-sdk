import type { CloudCrypto, InMemoryBlobBytes } from '@byok-sdk/cloud';
import type { Clock, ContentHash, CoreStores, StorageReservation, TenantId } from '@byok-sdk/core';
import type { BlobRef } from '@byok-sdk/protocol';

/** Internal operations over SDK-validated bytes for both embedded stores. */
export interface EmbeddedBlobAccess {
  readCommitted(tenant: TenantId, blobId: string): Promise<BlobRef | undefined>;
  reuseCommitted(tenant: TenantId, hash: ContentHash, size: number, contentType: string): Promise<string | undefined>;
  writeReserved(tenant: TenantId, reservation: StorageReservation, bytes: Uint8Array): Promise<string>;
}

export declare const BLOB_RESERVATION_TTL_MS: number;
export declare function composeEmbeddedMemory(clock: Clock, crypto: CloudCrypto): {
  readonly core: CoreStores;
  readonly objectBytes: InMemoryBlobBytes;
  readonly embeddedBlobs: EmbeddedBlobAccess;
};
