import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { DshAdapter, type DshAdapterOptions, type DshModelSelection } from '../adapters/dsh/dsh-adapter';
import { dshPatch, DSH_PROVIDER_KEY_ENV } from '../adapters/dsh/dsh-profile';
import { DSH_RUNTIME_CAPABILITIES } from '../adapters/dsh/dsh-capabilities';
import { QUALIFIED_DSH_VERSION } from '../adapters/dsh/dsh-version';
import { PolicyUnsupportedError, type MessageDraftDelta, type RuntimeTaskInput, type Session } from '../types';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { UnsupportedOptionError } from '../runtime/dsh-session-runtime';
import * as processTree from '../adapters/process-tree';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { testExecutionScratch } from './fixtures/execution-scratch';
import { captureProcessIdentity, expectProcessNotLive } from './support/process-liveness';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { acquireDshProfile } from '../../vendor/oar/223703d/runtimes/dsh/profile-startup.js';
import { dshListModels } from '../../vendor/oar/223703d/runtimes/dsh/list-models.js';
import { dshBridgeSource } from '../../vendor/oar/223703d/runtimes/dsh/bridge.js';

const DSH_TARGET = { lane: 'harness', harnessId: 'dsh', selection: { mode: 'byok', providerId: 'openai', modelId: 'byok-custom/loop-model' } } as const;

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));
const MODEL: DshModelSelection = { provider: 'custom', providerId: 'openai', model: 'loop-model', baseUrl: 'http://127.0.0.1:9/v1' };
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
    home: root, model: MODEL, resolveKey: async () => 'sdk-test-dsh-resolver-key', resolveBin: () => ({ command: fixture, source: 'path' }),
    runtimeEnvironment: { base: 'allowlist', pass: ['FAKE_DSH_*', 'TEST_DSH_*'] }, ...options,
  });
  const resources = { workspaceDir, env: { PATH: process.env.PATH, HOME: os.homedir(), FAKE_DSH_LOG: log, byok_dsh_provider_api_key: 'ambient-key', DSH_STRAY: 'ambient', ...env } };
  const open = async (offer: RuntimeTaskInput = { target: DSH_TARGET, instruction: 'hello' }, extra: Record<string, unknown> = {}) => {
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
    expect(() => new DshAdapter({ resolveKey: async () => 'sdk-test-dsh-resolver-key', home: 'relative/root', model: MODEL })).toThrow(/absolute/);
    expect(() => new DshAdapter({ resolveKey: async () => 'sdk-test-dsh-resolver-key', home: path.join(os.homedir(), '.dsh'), model: MODEL })).toThrow(/~\/\.dsh/);
    expect(() => new DshAdapter({ resolveKey: async () => 'sdk-test-dsh-resolver-key', home: path.join(os.homedir(), '.dsh', 'profiles'), model: MODEL })).toThrow(/~\/\.dsh/);
  });

  it('validates the model selection and sandbox', () => {
    const at = (model: Partial<DshModelSelection>) => () => new DshAdapter({ resolveKey: async () => 'sdk-test-dsh-resolver-key', home: '/tmp/byok-dsh-x', model: { ...MODEL, ...model } as DshModelSelection });
    expect(at({ model: '' })).toThrow(/model/);
    expect(at({ provider: 'Open AI' })).toThrow(/provider/);
    expect(at({ provider: 'custom', baseUrl: undefined })).toThrow(/baseUrl is required/);
    expect(at({ provider: 'deepseek' })).toThrow(/not supported for the deepseek provider/);
    expect(at({ baseUrl: 'https://user:secret@example.test/v1' })).toThrow(/credentials/);
    expect(at({ baseUrl: 'https://example.test/v1?api_key=secret' })).toThrow(/query string/);
    expect(at({ keyEnv: 'TEST_DSH_PROVIDER_KEY' } as Partial<DshModelSelection>)).toThrow(/keyEnv was removed.*resolveKey/);
    expect(() => new DshAdapter({ home: '/tmp/byok-dsh-x', model: MODEL } as DshAdapterOptions)).toThrow(/resolveKey must be a function/);
    expect(() => new DshAdapter({ resolveKey: async () => 'sdk-test-dsh-resolver-key', home: '/tmp/byok-dsh-x', model: MODEL, sandbox: 'inherit' as never })).toThrow(/sandbox/);
  });

  it('declares the dsh descriptor', () => {
    const descriptor = new DshAdapter({ resolveKey: async () => 'sdk-test-dsh-resolver-key', home: '/tmp/byok-dsh-x', model: MODEL }).descriptor;
    expect(descriptor).toMatchObject({ id: 'dsh', selectionModes: ['byok'], byokProviderId: 'openai', requiresMcpToolsetToolObservation: true, platforms: ['darwin', 'linux'], progressMessageBoundary: 'event' });
    expect(descriptor.capabilities).toEqual(DSH_RUNTIME_CAPABILITIES);
    expect(descriptor.versionPolicy).toEqual({ qualifiedVersion: QUALIFIED_DSH_VERSION, unqualified: 'warn' });
  });
});

