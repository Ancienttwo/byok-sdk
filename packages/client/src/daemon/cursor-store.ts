import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Persists the highest processed server->daemon envelope `seq` per
 * (server, device) pair (protocol §9, at-least-once redelivery), so a
 * restarted daemon can send an accurate `conn.hello.cursor` and the server
 * can skip re-delivering envelopes it already knows were handled. Keyed by a
 * hash of `serverUrl` + `deviceId` together (not just `serverUrl`) so
 * filenames stay filesystem-safe regardless of scheme/port/path.
 *
 * Finding F5 (stale cursor across re-pair): `POST /byok/pair` always mints a
 * brand new `deviceId` (see `packages/server/src/http.ts`), including on a
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
export class CursorStore {
  constructor(private readonly storeDir: string) {}

  private fileFor(serverUrl: string, deviceId: string): string {
    const key = createHash('sha256').update(`${serverUrl}::${deviceId}`).digest('hex').slice(0, 32);
    return path.join(this.storeDir, `cursor-${key}.json`);
  }

  async load(serverUrl: string, deviceId: string): Promise<number | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.fileFor(serverUrl, deviceId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as { cursor?: unknown };
      return typeof parsed.cursor === 'number' ? parsed.cursor : undefined;
    } catch {
      return undefined;
    }
  }

  async save(serverUrl: string, deviceId: string, cursor: number): Promise<void> {
    const file = this.fileFor(serverUrl, deviceId);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify({ cursor }), 'utf8');
  }

  /** Remove any persisted cursor for (serverUrl, deviceId) — a no-op if none exists. Called from `pair()` (finding F5) so a device that's about to be replaced never leaves a cursor a future, unrelated device could somehow inherit. */
  async clear(serverUrl: string, deviceId: string): Promise<void> {
    await fs.rm(this.fileFor(serverUrl, deviceId), { force: true });
  }
}
