import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Persists the highest processed server->daemon envelope `seq` per server
 * (protocol §9, at-least-once redelivery), so a restarted daemon can send an
 * accurate `conn.hello.cursor` and the server can skip re-delivering
 * envelopes it already knows were handled. Keyed by a hash of `serverUrl`
 * (not the raw URL) so filenames stay filesystem-safe regardless of
 * scheme/port/path.
 */
export class CursorStore {
  constructor(private readonly storeDir: string) {}

  private fileFor(serverUrl: string): string {
    const key = createHash('sha256').update(serverUrl).digest('hex').slice(0, 32);
    return path.join(this.storeDir, `cursor-${key}.json`);
  }

  async load(serverUrl: string): Promise<number | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.fileFor(serverUrl), 'utf8');
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

  async save(serverUrl: string, cursor: number): Promise<void> {
    const file = this.fileFor(serverUrl);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify({ cursor }), 'utf8');
  }
}
