import { promises as fs, constants } from 'node:fs';
import type { NativeSessionsIO } from './renderer.js';

/** Renderer owns read/record/time budgets; this adapter only opens existing, read-only files. */
export const nativeSessionsIO: NativeSessionsIO = {
  async lstat(file, signal) {
    signal.throwIfAborted();
    const stat = await fs.lstat(file);
    signal.throwIfAborted();
    return { kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other' };
  },
  async realpath(file, signal) {
    signal.throwIfAborted();
    const resolved = await fs.realpath(file);
    signal.throwIfAborted();
    return resolved;
  },
  async *list(directory, signal) {
    signal.throwIfAborted();
    const cursor = await fs.opendir(directory);
    for await (const entry of cursor) {
      signal.throwIfAborted();
      yield entry.name;
    }
  },
  async open(file, signal) {
    signal.throwIfAborted();
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      signal.throwIfAborted();
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('native session source is not a regular file');
      return {
        size: stat.size,
        async read(offset, length, readSignal) {
          readSignal.throwIfAborted();
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          readSignal.throwIfAborted();
          return buffer.subarray(0, bytesRead);
        },
        close: () => handle.close(),
      };
    } catch (error) { await handle.close(); throw error; }
  },
};
