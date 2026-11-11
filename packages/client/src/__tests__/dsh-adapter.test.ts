import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { DshAdapter, type DshAdapterOptions, type DshModelSelection } from '../adapters/dsh/dsh-adapter';
import { dshPatch } from '../adapters/dsh/dsh-profile';
import { DSH_RUNTIME_CAPABILITIES } from '../adapters/dsh/dsh-capabilities';
import { QUALIFIED_DSH_VERSION } from '../adapters/dsh/dsh-version';
import { PolicyUnsupportedError, type MessageDraftDelta, type RuntimeTaskInput, type Session } from '../types';
import { RuntimeExecutionFailure } from '../runtime-failure';
import * as processTree from '../adapters/process-tree';
import { startPreparedOperation } from './fixtures/prepared-operation';

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));
const MODEL: DshModelSelection = { provider: 'custom', model: 'loop-model', baseUrl: 'http://127.0.0.1:9/v1', keyEnv: 'TEST_DSH_PROVIDER_KEY' };
const sessions: Session[] = [];
const dirs: string[] = [];
const ambient: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return fs.realpath(dir);
}

function setAmbient(name: string, value: string): void {
  ambient.push(name);
  process.env[name] = value;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => {})));
  for (const name of ambient.splice(0)) delete process.env[name];
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup(options: Partial<DshAdapterOptions> = {}, env: NodeJS.ProcessEnv = {}) {
  const root = await tempDir('bd-');
  const workspaceDir = await tempDir('bdw-');
  const log = path.join(await tempDir('bdl-'), 'facts.jsonl');
  const adapter = new DshAdapter({
    home: root, model: MODEL, resolveBin: () => ({ command: fixture, source: 'path' }),
    runtimeEnvironment: { base: 'allowlist', pass: ['FAKE_DSH_*', 'TEST_DSH_*'] }, ...options,
  });
  const resources = { workspaceDir, env: { PATH: process.env.PATH, HOME: os.homedir(), FAKE_DSH_LOG: log, TEST_DSH_PROVIDER_KEY: 'test-key', DSH_STRAY: 'ambient', ...env } };
  const open = async (offer: RuntimeTaskInput = { instruction: 'hello' }, extra: Record<string, unknown> = {}) => {
    const session = await startPreparedOperation(adapter, offer, { ...resources, ...extra });
    sessions.push(session);
    return session;
  };
  const facts = async (): Promise<Array<Record<string, any>>> =>
    (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, workspaceDir, adapter, open, facts, log };
}

async function turn(session: Session): Promise<Array<AgentEvent | MessageDraftDelta>> {
  const events: Array<AgentEvent | MessageDraftDelta> = [];
  for await (const event of session.events) {
    events.push(event);
    if (event.type === 'turn_end') return events;
  }
  throw new Error('event stream ended without turn_end');
}

