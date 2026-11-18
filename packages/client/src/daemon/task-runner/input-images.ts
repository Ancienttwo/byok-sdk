import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InputImageBlobRef } from '@byok-sdk/protocol';
import type { RuntimeInputImage } from '../../types.js';
import type { BlobClient } from '../blob-client.js';
import type { ExecutionScratch } from '../retention/scratch.js';

const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as const;

export async function materializeInputImages(
  images: readonly InputImageBlobRef[], blobClient: Pick<BlobClient, 'downloadBlob'>, scratch: ExecutionScratch, signal: AbortSignal,
): Promise<readonly RuntimeInputImage[]> {
  const files: RuntimeInputImage[] = [];
  // Codex can read a file after acknowledging input. Keep it for the execution.
  for (const { blob, mediaType } of images) {
    signal.throwIfAborted();
    const bytes = await blobClient.downloadBlob(blob, { signal });
    signal.throwIfAborted();
    const path = join(scratch.runtimeDir, `${randomUUID()}.${extension[mediaType]}`);
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx', signal });
    files.push({ path, mediaType });
  }
  signal.throwIfAborted();
  return files;
}
