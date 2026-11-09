import { promises as fs } from 'node:fs';
import path from 'node:path';

const FALLBACK_LEAF = /^(byok|byok-store-mutex)-[0-9a-f]{16}$/;

/**
 * Removes the private `/tmp/byok[-store-mutex]-<hash>` directory a long-path
 * socket fallback created, after its socket has been unlinked.
 *
 * Scoped to the exact fallback shape (parent `/tmp`, hashed leaf) because a
 * store may itself live directly under `/tmp`, and `<storeDir>/control.sock`
 * must never turn teardown into store deletion. Non-recursive `rmdir`: a
 * directory still holding anything (e.g. a socket a restarted daemon just
 * bound) is left alone.
 */
export async function reclaimSocketFallbackDirectory(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = path.dirname(endpoint);
  if (path.dirname(dir) !== '/tmp' || !FALLBACK_LEAF.test(path.basename(dir))) return;
  await fs.rmdir(dir).catch(() => undefined);
}
