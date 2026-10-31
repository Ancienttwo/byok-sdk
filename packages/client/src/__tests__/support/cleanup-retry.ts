import { promises as fs } from 'node:fs';

/**
 * Windows can refuse a recursive delete while a process that has just exited
 * still holds a handle or image mapping. This suite spawns a compiled
 * `hermes.exe` fixture; Windows releases its image section asynchronously
 * after exit, so an `fs.rm` issued immediately after `session.close()` can
 * lose that race and fail with `EPERM` (or `EBUSY`) after every assertion
 * already passed (#1208). `force: true` only suppresses ENOENT — it never
 * retries.
 *
 * Retry only those two transient busy-file errnos, within a fixed bound, and
 * rethrow the ORIGINAL last error at exhaustion: a persistent lock or an
 * unrelated failure must still fail the test, never be swallowed. Same
 * bounded shape as the compiled-fixture cleanup in #1088.
 */
export const CLEANUP_MAX_ATTEMPTS = 4;
export const CLEANUP_BACKOFF_MS = 100;

const TRANSIENT_CLEANUP_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY']);

export interface CleanupRetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Base for the linear backoff between attempts (100, 200, ... ms). */
  backoffMs?: number;
  /** Deletion seam for the unit test; defaults to recursive, forced `rm`. */
  remove?: (target: string) => Promise<void>;
  /** Wait seam for the unit test; defaults to a real timer. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Removes one fixture directory, retrying only transient `EPERM`/`EBUSY`
 * failures. The final attempt rethrows whatever `remove` threw, unchanged, so
 * fail-closed behavior is preserved.
 */
export async function removeDirectoryWithRetry(
  target: string,
  options: CleanupRetryOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? CLEANUP_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? CLEANUP_BACKOFF_MS;
  const remove = options.remove ?? ((path: string) => fs.rm(path, { recursive: true, force: true }));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove(target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (attempt >= attempts || code === undefined || !TRANSIENT_CLEANUP_CODES.has(code)) throw error;
      await wait(backoffMs * attempt);
    }
  }
}
