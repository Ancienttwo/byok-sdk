import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  diffMcpObservation,
  jsonEquals,
  observeMcpServer,
  McpAuthorityError,
  McpStdioClient,
  McpTransportError,
  MCP_OBSERVATION_MAX_STDOUT_BYTES,
  MCP_MAX_FRAME_BYTES,
  type McpServerObservation,
} from '../mcp';

/**
 * The shared MCP core's contract, against a real child process speaking real
 * JSON-RPC over real pipes. Nothing here stubs the transport: the bounds, the
 * name rules and the lifecycle only mean anything against a server that can
 * actually misbehave.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-mcp-core-'));
  dirs.push(dir);
  return dir;
}

function server(config: Record<string, unknown> = {}) {
  return { command: process.execPath, args: [FIXTURE, JSON.stringify(config)] };
}

const ENV = { PATH: process.env.PATH ?? '' } as const;

async function observe(config: Record<string, unknown> = {}, serverName = 'salesko'): Promise<McpServerObservation> {
  return observeMcpServer(serverName, server(config), { env: ENV, timeoutMs: 15_000 });
}

describe('MCP core — initialize, list, call, cancel, close', () => {
  it('completes the handshake and reports the server\'s own identity and tools', async () => {
    const observation = await observe();
    expect(observation.serverName).toBe('salesko');
    expect(observation.serverInfo).toEqual({ name: 'byok-mcp-fixture', version: '1.0.0' });
    expect(observation.protocolVersion).toBe('2025-06-18');
    // Canonically ordered by tool name, not in the server's own order.
    expect(observation.tools.map((tool) => tool.name)).toEqual(['echo', 'find_leads']);
    expect(observation.tools[1]?.description).toBe('Find leads matching a query.');
    expect(observation.tools[1]?.inputSchema).toMatchObject({ required: ['query'] });
  });

  it('calls a tool and returns the server\'s own result', async () => {
    const client = new McpStdioClient(server(), { env: ENV, label: 'fixture' });
    try {
      await client.connect();
      const result = await client.callTool('echo', { text: 'hello' });
      expect(result.isError).toBe(false);
      expect(result.content?.[0]).toEqual({ type: 'text', text: 'byok-fixture:echo:{"text":"hello"}' });
    } finally {
      await client.close();
    }
  });

  it('cancels an in-flight call and tells the server it was cancelled', async () => {
    const dir = await tempDir();
    const recordTo = path.join(dir, 'received.jsonl');
    const client = new McpStdioClient(server({ callDelayMs: 30_000, recordTo }), { env: ENV, label: 'fixture' });
    try {
      await client.connect();
      const controller = new AbortController();
      const pending = client.callTool('echo', { text: 'slow' }, { signal: controller.signal });
      pending.catch(() => {});
      // Abort only once the server has actually received the call: aborting
      // before the request is on the wire would be a local give-up, which is
      // not the property under test.
      await expect.poll(async () => {
        const raw = await fs.readFile(recordTo, 'utf8').catch(() => '');
        return raw.split('\n').some((line) => line && JSON.parse(line).method === 'tools/call');
      }, { timeout: 5_000 }).toBe(true);
      controller.abort();
      await expect(pending).rejects.toThrow();
      // In band, not merely a local give-up: the server is told, so it can
      // stop work rather than finish an answer nobody will read.
      await expect.poll(async () => {
        const raw = await fs.readFile(recordTo, 'utf8').catch(() => '');
        return raw.split('\n').some((line) => line && JSON.parse(line).method === 'notifications/cancelled');
      }, { timeout: 5_000 }).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('classifies a JSON-RPC rejection of the REQUEST as a permanent authority failure', async () => {
    // -32601 is the server saying this method does not exist. Re-offering the
    // task sends the same request to the same command and gets the same
    // answer, so it must not come back as a retryable transport fault.
    const client = new McpStdioClient(server({ callError: { code: -32601, message: 'no such tool' } }), {
      env: ENV,
      label: 'fixture',
    });
    try {
      await client.connect();
      await expect(client.callTool('echo', { text: 'hi' })).rejects.toThrow(McpAuthorityError);
      await expect(client.callTool('echo', { text: 'hi' })).rejects.toThrow(/-32601/u);
    } finally {
      await client.close();
    }
  });

  it('keeps a JSON-RPC report of the SERVER\'S OWN condition retryable', async () => {
    // -32603 is a handler that threw. That is a condition on the server's
    // side, which a server still warming up may legitimately report once.
    const client = new McpStdioClient(server({ callError: { code: -32603, message: 'handler exploded' } }), {
      env: ENV,
      label: 'fixture',
    });
    try {
      await client.connect();
      await expect(client.callTool('echo', { text: 'hi' })).rejects.toThrow(McpTransportError);
    } finally {
      await client.close();
    }
  });

  it('issues a timed-out tools/call exactly once and never replays it', async () => {
    // "Retryable" is a decision about re-OFFERING a task, never a licence to
    // replay a call whose outcome is unknown: a second `tools/call` could run
    // a mutation the first one already performed.
    const dir = await tempDir();
    const recordTo = path.join(dir, 'received.jsonl');
    const client = new McpStdioClient(server({ callDelayMs: 30_000, recordTo }), { env: ENV, label: 'fixture' });
    try {
      await client.connect();
      await expect(client.callTool('echo', { text: 'slow' }, { timeoutMs: 500 })).rejects.toThrow();
      // Give any hypothetical replay more time than the deadline it would
      // have to fire after.
      await new Promise((resolve) => { setTimeout(resolve, 750); });
      const lines = (await fs.readFile(recordTo, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.filter((entry) => entry.method === 'tools/call')).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('close() is idempotent and leaves no child behind', async () => {
    const client = new McpStdioClient(server(), { env: ENV, label: 'fixture' });
    await client.connect();
    await client.close();
    await client.close();
    await expect(client.callTool('echo', { text: 'after close' })).rejects.toThrow();
  });

  it('observing always ends the child, including on the happy path', async () => {
    const dir = await tempDir();
    const recordTo = path.join(dir, 'received.jsonl');
    await observe({ recordTo });
    // The fixture records every request it saw; a surviving child would keep
    // answering. Nothing after tools/list can arrive.
    const methods = (await fs.readFile(recordTo, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).method);
    expect(methods).toContain('tools/list');
    expect(methods).not.toContain('tools/call');
  });
});

describe('MCP core — one ungrantable name fails the whole observation', () => {
  it.each([
    ['a dot', 'salesko.read'],
    ['a comma', 'a,b'],
    ['whitespace', 'find leads'],
    ['a quote', 'find"leads'],
    ['a leading dash', '-leads'],
    ['over 64 characters', `a${'b'.repeat(64)}`],
  ])('rejects %s', async (_label, badName) => {
    const tools = [
      { name: 'echo', description: 'fine', inputSchema: { type: 'object' } },
      { name: badName, description: 'bad', inputSchema: { type: 'object' } },
    ];
    // Not "the good one survives": the whole observation is refused, so a bad
    // name can never ride along with good ones.
    await expect(observe({ tools })).rejects.toThrow(McpAuthorityError);
    await expect(observe({ tools })).rejects.toThrow(/ungrantable tool name/u);
  });

  it('rejects a malformed tool entry as the server\'s own answer, not a retryable fault', async () => {
    // The package's own result validation catches a non-object entry before
    // this SDK's name rules run. What matters is the CLASSIFICATION: an
    // invalid `tools/list` result is the server stating a permanent fact about
    // itself, so it must not come back as a retryable transport failure.
    await expect(observe({ tools: ['not-an-object'] })).rejects.toThrow(McpAuthorityError);
    await expect(observe({ tools: ['not-an-object'] })).rejects.toThrow(/tools\/list/u);
  });

  it('rejects a tool with no object inputSchema', async () => {
    await expect(observe({ tools: [{ name: 'echo', description: 'x' }] }))
      .rejects.toThrow(McpAuthorityError);
  });

  it('rejects a duplicated tool name', async () => {
    const tool = { name: 'echo', description: 'x', inputSchema: { type: 'object' } };
    await expect(observe({ tools: [tool, tool] })).rejects.toThrow(/more than once/u);
  });
});

describe('MCP core — byte bounds', () => {
  it('refuses a server that floods stdout past the observation cap', async () => {
    await expect(observe({ floodBytes: MCP_OBSERVATION_MAX_STDOUT_BYTES + 200_000 }))
      .rejects.toThrow(McpAuthorityError);
    await expect(observe({ floodBytes: MCP_OBSERVATION_MAX_STDOUT_BYTES + 200_000 }))
      .rejects.toThrow(new RegExp(`more than ${MCP_OBSERVATION_MAX_STDOUT_BYTES} bytes`, 'u'));
  }, 30_000);

  it('refuses a single frame larger than the frame cap', async () => {
    await expect(observe({ oversizedFrame: MCP_MAX_FRAME_BYTES + 1_000 }))
      .rejects.toThrow(McpAuthorityError);
  }, 30_000);

  it('accepts a large-but-bounded answer', async () => {
    // Well under both caps: the bounds must not fail an honest large schema.
    const tools = [{
      name: 'big',
      description: 'x'.repeat(100_000),
      inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
    }];
    const observation = await observe({ tools });
    expect(observation.tools[0]?.description).toHaveLength(100_000);
  }, 30_000);

  it('times out a silent server rather than waiting forever', async () => {
    await expect(observeMcpServer('quiet', server({ silent: true }), { env: ENV, timeoutMs: 750 }))
      .rejects.toThrow();
  }, 30_000);

  it('reports a command that cannot start', async () => {
    await expect(observeMcpServer('missing', { command: path.join(os.tmpdir(), 'byok-not-a-real-binary') }, {
      env: ENV,
      timeoutMs: 5_000,
    })).rejects.toThrow();
  });
});

describe('MCP core — drift detection', () => {
  const base: McpServerObservation = {
    serverName: 'salesko',
    serverInfo: { name: 'byok-mcp-fixture', version: '1.0.0' },
    protocolVersion: '2025-06-18',
    tools: [{
      name: 'find_leads',
      description: 'Find leads matching a query.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
    }],
  };

  it('reports no drift against itself', () => {
    expect(diffMcpObservation(base, base)).toEqual([]);
  });

  it('reports tool_added for a tool that was not frozen', () => {
    const observed = {
      ...base,
      tools: [...base.tools, { name: 'echo', description: 'new', inputSchema: { type: 'object' } }],
    };
    // Rejected, not skipped: an extra tool is authority nobody admitted.
    expect(diffMcpObservation(base, observed)).toEqual([
      { reason: 'tool_added', toolName: 'echo', detail: expect.stringContaining('was not frozen') },
    ]);
  });

  it('reports tool_removed for a frozen tool that is gone', () => {
    expect(diffMcpObservation(base, { ...base, tools: [] })).toEqual([
      { reason: 'tool_removed', toolName: 'find_leads', detail: expect.stringContaining('is gone') },
    ]);
  });

  it('reports tool_description_changed on its own, without a schema drift', () => {
    const observed = { ...base, tools: [{ ...base.tools[0]!, description: 'Find leads. Now with feeling.' }] };
    expect(diffMcpObservation(base, observed)).toEqual([
      { reason: 'tool_description_changed', toolName: 'find_leads', detail: expect.any(String) },
    ]);
  });

  it('does NOT drift when a schema is re-emitted with its keys in another order', () => {
    const reordered = {
      required: ['query'],
      properties: { limit: { type: 'number' }, query: { type: 'string' } },
      type: 'object',
    };
    const observed = { ...base, tools: [{ ...base.tools[0]!, inputSchema: reordered }] };
    // Key order is not part of a JSON value. Treating it as drift would fail
    // every honest server that serializes its schema differently.
    expect(diffMcpObservation(base, observed)).toEqual([]);
  });

  it('reports tool_schema_changed when a schema VALUE changes', () => {
    const changed = {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'string' } },
      required: ['query'],
    };
    const observed = { ...base, tools: [{ ...base.tools[0]!, inputSchema: changed }] };
    expect(diffMcpObservation(base, observed)).toEqual([
      { reason: 'tool_schema_changed', toolName: 'find_leads', detail: expect.any(String) },
    ]);
  });

  it('reports a changed required-array ORDER as drift', () => {
    const frozen = { ...base, tools: [{ ...base.tools[0]!, inputSchema: { required: ['a', 'b'] } }] };
    const observed = { ...base, tools: [{ ...base.tools[0]!, inputSchema: { required: ['b', 'a'] } }] };
    // Arrays are positional in JSON; reordering one is a different value.
    expect(diffMcpObservation(frozen, observed)).toEqual([
      { reason: 'tool_schema_changed', toolName: 'find_leads', detail: expect.any(String) },
    ]);
  });

  it('reports server identity and protocol drift separately from tool drift', () => {
    const observed = {
      ...base,
      serverInfo: { name: 'byok-mcp-fixture', version: '1.1.0' },
      protocolVersion: '2025-11-25',
    };
    expect(diffMcpObservation(base, observed).map((drift) => drift.reason))
      .toEqual(['server_info_changed', 'protocol_version_changed']);
  });

  it('reports every distinct drift at once rather than the first', () => {
    const observed = {
      ...base,
      tools: [
        { ...base.tools[0]!, description: 'changed', inputSchema: { type: 'string' } },
        { name: 'echo', description: 'new', inputSchema: { type: 'object' } },
      ],
    };
    expect(diffMcpObservation(base, observed).map((drift) => drift.reason))
      .toEqual(['tool_added', 'tool_description_changed', 'tool_schema_changed']);
  });
});

describe('MCP core — structural JSON equality', () => {
  it.each([
    ['key order', { a: 1, b: 2 }, { b: 2, a: 1 }, true],
    ['nested key order', { a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }, true],
    ['a changed value', { a: 1 }, { a: 2 }, false],
    ['an extra key', { a: 1 }, { a: 1, b: 2 }, false],
    ['array order', [1, 2], [2, 1], false],
    ['null vs missing', { a: null }, {}, false],
    ['number vs string', { a: 1 }, { a: '1' }, false],
  ])('%s', (_label, left, right, expected) => {
    expect(jsonEquals(left, right)).toBe(expected);
    expect(jsonEquals(right, left)).toBe(expected);
  });
});