describe('DshAdapter construction and descriptor', () => {
  it('requires an absolute SDK-owned root that is not the user\'s ~/.dsh', () => {
    expect(() => new DshAdapter({ home: 'relative/root', model: MODEL })).toThrow(/absolute/);
    expect(() => new DshAdapter({ home: path.join(os.homedir(), '.dsh'), model: MODEL })).toThrow(/~\/\.dsh/);
    expect(() => new DshAdapter({ home: path.join(os.homedir(), '.dsh', 'profiles'), model: MODEL })).toThrow(/~\/\.dsh/);
  });

  it('validates the model selection and sandbox', () => {
    const at = (model: Partial<DshModelSelection>) => () => new DshAdapter({ home: '/tmp/byok-dsh-x', model: { ...MODEL, ...model } as DshModelSelection });
    expect(at({ model: '' })).toThrow(/model/);
    expect(at({ provider: 'Open AI' })).toThrow(/provider/);
    expect(at({ provider: 'custom', baseUrl: undefined })).toThrow(/baseUrl is required/);
    expect(at({ provider: 'deepseek' })).toThrow(/not supported for the deepseek provider/);
    expect(at({ baseUrl: 'https://user:secret@example.test/v1' })).toThrow(/credentials/);
    expect(at({ baseUrl: 'https://example.test/v1?api_key=secret' })).toThrow(/query string/);
    expect(at({ keyEnv: 'NOT A NAME' })).toThrow(/keyEnv/);
    expect(at({ keyEnv: 'PROVIDER_CREDENTIAL' })).toThrow(/KEY, TOKEN, SECRET or PASSWORD/);
    expect(at({ keyEnv: 'BYOK_DSH_PROVIDER_KEY' })).toThrow(/BYOK_ or DSH_/);
    expect(at({ keyEnv: 'DSH_KEY' })).toThrow(/BYOK_ or DSH_/);
    expect(at({ keyEnv: 'DEEPSEEK_API_KEY' })).toThrow(/web_search/);
    expect(() => new DshAdapter({ home: '/tmp/byok-dsh-x', model: MODEL, sandbox: 'inherit' as never })).toThrow(/sandbox/);
  });

  it('declares the dsh descriptor', () => {
    const descriptor = new DshAdapter({ home: '/tmp/byok-dsh-x', model: MODEL }).descriptor;
    expect(descriptor).toMatchObject({ id: 'dsh', supportsDispatchSelection: false, platforms: ['darwin', 'linux'], progressMessageBoundary: 'event' });
    expect(descriptor.capabilities).toEqual(DSH_RUNTIME_CAPABILITIES);
    expect(descriptor.versionPolicy).toEqual({ qualifiedVersion: QUALIFIED_DSH_VERSION, unqualified: 'warn' });
  });
});

describe('dshPatch', () => {
  const parse = (model: DshModelSelection) => JSON.parse(dshPatch(model));

  it('routes deepseek through dsh\'s own DeepSeek plugin', () => {
    expect(parse({ provider: 'deepseek', model: 'deepseek-v4-flash', keyEnv: 'DS_KEY' })).toEqual([
      { id: 'llm-deepseek', config: { apiKeyEnv: 'DS_KEY' } },
    ]);
  });

  it('hand-declares an OpenAI-compatible custom route', () => {
    expect(parse(MODEL)).toEqual([
      { id: 'llm-pi-ai', config: { providers: { 'byok-custom': { apiKeyEnv: 'TEST_DSH_PROVIDER_KEY', api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'loop-model' }] } } } },
    ]);
  });

  it('keys a pi-ai catalog route by its provider id', () => {
    expect(parse({ provider: 'openai', model: 'gpt-5', keyEnv: 'OA_KEY' })).toEqual([
      { id: 'llm-pi-ai', config: { providers: { openai: { apiKeyEnv: 'OA_KEY' } } } },
    ]);
  });

  it('never carries the key value', () => {
    expect(dshPatch(MODEL)).not.toContain('test-key');
  });
});

describe('DshAdapter detect and prepare', () => {
  it('reads the version, resolves the acp profile in the SDK root, and reports the key variable', async () => {
    const { adapter, root } = await setup();
    setAmbient('TEST_DSH_PROVIDER_KEY', 'test-key');
    expect(await adapter.detect()).toEqual({ kind: 'available', version: QUALIFIED_DSH_VERSION, authPresent: true, executablePath: fixture, executableSource: 'config', versionVerdict: { state: 'allow', qualifiedVersion: QUALIFIED_DSH_VERSION } });
    await expect(fs.stat(path.join(root, 'profiles', 'acp'))).resolves.toBeDefined();
    await expect(fs.readdir(path.join(root, 'byok-agents-home'))).resolves.toEqual([]);
  });

  it('reports a missing key and an unqualified version', async () => {
    const { adapter } = await setup();
    setAmbient('FAKE_DSH_VERSION', '0.2.2-alpha.2');
    expect(await adapter.detect()).toMatchObject({ kind: 'available', version: '0.2.2-alpha.2', authPresent: false, advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: QUALIFIED_DSH_VERSION } });
  });

  it('refuses an installation whose acp profile does not resolve', async () => {
    const { adapter } = await setup();
    setAmbient('FAKE_DSH_NO_ACP', '1');
    expect(await adapter.detect()).toEqual({ kind: 'refused', reason: 'acp_unavailable' });
  });

  it('validates MCP servers before probing dsh', async () => {
    const resolveBin = vi.fn(() => ({ command: fixture, source: 'path' as const }));
    const { adapter } = await setup({ resolveBin });
    const prepare = (name: string) => adapter.prepare({ offer: { instruction: 'x' }, descriptor: adapter.descriptor, requiredToolsetIds: [], mcpServers: { [name]: { command: 'mcp' }, byokagentresult: { command: 'mcp' } } });
    expect(await prepare('x'.repeat(33))).toEqual({ kind: 'reject', reason: 'dsh cannot attach the task MCP servers: DSH MCP server names must match [A-Za-z0-9_-]{1,32}; OAR does not rename them', retryable: false });
    expect(resolveBin).not.toHaveBeenCalled();
    expect((await prepare('x'.repeat(32))).kind).toBe('prepared');
  });

  it('rejects a missing binary', async () => {
    const missing = new DshAdapter({ home: await tempDir('bd-'), model: MODEL, resolveBin: () => ({ command: path.join(os.tmpdir(), 'no-such-dsh'), source: 'path' }), runtimeEnvironment: { base: 'allowlist' } });
    await expect(missing.prepare({ offer: { instruction: 'x' }, descriptor: missing.descriptor, requiredToolsetIds: [] })).resolves.toEqual({ kind: 'reject', reason: 'dsh installation refused: not-found', retryable: false });
  });
});

