/**
 * T3/T4/T6/T7: the tools-only stdio MCP server core, driven over in-memory
 * streams so every emitted byte — and every byte deliberately NOT emitted — is
 * observable.
 *
 * The interop suite next door proves a real `@modelcontextprotocol/client`
 * accepts what this core says. This suite proves the parts a well-behaved
 * client never exercises: the malformed envelopes it would never send, the
 * bounds a hostile or broken peer would breach, and the responses that must
 * never appear.
 */
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  MCP_SERVER_MAX_FRAME_BYTES,
  MCP_SERVER_MAX_IN_FLIGHT,
  MCP_SERVER_MAX_LINE_BYTES,
  MCP_SERVER_MAX_SEEN_IDS,
  MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS,
  McpServerFrameTooLargeError,
  McpServerToolError,
  serveMcpOverStdio,
  type McpServerCloseReason,
  type McpServerOptions,
  type McpServerToolCall,
} from '../mcp-server';

const TOOL = {
  name: 'echo',
  description: 'Echo the message back.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string' } } },
} as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(2);
  }
}

interface Harness {
  readonly lines: string[];
  readonly closes: McpServerCloseReason[];
  readonly stdin: PassThrough;
  send(message: unknown): void;
  sendRaw(raw: string): void;
  handle: { close(): void };
  /** Waits for `count` total emitted lines. */
  expectLines(count: number): Promise<void>;
  /** Asserts no line arrives within a quiet window. */
  expectSilence(ms?: number): Promise<void>;
  parsed(index: number): Record<string, unknown>;
}

function start(
  overrides: Partial<McpServerOptions> & { readonly callTool?: McpServerOptions['callTool'] } = {},
): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  const closes: McpServerCloseReason[] = [];
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
  const handle = serveMcpOverStdio({
    serverInfo: { name: 'core-test', version: '0.0.1' },
    tools: [TOOL],
    callTool: async (call) => ({ content: [{ type: 'text', text: `echo: ${String(call.arguments?.message ?? '')}` }] }),
    input: stdin,
    output: stdout,
    onClose: (reason) => closes.push(reason),
    ...overrides,
  });
  return {
    lines,
    closes,
    stdin,
    handle,
    send: (message) => stdin.write(`${JSON.stringify(message)}\n`),
    sendRaw: (raw) => stdin.write(raw),
    expectLines: (count) => waitUntil(() => lines.length >= count),
    expectSilence: async (ms = 40) => {
      const before = lines.length;
      await sleep(ms);
      expect(lines.slice(before)).toEqual([]);
    },
    parsed: (index) => JSON.parse(lines[index] as string) as Record<string, unknown>,
  };
}

async function initialize(harness: Harness, protocolVersion: string, id: number = 1): Promise<void> {
  const before = harness.lines.length;
  harness.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion } });
  await harness.expectLines(before + 1);
}

describe('the MCP server core: construction', () => {
  it('refuses a tools-only server with no tools, and two tools sharing a name', () => {
    const base = {
      serverInfo: { name: 'core-test', version: '0.0.1' },
      callTool: async () => ({}),
      input: new PassThrough(),
      output: new PassThrough(),
    };
    expect(() => serveMcpOverStdio({ ...base, tools: [] })).toThrow(/at least one tool/);
    expect(() => serveMcpOverStdio({ ...base, tools: [TOOL, { ...TOOL }] })).toThrow(/two tools named "echo"/);
  });

  it('pins the advertised version list and the published bounds', () => {
    expect([...MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS]).toEqual(['2025-11-25', '2025-06-18', '2024-11-05']);
    expect(MCP_SERVER_MAX_LINE_BYTES).toBe(1_048_576);
    expect(MCP_SERVER_MAX_FRAME_BYTES).toBe(1_048_576);
    expect(MCP_SERVER_MAX_IN_FLIGHT).toBe(64);
    expect(MCP_SERVER_MAX_SEEN_IDS).toBe(4096);
  });
});

