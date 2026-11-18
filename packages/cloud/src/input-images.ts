import type { TenantId } from '@byok-sdk/core';
import type { InputImageBlobRef } from '@byok-sdk/protocol';
import { ByokCloudError } from './errors.js';
import type { CloudBlobStore } from './stores/ports.js';

/** Require every image reference to name a committed blob owned by the tenant. */
export async function assertCommittedInputImages(
  blobs: Pick<CloudBlobStore, 'getDownloadUrl'>,
  tenant: TenantId,
  images: readonly InputImageBlobRef[],
): Promise<void> {
  for (const { blob } of images) {
    if (await blobs.getDownloadUrl(tenant, blob.blobId) === undefined) {
      throw new ByokCloudError('coordination_input_invalid', 'Input images must name committed blobs of this tenant.');
    }
  }
}
