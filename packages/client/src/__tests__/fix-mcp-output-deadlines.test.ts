/** S18-1: inert streams prove a session-wide output bound, independently of live handlers. */
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createBoundedFrameWriter } from '../mcp-server/framing';
import { serveMcpOverStdio, type McpServerCloseReason, type McpServerOptions } from '../mcp-server';

const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_FRAMES = 256;
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class ManualSink extends Writable {
  readonly frames: string[] = [];
  private readonly callbacks: (() => void)[] = [];

  constructor(highWaterMark = 1) {
    super({ highWaterMark });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.frames.push(chunk.toString('utf8'));
    this.callbacks.push(done);
  }

  flushOne(): void {
    this.callbacks.shift()?.();
  }
}

function start(overrides: Partial<McpServerOptions> = {}, highWaterMark = 1) {
  const input = new PassThrough();
  const output = new ManualSink(highWaterMark);
  const closes: McpServerCloseReason[] = [];
  let notify = (): void => {};
  const unsubscribe = vi.fn();
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'x'.repeat(65_536) }] }));
  const handle = serveMcpOverStdio({
    input,
    output,
    serverInfo: { name: 'inert-output-bound', version: '0' },
    tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    maxInFlight: 1,
    callTool,
    onClose: (reason) => closes.push(reason),
    toolsListChanged: { onToolsListChanged: (callback) => { notify = callback; return unsubscribe; } },
    ...overrides,
  });
  return {
    input, output, closes, callTool, handle, unsubscribe,
    notify: () => notify(),
    send: (message: unknown) => input.write(`${JSON.stringify(message)}\n`),
  };
}

function expectClosed(h: ReturnType<typeof start>): void {
  expect(h.closes).toEqual([{
    kind: 'outbound-buffer-limit', limitBytes: MAX_PENDING_BYTES, limitFrames: MAX_PENDING_FRAMES,
  }]);
  expect(h.input.isPaused()).toBe(true);
  expect(h.input.listenerCount('data')).toBe(0);
  expect(h.unsubscribe).toHaveBeenCalledOnce();
  expect(h.output.listenerCount('drain')).toBe(0);
  expect(h.output.listenerCount('close')).toBe(0);
  expect(h.output.listenerCount('error')).toBe(0);
}