describe('dshPatch', () => {
  const parse = (model: DshModelSelection) => JSON.parse(dshPatch(model));

  it('routes deepseek through dsh\'s own DeepSeek plugin', () => {
    expect(parse({ provider: 'deepseek', model: 'deepseek-v4-flash' })).toEqual([
      { id: 'llm-deepseek', config: { apiKeyEnv: DSH_PROVIDER_KEY_ENV } },
    ]);
  });

  it('hand-declares an OpenAI-compatible custom route', () => {
    expect(parse(MODEL)).toEqual([
      { id: 'llm-pi-ai', config: { providers: { 'byok-custom': { apiKeyEnv: DSH_PROVIDER_KEY_ENV, api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'loop-model' }] } } } },
    ]);
  });

  it('keys a pi-ai catalog route by its provider id', () => {
    expect(parse({ provider: 'openai', model: 'gpt-5' })).toEqual([
      { id: 'llm-pi-ai', config: { providers: { openai: { apiKeyEnv: DSH_PROVIDER_KEY_ENV } } } },
    ]);
  });

  it('never carries the key value', () => {
    expect(dshPatch(MODEL)).not.toContain('sdk-test-dsh-resolver-key');
  });
});

describe('DshAdapter detect and prepare', () => {
  it('reads the version, resolves the acp profile in the SDK root, without reading the key', async () => {
    const resolveKey = vi.fn(async () => 'sdk-test-dsh-resolver-key');
    const { adapter, root } = await setup({ resolveKey });
    expect(await adapter.detect()).toEqual({ kind: 'available', version: QUALIFIED_DSH_VERSION, sessionCapabilities: { images: false }, executablePath: fixture, executableSource: 'config', versionVerdict: { state: 'allow', qualifiedVersion: QUALIFIED_DSH_VERSION } });
    await expect(fs.stat(path.join(root, 'profiles', 'acp'))).resolves.toBeDefined();
    await expect(fs.readdir(path.join(root, 'byok-agents-home'))).resolves.toEqual([]);
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it('reports an unqualified version', async () => {
    const { adapter } = await setup();
    setAmbient('FAKE_DSH_VERSION', '0.2.2-alpha.2');
    expect(await adapter.detect()).toMatchObject({ kind: 'available', version: '0.2.2-alpha.2', versionVerdict: { state: 'warn', qualifiedVersion: QUALIFIED_DSH_VERSION } });
  });

  it('refuses an installation whose acp profile does not resolve', async () => {
    const { adapter } = await setup();
    setAmbient('FAKE_DSH_NO_ACP', '1');
    expect(await adapter.detect()).toEqual({ kind: 'refused', reason: 'acp_unavailable' });
  });

  it('validates MCP servers before probing dsh', async () => {
    const resolveBin = vi.fn(() => ({ command: fixture, source: 'path' as const }));
    const { adapter } = await setup({ resolveBin });
    const prepare = (name: string) => adapter.prepare({ offer: { target: DSH_TARGET, instruction: 'x' }, descriptor: adapter.descriptor, requiredToolsetIds: [], mcpServers: { [name]: { command: 'mcp' }, byokagentresult: { command: 'mcp' } } });
    expect(await prepare('x'.repeat(33))).toEqual({ kind: 'reject', reason: 'dsh cannot attach the task MCP servers: DSH MCP server names must match [A-Za-z0-9_-]{1,32}; OAR does not rename them', retryable: false });
    expect(resolveBin).not.toHaveBeenCalled();
    expect((await prepare('x'.repeat(32))).kind).toBe('prepared');
  });

  it('#2469: detect(signal) rethrows a pre-aborted reason before writing the root, and stops a hung acp profile probe on abort', async () => {
    const { adapter, root } = await setup();
    const reason = new Error('offer cancelled');
    await expect(adapter.detect(AbortSignal.abort(reason))).rejects.toBe(reason);
    await expect(fs.readdir(root)).resolves.toEqual([]);
    const pidFile = path.join(await tempDir('bdh-'), 'pid');
    setAmbient('FAKE_DSH_HELP_HANG_PID_FILE', pidFile);
    const controller = new AbortController();
    const pending = adapter.detect(controller.signal);
    const pid = await vi.waitFor(async () => {
      const value = Number(await fs.readFile(pidFile, 'utf8'));
      expect(value).toBeGreaterThan(0);
      return value;
    }, { timeout: 5_000 });
    const child = captureProcessIdentity(pid);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expectProcessNotLive(child));
  });

  it('#2469: prepare() reuses the admission observation of the same executable and otherwise probes the version afresh', async () => {
    const { adapter } = await setup();
    const log = path.join(await tempDir('bdp-'), 'probes');
    setAmbient('FAKE_DSH_PROBE_LOG', log);
    const probes = async () => {
      const lines = (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      await fs.rm(log, { force: true });
      return lines;
    };
    const detected = await adapter.detect();
    if (detected.kind !== 'available') throw new Error('fixture dsh is unavailable');
    expect(await probes()).toEqual(['--version', '--profile acp --help']);
    const input = { offer: { target: DSH_TARGET, instruction: 'x' }, descriptor: adapter.descriptor, requiredToolsetIds: [] };
    expect(await adapter.prepare({ ...input, detected })).toMatchObject({ kind: 'prepared', detected: { version: QUALIFIED_DSH_VERSION } });
    expect(await probes()).toEqual([]);
    expect(await adapter.prepare(input)).toMatchObject({ kind: 'prepared', detected: { version: QUALIFIED_DSH_VERSION } });
    expect(await probes()).toEqual(['--version']);
    // A copy or a plain object carries no verified installation.
    for (const forged of [{ ...detected }, { kind: 'available', version: QUALIFIED_DSH_VERSION } as const]) {
      expect(await adapter.prepare({ ...input, detected: forged })).toMatchObject({ kind: 'prepared' });
      expect(await probes()).toEqual(['--version']);
    }
  });

  it('rejects a missing binary', async () => {
    const missing = new DshAdapter({ resolveKey: async () => 'sdk-test-dsh-resolver-key', home: await tempDir('bd-'), model: MODEL, resolveBin: () => ({ command: path.join(os.tmpdir(), 'no-such-dsh'), source: 'path' }), runtimeEnvironment: { base: 'allowlist' } });
    await expect(missing.prepare({ offer: { target: DSH_TARGET, instruction: 'x' }, descriptor: missing.descriptor, requiredToolsetIds: [] })).resolves.toEqual({ kind: 'reject', reason: 'dsh installation refused: not-found', retryable: false });
  });
});

describe('DshAdapter catalog', () => {
  it('resolves on an authenticated catalog spawn and skips the resolver on a cache hit', async () => {
    const resolveKey = vi.fn(async () => '/catalog-resolver-fixture-key');
    const { adapter, log, facts } = await setup({ resolveKey });
    setAmbient('FAKE_DSH_LOG', log);
    const catalog = { kind: 'ok', models: [{ id: 'byok-custom/loop-model', displayName: '[redacted]', provider: { id: 'byok-custom' } }] };
    await expect(adapter.listModels()).resolves.toEqual(catalog);
    await expect(adapter.listModels()).resolves.toEqual(catalog);
    expect(resolveKey).toHaveBeenCalledOnce();
    await expect(adapter.listModels({ refresh: true })).resolves.toEqual(catalog);
    expect(resolveKey).toHaveBeenCalledTimes(2);
    expect((await facts()).filter(fact => fact.kind === 'start')).toHaveLength(2);
  });
});

describe('DshAdapter sessions', () => {
  it('uses the task model and effort, with session-log upload off, on fresh and resumed DSH sessions', async () => {
    const resolveKey = vi.fn().mockResolvedValueOnce('dsh-first-test-key-value').mockResolvedValueOnce('dsh-rotated-test-key-value');
    const box = await setup({ resolveKey });
    const request = { target: { ...DSH_TARGET, selection: { ...DSH_TARGET.selection, modelId: 'byok-custom/task-model' } }, instruction: 'hello', effort: 'high' };
    const fresh = await box.open(request);
    await turn(fresh);
    const sessionRef = fresh.sessionRef;
    await fresh.close();
    await turn(await box.open({ ...request, sessionRef }));
    const log = await box.facts();
    expect(resolveKey).toHaveBeenCalledTimes(2);
    expect(log.filter(row => row.kind === 'start').map(row => row.env[DSH_PROVIDER_KEY_ENV])).toEqual(['dsh-first-test-key-value', 'dsh-rotated-test-key-value']);
    const expected = { provider: 'byok-custom', model: 'task-model', reasoningEffort: 'high' };
    expect(log.filter(fact => ['open', 'resume'].includes(fact.method)).map(row => row.request.agentOptions)).toEqual([expected, expected]);
    expect(log.find(fact => fact.kind === 'start')?.patch).toEqual(JSON.parse(dshPatch({ ...MODEL, model: 'task-model' })));
    const sessionLog = { id: 'session-log-deepseek', name: '@deepseek-ai/dsh-session-log-deepseek' };
    for (const { overlay } of log.filter(row => row.kind === 'start')) {
      expect(overlay.at(-1)).toEqual({ ...sessionLog, config: { enabled: false } });
      expect(overlay[1].insert.at(-1).config.sessionLogPlugin).toEqual(sessionLog);
    }
  });

  it.each([
    [{ ...DSH_TARGET.selection, providerId: 'anthropic' }, undefined],
    [{ ...DSH_TARGET.selection, modelId: 'other/loop-model' }, 'model_unavailable'],
    [{ ...DSH_TARGET.selection, modelId: 'byok-custom/' }, 'model_unavailable'],
  ] as const)('rejects a mismatched BYOK selection before invoking the resolver', async (selection, code) => {
    const resolveKey = vi.fn(async () => 'test-key');
    const { adapter } = await setup({ resolveKey });
    await expect(adapter.prepare({ offer: { target: { ...DSH_TARGET, selection }, instruction: 'test' }, descriptor: adapter.descriptor, requiredToolsetIds: [] }))
      .resolves.toMatchObject({ kind: 'reject', retryable: false, ...(code === undefined ? {} : { code }) });
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it('uses the offered model on the configured route even when a different default exists', async () => {
    const { open, facts } = await setup();
    const target = { ...DSH_TARGET, selection: { ...DSH_TARGET.selection, modelId: 'byok-custom/another/vendor-model' } };
    await turn(await open({ target, instruction: 'hello' }));
    const log = await facts();
    expect(log.find(row => row.method === 'open')?.request.agentOptions).toMatchObject({ provider: 'byok-custom', model: 'another/vendor-model' });
    expect(log.find(row => row.kind === 'start')?.patch[0].config.providers['byok-custom'].models).toEqual([{ id: 'another/vendor-model' }]);
  });

  it('uses only an advertised configured fallback and omits undeclared custom patch models', async () => {
    const target = { ...DSH_TARGET, selection: { mode: 'byok', providerId: 'openai' } } as const;
    const fixed = await setup();
    expect(fixed.adapter.descriptor.defaultModelModes).toEqual(['byok']);
    await turn(await fixed.open({ target, instruction: 'hello' }));
    expect((await fixed.facts()).find(row => row.method === 'open')?.request.agentOptions.model).toBe(MODEL.model);

    const model: DshModelSelection = { provider: 'custom', providerId: 'openai', baseUrl: MODEL.baseUrl };
    const dynamic = await setup({ model });
    expect(dynamic.adapter.descriptor.selectionModes).toEqual(['byok']);
    expect(dynamic.adapter.descriptor.defaultModelModes).toBeUndefined();
    expect(JSON.parse(dshPatch(model))[0].config.providers['byok-custom']).not.toHaveProperty('models');
    await expect(dynamic.adapter.prepare({ offer: { target, instruction: 'test' }, descriptor: dynamic.adapter.descriptor, requiredToolsetIds: [] }))
      .resolves.toMatchObject({ kind: 'reject', code: 'invalid_request', retryable: false });
    await turn(await dynamic.open());
  });

  it('keeps two concurrent launch keys scoped to their own processes', async () => {
    const slow = Promise.withResolvers<string>();
    const resolveKey = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce('dsh-parallel-second-key-value');
    const { open, facts } = await setup({ resolveKey });
    const first = open({ target: DSH_TARGET, instruction: 'first launch' });
    await vi.waitFor(() => expect(resolveKey).toHaveBeenCalledOnce());
    await turn(await open({ target: DSH_TARGET, instruction: 'second launch' }));
    slow.resolve('dsh-parallel-first-key-value');
    await turn(await first);
    const log = await facts();
    expect(log.filter(row => row.kind === 'start').map(row => row.env[DSH_PROVIDER_KEY_ENV])).toEqual(['dsh-parallel-second-key-value', 'dsh-parallel-first-key-value']);
    expect(log.filter(row => row.method === 'prompt').map(row => row.request.text)).toEqual(['second launch', 'first launch']);
  });

  it('fails before prompt when DSH reports a different effort', async () => {
    const box = await setup({}, { FAKE_DSH_EFFORT_READBACK: 'low' });
    await expect(box.open({ target: DSH_TARGET, instruction: 'hello', effort: 'high' }))
      .rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', failure: { class: 'invalid_request' } });
    expect((await box.facts()).some(row => row.method === 'prompt')).toBe(false);
  });

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
    expect(start.env).toMatchObject({ DSH_HOME: root, DSH_AGENTS_HOME: path.join(root, 'byok-agents-home'), DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_MODE: 'DISABLED', [DSH_PROVIDER_KEY_ENV]: 'sdk-test-dsh-resolver-key' });
    expect(start.env).not.toHaveProperty('byok_dsh_provider_api_key');
    expect(process.env[DSH_PROVIDER_KEY_ENV]).toBeUndefined();
    expect(start.env).not.toHaveProperty('DSH_STRAY');
    expect(start.patch).toEqual(JSON.parse(dshPatch(MODEL)));
  });

  it.each([
    ['rejected', async (): Promise<string> => { throw new Error('private resolver value', { cause: new Error('nested resolver value') }); }],
    ['thrown', (): never => { throw new Error('private resolver value'); }],
    ['blank', async (): Promise<string> => ' '.repeat(25)],
    ['short', async (): Promise<string> => '1234567890123456789'],
    ['invalid environment bytes', async (): Promise<string> => 'private resolver value\0'],
  ] as const)('refuses a %s key before spawn and discards resolver diagnostics', async (label, resolveKey) => {
    const { open, facts } = await setup({ resolveKey });
    const scratch = await testExecutionScratch();
    const error = await open(undefined, { scratch }).catch(error => error);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'start', retry: 'non-retryable', failure: { class: 'auth' }, message: ['rejected', 'thrown'].includes(label) ? 'dsh provider API key resolution failed' : expect.stringContaining('at least 20 characters') });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('resolver value');
    expect((await facts()).some(row => row.kind === 'start')).toBe(false);
    await expect(fs.stat(scratch.sdkDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([' leading-space-dsh-credential', 'trailing-space-dsh-credential '])('refuses a resolved key with edge whitespace before spawn', async key => {
    const { open, facts } = await setup({ resolveKey: async () => key });
    await expect(open()).rejects.toMatchObject({
      phase: 'start', retry: 'non-retryable', failure: { class: 'auth' },
      message: 'dsh provider API key cannot contain leading or trailing whitespace',
    });
    expect((await facts()).some(row => row.kind === 'start')).toBe(false);
  });

  it('cancels a pending resolver, reclaims scratch, and ignores a late key', async () => {
    const pending = Promise.withResolvers<string>();
    const resolveKey = vi.fn(() => pending.promise);
    const { open, facts } = await setup({ resolveKey });
    const scratch = await testExecutionScratch();
    const controller = new AbortController();
    const rejected = expect(open(undefined, { scratch, signal: controller.signal })).rejects.toThrow('dsh start was cancelled');
    await vi.waitFor(() => expect(resolveKey).toHaveBeenCalledOnce());
    controller.abort('private cancellation value');
    await rejected;
    await expect(fs.stat(scratch.sdkDir)).rejects.toMatchObject({ code: 'ENOENT' });
    pending.resolve('late-key');
    expect((await facts()).some(row => row.kind === 'start')).toBe(false);
  });

  it('ends a start queued behind a held cold profile on abort and spawns nothing after the holder releases', async () => {
    const { open, facts, root } = await setup();
    const release = await acquireDshProfile({ DSH_HOME: root }, root);
    const scratch = await testExecutionScratch();
    const controller = new AbortController();
    const outcome = open(undefined, { scratch, signal: controller.signal }).then(() => 'started', (error: unknown) => error);
    // launchDsh writes its patch file right before it waits for the profile.
    await vi.waitFor(() => fs.stat(path.join(scratch.sdkDir, 'oar-dsh-bridge.patch.json')));
    controller.abort('private cancellation value');
    expect(await outcome).toBeInstanceOf(Error);
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await facts()).some(row => row.kind === 'start')).toBe(false);
  });

  it('ends a model listing queued behind a held cold profile on abort and spawns nothing after the holder releases', async () => {
    const root = await tempDir('bdm-');
    const directory = await tempDir('bdmd-');
    const release = await acquireDshProfile({ DSH_HOME: root }, root);
    const spawnProcess = vi.fn(() => { throw new Error('no spawn expected'); });
    const controller = new AbortController();
    const listing = dshListModels(
      { kind: 'available', via: 'executable', command: 'dsh', version: QUALIFIED_DSH_VERSION },
      { env: { DSH_HOME: root }, timeoutMs: 60_000, signal: controller.signal, spawn: spawnProcess, run: vi.fn(), redact: (text: string) => text },
      { directory, patches: [], env: { DSH_HOME: root } },
    ).then(() => 'listed', (error: unknown) => error);
    await vi.waitFor(() => fs.stat(path.join(directory, 'oar-dsh-bridge.patch.json')));
    controller.abort();
    expect(await listing).toBeInstanceOf(Error);
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('opens through the bridge with a rejecting persistence.stat and reports no session file', async () => {
    const dir = await tempDir('bdb-');
    const bridge = path.join(dir, 'bridge.mjs');
    await fs.writeFile(bridge, dshBridgeSource);
    const harness = path.join(dir, 'harness.mjs');
    await fs.writeFile(harness, `
      const { apply } = await import(${JSON.stringify(pathToFileURL(bridge).href)});
      const services = {
        loader: { await: async () => {} },
        agents: { create: async ({ sessionId, meta }) => ({ agent: { session: { id: sessionId, header: { id: sessionId, cwd: meta.cwd } }, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }, dispose: async () => {} }) },
        sessionPersistence: { stat: async () => { throw new Error('stat failed'); }, flush: async () => {} },
      };
      apply({ get: (name) => services[name], on: () => {}, effect: () => {} }, {});
    `);
    const child = spawn(process.execPath, [harness], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
      const next = async () => JSON.parse((await lines.next()).value as string);
      expect(await next()).toEqual({ type: 'profile-loaded' });
      expect(await next()).toMatchObject({ type: 'ready' });
      child.stdin!.write(`${JSON.stringify({ id: 'o1', method: 'open', sessionId: 's1', cwd: dir })}\n`);
      const opened = await next();
      expect(opened).toMatchObject({ type: 'response', id: 'o1', result: { sessionId: 's1' } });
      expect(opened.result).not.toHaveProperty('sessionFile');
      expect(opened.result).not.toHaveProperty('sessionFileStat');
      child.stdin!.write(`${JSON.stringify({ id: 'd1', method: 'dispose' })}\n`);
      expect(await next()).toEqual({ type: 'response', id: 'd1', result: {} });
    } finally { child.kill(); }
  });

  it('redacts echoed key bytes from an early native exit', async () => {
    const key = '/stderr-provider-key-fixture';
    const { open } = await setup({ resolveKey: async () => key }, { FAKE_DSH_OPEN_EXIT: '1' });
    const error = await open().catch(error => error);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(key);
  });

  it.each([
    ['registered credential', '/synthetic-dsh-credential-distinctive-suffix'],
    ['unregistered key', 'sk-synthetic_dsh_key_distinctive_suffix'],
    ['unregistered JWT', ['eyJsyntheticHeader', 'syntheticPayload', 'syntheticSignatureSuffix'].join('.')],
  ])('redacts a split %s before keeping the 64 KiB stderr tail', async (kind, sample) => {
    const key = kind === 'registered credential' ? sample : 'sdk-test-dsh-resolver-key';
    const env = { FAKE_DSH_OPEN_EXIT: 'tail', ...(key === sample ? {} : { FAKE_DSH_STDERR_SAMPLE: sample }) };
    const { open } = await setup({ resolveKey: async () => key }, env);
    const error = await open().catch(error => error);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'start', failure: { class: 'runtime_exited' } });
    const diagnostics = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(diagnostics).toContain('DSH startup marker');
    expect(diagnostics).toContain('[redacted]');
    expect(diagnostics).not.toContain(sample);
    expect(diagnostics).not.toContain(sample.slice(-16));
  });

  it.each(['non-provider-prefix-fixture-key', '/looks/like/a/provider/key'])('redacts an echoed key from the native event before projection (%s)', async key => {
    const { open } = await setup({ resolveKey: async () => key });
    const events = await turn(await open({ target: DSH_TARGET, instruction: 'echo-provider-key' }));
    expect(events).toContainEqual({ type: 'progress', text: 'key was [redacted]' });
    expect(JSON.stringify(events)).not.toContain(key);
  });

  it('projects valid tool arguments with a credential-bearing object withheld as a string', async () => {
    const { open } = await setup();
    const events = await turn(await open({ target: DSH_TARGET, instruction: 'echo-key-in-tool-field' }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_use', tool: 'fixture-tool', input: { keep: true, payload: '[redacted]' },
    }));
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
  });

  it('keeps a dsh tool event when its root input object was withheld', async () => {
    const { open } = await setup();
    const events = await turn(await open({ target: DSH_TARGET, instruction: 'echo-key-as-tool-field' }));
    expect(events.find(event => event.type === 'tool_use')).toEqual({
      type: 'tool_use', tool: 'fixture-tool', toolCallId: 'call_redacted',
    });
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
  });

  it('checks the native route when the resolved key matches the model name', async () => {
    const key = 'example-model-and-key-name';
    const { open } = await setup({ model: { ...MODEL, model: key }, resolveKey: async () => key });
    const events = await turn(await open());
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(JSON.stringify(events)).not.toContain(key);
  });

  it('opens the session in the canonical workspace with the task MCP servers', async () => {
    const { open, facts, workspaceDir } = await setup();
    const session = await open({ target: DSH_TARGET, instruction: 'hello' }, {
      mcpServers: { byokagentresult: { command: '/usr/bin/env', args: ['node', 'helper.mjs'] } },
    });
    await turn(session);
    const all = await facts();
    expect(all.find((fact) => fact.method === 'open')!.request).toMatchObject({ cwd: workspaceDir, agentOptions: { provider: 'byok-custom', model: 'loop-model' } });
    expect(all.find((fact) => fact.kind === 'start')!.overlay[1].insert.map((row: { id: string }) => row.id)).toEqual(['oar-dsh-bridge']);
    expect(all.find((fact) => fact.method === 'mountMcp')!.request.servers).toEqual([
      { serverName: 'byokagentresult', failOnStartupError: true, transport: 'stdio', command: '/usr/bin/env', args: ['node', 'helper.mjs'], env: {}, cwd: workspaceDir },
    ]);
    expect(session.sessionRef).toBe(all.find((fact) => fact.method === 'open')!.request.sessionId);
    // The vendored dsh session can carry these since OAR 0.111; a task with no Agent gets none of them (#2363).
    const opened = all.find((fact) => fact.method === 'open')!.request;
    for (const option of ['disallowedTools', 'systemPrompt', 'appendSystemPrompt']) expect(opened).not.toHaveProperty(option);
    expect(all.some((fact) => fact.method === 'name')).toBe(false);
  });

  it('appends the Agent persona for a memory reader on open and on resume, never for a writer', async () => {
    const { open, facts } = await setup();
    const home = await tempDir('bdh-');
    const run = path.join(home, '.byok', 'runs', 'adapter-unit-test');
    await fs.mkdir(run, { recursive: true });
    await fs.writeFile(path.join(home, 'AGENTS.md'), 'agent persona');
    await turn(await open(undefined, { workspaceDir: home, agentHome: home }));
    const reader = { workspaceDir: run, reader: { canonicalHome: home } };
    const first = await open({ target: DSH_TARGET, instruction: 'read' }, reader);
    await turn(first);
    await turn(await open({ target: DSH_TARGET, instruction: 'again', sessionRef: first.sessionRef }, reader));
    const all = await facts();
    const requests = all.filter((fact) => fact.method === 'open' || fact.method === 'resume').map((fact) => fact.request);
    expect(requests.map((request) => request.appendSystemPrompt)).toEqual([undefined, 'agent persona', 'agent persona']);
    for (const request of requests) for (const option of ['disallowedTools', 'systemPrompt']) expect(request).not.toHaveProperty(option);
    expect(all.some((fact) => fact.method === 'name')).toBe(false);
  });

  it('mounts credentialed stdio and HTTP entries through the bridge and keeps their credentials out of the launch and the events', async () => {
    const stdioToken = 'stdio-mcp-token-distinctive-suffix';
    const bearer = 'http-mcp-bearer-distinctive-suffix';
    const { open, facts, workspaceDir } = await setup();
    const session = await open({ target: DSH_TARGET, instruction: 'hello' }, { mcpServers: {
      local: { command: '/usr/bin/env', env: { HOST_TOKEN: stdioToken } },
      remote: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${bearer}` } },
    } });
    const events = await turn(session);
    const all = await facts();
    expect(all.find((fact) => fact.method === 'mountMcp')!.request.servers).toEqual([
      { serverName: 'local', failOnStartupError: true, transport: 'stdio', command: '/usr/bin/env', args: [], env: { HOST_TOKEN: stdioToken }, cwd: workspaceDir },
      { serverName: 'remote', failOnStartupError: true, transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${bearer}` } },
    ]);
    const start = JSON.stringify(all.find((fact) => fact.kind === 'start'));
    for (const secret of [stdioToken, bearer]) {
      expect(start).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain(secret);
    }
  });

  it.each([
    ['in a refusal frame', { FAKE_DSH_MOUNT_FAIL: '1' }, 'MCP plugin is not active'],
    ['on stderr', { FAKE_DSH_MOUNT_FAIL: 'exit' }, 'mount failed'],
    ['in a native event frame', {}, 'mounted'],
  ])('redacts MCP credentials echoed %s, whatever their names, raw and encoded once or twice', async (where, env, marker) => {
    const bare = 'bare"token\\value-123';
    const credentials = ['abc12345', '/opt/service/secret-path-123', 'custom-header-credential-123', 'long"quoted\\secret-123', bare];
    const { open, facts } = await setup({}, env);
    const mcpServers = {
      local: { command: '/usr/bin/env', env: { HOST_ACCESS: credentials[0], SERVICE_REF: credentials[1], LOGIN_BLOB: credentials[3], DEBUG: '1' } },
      remote: { type: 'http' as const, url: 'http://127.0.0.1:9/mcp', headers: { 'X-Auth': credentials[2], Authorization: `Bearer ${bare}` } },
    };
    let text: string;
    if (where === 'in a native event frame') {
      text = JSON.stringify(await turn(await open({ target: DSH_TARGET, instruction: 'echo-mcp-mount' }, { mcpServers })));
    } else {
      const error = await open({ target: DSH_TARGET, instruction: 'hello' }, { mcpServers }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ phase: 'start' });
      text = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect((await facts()).some((fact) => fact.method === 'open')).toBe(false);
    }
    expect(text).toContain(marker);
    // The serialized output adds one level of escaping over the native text, which holds up to two.
    const escape = (value: string) => JSON.stringify(value).slice(1, -1);
    for (const secret of credentials) {
      for (const form of [secret, escape(secret), escape(escape(secret)), escape(escape(escape(secret)))]) expect(text).not.toContain(form);
    }
    // A value under eight characters is not redacted, so the echoed DEBUG=1 stays readable.
    expect(text).toMatch(/DEBUG\\*":\\*"1\\*"/);
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

  it('attributes linked DSH child events and keeps the session-wide terminal totals', async () => {
    const { open } = await setup();
    const agentPath = ['child-1'];
    const toolCallId = JSON.stringify(['child-1', agentPath, 'call_1']);
    expect(await turn(await open({ target: DSH_TARGET, instruction: 'subagent-usage' }))).toEqual([
      { type: 'progress', text: 'first message: subagent-usage' },
      { type: 'tool_use', tool: 'bash', toolCallId: 'call_1', input: { command: 'ls' } },
      { type: 'tool_result', tool: 'bash', toolCallId: 'call_1', output: { content: [{ type: 'text', text: 'a.txt\n' }] } },
      { type: 'progress', text: 'child reply', agentPath },
      { type: 'usage', agentPath, inputTokens: 13, outputTokens: 2, cachedInputTokens: 3, reasoningTokens: 1, contextTokens: 15, contextWindow: 5000, contextSource: 'provider' },
      { type: 'tool_use', agentPath, tool: 'bash', toolCallId, input: { command: 'ls' } },
      { type: 'tool_result', agentPath, tool: 'bash', toolCallId, output: {} },
      { type: 'progress', text: 'final answer' },
      { type: 'usage', agentPath, inputTokens: 24, outputTokens: 3, cachedInputTokens: 4, reasoningTokens: 2, contextTokens: 27, contextWindow: 5000, contextSource: 'provider' },
      { type: 'usage', inputTokens: 252, outputTokens: 18, cachedInputTokens: 27, reasoningTokens: 3, contextTokens: 127, contextSource: 'provider', contextWindow: 1000 },
      { type: 'turn_end' },
    ]);
  });

  it('keeps a tool input past 10k whole, as the native object', async () => {
    const { open } = await setup();
    const events = await turn(await open({ target: DSH_TARGET, instruction: 'long-input' }));
    const input = events.find((event) => event.type === 'tool_use')!.input as { command: string };
    expect(input.command.length).toBe(12027);
    expect(input.command.endsWith('; git push origin main')).toBe(true);
  });

  it('fails closed on tool arguments that are not a JSON object', async () => {
    const { open } = await setup();
    const error = await turn(await open({ target: DSH_TARGET, instruction: 'bad-input' })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ retry: 'non-retryable', message: expect.stringMatching(/not a JSON object/) });
  });

  it('stops dsh before it reports turn_end, drops what follows and refuses a follow-up', async () => {
    const { open, facts } = await setup();
    const session = await open({ target: DSH_TARGET, instruction: 'spontaneous' });
    const events = await turn(session);
    expect((await facts()).some((fact) => fact.method === 'dispose')).toBe(true);
    expect(events.filter((event) => event.type === 'progress')).toEqual([{ type: 'progress', text: 'started a subagent' }]);
    await expect(session.followUp({ target: DSH_TARGET, instruction: 'again' })).rejects.toBeInstanceOf(PolicyUnsupportedError);
  });

  it('steers the running turn and reports a refused steer', async () => {
    const { open, facts } = await setup();
    const session = await open({ target: DSH_TARGET, instruction: 'hang' });
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
    const session = await open({ target: DSH_TARGET, instruction: 'fail' });
    const error = await turn(session).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'run', retry: 'non-retryable', failure: { class: 'auth' } });
    expect((error as Error).message).toMatch(/invalid api key/);
  });

  it('preserves the failed outcome when the native reason echoes the resolved key', async () => {
    const { open } = await setup({ resolveKey: async () => 'dsh-auth-echo-credential-fixture' });
    const session = await open({ target: DSH_TARGET, instruction: 'fail-echo-provider-key' });
    await expect(turn(session)).rejects.toMatchObject({ phase: 'run', failure: { class: 'auth' }, message: expect.stringContaining('invalid api key: [redacted]') });
  });

  it('retries a native rate limit', async () => {
    const { open } = await setup();
    const error = await turn(await open({ target: DSH_TARGET, instruction: 'rate-limit' })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ phase: 'run', retry: 'retryable', failure: { class: 'rate_limited' } });
  });

  it('fails the session when dsh exits during a turn', async () => {
    const { open } = await setup();
    const error = await turn(await open({ target: DSH_TARGET, instruction: 'exit' })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ failure: { class: 'runtime_exited' } });
  });

  it('interrupts with the native cancel and ends the turn', async () => {
    const { open, facts } = await setup();
    const session = await open({ target: DSH_TARGET, instruction: 'hang' });
    const events = turn(session);
    await expect.poll(async () => (await facts()).some((fact) => fact.method === 'prompt')).toBe(true);
    await session.interrupt();
    expect((await events).at(-1)).toEqual({ type: 'turn_end' });
    expect((await facts()).some((fact) => fact.method === 'cancel')).toBe(true);
  });

  it('refuses the interrupt and sends no native cancel when the agent\'s descendants cannot be read first', async () => {
    vi.spyOn(processTree, 'rememberOwnedDescendants').mockImplementation(() => { throw new Error('Process table ps: timeout after 5000 ms'); });
    const { open, facts } = await setup();
    const session = await open({ target: DSH_TARGET, instruction: 'hang' });
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
    const recorded = await facts();
    expect(recorded.some((fact) => fact.method === 'dispose')).toBe(true);
    expectProcessNotLive(recorded.find((fact) => fact.kind === 'start')!.pid as number);
  });

  it('resumes a known session in the same workspace and re-sends its MCP servers', async () => {
    const { open, facts } = await setup();
    const first = await open();
    await turn(first);
    const sessionRef = first.sessionRef;
    await first.close();
    const mcpServers = { byokagentresult: { command: '/usr/bin/env', args: ['node', 'helper.mjs'] } };
    const resumed = await open({ target: DSH_TARGET, instruction: 'again', sessionRef }, { mcpServers });
    expect(resumed.sessionRef).toBe(sessionRef);
    expect((await turn(resumed))[0]).toEqual({ type: 'progress', text: 'first message: again' });
    const all = await facts();
    expect(all.find((fact) => fact.method === 'resume')!.request).toMatchObject({ sessionId: sessionRef, route: { provider: 'saved', model: 'route' } });
    expect(all.filter((fact) => fact.method === 'mountMcp').at(-1)!.request.servers.map((server: { serverName: string }) => server.serverName)).toEqual(['byokagentresult']);
  });

  it('fails a resume of an unknown session or another workspace as a non-retryable authority failure', async () => {
    const { open, workspaceDir } = await setup();
    await expect(open({ target: DSH_TARGET, instruction: 'x', sessionRef: 'unknown-session' })).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable' });
    const first = await open();
    await turn(first);
    const sessionRef = first.sessionRef;
    await first.close();
    await expect(open({ target: DSH_TARGET, instruction: 'x', sessionRef }, { workspaceDir: await tempDir('bdo-') })).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', message: expect.stringContaining(workspaceDir) });
  });

  it('refuses a dsh without steer as a non-retryable authority failure', async () => {
    const { open } = await setup({}, { FAKE_DSH_NO_STEER: '1' });
    await expect(open()).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', failure: { class: 'invalid_request' } });
  });

  it('refuses the open before any model request when dsh cannot confirm session-log upload is off', async () => {
    const { open, facts } = await setup({}, { FAKE_DSH_SESSION_LOG_UNMOUNTED: '1' });
    const error = await open().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ phase: 'start', retry: 'non-retryable' });
    expect((error as Error).cause).toBeInstanceOf(UnsupportedOptionError);
    expect((error as Error).cause).toMatchObject({ option: 'sessionLogUpload' });
    expect((await facts()).filter(row => row.kind === 'request')).toEqual([]);
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
