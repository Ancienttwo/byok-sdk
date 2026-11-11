import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { RESIDENT_MEMORY_MAX_BYTES, type AgentMemoryStartRefusal } from '@byok-sdk/protocol/constants';

/** Opens a file without following a symlink or blocking on a FIFO, where the platform has the flags. */
export const DIGEST_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * One read of the resident `MEMORY.md`; see {@link readResidentMemory}. An
 * unreadable file names its `refusal` class when the home itself is at fault
 * (#1843); a missing file, a changed home identity or an I/O error has none.
 */
export type ResidentMemoryRead =
  | { readonly kind: 'read'; readonly content: string; readonly revision: string; readonly byteCount: number }
  | { readonly kind: 'over-limit'; readonly byteCount: number }
  | { readonly kind: 'unreadable'; readonly reason: string; readonly refusal?: AgentMemoryStartRefusal };

const NOT_REGULAR_FILE = { kind: 'unreadable', reason: 'not a regular file', refusal: 'agent_memory_resident_not_regular_file' } as const;

/**
 * Reads the resident `MEMORY.md` of a leased home (#1439) with one
 * implementation on every platform, at most the limit plus one byte, as strict
 * UTF-8. The `lstat` covers a platform without `O_NOFOLLOW`. The revision is
 * the one `memory_save` compares. A file problem is a result, never a throw.
 */
export async function readResidentMemory(
  home: string,
  homeIdentity: Readonly<{ dev: bigint; ino: bigint }>,
): Promise<ResidentMemoryRead> {
  const absolute = path.join(home, 'MEMORY.md');
  try {
    if (!(await fs.lstat(absolute)).isFile()) return NOT_REGULAR_FILE;
    const handle = await fs.open(absolute, DIGEST_OPEN_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return NOT_REGULAR_FILE;
      // Another hard link can name a file outside the home.
      if (stat.nlink !== 1) return { kind: 'unreadable', reason: 'multiple links', refusal: 'agent_memory_resident_multiple_links' };
      const current = await fs.stat(home, { bigint: true });
      if (current.dev !== homeIdentity.dev || current.ino !== homeIdentity.ino) return { kind: 'unreadable', reason: 'home identity changed' };
      const bytes = Buffer.alloc(RESIDENT_MEMORY_MAX_BYTES + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > RESIDENT_MEMORY_MAX_BYTES) return { kind: 'over-limit', byteCount: Math.max(stat.size, total) };
      const body = bytes.subarray(0, total);
      return {
        kind: 'read',
        content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body),
        revision: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        byteCount: total,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof TypeError) return { kind: 'unreadable', reason: 'not valid UTF-8', refusal: 'agent_memory_resident_not_utf8' };
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return NOT_REGULAR_FILE;
    return { kind: 'unreadable', reason: code === 'ENOENT' ? 'missing' : code ?? 'read failed' };
  }
}
