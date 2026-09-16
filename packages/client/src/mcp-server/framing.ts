/**
 * The two byte-level halves of the MCP stdio transport, both BOUNDED.
 *
 * MCP's stdio transport is newline-delimited JSON in both directions. Neither
 * direction is bounded by the transport itself, and the SDK has already been
 * bitten by that on the client side: `mcp/client.ts` caps a single inbound
 * frame at `MCP_MAX_FRAME_BYTES` precisely because a peer that never emits a
 * newline would otherwise grow this process's heap without limit. The server
 * side needs the same guarantee, and needs it OUTBOUND too — an oversized
 * answer reaches the official client only as a generic `Connection closed`,
 * with the real reason on `transport.onerror`, so a half-written line would
 * hand the peer garbage to parse instead of a legible failure.
 *
 * Hence: the reader owns the split (`readline` has no byte bound at all), and
 * the writer refuses an over-cap frame ENTIRELY rather than truncating it.
 */

/** `\n`. UTF-8 never encodes a continuation byte as 0x0A, so a raw byte split is safe for multi-byte text. */
const NEWLINE_BYTE = 0x0a;

export interface BoundedLineReaderOptions {
  readonly input: NodeJS.ReadableStream;
  /** Maximum bytes between two newlines. Exceeding it is fatal to the session. */
  readonly maxLineBytes: number;
  /** One complete line, newline stripped, decoded as UTF-8. */
  readonly onLine: (line: string) => void;
  /** The byte bound was breached. Nothing further is read, parsed, or answered. */
  readonly onLimit: () => void;
  /** The read side ended cleanly. */
  readonly onEnd: () => void;
}

export interface BoundedLineReader {
  /** Detach from the stream and stop delivering lines. Idempotent. */
  stop(): void;
}

/**
 * Reads raw bytes and delivers complete lines, counting bytes since the last
 * newline ACROSS chunks. The moment that count would exceed `maxLineBytes` the
 * reader detaches: no further buffering, no parse attempt, no callback except
 * `onLimit`.
 *
 * "Ending the read side" here means detaching and pausing, not destroying the
 * caller's stream: the core never decides this process's lifetime (the bin
 * does), and a server that owns `process.stdin` must not tear it out from under
 * whatever else the host wired to it.
 *
 * An unterminated trailing segment at EOF is DISCARDED, not delivered. A frame
 * without its newline is not a frame; delivering it would mean answering a
 * request the peer may never have finished writing.
 */
export function createBoundedLineReader(options: BoundedLineReaderOptions): BoundedLineReader {
  const { input, maxLineBytes, onLine, onLimit, onEnd } = options;
  let segments: Buffer[] = [];
  let pendingBytes = 0;
  let stopped = false;

  const detach = (): void => {
    input.off('data', handleData);
    input.off('end', handleEnd);
    input.pause();
    segments = [];
    pendingBytes = 0;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    detach();
  };

  function handleData(chunk: Buffer | string): void {
    if (stopped) return;
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let offset = 0;
    for (;;) {
      const newlineAt = buffer.indexOf(NEWLINE_BYTE, offset);
      if (newlineAt === -1) {
        const rest = buffer.length - offset;
        if (pendingBytes + rest > maxLineBytes) {
          stop();
          onLimit();
          return;
        }
        if (rest > 0) {
          segments.push(Buffer.from(buffer.subarray(offset)));
          pendingBytes += rest;
        }
        return;
      }
      const sliceLength = newlineAt - offset;
      if (pendingBytes + sliceLength > maxLineBytes) {
        stop();
        onLimit();
        return;
      }
      segments.push(Buffer.from(buffer.subarray(offset, newlineAt)));
      const line = Buffer.concat(segments).toString('utf8');
      segments = [];
      pendingBytes = 0;
      offset = newlineAt + 1;
      onLine(line);
      if (stopped) return;
    }
  }

  function handleEnd(): void {
    if (stopped) return;
    stopped = true;
    detach();
    onEnd();
  }

  input.on('data', handleData);
  input.on('end', handleEnd);
  return { stop };
}

export interface BoundedFrameWriterOptions {
  readonly output: NodeJS.WritableStream;
  /** Maximum UTF-8 bytes of one encoded frame, newline included. */
  readonly maxFrameBytes: number;
}

export interface BoundedFrameWriter {
  /**
   * Queues one already-encoded frame (JSON + `\n`).
   *
   * Returns the frame's UTF-8 byte length when it exceeds the cap — in which
   * case NOTHING was written and nothing ever will be for that frame — and
   * `undefined` when the frame was accepted. Never emits a partial line.
   */
  write(frame: string): number | undefined;
  /** Drop the queue and refuse every later frame. Idempotent. */
  stop(): void;
}

/**
 * One shared writer for the whole session, so concurrently settling handlers
 * can never interleave halves of two frames, and `write()` returning `false`
 * parks the queue until `'drain'` instead of letting handlers run ahead of the
 * pipe.
 *
 * The queue is bounded transitively: the only unsolicited frames are responses,
 * and the number of outstanding responses is capped by the session's in-flight
 * bound.
 */
export function createBoundedFrameWriter(options: BoundedFrameWriterOptions): BoundedFrameWriter {
  const { output, maxFrameBytes } = options;
  const queue: string[] = [];
  let pumping = false;
  let stopped = false;

  async function pump(): Promise<void> {
    pumping = true;
    try {
      while (queue.length > 0 && !stopped) {
        const frame = queue.shift() as string;
        if (output.write(frame)) continue;
        if (stopped) return;
        await new Promise<void>((resolve) => {
          const done = (): void => {
            output.off('drain', done);
            output.off('close', done);
            output.off('error', done);
            resolve();
          };
          output.once('drain', done);
          output.once('close', done);
          output.once('error', done);
        });
      }
    } finally {
      pumping = false;
    }
  }

  return {
    write(frame: string): number | undefined {
      if (stopped) return undefined;
      const bytes = Buffer.byteLength(frame, 'utf8');
      if (bytes > maxFrameBytes) return bytes;
      queue.push(frame);
      if (!pumping) void pump();
      return undefined;
    },
    stop(): void {
      stopped = true;
      queue.length = 0;
    },
  };
}
