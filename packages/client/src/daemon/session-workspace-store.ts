import { promises as fs } from 'node:fs';
import path from 'node:path';

/** What's recoverable for a given `sessionRef` — see the class doc comment. */
export interface SessionWorkspaceRecord {
  workspaceDir: string;
  /**
   * The underlying runtime's own resumable session identifier. For the pi
   * adapter today this is always identical to the map's own `sessionRef`
   * key (`PiSession.sessionRef` already *is* pi's real session id — see
   * pi-adapter.ts's `resolveFreshSessionId`), since pi is the only adapter
   * that exists. Kept as its own field — rather than assumed identical to
   * the key — because docs/protocol.md §1.3 itself describes `session_ref`
   * as "opaque, server-issued... the daemon maps to a runtime session id",
   * i.e. two conceptually distinct things connected by exactly this map; a
   * future adapter (M2: claude/codex) is not guaranteed to want its own
   * internal resume token to be the same string it hands back on the wire.
   */
  runtimeSessionId: string;
}

interface StoredEntry {
  workspaceDir: string;
  runtimeSessionId: string;
  updatedAt: string;
}

type StoredShape = Record<string, StoredEntry>;

function isStoredShape(value: unknown): value is StoredShape {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredEntry(value: unknown): value is StoredEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<StoredEntry>).workspaceDir === 'string' &&
    typeof (value as Partial<StoredEntry>).runtimeSessionId === 'string'
  );
}

/**
 * Monotonic per-process suffix for `save()`'s temp file (never
 * `Date.now()`/`Math.random()` — both can collide under a mocked/frozen
 * clock or a restricted-entropy sandbox, and a suffix collision between two
 * concurrent `save()` calls would defeat the whole point of writing to a
 * private temp path). Combined with `process.pid` below so two
 * `SessionWorkspaceStore` instances in the same process (e.g. a test's own
 * read-only "storeView" alongside the daemon's real instance, both pointed
 * at the same `storeDir`) never pick the same temp filename, and two
 * separate daemon processes sharing a `storeDir` don't either.
 */
let tmpSeq = 0;

/**
 * Persists `sessionRef -> {workspaceDir, runtimeSessionId}` across daemon
 * restarts (finding #3 from the 2026-07-16 live GLM run): a `task.offer`
 * carrying a `sessionRef` this device has previously reported (via a prior
 * task's `task.complete.sessionRef`) reuses that exact workspace directory
 * as the new task's cwd — which is what lets a runtime adapter's own resume
 * mechanism (e.g. pi's `--session <id>`, scoped to the cwd/project a session
 * was created under — see pi-adapter.ts) actually find the session again.
 * An unknown or absent `sessionRef` is simply not in this map, and
 * `task-runner.ts` treats that identically to "no sessionRef was ever
 * offered" — fresh workspace, fresh session.
 *
 * One JSON file under `storeDir`, mirroring `DeviceStore`/`CursorStore`'s
 * own persistence style: always read/write straight through to disk, no
 * in-memory cache that could go stale or need invalidating across multiple
 * `TaskRunner`/daemon instances sharing the same `storeDir` (exactly the
 * "map persisted across daemon restart" requirement).
 *
 * Two correctness properties `task-runner.ts` depends on, neither of which
 * a bare `fs.writeFile` + independent `fs.readFile` calls actually gives
 * you:
 *
 * 1. **No torn reads.** `record()` is deliberately fire-and-forgotten from
 *    `handleOffer` (see its call site) — it must never block `task.started`
 *    on a disk write. But a bare `fs.writeFile` is not atomic: it truncates
 *    the file before writing the new bytes, so a `get()` racing an
 *    in-flight `record()` on another task's offer can `JSON.parse` a
 *    half-written file, fail, and silently fall back to `{}` (see `load()`)
 *    — resolving what should have been a resume to a fresh workspace.
 *    `save()` below instead writes to a private temp file in the same
 *    directory and `fs.rename`s it onto the real path, which POSIX
 *    guarantees is atomic when both paths share a filesystem (true here —
 *    same directory): any concurrent reader sees either the fully-old or
 *    fully-new bytes, never a partial write.
 * 2. **No lost updates.** Two `record()` calls for two different
 *    `sessionRef`s that overlap (both `load()` the same on-disk snapshot,
 *    each mutate their own key into their own in-memory copy, then `save()`
 *    back to back) would otherwise let the second `save()` overwrite the
 *    first's key with a snapshot that never saw it — each individual
 *    `save()` being atomic does not prevent this. `enqueue()` below chains
 *    every `get()`/`record()` through one serial promise queue per
 *    instance, so no two load-modify-save cycles (or a read and a
 *    concurrent write) ever interleave.
 */
export class SessionWorkspaceStore {
  private readonly filePath: string;

  /**
   * Serial "mutex" queue: every `get()`/`record()` chains its work off this
   * promise and replaces it, so operations on this instance always run
   * one-at-a-time, in call order — never interleaved. The queue's own tail
   * is never allowed to reject (a failed task must not wedge every
   * subsequent caller behind a rejected promise); the failure still
   * propagates to that call's own caller via the returned promise.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(storeDir: string) {
    this.filePath = path.join(storeDir, 'session-workspaces.json');
  }

  async get(sessionRef: string): Promise<SessionWorkspaceRecord | undefined> {
    return this.enqueue(async () => {
      const all = await this.load();
      const entry = all[sessionRef];
      if (!entry) return undefined;
      return { workspaceDir: entry.workspaceDir, runtimeSessionId: entry.runtimeSessionId };
    });
  }

  async record(sessionRef: string, entry: SessionWorkspaceRecord): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.load();
      all[sessionRef] = {
        workspaceDir: entry.workspaceDir,
        runtimeSessionId: entry.runtimeSessionId,
        updatedAt: new Date().toISOString(),
      };
      await this.save(all);
    });
  }

  /** See the class doc comment's "no lost updates" property. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    // Swallow here (not on `result`, which the caller still awaits/rejects
    // on normally) purely so a rejected task doesn't permanently wedge the
    // queue for every operation enqueued after it.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<StoredShape> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredShape(parsed)) return {};
      const result: StoredShape = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (isStoredEntry(value)) result[key] = value;
      }
      return result;
    } catch {
      // Fail safe on a corrupt/torn file: treat it as empty rather than
      // throwing (see `task-runner.ts`'s `handleOffer`, which must always
      // be able to resolve "no known workspace" and continue with a fresh
      // one). `save()`'s atomic rename is what prevents this from actually
      // happening for writes made through this class; this remains only a
      // defense for a file corrupted some other way (hand-edited, an old
      // pre-fix write, etc).
      return {};
    }
  }

  private async save(all: StoredShape): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Same directory as the real target (required for `fs.rename` to be
    // atomic on POSIX — same filesystem), and unique per call so two
    // instances/processes racing to save never collide on the same temp
    // path (see `tmpSeq`'s doc comment).
    const tmpPath = `${this.filePath}.${process.pid}-${tmpSeq++}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(all, null, 2), 'utf8');
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }
  }
}
