import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { PiRpcMessage } from '../adapters/pi/rpc-client';
import type { Session } from '../types';

const sandbox = vi.hoisted(() => {
  const forbidden: string[] = [];
  return {
    forbidden,
    deny(name: string): never { forbidden.push(name); throw new Error(`P2 forbidden operation: ${name}`); },
    files: new Map<string, string>(),
    directory: 0,
    frames: [] as PiRpcMessage[],
    commands: [] as string[],
    stats: async (): Promise<PiRpcMessage> => ({ type: 'response', success: true, data: { contextUsage: { tokens: 11, contextWindow: 128 } } }),
  };
});

// No real child, socket, provider, auth store or session file is constructed.
vi.mock('node:child_process', () => ({
  spawn: () => sandbox.deny('spawn'), spawnSync: () => sandbox.deny('spawnSync'),
  exec: () => sandbox.deny('exec'), execSync: () => sandbox.deny('execSync'),
  execFile: () => sandbox.deny('execFile'), execFileSync: () => sandbox.deny('execFileSync'),
  fork: () => sandbox.deny('fork'),
}));
vi.mock('node:http', () => sandbox.deny('import node:http'));
vi.mock('node:https', () => sandbox.deny('import node:https'));
vi.mock('node:http2', () => sandbox.deny('import node:http2'));
vi.mock('node:net', () => sandbox.deny('import node:net'));
vi.mock('node:tls', () => sandbox.deny('import node:tls'));
vi.mock('node:dgram', () => sandbox.deny('import node:dgram'));
vi.mock('node:fs/promises', () => sandbox.deny('import node:fs/promises'));
vi.mock('node:fs', () => ({
  readFileSync: () => sandbox.deny('readFileSync'),
  existsSync: () => sandbox.deny('existsSync'),
  realpathSync: () => sandbox.deny('realpathSync'),
  statSync: () => sandbox.deny('statSync'),
  readdirSync: () => sandbox.deny('readdirSync'),
  promises: {
    mkdtemp: async (prefix: string) => `${prefix}virtual-${++sandbox.directory}`,
    chmod: async () => {},
    writeFile: async (file: string, bytes: string | Buffer) => { sandbox.files.set(file, bytes.toString()); },
    readFile: async (file: string) => {
      if (!sandbox.files.has(file)) return sandbox.deny('read outside virtual filesystem');
      return sandbox.files.get(file)!;
    },
    // In-memory disposal only: no disk path is removed.
    rm: async () => {},
  },
}));
vi.mock('../adapters/pi-durable/session', () => ({ startDurablePi: () => sandbox.deny('durable launch') }));
vi.mock('../sdk-reserved-helper-host', () => ({
  BYOK_SDK_HELPER_SUBCOMMAND: '__byok_sdk_helper',
  resolveSdkReservedHelperBin: () => sandbox.deny('SDK helper resolution'),
}));
vi.mock('../adapters/pi/resolve-bin', () => ({
  resolvePiBin: () => sandbox.deny('Pi bin resolution'),
  resolvePiRuntimeIdentity: () => sandbox.deny('Pi runtime identity resolution'),
}));
// Keep projection's pure validation, but do not evaluate the MCP transport SDK.
vi.mock('../mcp/client', async () => ({
  McpAuthorityError: (await import('../mcp/authority-error')).McpAuthorityError,
  McpStdioClient: class { constructor() { sandbox.deny('MCP client'); } },
  McpTransportError: class extends Error {},
  MCP_DEFAULT_REQUEST_TIMEOUT_MS: 10_000,
  MCP_OBSERVATION_MAX_STDOUT_BYTES: 1_048_576,
}));
vi.mock('../adapters/pi/todo-locale-assets', () => ({ locateBundledPiAssets: () => sandbox.deny('Pi assets') }));
vi.mock('../adapters/pi/runtime-launch', () => ({
  resolvePiRuntimeLaunch: async (input: { kind: string; sessionCwd: string; cwd: string; env: NodeJS.ProcessEnv }) => {
    if (input.kind !== 'pi-rpc') return sandbox.deny('non-RPC runtime');
    return { kind: input.kind, sessionCwd: input.sessionCwd, cwd: input.cwd, env: input.env, release: async () => {} };
  },
  piLaunchCommand: (_runtime: unknown, kind: string) => {
    if (kind !== 'pi-rpc') return sandbox.deny('non-RPC command');
    return { command: 'p2-synthetic-never-executable', args: [] };
  },
}));
vi.mock('../adapters/pi/rpc-client', () => ({
  PiRpcClient: class {
    constructor(input: { command: string }) {
      if (input.command !== 'p2-synthetic-never-executable') sandbox.deny('unexpected RPC command');
    }
    get events() {
      return { async *[Symbol.asyncIterator]() { for (const frame of sandbox.frames) yield frame; } };
    }
    async send(command: { type: string }): Promise<PiRpcMessage> {
      sandbox.commands.push(command.type);
      if (command.type === 'prompt') return { type: 'response', success: true };
      if (command.type === 'get_state') return { type: 'response', success: true, data: { sessionId: 'p2-synthetic-session' } };
      if (command.type === 'get_session_stats') return sandbox.stats();
      return sandbox.deny(`RPC ${command.type}`);
    }
    async dispose() {}
    kill() { return sandbox.deny('RPC kill'); }
    recordUnmappedFrame() { return sandbox.deny('unexpected RPC event'); }
  },
}));