describe('DshAdapter sessions', () => {
  it('launches dsh in the scratch directory with the SDK patch, home and switches', async () => {
    const { open, facts, root, workspaceDir } = await setup();
    const session = await open();
    await turn(session);
    const start = (await facts()).find((fact) => fact.kind === 'start')!;
    expect(start.argv.slice(0, 3)).toEqual(['--profile', 'acp', '--patch']);
    expect(path.basename(start.argv[3])).toBe('dsh.patch.yml');
    expect(start.overlay[0]).toEqual({ id: 'acp', disabled: true });
    expect(start.env.TMPDIR).toBeTruthy();
    expect(start.env.TMPDIR).not.toBe(os.tmpdir());
    expect(path.dirname(start.argv[3])).toBe(start.cwd);
    expect(start.cwd).not.toBe(workspaceDir);
    expect(start.env).toMatchObject({ DSH_HOME: root, DSH_AGENTS_HOME: path.join(root, 'byok-agents-home'), DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_MODE: 'DISABLED', TEST_DSH_PROVIDER_KEY: 'test-key' });
    expect(start.env).not.toHaveProperty('DSH_STRAY');
    expect(start.patch).toEqual(JSON.parse(dshPatch(MODEL)));
  });

  it('opens the session in the canonical workspace with the task MCP servers', async () => {
    const { open, facts, workspaceDir } = await setup();
    const session = await open({ instruction: 'hello' }, {
      mcpServers: { byokagentresult: { command: '/usr/bin/env', args: ['node', 'helper.mjs'] } },
    });
    await turn(session);
    const all = await facts();
    expect(all.find((fact) => fact.method === 'open')!.request).toMatchObject({ cwd: workspaceDir, agentOptions: { provider: 'byok-custom', model: 'loop-model' } });
    const [row] = all.find((fact) => fact.kind === 'start')!.overlay[1].insert;
    expect(row).toMatchObject({ name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'byokagentresult', command: '/usr/bin/env', args: ['node', 'helper.mjs'], cwd: workspaceDir } });
    expect(session.sessionRef).toBe(all.find((fact) => fact.method === 'open')!.request.sessionId);
  });

  it.each([
    ['env', { command: '/usr/bin/env', env: { TOKEN: 'x' } }],
    ['http', { type: 'http', url: 'http://127.0.0.1:9/mcp' }],
  ])('refuses an MCP entry with %s before dsh starts, without a retry', async (_label, server) => {
    const { adapter, facts } = await setup();
    expect(await adapter.prepare({ offer: { instruction: 'x' }, descriptor: adapter.descriptor, requiredToolsetIds: [], mcpServers: { host: server } as never })).toEqual({
      kind: 'reject', reason: 'dsh cannot attach the task MCP servers: DSH session MCP supports stdio command and args only; HTTP, env and headers have no verified persistence boundary', retryable: false,
    });
    expect((await facts()).some((fact) => fact.kind === 'start')).toBe(false);
  });

  it('projects committed messages, tools and billed usage, then ends the turn', async () => {
    const { open } = await setup();
    const events = await turn(await open());
    expect(events).toEqual([
      { type: 'progress', text: 'first message: hello' },
      { type: 'tool_use', tool: 'bash', toolCallId: 'call_1', input: { command: 'ls' } },
      { type: 'tool_result', tool: 'bash', toolCallId: 'call_1', output: { content: [{ type: 'text', text: 'a.txt\n' }] } },
      { type: 'progress', text: 'final answer' },
      { type: 'usage', inputTokens: 210, outputTokens: 12, cachedInputTokens: 20, contextTokens: 127, contextSource: 'provider', contextWindow: 1000 },
      { type: 'turn_end' },
    ]);
  });

  it('sums interleaved subagent usage while keeping context and other events root-only', async () => {
    const { open } = await setup();
    expect(await turn(await open({ instruction: 'subagent-usage' }))).toEqual([
      { type: 'progress', text: 'first message: subagent-usage' },
      { type: 'tool_use', tool: 'bash', toolCallId: 'call_1', input: { command: 'ls' } },
      { type: 'tool_result', tool: 'bash', toolCallId: 'call_1', output: { content: [{ type: 'text', text: 'a.txt\n' }] } },
      { type: 'progress', text: 'final answer' },
      { type: 'usage', inputTokens: 252, outputTokens: 18, cachedInputTokens: 27, reasoningTokens: 3, contextTokens: 127, contextSource: 'provider', contextWindow: 1000 },
      { type: 'turn_end' },
    ]);
  });

  it('keeps a tool input past 10k whole, as the native object', async () => {
    const { open } = await setup();
    const events = await turn(await open({ instruction: 'long-input' }));
    const input = events.find((event) => event.type === 'tool_use')!.input as { command: string };
    expect(input.command.length).toBe(12027);
    expect(input.command.endsWith('; git push origin main')).toBe(true);
  });

  it('fails closed on tool arguments that are not a JSON object', async () => {
    const { open } = await setup();
    const error = await turn(await open({ instruction: 'bad-input' })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ retry: 'non-retryable', message: expect.stringMatching(/not a JSON object/) });
  });

  it('stops dsh before it reports turn_end, drops what follows and refuses a follow-up', async () => {
    const { open, facts } = await setup();
    const session = await open({ instruction: 'spontaneous' });
    const events = await turn(session);
    expect((await facts()).some((fact) => fact.method === 'dispose')).toBe(true);
    expect(events.filter((event) => event.type === 'progress')).toEqual([{ type: 'progress', text: 'started a subagent' }]);
    await expect(session.followUp({ instruction: 'again' })).rejects.toBeInstanceOf(PolicyUnsupportedError);
  });

  it('steers the running turn and reports a refused steer', async () => {
    const { open, facts } = await setup();
    const session = await open({ instruction: 'hang' });
    await expect.poll(async () => (await facts()).some((fact) => fact.method === 'prompt')).toBe(true);
    await expect.poll(() => session.steer('turn left').then(() => true, () => false)).toBe(true);
    expect((await facts()).find((fact) => fact.method === 'steer')!.request).toMatchObject({ text: 'turn left' });
    const events = turn(session);
    await session.interrupt();
    await events;
    await expect(session.steer('late')).rejects.toMatchObject({ message: 'runtime exited' });
  });

  it('fails a turn dsh rejects as a non-retryable semantic failure with its native class', async () => {
    const { open } = await setup();
    const session = await open({ instruction: 'fail' });
    const error = await turn(session).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'run', retry: 'non-retryable', failure: { class: 'auth' } });
    expect((error as Error).message).toMatch(/invalid api key/);
  });

  it('retries a native rate limit', async () => {
    const { open } = await setup();
    const error = await turn(await open({ instruction: 'rate-limit' })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ phase: 'run', retry: 'retryable', failure: { class: 'rate_limited' } });
  });

  it('fails the session when dsh exits during a turn', async () => {
    const { open } = await setup();
    const error = await turn(await open({ instruction: 'exit' })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ failure: { class: 'runtime_exited' } });
  });

  it('interrupts with the native cancel and ends the turn', async () => {
    const { open, facts } = await setup();
    const session = await open({ instruction: 'hang' });
    const events = turn(session);
    await expect.poll(async () => (await facts()).some((fact) => fact.method === 'prompt')).toBe(true);
    await session.interrupt();
    expect((await events).at(-1)).toEqual({ type: 'turn_end' });
    expect((await facts()).some((fact) => fact.method === 'cancel')).toBe(true);
  });

  it('refuses the interrupt and sends no native cancel when the agent\'s descendants cannot be read first', async () => {
    vi.spyOn(processTree, 'rememberOwnedDescendants').mockImplementation(() => { throw new Error('Process table ps: timeout after 5000 ms'); });
    const { open, facts } = await setup();
    const session = await open({ instruction: 'hang' });
    await expect.poll(async () => (await facts()).some((fact) => fact.method === 'prompt')).toBe(true);
    await expect(session.interrupt()).rejects.toMatchObject({ message: 'dsh interrupt refused: Process table ps: timeout after 5000 ms' });
    expect((await facts()).some((fact) => fact.method === 'cancel')).toBe(false);
    await expect.poll(async () => (await facts()).some((fact) => fact.method === 'dispose')).toBe(true);
  });

  it('disposes the native sessions before the process', async () => {
    const { open, facts } = await setup();
    const session = await open();
    await turn(session);
    await session.close();
    expect((await facts()).some((fact) => fact.method === 'dispose')).toBe(true);
    const pid = (await facts()).find((fact) => fact.kind === 'start')!.pid as number;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('resumes a known session in the same workspace and re-sends its MCP servers', async () => {
    const { open, facts } = await setup();
    const first = await open();
    await turn(first);
    const sessionRef = first.sessionRef;
    await first.close();
    const mcpServers = { byokagentresult: { command: '/usr/bin/env', args: ['node', 'helper.mjs'] } };
    const resumed = await open({ instruction: 'again', sessionRef }, { mcpServers });
    expect(resumed.sessionRef).toBe(sessionRef);
    expect((await turn(resumed))[0]).toEqual({ type: 'progress', text: 'first message: again' });
    const all = await facts();
    expect(all.find((fact) => fact.method === 'resume')!.request).toMatchObject({ sessionId: sessionRef, route: { provider: 'saved', model: 'route' } });
    expect(all.filter((fact) => fact.kind === 'start').at(-1)!.overlay[1].insert[0].config.serverName).toBe('byokagentresult');
  });

  it('fails a resume of an unknown session or another workspace as a non-retryable authority failure', async () => {
    const { open, workspaceDir } = await setup();
    await expect(open({ instruction: 'x', sessionRef: 'unknown-session' })).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable' });
    const first = await open();
    await turn(first);
    const sessionRef = first.sessionRef;
    await first.close();
    await expect(open({ instruction: 'x', sessionRef }, { workspaceDir: await tempDir('bdo-') })).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', message: expect.stringContaining(workspaceDir) });
  });

  it('refuses a dsh without steer as a non-retryable authority failure', async () => {
    const { open } = await setup({}, { FAKE_DSH_NO_STEER: '1' });
    await expect(open()).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', failure: { class: 'invalid_request' } });
  });

  it('fails closed when a request does not run the configured route', async () => {
    const { open } = await setup({}, { FAKE_DSH_ROUTE: 'deepseek-official/deepseek-v4-flash' });
    const error = await turn(await open()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ retry: 'non-retryable', message: expect.stringMatching(/provider route and model/) });
  });

  it('passes the configured sandbox mode', async () => {
    const { open, facts } = await setup({ sandbox: 'workspace-write' });
    await turn(await open());
    expect((await facts()).find((fact) => fact.kind === 'start')!.env.DSH_PERMISSION_MODE).toBe('workspace-write');
  });
});
