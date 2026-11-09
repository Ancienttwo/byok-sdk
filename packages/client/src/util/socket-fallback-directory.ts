import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The one root both long-path socket fallbacks nest under. Deliberately a
 * literal, not `os.tmpdir()` — see `daemon-owner.ts`'s
 * `STORE_MUTEX_FALLBACK_ROOT` for the two independent reasons a
 * environment-derived root cannot carry a lock address. Both call sites pass
 * the literal too; this module only re-states it to recognise their output.
 */
const SOCKET_FALLBACK_ROOT = '/tmp';

/**
 * The names the two derivations give their fallback directory: a prefix plus
 * the first 16 hex digits of SHA-256 over the store path. Restated here as a
 * shape, not rebuilt from a store — this module only decides whether a path it
 * is handed IS a fallback directory, and must refuse anything that merely sits
 * one level under the root.
 */
const FALLBACK_DIRECTORY_NAME = /^(?:byok|byok-store-mutex)-[0-9a-f]{16}$/u;

/**
 * Removes the private directory a long-path socket endpoint was bound under,
 * once nothing is left in it.
 *
 * Two endpoints choose `sun_path` fit over placement: a store's control socket
 * (`control/protocol.ts`'s `controlSocketPath`) and its mutation lock
 * (`daemon-owner.ts`'s `storeMutexEndpoint`). When no address under `storeDir`
 * fits the platform budget, both nest a socket one level below a FIXED short
 * root, in a directory named from that store alone. Unlinking the socket at
 * close was never the end of that bargain: the directory is keyed by the
 * store, so every store that ever took the branch kept one for the life of the
 * machine, and nothing collected them.
 *
 * `rmdir` is deliberate — the exact primitive, not a convenience. That
 * directory exists only so it can be created 0700 BEFORE the bind inside it
 * (see `control/protocol.ts`'s doc comment on that window), so once its socket
 * is gone it holds nothing of value. A non-empty directory is NOT ours to
 * clear: it may hold the next daemon's freshly bound socket, and recursing
 * would delete a live endpoint. `rmdir` refuses exactly that case (ENOTEMPTY),
 * which is why every failure path here is silent.
 *
 * Scope is the fallback root and nothing else. The common case —
 * `<storeDir>/control.sock`, `<storeDir>/mutex.sock` — sits directly in the
 * store, and dropping a long-path branch must never turn a close into a store
 * removal. Requiring BOTH the parent to be {@link SOCKET_FALLBACK_ROOT} and the
 * leaf to carry a fallback name states that once, for both call sites: a store
 * that itself happens to live directly under the root (`/tmp/my-store`) passes
 * the first test and must still fail the second.
 *
 * Reclaiming races a concurrent bind for the same store, which is the ordinary
 * restart case. The window is only between that binder's `mkdir` and its
 * `listen`, and both bind sites retry once on `ENOENT` — see
 * `bindControlEndpoint` and `acquireStoreMutex`.
 */
export async function reclaimSocketFallbackDirectory(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return; // a pipe leaves no directory behind
  const directory = path.dirname(endpoint);
  if (path.dirname(directory) !== SOCKET_FALLBACK_ROOT) return;
  if (!FALLBACK_DIRECTORY_NAME.test(path.basename(directory))) return;
  // ENOENT (already reclaimed) and ENOTEMPTY (someone bound here after us, or
  // a non-socket artifact appeared) both mean "leave it": this is best-effort
  // housekeeping on a path another process may legitimately own by now.
  await fs.rmdir(directory).catch(() => undefined);
}