describe('T7: capabilities are core authority', () => {
  it('advertises exactly {tools:{}} and cannot be widened through any option', async () => {
    // Deliberately smuggled: `capabilities`, `logging`, `resources` are not on
    // `McpServerOptions` at all, so this cast is the closest a caller can get.
    const harness = start({
      ...({ capabilities: { tools: {}, logging: {}, resources: {} }, logging: {}, resources: {} } as unknown as Partial<McpServerOptions>),
    });
    await initialize(harness, '2025-11-25');
    const result = harness.parsed(0).result as { capabilities: unknown; protocolVersion: string; serverInfo: unknown };
    expect(result.capabilities).toEqual({ tools: {} });
    expect(Object.keys(result.capabilities as object)).toEqual(['tools']);
    expect(result.serverInfo).toEqual({ name: 'core-test', version: '0.0.1' });
    harness.handle.close();
  });

  it('advertises listChanged and emits the notification ONLY when a real emitter is supplied', async () => {
    let notify: (() => void) | undefined;
    const harness = start({
      toolsListChanged: {
        onToolsListChanged: (fire) => {
          notify = fire;
          return () => {
            notify = undefined;
          };
        },
      },
    });
    await initialize(harness, '2025-11-25');
    expect((harness.parsed(0).result as { capabilities: unknown }).capabilities).toEqual({ tools: { listChanged: true } });

    notify?.();
    await harness.expectLines(2);
    expect(harness.parsed(1)).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    harness.handle.close();
  });
});

