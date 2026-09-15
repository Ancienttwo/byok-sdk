import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observeMcpServer, type McpToolsetServerObservation } from '../mcp';
import { BYOK_PI_MCP_CONFIG_PATH } from '../adapters/pi/mcp-config';

/**
 * The Pi MCP extension's CALL path, end to end against a real stdio server.
 *
 * The projection tests prove the extension registers the right tools; this
 * proves what happens when the model invokes one — the lazy open, the
 * re-verification against the frozen observation, the `tools/call` itself, the
 * server's own content crossing back, and the close that leaves no child.
 * Nothing here stubs the pool or the transport: a lazily-opened connection, a
 * drift refusal and a reaped child only mean anything against a server that
 * really has to be started and really has to be killed.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const ENV = { PATH: process.env.PATH ?? '' } as const;

const dirs: string[] = [];
let configPathBefore: string | undefined;

beforeEach(() => {
  configPathBefore = process.env[BYOK_PI_MCP_CONFIG_PATH];
});

afterEach(async () => {
  if (configPathBefore === undefined) delete process.env[BYOK_PI_MCP_CONFIG_PATH];
  else process.env[BYOK_PI_MCP_CONFIG_PATH] = configPathBefore;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-mcp-call-'));
  dirs.push(dir);
  return dir;
}

function serverSpec(config: Record<string, unknown> = {}) {
  return { command: process.execPath, args: [FIXTURE, JSON.stringify(config)] };
}

interface RegisteredTool {
  readonly name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    details: { toolsetId: string; serverName: string; toolName: string; isError: boolean };
  }>;
}

interface LoadedExtension {
  readonly tools: RegisteredTool[];
  readonly recordTo: string;
  shutdown(): void;
}

/** What the daemon observed at admission, for a server started with no recording. */
async function frozenObservation(): Promise<McpToolsetServerObservation> {
  const observed = await observeMcpServer('salesko', serverSpec(), { env: ENV, timeoutMs: 15_000 });
  return { ...observed, toolsetId: 'salesko.read.v1' };
}

/**
 * Write the task-scoped file exactly as `pi-adapter.ts` writes it, then load
 * the REAL extension against it. The running server records every request it
 * receives — including its own pid and the `BYOK_*` variables it was spawned
 * with — to `recordTo`.
 */
async function loadExtension(
  observation: Readonly<Record<string, McpToolsetServerObservation>>,
  serverConfig: Record<string, unknown> = {},
): Promise<LoadedExtension> {
  const dir = await tempDir();
  const recordTo = path.join(dir, 'received.jsonl');
  const configPath = path.join(dir, 'mcp-config.json');
  await fs.writeFile(configPath, JSON.stringify({
    mcpServers: { salesko: serverSpec({ ...serverConfig, recordTo }) },
    observation,
  }));
  process.env[BYOK_PI_MCP_CONFIG_PATH] = configPath;

  const tools: RegisteredTool[] = [];
  let onShutdown: (() => void) | undefined;
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    on: (event: string, handler: () => void) => {
      if (event === 'session_shutdown') onShutdown = handler;
    },
  };
  const extension = await import('../adapters/pi/mcp-extension');
  extension.default(pi as never);
  return { tools, recordTo, shutdown: () => onShutdown?.() };
}

