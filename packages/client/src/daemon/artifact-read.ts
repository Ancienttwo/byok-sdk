import type { FileHandle } from 'node:fs/promises';

export const DEFAULT_ARTIFACT_LIMITS = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024,
  maxTaskBytes: 64 * 1024 * 1024,
});

/** The caller retains fd ownership; no pathname is reopened. */
export async function readArtifactBytes(
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal,
  account: (bytes: number) => void,
): Promise<Buffer> {
  signal.throwIfAborted();
  const stat = await handle.stat();
  if (stat.size > maxBytes) throw new Error('artifact local byte budget exceeded');
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = handle.createReadStream({ autoClose: false, start: 0, signal, highWaterMark: 64 * 1024 });
  try {
    for await (const data of stream) {
      signal.throwIfAborted();
      const chunk = data as Buffer;
      account(chunk.length);
      total += chunk.length;
      if (total > maxBytes) throw new Error('artifact local byte budget exceeded');
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, total);
  } finally {
    stream.destroy();
  }
}