describe('T5-adjacent: initialize selects, never echoes', () => {
  for (const version of MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS) {
    it(`returns ${version} when the peer offers it`, async () => {
      const harness = start();
      await initialize(harness, version);
      expect((harness.parsed(0).result as { protocolVersion: string }).protocolVersion).toBe(version);
      harness.handle.close();
    });
  }

  for (const offered of ['2025-03-26', '2024-10-07', '2026-07-28', 'not-a-version']) {
    it(`answers the newest supported version when the peer offers ${offered}`, async () => {
      const harness = start();
      await initialize(harness, offered);
      expect((harness.parsed(0).result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
      harness.handle.close();
    });
  }

  it('answers the newest supported version when protocolVersion is absent or not a string', async () => {
    const harness = start();
    harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    harness.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 3 } });
    await harness.expectLines(2);
    expect((harness.parsed(0).result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    expect((harness.parsed(1).result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    harness.handle.close();
  });
});

describe('T6: parsing, id validation and the handler spy', () => {
  it('answers id 0 — the official client\'s very first id — rather than treating it as falsy', async () => {
    const harness = start();
    harness.send({ jsonrpc: '2.0', id: 0, method: 'ping' });
    await harness.expectLines(1);
    expect(harness.parsed(0)).toEqual({ jsonrpc: '2.0', id: 0, result: {} });
    harness.handle.close();
  });

  const INVALID: readonly { readonly label: string; readonly message: unknown; readonly echoesId: number | string | undefined }[] = [
    { label: 'id: null', message: { jsonrpc: '2.0', id: null, method: 'ping' }, echoesId: undefined },
    { label: 'id: 1.5', message: { jsonrpc: '2.0', id: 1.5, method: 'ping' }, echoesId: undefined },
    { label: 'id: {}', message: { jsonrpc: '2.0', id: {}, method: 'ping' }, echoesId: undefined },
    { label: 'id: []', message: { jsonrpc: '2.0', id: [], method: 'ping' }, echoesId: undefined },
    { label: 'id: true', message: { jsonrpc: '2.0', id: true, method: 'ping' }, echoesId: undefined },
    { label: 'missing jsonrpc', message: { id: 7, method: 'ping' }, echoesId: 7 },
    { label: 'wrong jsonrpc', message: { jsonrpc: '1.0', id: 8, method: 'ping' }, echoesId: 8 },
    { label: 'non-string method', message: { jsonrpc: '2.0', id: 9, method: 42 }, echoesId: 9 },
    { label: 'method absent on a message carrying an id', message: { jsonrpc: '2.0', id: 10 }, echoesId: 10 },
    { label: 'params is a string', message: { jsonrpc: '2.0', id: 11, method: 'ping', params: 'nope' }, echoesId: 11 },
    { label: 'params is a number', message: { jsonrpc: '2.0', id: 12, method: 'ping', params: 3 }, echoesId: 12 },
    { label: 'top-level array (batch)', message: [{ jsonrpc: '2.0', id: 13, method: 'ping' }], echoesId: undefined },
    { label: 'top-level scalar', message: 5, echoesId: undefined },
    { label: 'top-level null', message: null, echoesId: undefined },
  ];

  for (const invalid of INVALID) {
    it(`rejects ${invalid.label} with -32600 and never invokes the handler`, async () => {
      const callTool = vi.fn(async () => ({ never: true }));
      const harness = start({ callTool });
      harness.send(invalid.message);
      await harness.expectLines(1);
      const response = harness.parsed(0);
      expect((response.error as { code: number }).code).toBe(-32600);
      expect(response.result).toBeUndefined();
      if (invalid.echoesId === undefined) {
        // Before `initialize`, id-echo follows the newest revision, which omits
        // an id it could not read rather than nulling it.
        expect('id' in response).toBe(false);
      } else {
        expect(response.id).toBe(invalid.echoesId);
      }
      expect(callTool).not.toHaveBeenCalled();
      harness.handle.close();
    });
  }

  it('answers an unparseable line with -32700 and never invokes the handler', async () => {
    const callTool = vi.fn(async () => ({ never: true }));
    const harness = start({ callTool });
    harness.sendRaw('{not json at all\n');
    await harness.expectLines(1);
    expect((harness.parsed(0).error as { code: number }).code).toBe(-32700);
    expect('id' in harness.parsed(0)).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
    harness.handle.close();
  });

  it('rejects a duplicate id even after the first request has completed', async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const harness = start({ callTool });
    harness.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await harness.expectLines(1);
    expect(harness.parsed(0).result).toEqual({ ok: true });
    harness.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await harness.expectLines(2);
    expect(harness.parsed(1)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32600, message: 'request id already used in this session' },
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    harness.handle.close();
  });

  it('treats a string id and the same-looking number id as different ids', async () => {
    const harness = start();
    harness.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    harness.send({ jsonrpc: '2.0', id: '7', method: 'ping' });
    await harness.expectLines(2);
    expect(harness.parsed(0)).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect(harness.parsed(1)).toEqual({ jsonrpc: '2.0', id: '7', result: {} });
    harness.handle.close();
  });

  for (const version of MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS) {
    it(`under ${version}, notifications are never answered and unreadable-id errors follow that revision's rule`, async () => {
      const callTool = vi.fn(async () => ({ never: true }));
      const harness = start({ callTool });
      await initialize(harness, version);

      // A message with a string method and NO id key is a notification under
      // every revision: known or unknown, it produces no output line at all.
      harness.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      harness.send({ jsonrpc: '2.0', method: 'notifications/unheard-of' });
      harness.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo', arguments: {} } });
      await harness.expectSilence();
      expect(callTool).not.toHaveBeenCalled();

      const omitsId = version === '2025-11-25';
      harness.send({ jsonrpc: '2.0', id: null, method: 'ping' });
      harness.send([{ jsonrpc: '2.0', id: 2, method: 'ping' }]);
      harness.sendRaw('}not json\n');
      await harness.expectLines(4);

      for (const [index, code] of [
        [1, -32600],
        [2, -32600],
        [3, -32700],
      ] as const) {
        const response = harness.parsed(index);
        expect((response.error as { code: number }).code).toBe(code);
        expect('id' in response, `${version} index ${index}`).toBe(!omitsId);
        if (!omitsId) expect(response.id).toBeNull();
      }

      // A readable id is ALWAYS echoed, under every revision.
      harness.send({ jsonrpc: '2.0', id: 21, method: 'ping', params: 'nope' });
      await harness.expectLines(5);
      expect(harness.parsed(4).id).toBe(21);
      expect(callTool).not.toHaveBeenCalled();
      harness.handle.close();
    });
  }

  it('answers -32601 for an unknown method, naming it', async () => {
    const harness = start();
    harness.send({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    await harness.expectLines(1);
    expect(harness.parsed(0)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'unknown method: resources/list' },
    });
    harness.handle.close();
  });

  it('rejects a tools/call with no string params.name without reaching the handler', async () => {
    const callTool = vi.fn(async () => ({ never: true }));
    const harness = start({ callTool });
    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    await harness.expectLines(1);
    expect(harness.parsed(0)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'tools/call requires a string params.name' },
    });
    expect(callTool).not.toHaveBeenCalled();
    harness.handle.close();
  });

  it('forwards an undefined tool name to the server rather than ruling on it', async () => {
    const seen: string[] = [];
    const harness = start({
      callTool: async (call) => {
        seen.push(call.name);
        throw new McpServerToolError(-32602, `unknown tool "${call.name}"`);
      },
    });
    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } });
    await harness.expectLines(1);
    expect(seen).toEqual(['not_a_tool']);
    expect(harness.parsed(0)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'unknown tool "not_a_tool"' },
    });
    harness.handle.close();
  });

  it('serves tools/list from the caller\'s JSON Schema verbatim, with no pagination cursor', async () => {
    const harness = start();
    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await harness.expectLines(1);
    expect(harness.parsed(0).result).toEqual({
      tools: [{ name: TOOL.name, description: TOOL.description, inputSchema: TOOL.inputSchema }],
    });
    harness.handle.close();
  });
});

