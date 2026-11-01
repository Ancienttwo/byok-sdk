import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { DshAdapter, type DshAdapterOptions, type DshModelSelection } from '../adapters/dsh/dsh-adapter';
import { dshPatch } from '../adapters/dsh/dsh-profile';
import { DSH_RUNTIME_CAPABILITIES } from '../adapters/dsh/dsh-capabilities';
import { QUALIFIED_DSH_VERSION } from '../adapters/dsh/dsh-version';
import { SteerUnsupportedError, type MessageDraftDelta, type RuntimeTaskInput, type Session } from '../types';
import { RuntimeExecutionFailure } from '../runtime-failure';
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
    expect(descriptor).toMatchObject({ id: 'dsh', supportsDispatchSelection: false, platforms: ['darwin', 'linux'], progressEventsAreMessages: true });
    expect(descriptor.capabilities).toEqual(DSH_RUNTIME_CAPABILITIES);
    expect(descriptor.versionPolicy).toEqual({ qualifiedVersion: QUALIFIED_DSH_VERSION, unqualified: 'warn' });
  });
});

describe('dshPatch', () => {
  const parse = (model: DshModelSelection) => JSON.parse(dshPatch(model));
  const routeOf = (provider: string, model: string) => [
    { id: 'acp', config: { provider, model } },
    { id: 'agent-default-model', config: { provider, model } },
  ];

  it('routes deepseek through dsh\'s own DeepSeek plugin', () => {
    expect(parse({ provider: 'deepseek', model: 'deepseek-v4-flash', keyEnv: 'DS_KEY' })).toEqual([
      { id: 'llm-deepseek', config: { apiKeyEnv: 'DS_KEY' } },
      ...routeOf('deepseek-official', 'deepseek-v4-flash'),
    ]);
  });

  it('hand-declares an OpenAI-compatible custom route', () => {
    expect(parse(MODEL)).toEqual([
      { id: 'llm-pi-ai', config: { providers: { 'byok-custom': { apiKeyEnv: 'TEST_DSH_PROVIDER_KEY', api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'loop-model' }] } } } },
      ...routeOf('byok-custom', 'loop-model'),
    ]);
  });

  it('keys a pi-ai catalog route by its provider id', () => {
    expect(parse({ provider: 'openai', model: 'gpt-5', keyEnv: 'OA_KEY' })).toEqual([
      { id: 'llm-pi-ai', config: { providers: { openai: { apiKeyEnv: 'OA_KEY' } } } },
      ...routeOf('openai', 'gpt-5'),
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

  it('rejects a dispatch selection and a missing binary', async () => {
    const { adapter } = await setup();
    const offer = { instruction: 'x', dispatchSelection: { providerProfileRef: 'p' } } as unknown as RuntimeTaskInput;
    await expect(adapter.prepare({ offer, descriptor: adapter.descriptor, requiredToolsetIds: [] })).resolves.toMatchObject({ kind: 'reject', retryable: false });
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
    expect(path.dirname(start.argv[3])).toBe(start.cwd);
    expect(start.cwd).not.toBe(workspaceDir);
    expect(start.env).toMatchObject({ DSH_HOME: root, DSH_AGENTS_HOME: path.join(root, 'byok-agents-home'), DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_MODE: 'DISABLED', TEST_DSH_PROVIDER_KEY: 'test-key' });
    expect(start.env).not.toHaveProperty('DSH_STRAY');
    expect(start.patch).toEqual(JSON.parse(dshPatch(MODEL)));
  });

  it('opens the session in the canonical workspace with the task MCP servers', async () => {
    const { open, facts, workspaceDir } = await setup();
    const session = await open({ instruction: 'hello' }, {
      mcpServers: { byokagentresult: { command: '/usr/bin/env', args: ['node', 'helper.mjs'], env: { TOKEN_FILE: '/x' } } },
    });
    await turn(session);
    const opened = (await facts()).find((fact) => fact.method === 'session/new')!;
    expect(opened.params).toEqual({
      cwd: workspaceDir,
      mcpServers: [{ name: 'byokagentresult', command: '/usr/bin/env', args: ['node', 'helper.mjs'], env: [{ name: 'TOKEN_FILE', value: '/x' }] }],
    });
    expect(session.sessionRef).toBe('dsh-session-1');
  });

  it('projects committed messages, tools and context usage, then ends the turn', async () => {
    const { open } = await setup();
    const events = await turn(await open());
    expect(events).toEqual([
      { type: 'progress', text: 'first message: hello' },
      // OAR's runtime-neutral tool events, as for Grok: the raw input as JSON text, the content blocks under `content`.
      { type: 'tool_use', tool: 'bash', toolCallId: 'call_1', input: '{"command":"ls"}' },
      { type: 'tool_result', tool: 'bash', toolCallId: 'call_1', output: { content: [{ type: 'text', text: 'a.txt\n' }] } },
      { type: 'progress', text: 'final answer' },
      { type: 'usage', contextTokens: 100, contextSource: 'provider', contextWindow: 1000 },
      { type: 'turn_end' },
    ]);
  });

  it('runs a follow-up on the same session and refuses steering', async () => {
    const { open, facts } = await setup();
    const session = await open();
    await turn(session);
    await session.followUp({ instruction: 'again' });
    expect((await turn(session))[0]).toEqual({ type: 'progress', text: 'first message: again' });
    await expect(session.steer('x')).rejects.toBeInstanceOf(SteerUnsupportedError);
    expect((await facts()).filter((fact) => fact.method === 'session/prompt')).toHaveLength(2);
  });

  it('cancels every permission request', async () => {
    const { open, facts } = await setup();
    const events = await turn(await open({ instruction: 'permission' }));
    expect(events.at(-2)).toMatchObject({ type: 'tool_result', toolCallId: 'call_p', isError: true });
    expect((await facts()).find((fact) => fact.kind === 'permission-answer')!.answer).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('fails a turn dsh rejects as a non-retryable semantic failure', async () => {
    const { open } = await setup();
    const session = await open({ instruction: 'fail' });
    const error = await turn(session).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'run', category: 'semantic', retry: 'non-retryable' });
    expect((error as Error).message).toMatch(/invalid api key/);
  });

  it('keeps a rate limit dsh reports only in text non-retryable, with class unknown', async () => {
    const { open } = await setup();
    const error = await turn(await open({ instruction: 'rate-limit' })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ phase: 'run', category: 'semantic', retry: 'non-retryable', failure: { class: 'unknown' } });
  });

  it('fails the session when dsh exits during a turn', async () => {
    const { open } = await setup();
    const error = await turn(await open({ instruction: 'exit' })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ category: 'infrastructure', failure: { class: 'runtime_exited' } });
  });

  it('interrupts with session/cancel and ends the turn', async () => {
    const { open, facts } = await setup();
    const session = await open({ instruction: 'hang' });
    const events = turn(session);
    await expect.poll(async () => (await facts()).some((fact) => fact.method === 'session/prompt')).toBe(true);
    await session.interrupt();
    expect((await events).at(-1)).toEqual({ type: 'turn_end' });
    expect((await facts()).some((fact) => fact.method === 'session/cancel')).toBe(true);
  });

  it('closes the native session before disposing the process', async () => {
    const { open, facts } = await setup();
    const session = await open();
    await turn(session);
    await session.close();
    const close = (await facts()).find((fact) => fact.method === 'session/close');
    expect(close?.params).toEqual({ sessionId: 'dsh-session-1' });
    const pid = (await facts()).find((fact) => fact.kind === 'start')!.pid as number;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('resumes a known session in the same workspace', async () => {
    const { open, facts, workspaceDir } = await setup();
    const first = await open();
    await turn(first);
    await first.close();
    const resumed = await open({ instruction: 'again', sessionRef: 'dsh-session-1' });
    expect(resumed.sessionRef).toBe('dsh-session-1');
    expect((await turn(resumed))[0]).toEqual({ type: 'progress', text: 'first message: again' });
    expect((await facts()).find((fact) => fact.method === 'session/resume')!.params).toEqual({ sessionId: 'dsh-session-1', cwd: workspaceDir, mcpServers: [] });
  });

  it('fails a resume dsh refuses as a non-retryable authority failure', async () => {
    const { open } = await setup();
    await expect(open({ instruction: 'x', sessionRef: 'unknown-session' })).rejects.toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable' });
    await expect(open({ instruction: 'x', sessionRef: 'corrupt-session' })).rejects.toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable' });
  });

  it('fails closed when the session does not run the configured route', async () => {
    const { open } = await setup({}, { FAKE_DSH_ROUTE: JSON.stringify(['deepseek-official', 'deepseek-v4-flash']) });
    await expect(open()).rejects.toMatchObject({ phase: 'start', category: 'authority', message: expect.stringMatching(/provider route and model/) });
  });

  it('passes the configured sandbox mode', async () => {
    const { open, facts } = await setup({ sandbox: 'workspace-write' });
    await turn(await open());
    expect((await facts()).find((fact) => fact.kind === 'start')!.env.DSH_PERMISSION_MODE).toBe('workspace-write');
  });
});
