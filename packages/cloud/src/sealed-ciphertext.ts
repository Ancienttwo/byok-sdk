import type { ContentHash } from '@byok-sdk/core';
import type { BlobRef } from '@byok-sdk/protocol';
import type { TenantBoundObjects } from './tenant-stores';

/** The object reference kind of a sealed ciphertext blob that a task names (#654). Its id is the task id. */
export const SEALED_TASK_REFERENCE_KIND = 'sealed-task';

/** The ciphertext blob that a sealed member names, if any. */
export function sealedCiphertextRef(payload: object): BlobRef | undefined {
  return Object(Object(payload).sealed).ciphertextRef as BlobRef | undefined;
}

/**
 * Whether the blob of a sealed member above the inline limit is committed in
 * this tenant, with the declared size (the schema fixes it at
 * `paddedLength + 16`) and content type. The receiver checks the SHA-256 of
 * the bytes it fetches. This reads only, so a lane runs it before any write.
 */
export async function sealedCiphertextCommitted(objects: TenantBoundObjects, ref: BlobRef): Promise<boolean> {
  const object = await objects.get(ref.contentHash as ContentHash);
  return object?.state === 'committed' && object.byteSize === BigInt(ref.size) && object.contentType === ref.contentType;
}

/**
 * Whether any reference holds the blob. A device learns the hash of an offer
 * or steer blob only after the task retained it, so a blob with no reference
 * is not one that another body of the task names.
 */
export async function sealedCiphertextHeld(objects: TenantBoundObjects, ref: BlobRef): Promise<boolean> {
  return ((await objects.get(ref.contentHash as ContentHash))?.refCount ?? 0) > 0;
}

/** The task holds its ciphertext blob, so orphan GC keeps it while the task lives. `redactTasks` releases it. */
export async function retainSealedCiphertext(objects: TenantBoundObjects, taskId: string, ref: BlobRef): Promise<void> {
  await objects.addReference({ hash: ref.contentHash as ContentHash, refKind: SEALED_TASK_REFERENCE_KIND, refId: taskId });
}

/** Releases a blob that no stored row of the task names, such as the blob of a retry that lost. */
export async function releaseSealedCiphertext(objects: TenantBoundObjects, taskId: string, ref: BlobRef): Promise<void> {
  await objects.removeReference({ hash: ref.contentHash as ContentHash, refKind: SEALED_TASK_REFERENCE_KIND, refId: taskId });
}