describe('T3: bounded frames, both directions', () => {
  it('(a) fails closed on an inbound line that exceeds the byte bound ACROSS chunks', async () => {
    const callTool = vi.fn(async () => ({ never: true }));
    const harness = start({ maxLineBytes: 64, callTool });
    // 65 bytes, no newline, delivered as five chunks — none of which alone
    // exceeds the bound.
    for (let index = 0; index < 5; index += 1) harness.sendRaw('x'.repeat(13));
    await waitUntil(() => harness.closes.length > 0);
    expect(harness.closes).toEqual([{ kind: 'frame-limit', limitBytes: 64 }]);
    expect(harness.lines).toEqual([]);
    expect(callTool).not.toHaveBeenCalled();

    // The read side really ended: a well-formed request afterwards is ignored.
    harness.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await harness.expectSilence();
    expect(harness.closes).toHaveLength(1);
  });

  it('accepts a line of exactly the bound', async () => {
    const harness = start({ maxLineBytes: 64 });
    const request = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const encoded = JSON.stringify(request);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(64);
    harness.sendRaw(`${encoded}\n`);
    await harness.expectLines(1);
    expect(harness.closes).toEqual([]);
    harness.handle.close();
  });

  it('(b) writes NOTHING for an over-cap outbound frame and closes fail-closed', async () => {
    const harness = start({
      maxOutboundFrameBytes: 256,
      callTool: async () => ({ content: [{ type: 'text', text: 'x'.repeat(4_000) }] }),
    });
    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await waitUntil(() => harness.closes.length > 0);

    // Not a truncated prefix, not a partial JSON line: nothing at all.
    expect(harness.lines).toEqual([]);
    const reason = harness.closes[0];
    expect(reason?.kind).toBe('outbound-frame-limit');
    if (reason?.kind !== 'outbound-frame-limit') throw new Error('expected an outbound-frame-limit close');
    expect(reason.limitBytes).toBe(256);
    expect(reason.bytes).toBeGreaterThan(4_000);
    expect(reason.error).toBeInstanceOf(McpServerFrameTooLargeError);
    expect(reason.error.requestId).toBe(1);
    expect(reason.error.bytes).toBe(reason.bytes);
    expect(reason.error.limitBytes).toBe(256);

    // The session is closed: a later request is neither read nor answered.
    harness.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await harness.expectSilence();
    expect(harness.closes).toHaveLength(1);
  });

  it('(c) honours backpressure: no frame is written while the pipe is full, and order is preserved', async () => {
    class ManualSink extends Writable {
      readonly delivered: string[] = [];
      private readonly pending: (() => void)[] = [];

      constructor() {
        super({ highWaterMark: 1 });
      }

      override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
        this.delivered.push(chunk.toString('utf8'));
        this.pending.push(done);
      }

      flushOne(): boolean {
        const next = this.pending.shift();
        if (next === undefined) return false;
        next();
        return true;
      }
    }

    const sink = new ManualSink();
    const stdin = new PassThrough();
    const handle = serveMcpOverStdio({
      serverInfo: { name: 'core-test', version: '0.0.1' },
      tools: [TOOL],
      callTool: async () => ({ ok: true }),
      input: stdin,
      output: sink,
    });
    for (const id of [1, 2, 3, 4]) stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })}\n`);

    await waitUntil(() => sink.delivered.length >= 1);
    // The pipe is full after the first frame and the writer parked: it did not
    // spin the remaining frames into the stream.
    await sleep(40);
    expect(sink.delivered).toHaveLength(1);

    for (let index = 0; index < 4; index += 1) {
      sink.flushOne();
      await waitUntil(() => sink.delivered.length >= Math.min(index + 2, 4));
    }
    expect(sink.delivered.map((frame) => (JSON.parse(frame.trim()) as { id: number }).id)).toEqual([1, 2, 3, 4]);
    for (const frame of sink.delivered) expect(frame.endsWith('\n')).toBe(true);
    handle.close();
  });
});

describe('T4: cancellation', () => {
  function deferredCallTool(): {
    readonly calls: McpServerToolCall[];
    resolveAll(): void;
    readonly callTool: McpServerOptions['callTool'];
  } {
    const calls: McpServerToolCall[] = [];
    const resolvers: (() => void)[] = [];
    return {
      calls,
      resolveAll: () => {
        while (resolvers.length > 0) (resolvers.shift() as () => void)();
      },
      callTool: async (call) => {
        calls.push(call);
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
          call.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { content: [{ type: 'text', text: 'late' }] };
      },
    };
  }

  it('aborts the signal, writes nothing for that id ever, and keeps the session usable', async () => {
    const deferred = deferredCallTool();
    const harness = start({ callTool: deferred.callTool });
    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await waitUntil(() => deferred.calls.length === 1);
    expect(harness.lines).toEqual([]);

    harness.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'user' } });
    await waitUntil(() => deferred.calls[0]?.signal.aborted === true);

    // (a) the handler settles and still nothing is written for id 1.
    deferred.resolveAll();
    await harness.expectSilence(60);
    expect(harness.lines).toEqual([]);

    // (c) a later call on the same connection still works.
    harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await waitUntil(() => deferred.calls.length === 2);
    deferred.resolveAll();
    await harness.expectLines(1);
    expect(harness.parsed(0).id).toBe(2);
    harness.handle.close();
  });

  it('ignores a cancel naming nothing in flight, with no response', async () => {
    const harness = start();
    harness.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
    harness.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} });
    await harness.expectSilence();
    harness.handle.close();
  });

  it('(e) releases the in-flight slot only when a cancelled handler SETTLES', async () => {
    const deferred = deferredCallTool();
    const harness = start({ maxInFlight: 2, callTool: deferred.callTool });

    let nextId = 1;
    for (let round = 0; round < 3; round += 1) {
      const ids = [nextId, nextId + 1];
      nextId += 2;
      for (const id of ids) harness.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo', arguments: {} } });
      await waitUntil(() => deferred.calls.length === nextId - 1);
      for (const id of ids) harness.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
      await waitUntil(() => deferred.calls.slice(-2).every((call) => call.signal.aborted));
      await sleep(10);
    }

    // Six cancelled calls later, the bound of two is fully available again —
    // which is only true if every cancelled handler promise was awaited to
    // settle and released, rather than leaked.
    expect(harness.lines).toEqual([]);
    for (const id of [90, 91]) harness.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await waitUntil(() => deferred.calls.length === 8);
    deferred.resolveAll();
    await harness.expectLines(2);
    expect(harness.lines.map((line) => (JSON.parse(line) as { id: number }).id).sort()).toEqual([90, 91]);
    harness.handle.close();
  });
});

describe('R2: bounded in-flight work', () => {
  it('refuses request maxInFlight + 1 with -32000 and never invokes the handler for it', async () => {
    const deferred = (() => {
      const calls: McpServerToolCall[] = [];
      const resolvers: (() => void)[] = [];
      return {
        calls,
        release: () => {
          while (resolvers.length > 0) (resolvers.shift() as () => void)();
        },
        callTool: async (call: McpServerToolCall) => {
          calls.push(call);
          await new Promise<void>((resolve) => resolvers.push(resolve));
          return { ok: true };
        },
      };
    })();
    const harness = start({ maxInFlight: 2, callTool: deferred.callTool });
    for (const id of [1, 2, 3]) harness.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await harness.expectLines(1);

    expect(harness.parsed(0)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32000, message: 'at most 2 tools/call requests may be in flight at once' },
    });
    expect(deferred.calls.map((call) => call.name)).toEqual(['echo', 'echo']);

    // The session stays open and the slots come back.
    deferred.release();
    await harness.expectLines(3);
    harness.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await waitUntil(() => deferred.calls.length === 3);
    deferred.release();
    await harness.expectLines(4);
    harness.handle.close();
  });
});

describe('R13: explicit EOF close', () => {
  it('fires onClose once, aborts every in-flight call and writes nothing further', async () => {
    const aborted: boolean[] = [];
    const harness = start({
      callTool: async (call) => {
        await new Promise<void>((resolve) => call.signal.addEventListener('abort', () => resolve(), { once: true }));
        aborted.push(call.signal.aborted);
        return { content: [{ type: 'text', text: 'too late' }] };
      },
    });
    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await sleep(20);
    harness.stdin.end();

    await waitUntil(() => aborted.length === 1);
    expect(harness.closes).toEqual([{ kind: 'eof' }]);
    await harness.expectSilence(60);
    expect(harness.lines).toEqual([]);
  });
});

describe('§4: error-mapping policy stays with the server', () => {
  it('writes a handler\'s normal return as the result verbatim, refusals included', async () => {
    const harness = start({
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'nope' }) }] }),
    });
    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await harness.expectLines(1);
    const response = harness.parsed(0);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ content: [{ type: 'text', text: '{"behavior":"deny","message":"nope"}' }] });
    harness.handle.close();
  });

  it('carries a McpServerToolError\'s code, message and optional data through untouched', async () => {
    const harness = start({
      callTool: async () => {
        throw new McpServerToolError(-32042, 'server said no', { detail: 'context' });
      },
    });
    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await harness.expectLines(1);
    expect(harness.parsed(0)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32042, message: 'server said no', data: { detail: 'context' } },
    });
    harness.handle.close();
  });

  it('answers -32603 when a handler throws something it never authored a mapping for', async () => {
    const harness = start({
      callTool: async () => {
        throw new TypeError('handler bug');
      },
    });
    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await harness.expectLines(1);
    expect(harness.parsed(0)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'handler bug' },
    });
    harness.handle.close();
  });

  it('hands the handler `arguments: undefined` when the peer sent no object', async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    const harness = start({
      callTool: async (call) => {
        seen.push(call.arguments as Record<string, unknown> | undefined);
        return { ok: true };
      },
    });
    harness.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
    harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: [1, 2] } });
    harness.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
    await harness.expectLines(3);
    expect(seen).toEqual([undefined, undefined, { a: 1 }]);
    harness.handle.close();
  });
});