async function records(recordTo: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(recordTo, 'utf8').catch(() => '');
  return raw.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Pi MCP extension — the call path', () => {
  it('opens the server on the first call, not at registration, and returns its own result', async () => {
    const observation = { salesko: await frozenObservation() };
    const { tools, recordTo, shutdown } = await loadExtension(observation);

    // Lazy: registration alone must not pay to start a server a session may
    // never call. Nothing has been spawned, so nothing has been recorded.
    await expect(fs.access(recordTo)).rejects.toThrow();

    const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo');
    expect(echo).toBeDefined();
    const result = await echo!.execute('call-1', { text: 'hello' }, undefined);
    // The server's own content, verbatim — not a rendering this SDK invented.
    expect(result.content).toEqual([{ type: 'text', text: 'byok-fixture:echo:{"text":"hello"}' }]);
    expect(result.details).toEqual({
      toolsetId: 'salesko.read.v1',
      serverName: 'salesko',
      toolName: 'echo',
      isError: false,
    });

    const seen = await records(recordTo);
    expect(seen.map((entry) => entry.method)).toContain('tools/call');
    // The task-scoped config names every server this task projects and the
    // observation it was admitted with. A host toolset server has no business
    // reading either, so the SDK's Pi control variables are stripped.
    const start = seen.find((entry) => entry.event === 'start');
    // Non-vacuous: this process really does carry the variable the child must
    // not see, because that is how the extension found its own config.
    expect(process.env[BYOK_PI_MCP_CONFIG_PATH]).toBeTruthy();
    expect(start?.byokEnv).not.toContain(BYOK_PI_MCP_CONFIG_PATH);
    expect(start?.byokEnv).not.toContain('BYOK_PI_PERMISSION_MODE');

    const pid = start?.pid as number;
    expect(alive(pid)).toBe(true);
    shutdown();
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  }, 30_000);

  it('reuses one connection across calls and closes it once', async () => {
    const observation = { salesko: await frozenObservation() };
    const { tools, recordTo, shutdown } = await loadExtension(observation);
    const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo')!;
    const leads = tools.find((tool) => tool.name === 'mcp__salesko__find_leads')!;
    await echo.execute('call-1', { text: 'one' }, undefined);
    await leads.execute('call-2', { query: 'two' }, undefined);

    const seen = await records(recordTo);
    // One child, one handshake: two tools on one server share a connection.
    expect(seen.filter((entry) => entry.event === 'start')).toHaveLength(1);
    expect(seen.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
    expect(seen.filter((entry) => entry.method === 'tools/call')).toHaveLength(2);
    shutdown();
    await expect.poll(() => alive(seen[0]!.pid as number), { timeout: 10_000 }).toBe(false);
  }, 30_000);

  it('refuses the call when the live server no longer matches the frozen observation', async () => {
    const frozen = await frozenObservation();
    // An EXTRA frozen tool the live server does not have: admission and
    // execution are two different spawns, and a set difference either way is
    // authority nobody admitted this task for.
    const observation = {
      salesko: {
        ...frozen,
        tools: [...frozen.tools, { name: 'delete_everything', description: 'gone', inputSchema: { type: 'object' } }],
      },
    };
    const { tools, recordTo, shutdown } = await loadExtension(observation);
    const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo')!;
    await expect(echo.execute('call-1', { text: 'hello' }, undefined))
      .rejects.toThrow(/no longer matches the tools this task was admitted with/u);

    const seen = await records(recordTo);
    // The refusal happens before any work: the server was started and listed,
    // and nothing was ever called on it.
    expect(seen.map((entry) => entry.method)).toContain('tools/list');
    expect(seen.map((entry) => entry.method)).not.toContain('tools/call');
    shutdown();
    await expect.poll(() => alive(seen[0]!.pid as number), { timeout: 10_000 }).toBe(false);
  }, 30_000);

  it('refuses the call when a frozen tool\'s schema drifted', async () => {
    const frozen = await frozenObservation();
    const observation = {
      salesko: {
        ...frozen,
        tools: frozen.tools.map((tool) => (tool.name === 'echo'
          ? { ...tool, inputSchema: { type: 'object', properties: { text: { type: 'number' } } } }
          : tool)),
      },
    };
    const { tools, recordTo, shutdown } = await loadExtension(observation);
    const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo')!;
    // The model was shown the frozen schema; calling against a different live
    // one would be calling a tool nobody was admitted for.
    await expect(echo.execute('call-1', { text: 'hello' }, undefined))
      .rejects.toThrow(/no longer matches the tools this task was admitted with/u);
    expect((await records(recordTo)).map((entry) => entry.method)).not.toContain('tools/call');
    shutdown();
  }, 30_000);

  it('normalizes only a non-object params, and never invents or repairs an argument', async () => {
    const observation = { salesko: await frozenObservation() };
    const { tools, recordTo, shutdown } = await loadExtension(observation);
    const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo')!;
    const leads = tools.find((tool) => tool.name === 'mcp__salesko__find_leads')!;

    // Pi hands `params` through untyped. Anything that is not a plain object
    // carries no arguments at all, and the SDK sends exactly that rather than
    // guessing what the model meant.
    for (const params of [null, undefined, 'text', 42, ['text']]) {
      const result = await echo.execute('call-shape', params, undefined);
      expect(result.content).toEqual([{ type: 'text', text: 'byok-fixture:echo:{}' }]);
    }

    // A missing OPTIONAL crosses as absent, and a wrong-typed value crosses
    // verbatim: the schema is the server's, so the server is the authority on
    // whether its own arguments are acceptable. Filling in a default or
    // coercing a type here would put arguments the model never chose on the
    // wire.
    const missingOptional = await leads.execute('call-2', { query: 'acme' }, undefined);
    expect(missingOptional.content).toEqual([{ type: 'text', text: 'byok-fixture:find_leads:{"query":"acme"}' }]);
    const wrongType = await leads.execute('call-3', { query: 7, limit: 'many' }, undefined);
    expect(wrongType.content).toEqual([{ type: 'text', text: 'byok-fixture:find_leads:{"query":7,"limit":"many"}' }]);

    expect((await records(recordTo)).filter((entry) => entry.method === 'tools/call')).toHaveLength(7);
    shutdown();
  }, 30_000);

  it('surfaces a failed call as the call\'s outcome and issues it exactly once', async () => {
    // A failure is reported, never replayed: a second `tools/call` could run a
    // mutation the first one already performed. "Retryable" is a decision
    // about re-offering the task, not about re-sending this call.
    const observation = { salesko: await frozenObservation() };
    const { tools, recordTo, shutdown } = await loadExtension(observation, {
      callError: { code: -32603, message: 'handler exploded' },
    });
    const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo')!;
    await expect(echo.execute('call-1', { text: 'hello' }, undefined)).rejects.toThrow(/handler exploded/u);
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    expect((await records(recordTo)).filter((entry) => entry.method === 'tools/call')).toHaveLength(1);
    shutdown();
  }, 30_000);

  it('refuses every call once the task\'s connections are closed', async () => {
    const observation = { salesko: await frozenObservation() };
    const { tools, shutdown } = await loadExtension(observation);
    const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo')!;
    await echo.execute('call-1', { text: 'hello' }, undefined);
    shutdown();
    await expect.poll(
      () => echo.execute('call-2', { text: 'after' }, undefined).then(() => '', (error: Error) => error.message),
      { timeout: 10_000 },
    ).toMatch(/connections for this task are closed/u);
  }, 30_000);
});
