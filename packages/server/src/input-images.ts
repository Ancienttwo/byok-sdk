import { ByokCloudError, type EmbeddedBlobAccess } from '@byok-sdk/cloud';
import { ByokCoreError, isCoreError, type TenantId } from '@byok-sdk/core';
import { INPUT_IMAGE_MAX_BYTES, InputImageBlobRefSchema, type InputImageBlobRef } from '@byok-sdk/protocol';
import type { FacadeStoreComposition } from './stores.js';
import type { UploadInputImage } from './types.js';

export function createImageUploads(composition: FacadeStoreComposition, tenant: TenantId, maxBytes: number) {
  let uploader: Promise<ReturnType<typeof import('./input-image-upload.js').createImageUploader>> | undefined;
  return async (input: UploadInputImage): Promise<InputImageBlobRef> => {
    if (input === null || typeof input !== 'object') {
      throw new ByokCloudError('coordination_input_invalid', 'An input image needs bytes and a content type.');
    }
    const { bytes, contentType } = input;
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength === 0 ||
      !InputImageBlobRefSchema.shape.mediaType.safeParse(contentType).success) {
      throw new ByokCloudError('coordination_input_invalid', 'An input image needs nonempty bytes and a supported content type.');
    }
    if (bytes.byteLength > maxBytes) {
      throw new ByokCoreError('storage_object_too_large', `An input image may contain at most ${maxBytes} bytes.`);
    }
    const snapshot = new Uint8Array(bytes);
    try {
      uploader ??= import('./input-image-upload.js').then(module => module.createImageUploader(composition, tenant));
      return await (await uploader)(snapshot, contentType);
    } catch (cause) {
      if (isCoreError(cause)) throw cause;
      throw new InputImageUploadError('blob_upload_failed', { cause });
    }
  };
}

export class InputImageUploadError extends Error {
  constructor(readonly code: 'server_closed' | 'blob_upload_failed', options?: ErrorOptions) {
    super(code === 'server_closed' ? 'The server is closing.' : 'The server could not store the input image.', options);
    this.name = 'InputImageUploadError';
  }
}

export async function assertEmbeddedInputImages(access: EmbeddedBlobAccess, tenant: TenantId,
  images: readonly InputImageBlobRef[], maxBlobSizeBytes: number): Promise<void> {
  const limit = Math.min(INPUT_IMAGE_MAX_BYTES, maxBlobSizeBytes);
  for (const { blob, mediaType } of images) {
    const stored = blob.size > 0 && blob.size <= limit ? await access.readCommitted(tenant, blob.blobId) : undefined;
    if (stored === undefined || stored.contentHash !== blob.contentHash || stored.size !== blob.size ||
      stored.contentType !== blob.contentType || stored.contentType !== mediaType) {
      throw new ByokCloudError('coordination_input_invalid', 'Input images must match committed blobs of this tenant within the image size limit.');
    }
  }
}
