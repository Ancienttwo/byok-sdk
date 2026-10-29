import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { atomicWriteFile } from '../util/atomic-write';

/**
 * Persists the highest processed server->daemon envelope `seq` per
 * (server, device) pair (protocol §9, at-least-once redelivery), so a
 * restarted daemon can send an accurate `conn.hello.cursor` and the server
 * can skip re-delivering envelopes it already knows were handled. Keyed by a
 * hash of `serverUrl` + `deviceId` together (not just `serverUrl`) so
 * filenames stay filesystem-safe regardless of scheme/port/path.
 *
 * Finding F5 (stale cursor across re-pair): `POST /byok/pair` always mints a
 * brand new `deviceId` (see `packages/cloud/src/auth/plane.ts`), including on a
 * re-pair against the same `serverUrl` (e.g. recovering from revocation,
 * protocol §6.3). A cursor keyed by `serverUrl` alone would hand the fresh
 * device's very first connection a stale, unrelated cursor value left over
 * from whatever device previously used this URL — the new device's own
 * server-side outbox starts its `seq` counter back at 1, so that stale
 * cursor would make the server's redelivery filter (`seq > cursor`) throw
 * away every legitimate envelope sent to it. Keying by the pair means a new
 * deviceId always starts with a genuinely fresh (absent) cursor entry;
 * `clear()` additionally lets `create-daemon.ts`'s `pair()` proactively wipe
 * the previous device's entry for this `serverUrl` as a hygiene measure.
 */
/**
 * #1121: the cursor file exists but holds no usable cursor, or cannot be read.
 * Never read as "no cursor": a missing cursor means a fresh device, and a
 * fresh device must not be inferred from a damaged store. Startup halts with
 * `cursor_unreadable`; the operator resets the cursor with
 * `byok-agent doctor --repair reset-cursor --yes` (or `resetDeviceCursor`).
 */
export class CursorUnreadableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('the durable delivery cursor is unreadable', options);
    this.name = 'CursorUnreadableError';
  }
}

export class CursorStore {
  constructor(private readonly storeDir: string) {}

  private fileFor(serverUrl: string, deviceId: string): string {
    const key = createHash('sha256').update(`${serverUrl}::${deviceId}`).digest('hex').slice(0, 32);
    return path.join(this.storeDir, `cursor-${key}.json`);
  }

  /**
   * `undefined` only when no cursor file exists. A file that cannot be read,
   * or that holds anything but a nonnegative integer cursor (the same guard
   * the server applies to `GET /byok/events?cursor=`), throws
   * {@link CursorUnreadableError}.
   */
  async load(serverUrl: string, deviceId: string): Promise<number | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.fileFor(serverUrl, deviceId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new CursorUnreadableError({ cause: err });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CursorUnreadableError({ cause: err });
    }
    const v = typeof parsed === 'object' && parsed !== null ? (parsed as { cursor?: unknown }).cursor : undefined;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
    throw new CursorUnreadableError();
  }

  async save(serverUrl: string, deviceId: string, cursor: number): Promise<void> {
    const file = this.fileFor(serverUrl, deviceId);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Atomic (temp file + rename) so a `load()` racing an in-flight `save()`
    // (e.g. redelivery bookkeeping alongside a concurrent reconnect) never
    // observes a torn/partial file and falls back to `undefined` for a
    // cursor that was, in fact, already durably persisted — see
    // `util/atomic-write.ts`.
    await atomicWriteFile(file, JSON.stringify({ cursor }), { fsync: true });
  }

  /** Remove any persisted cursor for (serverUrl, deviceId) — a no-op if none exists. Called from `pair()` (finding F5) so a device that's about to be replaced never leaves a cursor a future, unrelated device could somehow inherit. */
  async clear(serverUrl: string, deviceId: string): Promise<void> {
    await fs.rm(this.fileFor(serverUrl, deviceId), { force: true });
  }
}
