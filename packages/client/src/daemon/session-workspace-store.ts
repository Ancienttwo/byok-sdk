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
 */
export class SessionWorkspaceStore {
  private readonly filePath: string;

  constructor(storeDir: string) {
    this.filePath = path.join(storeDir, 'session-workspaces.json');
  }

  async get(sessionRef: string): Promise<SessionWorkspaceRecord | undefined> {
    const all = await this.load();
    const entry = all[sessionRef];
    if (!entry) return undefined;
    return { workspaceDir: entry.workspaceDir, runtimeSessionId: entry.runtimeSessionId };
  }

  async record(sessionRef: string, entry: SessionWorkspaceRecord): Promise<void> {
    const all = await this.load();
    all[sessionRef] = {
      workspaceDir: entry.workspaceDir,
      runtimeSessionId: entry.runtimeSessionId,
      updatedAt: new Date().toISOString(),
    };
    await this.save(all);
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
      return {};
    }
  }

  private async save(all: StoredShape): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(all, null, 2), 'utf8');
  }
}