describe('S18-1: aggregate pending MCP output', () => {
  it.each([1, 16 * 1024 * 1024])('bounds completed 64-KiB responses with maxInFlight=1 and highWaterMark=%i', async (highWaterMark) => {
    const h = start({}, highWaterMark);
    try {
      for (let id = 1; id <= 200 && h.closes.length === 0; id += 1) {
        h.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo' } });
        await turn();
      }
      expectClosed(h);
      expect(h.callTool).toHaveBeenCalledTimes(64);
      // Includes bytes accepted by the Writable even if write() returned true.
      expect(h.output.writableLength).toBeLessThanOrEqual(MAX_PENDING_BYTES);
      const calls = h.callTool.mock.calls.length;
      h.send({ jsonrpc: '2.0', id: 201, method: 'tools/call', params: { name: 'echo' } });
      h.notify();
      await turn();
      expect(h.callTool).toHaveBeenCalledTimes(calls);
      expect(h.closes).toHaveLength(1);
      // With write(false), only the first accepted frame reached the stream;
      // closing drops the remaining writer queue instead of resuming on drain.
      if (highWaterMark === 1) {
        h.output.flushOne();
        await turn();
        expect(h.output.frames).toHaveLength(1);
      }
    } finally { h.handle.close(); h.input.destroy(); h.output.destroy(); }
  });

  it.each(['ping', 'tools/list', 'unknown-method', 'parse-error', 'duplicate-id', 'list-changed'])('caps non-tool output from %s at 256 pending frames', async (path) => {
    const h = start();
    const emit = (id: number): void => {
      if (path === 'list-changed') h.notify();
      else if (path === 'parse-error') h.input.write('{broken\n');
      else h.send({ jsonrpc: '2.0', id: path === 'duplicate-id' ? 1 : id, method: path === 'duplicate-id' ? 'ping' : path });
    };
    try {
      for (let id = 1; id <= MAX_PENDING_FRAMES; id += 1) emit(id);
      expect(h.closes).toEqual([]);
      expect(h.output.frames).toHaveLength(1);
      emit(MAX_PENDING_FRAMES + 1);
      expectClosed(h);
      h.output.flushOne();
      await turn();
      expect(h.output.frames).toHaveLength(1);
      expect(h.callTool).not.toHaveBeenCalled();
    } finally { h.handle.close(); h.input.destroy(); h.output.destroy(); }
  });

  it('counts small frames buffered by a Writable even when write() returns true', () => {
    const h = start({}, 16 * 1024 * 1024);
    try {
      for (let id = 1; id <= MAX_PENDING_FRAMES; id += 1) h.send({ jsonrpc: '2.0', id, method: 'ping' });
      expect(h.closes).toEqual([]);
      h.send({ jsonrpc: '2.0', id: MAX_PENDING_FRAMES + 1, method: 'ping' });
      expectClosed(h);
    } finally { h.handle.close(); h.input.destroy(); h.output.destroy(); }
  });

  it('uses UTF-8 bytes, allows the exact aggregate byte boundary and restores capacity after drain', async () => {
    const output = new ManualSink();
    const writer = createBoundedFrameWriter({ output, maxFrameBytes: 1_048_576 });
    const frame = `${'é'.repeat(524_287)}a\n`;
    expect(Buffer.byteLength(frame, 'utf8')).toBe(1_048_576);
    try {
      for (let index = 0; index < 4; index += 1) expect(writer.write(frame)).toBeUndefined();
      expect(writer.write('\n')).toBe('pending-limit');
      output.flushOne();
      await turn();
      expect(writer.write(frame)).toBeUndefined();
      expect(writer.write('\n')).toBe('pending-limit');
      // Per-frame rejection still takes precedence and never consumes capacity.
      expect(writer.write(`${frame}x`)).toBe(1_048_577);
    } finally { writer.stop(); output.destroy(); }
  });

  it('unsubscribes if an emitter exhausts the output budget synchronously during subscription', () => {
    const unsubscribe = vi.fn();
    const h = start({ toolsListChanged: { onToolsListChanged: (notify) => {
      for (let index = 0; index <= MAX_PENDING_FRAMES; index += 1) notify();
      return unsubscribe;
    } } });
    try {
      expect(h.closes).toHaveLength(1);
      expect(h.closes[0]?.kind).toBe('outbound-buffer-limit');
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(h.output.listenerCount('drain')).toBe(0);
    } finally { h.handle.close(); h.input.destroy(); h.output.destroy(); }
  });

  it('aborts an active tool and stops reading the rest of an input chunk on buffer exhaustion', async () => {
    let signal: AbortSignal | undefined;
    const h = start({ callTool: async (call) => {
      signal = call.signal;
      await new Promise<void>((resolve) => call.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { done: true };
    } });
    try {
      h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
      // In-flight refusal responses bypass handler admission but not output admission.
      const requests = Array.from({ length: 300 }, (_, index) => JSON.stringify({
        jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name: 'echo' },
      }));
      h.input.write(`${requests.join('\n')}\n`);
      expectClosed(h);
      expect(signal?.aborted).toBe(true);
      await turn();
      expect(h.output.frames).toHaveLength(1);
    } finally { h.handle.close(); h.input.destroy(); h.output.destroy(); }
  });

  it('allows cancellation while output is stalled below the limit', async () => {
    let signal: AbortSignal | undefined;
    const h = start({ callTool: async (call) => {
      signal = call.signal;
      await new Promise<void>((resolve) => call.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { late: true };
    } });
    try {
      h.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo' } });
      h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
      expect(signal?.aborted).toBe(true);
      await turn();
      expect(h.closes).toEqual([]);
      expect(h.output.frames).toHaveLength(1);
    } finally { h.handle.close(); h.input.destroy(); h.output.destroy(); }
  });

  it('reclaims capacity on completed writes and preserves accepted response order across repeated drains', async () => {
    const h = start();
    try {
      for (let round = 0; round < 3; round += 1) {
        for (let index = 1; index <= 100; index += 1) h.send({ jsonrpc: '2.0', id: round * 100 + index, method: 'ping' });
        for (let index = 0; index < 100; index += 1) { h.output.flushOne(); await turn(); }
      }
      expect(h.closes).toEqual([]);
      expect(h.output.frames.map((frame) => JSON.parse(frame).id)).toEqual(Array.from({ length: 300 }, (_, index) => index + 1));
      expect(h.output.writableLength).toBe(0);
    } finally { h.handle.close(); h.input.destroy(); h.output.destroy(); }
  });

  it.each(['explicit', 'eof', 'inbound-limit', 'outbound-limit'])('releases a blocked drain waiter on %s close', async (path) => {
    const h = start({ maxLineBytes: 256, maxOutboundFrameBytes: 256 });
    try {
      h.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      h.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
      expect(h.output.listenerCount('drain')).toBe(1);
      if (path === 'explicit') h.handle.close();
      else if (path === 'eof') h.input.end();
      else if (path === 'inbound-limit') h.input.write('x'.repeat(257));
      else h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo' } });
      await turn();
      expect(h.output.listenerCount('drain')).toBe(0);
      expect(h.output.listenerCount('close')).toBe(0);
      expect(h.output.listenerCount('error')).toBe(0);
      h.output.flushOne();
      await turn();
      expect(h.output.frames).toHaveLength(1);
    } finally { h.handle.close(); h.input.destroy(); h.output.destroy(); }
  });
});