// These are the actual production adapter/event/failure implementations.
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { sealRuntimeOperationManifest } from '../types';
import { RuntimeExecutionFailure } from '../runtime-failure';

let session: Session | undefined;
beforeEach(() => {
  sandbox.forbidden.length = 0; sandbox.frames.length = 0; sandbox.commands.length = 0; sandbox.files.clear();
  sandbox.stats = async () => ({ type: 'response', success: true, data: { contextUsage: { tokens: 11, contextWindow: 128 } } });
  vi.stubGlobal('fetch', () => sandbox.deny('fetch'));
  vi.spyOn(process, 'kill').mockImplementation(() => sandbox.deny('process.kill'));
  vi.useFakeTimers();
});
afterEach(async () => {
  try { await session?.close(); expect(sandbox.forbidden).toEqual([]); }
  finally { session = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

async function events(aborted: boolean): Promise<AsyncIterator<AgentEvent>> {
  sandbox.frames.push({ type: 'agent_settled', aborted });
  const adapter = new PiAdapter({ resolveBin: () => sandbox.deny('resolve bin') });
  const offer = { instruction: 'synthetic settlement only' };
  const admitted = await adapter.prepare({ offer, descriptor: adapter.descriptor, requiredToolsetIds: [] });
  if (admitted.kind !== 'prepared') throw new Error('synthetic ordinary operation refused');
  const cwd = `${process.env.TMPDIR}/virtual-workspace`;
  const runtimeLaunch = await admitted.operation.resolveRuntimeLaunch!({ kind: 'instruction', cwd, env: {}, projectionRoot: `${process.env.TMPDIR}/virtual-projections` });
  const manifest = sealRuntimeOperationManifest({
    taskId: 'p2-synthetic', runtimeId: adapter.descriptor.id, descriptor: adapter.descriptor,
    requiredToolsetIds: [], workspace: { workspaceDir: cwd }, forwardedEnvironmentNames: [],
  });
  session = await admitted.operation.start({ kind: 'instruction', runtimeLaunch, manifest, instruction: offer.instruction, env: {}, mcpEnv: {} });
  return session.events[Symbol.asyncIterator]();
}
const abort = { phase: 'run', category: 'semantic', retry: 'non-retryable', message: 'pi run aborted before completion' };
const unavailable = { type: 'usage', contextSource: 'estimate' };

describe('Pi aborted settlement statistics', () => {
  it('delivers valid usage then semantic abort without successful completion', async () => {
    const iterator = await events(true);
    expect(await iterator.next()).toEqual({ done: false, value: { ...unavailable, contextTokens: 11, contextWindow: 128 } });
    await expect(iterator.next()).rejects.toBeInstanceOf(RuntimeExecutionFailure);
    await expect(iterator.next()).rejects.toMatchObject(abort);
    expect(sandbox.commands.filter(type => type === 'get_session_stats')).toHaveLength(1);
  });
  it('keeps a timed-out statistics read from converting abort into retryable failure', async () => {
    sandbox.stats = () => new Promise<PiRpcMessage>(() => {});
    const iterator = await events(true);
    const usage = iterator.next();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await usage).toEqual({ done: false, value: unavailable });
    await expect(iterator.next()).rejects.toMatchObject(abort);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves abort after statistics rejection', async () => {
    sandbox.stats = async () => { throw new Error('synthetic statistics rejection'); };
    const iterator = await events(true);
    expect(await iterator.next()).toEqual({ done: false, value: unavailable });
    await expect(iterator.next()).rejects.toMatchObject(abort);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves abort after an unsuccessful statistics response', async () => {
    sandbox.stats = async () => ({ type: 'response', success: false, error: 'synthetic unavailable statistics' });
    const iterator = await events(true);
    expect(await iterator.next()).toEqual({ done: false, value: unavailable });
    await expect(iterator.next()).rejects.toMatchObject(abort);
  });
  it('retains normal completion after valid statistics', async () => {
    const iterator = await events(false);
    expect((await iterator.next()).value).toEqual({ ...unavailable, contextTokens: 11, contextWindow: 128 });
    expect(await iterator.next()).toEqual({ done: false, value: { type: 'turn_end' } });
  });
  it('retains the retryable statistics timeout for a normal settlement', async () => {
    sandbox.stats = () => new Promise<PiRpcMessage>(() => {});
    const iterator = await events(false);
    const failure = expect(iterator.next()).rejects.toMatchObject({
      phase: 'run', category: 'infrastructure', retry: 'retryable', message: 'pi get_session_stats response timed out',
    });
    await vi.advanceTimersByTimeAsync(1000);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
});
