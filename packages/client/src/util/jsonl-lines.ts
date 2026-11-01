/**
 * The one JSONL line framing every SDK-owned line transport uses: the runtime
 * child readers (`runtime/owned-line-process.ts`, `adapters/pi/rpc-client.ts`)
 * and the Pi hosts that read the daemon's frames on stdin.
 *
 * LF (`\n`) is the only record delimiter and one trailing `\r` is stripped.
 * `node:readline` is deliberately not used: it also splits on U+2028 and
 * U+2029, which `JSON.stringify` leaves unescaped inside strings, so a valid
 * frame would arrive as two invalid ones. Splitting happens on bytes, before
 * decoding: 0x0A never occurs inside a multi-byte UTF-8 sequence, so a chunk
 * boundary inside a character cannot corrupt a line. Empty lines are skipped.
 */
export interface JsonlLineDecoder {
  /** Feeds one chunk. Complete lines reach `onLine` synchronously, in order. */
  push(chunk: Buffer | string): void;
  /** Bytes of an unterminated last line still held. */
  readonly pendingBytes: number;
  /** Drops the held bytes and every later chunk; `onLine` is never called again. */
  stop(): void;
}

export interface JsonlLineDecoderOptions {
  onLine(line: string): void;
  /**
   * Byte budget of one line, LF excluded. A line that would exceed it calls
   * `onOverflow` and stops the decoder. Absent: unbounded.
   */
  readonly maxLineBytes?: number;
  onOverflow?(): void;
}

export function createJsonlLineDecoder(options: JsonlLineDecoderOptions): JsonlLineDecoder {
  let held = Buffer.alloc(0);
  let stopped = false;
  const stop = (): void => { stopped = true; held = Buffer.alloc(0); };
  return {
    push(chunk) {
      if (stopped) return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      let offset = 0;
      while (offset < bytes.length && !stopped) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline === -1 ? bytes.length : newline;
        if (options.maxLineBytes !== undefined && held.length + end - offset > options.maxLineBytes) {
          stop();
          options.onOverflow?.();
          return;
        }
        held = held.length === 0 ? Buffer.from(bytes.subarray(offset, end)) : Buffer.concat([held, bytes.subarray(offset, end)]);
        if (newline === -1) return;
        const text = held.toString('utf8');
        held = Buffer.alloc(0);
        const line = text.endsWith('\r') ? text.slice(0, -1) : text;
        if (line.length > 0) options.onLine(line);
        offset = newline + 1;
      }
    },
    get pendingBytes() { return held.length; },
    stop,
  };
}

/**
 * Reads JSONL lines from a stream until it ends or `close()` is called, the
 * replacement for a `readline` interface over stdin. `closed` resolves once,
 * on either; an unterminated last line is dropped.
 */
export function readJsonlLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): { close(): void; readonly closed: Promise<void> } {
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const decoder = createJsonlLineDecoder({ onLine });
  const onData = (chunk: Buffer | string): void => decoder.push(chunk);
  const close = (): void => {
    decoder.stop();
    stream.off('data', onData);
    stream.off('end', close);
    stream.off('close', close);
    stream.pause();
    resolveClosed();
  };
  stream.on('data', onData);
  stream.once('end', close);
  stream.once('close', close);
  return { close, closed };
}
