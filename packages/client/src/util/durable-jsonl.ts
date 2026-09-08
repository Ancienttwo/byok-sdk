import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomic-write';

/** File mechanics only. The caller owns replay, identity and serialized mutations. */
export class DurableJsonlFile {
  private failure: unknown;
  constructor(readonly filePath: string) {}

  assertWritable(): void {
    if (this.failure !== undefined) {
      throw new Error('durable JSONL writer is quarantined after uncertain I/O; reopen and validate the log before retrying', { cause: this.failure });
    }
  }

  /** Replay is not a durability receipt: confirm the recovered bytes before use. */
  async confirmRecovered(): Promise<void> {
    let handle;
    try { handle = await fs.open(this.filePath, 'r+'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try { await handle.sync(); } finally { await handle.close(); }
    await this.syncDirectory();
  }

  async append(json: string): Promise<void> {
    this.assertWritable();
    try {
      const handle = await fs.open(this.filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
      try {
        const bytes = Buffer.from(`${json}\n`, 'utf8');
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
          if (bytesWritten <= 0) throw new Error('durable JSONL append made no progress');
          offset += bytesWritten;
        }
        await handle.sync();
      } finally { await handle.close(); }
      // Also makes a newly created log's directory entry durable on POSIX.
      await this.syncDirectory();
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  async replace(lines: readonly string[]): Promise<void> {
    this.assertWritable();
    try {
      await atomicWriteFile(this.filePath, lines.map(line => `${line}\n`).join(''), { mode: 0o600, fsync: true });
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  private async syncDirectory(): Promise<void> {
    // Node/libuv exposes no directory FlushFileBuffers on Windows.
    if (process.platform === 'win32') return;
    const directory = await fs.open(path.dirname(this.filePath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
