import { promises as fs } from 'node:fs';

/** Options for {@link atomicWriteFile}. */
export interface AtomicWriteOptions {
  /**
   * POSIX file mode (e.g. `0o600`) to apply to the written file. Applied to
   * the temp file at creation (via `fs.open`'s own `mode` argument, which
   * *is* honored there since the temp file is always freshly created — see
   * point 3 below) and re-asserted with an explicit `chmod` both right
   * after and again once more after the rename. Omit to leave the file at
   * the platform's default create mode.
   */
  mode?: number;
  /**
   * fsync(2) the temp file's contents before renaming it onto the target.
   * Off by default: it only buys extra durability against a crash in the
   * instant between the write and the rename landing (surviving a hard
   * power loss) — it is not needed for this helper's core guarantee (a
   * concurrent reader never observing a torn/partial file), which comes
   * from the rename alone.
   */
  fsync?: boolean;
}

/**
 * Monotonic per-process counter for the temp file's suffix. Deliberately
 * NOT `Date.now()`/`Math.random()` — both can collide (a mocked/frozen
 * clock in tests, a low-entropy sandbox), and a suffix collision between
 * two concurrent `atomicWriteFile` calls targeting the same directory would
 * let one call's temp file clobber another's mid-write, defeating the whole
 * point of writing to a private path first. Combined with `process.pid` so
 * two processes sharing a directory don't collide either. Mirrors
 * `session-workspace-store.ts`'s own `tmpSeq` — this helper generalizes
 * that store's pattern for reuse by `store.ts`/`cursor-store.ts`.
 */
let tmpSeq = 0;

/**
 * Write `data` to `filePath` such that:
 *
 * 1. **No torn reads.** A concurrent reader opening `filePath` at any point
 *    during the write either sees the file's prior complete contents or the
 *    new complete contents — never a truncated/partial write. A bare
 *    `fs.writeFile` does NOT give you this: it truncates the target in
 *    place before writing the new bytes, so a reader racing it can observe
 *    (or fail to `JSON.parse`) a half-written file. This helper instead
 *    writes to a private temp file in the same directory as `filePath`
 *    (same directory is required for the rename below to be atomic — it
 *    must stay on one filesystem) and `fs.rename`s it onto the target;
 *    POSIX guarantees that rename-onto-an-existing-path is an atomic
 *    directory-entry swap.
 * 2. **No corruption on crash.** If the process dies between the write and
 *    the rename, `filePath` is untouched — the half-written data only ever
 *    existed at the temp path. This does not, by itself, order two
 *    concurrent writers deterministically — the last rename to land wins,
 *    silently, with no lost-update detection. Callers that need that on
 *    top of atomicity (e.g. an in-memory map persisted across many
 *    concurrent callers) still need their own serialization, the way
 *    `session-workspace-store.ts`'s own per-instance queue does.
 * 3. **Mode preserved across a replace.** POSIX rename replaces the target
 *    path's directory entry wholesale — the resulting file's mode is the
 *    temp file's mode, not whatever the previously-existing target's mode
 *    was. Passing `{ mode }` sets that on the temp file before the rename
 *    so callers like `DeviceStore` (0600, holds a private key) get a
 *    guaranteed mode on every write, not just the one that first creates
 *    the file.
 * 4. **Works on win32.** POSIX `rename(2)` atomically replaces an existing
 *    `filePath` in one step. Windows' rename (`MoveFileEx` under libuv) can
 *    refuse to replace an existing target — most commonly `EPERM`, and on
 *    some Node/libuv versions `EEXIST` — when something transient (an
 *    antivirus scanner or search indexer briefly holding a read handle open
 *    on the destination is the usual culprit) is touching it. There is no
 *    built-in "replace even if the target is momentarily locked" primitive
 *    to fall back on, so on that error this helper removes the stale
 *    target and retries the rename once (see `renameOnto`). That reopens a
 *    tiny window where `filePath` doesn't exist — true atomic replace isn't
 *    available from userspace once Windows has refused the direct rename —
 *    but it's still strictly better than the plain `fs.writeFile` this
 *    replaces, which had no such window *not* exist at all (it truncates
 *    the live file in place, so a crash or a racing reader can see a torn
 *    file on every platform, not just a brief nonexistence window on one).
 *
 * The caller is responsible for ensuring the parent directory of `filePath`
 * already exists (e.g. via `fs.mkdir(dir, { recursive: true })`) — this
 * helper does not create it, mirroring `DeviceStore`/`CursorStore`/
 * `SessionWorkspaceStore`, which all do that themselves with their own
 * directory mode.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  // Same directory as `filePath` (required for `fs.rename` to be atomic on
  // POSIX — same filesystem) and unique per call so two callers racing to
  // write never collide on the same temp path (see `tmpSeq`'s doc comment).
  const tmpPath = `${filePath}.${process.pid}-${tmpSeq++}.tmp`;

  try {
    const handle = await fs.open(tmpPath, 'w', options.mode);
    try {
      await handle.writeFile(data);
      if (options.mode !== undefined) {
        // `open()`'s own `mode` argument only governs permissions at
        // creation time, which is always the case here since `tmpPath` is
        // guaranteed fresh — but re-asserting it explicitly costs nothing
        // and removes any doubt (mirrors `DeviceStore.save`'s pre-existing
        // defensive chmod, for the same reason: don't trust `mode` from a
        // single call site alone when the file holds a private key).
        await handle.chmod(options.mode);
      }
      if (options.fsync) {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  await renameOnto(tmpPath, filePath);

  if (options.mode !== undefined) {
    // Belt-and-suspenders for the replace case: on every platform this
    // helper supports, the rename above already carried the temp file's
    // mode across verbatim (see point 3 above) — this call is not
    // load-bearing today, but it makes that guarantee independently
    // verifiable by a test (stat the result) rather than an inference from
    // rename's documented semantics.
    await fs.chmod(filePath, options.mode);
  }
}

/**
 * `fs.rename(tmpPath, targetPath)` with the win32 replace-an-existing-file
 * fallback described in {@link atomicWriteFile}'s doc comment (point 4).
 * Split out purely for readability; tests exercise the fallback branch
 * indirectly, by mocking `fs.rename` to fail once with `EPERM` and calling
 * the public `atomicWriteFile` — real POSIX rename never takes this branch
 * itself, only Windows does.
 */
async function renameOnto(tmpPath: string, targetPath: string): Promise<void> {
  try {
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST') {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
    try {
      await fs.rm(targetPath, { force: true });
      await fs.rename(tmpPath, targetPath);
    } catch (fallbackErr) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw fallbackErr;
    }
  }
}
