import { observeOwnedProcessTable } from '../adapters/process-tree';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agyEnvironment } from '../adapters/antigravity/agy-profile';
import { dshEnvironment } from '../adapters/dsh/dsh-profile';
import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { CursorAdapter, type CursorAdapterOptions } from '../adapters/cursor/cursor-adapter';
import { resolveCursorBin } from '../adapters/cursor/resolve-bin';
import { CURSOR_AUTH_ENV_NAMES, isCursorAuthEnvironmentName, withoutProviderCredentials } from '../adapters/provider-credential-environment';
import { createRuntimeAdapters } from '../adapters/runtime-adapters';
import { cursorSession } from '../runtime/cursor-acp-profile';
import { buildAllowlistedEnv } from '../runtime/environment';
import { observeAdmissionDetection } from '../runtime-detection';
import { spawnOwnedLineProcess } from '../runtime/owned-line-process';
import { SteerUnsupportedError, type Session, type RuntimeOperationStartInput, type RuntimeOperationInstructionStartInput, type RuntimeTaskInput } from '../types';
import { testExecutionScratch } from './fixtures/execution-scratch';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';
import { captureProcessIdentity, expectProcessNotLive } from './support/process-liveness';

const AUTO = { lane: 'auto' } as const;
const TARGET = { lane: 'harness', harnessId: 'cursor', selection: { mode: 'device-default' } } as const;
const MODEL = { lane: 'harness', harnessId: 'cursor', selection: { mode: 'adapter-model', modelId: 'fixture-model' } } as const;
const VERSION = '2026.09.18-9a7762b';
const SESSION = 'cursor-fixture-session';
const LOGIN_FAILURE = { phase: 'start', retry: 'non-retryable', failure: { class: 'auth' }, message: expect.stringContaining('cursor-agent login') };
const fixture = path.join(import.meta.dirname, 'fixtures/fake-cursor-agent.mjs');
const sessions: Session[] = [];
const dirs: string[] = [];

afterEach(async () => {
  try { await Promise.all(sessions.splice(0).map(session => session.close())); }
  finally {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

interface Fact {
  argv?: string[];
  pid?: number;
  credentialNames?: string[];
  method?: string;
  params?: unknown;
  descendant?: number;
  permission?: unknown;
  refusals?: number[];
  terminal?: { result?: unknown; error?: { code: number } };
}

function setup(extra: Record<string, string> = {}, options: CursorAdapterOptions = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'cursor-'));
  dirs.push(cwd);
  const log = path.join(cwd, 'wire.jsonl');
  const bin = path.join(cwd, 'cursor-agent');
  // Node treats extensionless entrypoints as ESM when they contain imports.
  copyFileSync(fixture, bin);
  chmodSync(bin, 0o755);
  const env = { PATH: process.env.PATH ?? '', HOME: cwd, FAKE_CURSOR_LOG: log, ...extra };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const adapter = new CursorAdapter({ resolveBin: () => ({ command: bin, source: 'path' }),
    runtimeEnvironment: { base: 'allowlist', pass: ['FAKE_CURSOR_*', 'CURSOR_*', 'cursor_*'] }, ...options });
  const facts = (): Fact[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Fact) : [];
  const start = async (offer: Partial<RuntimeTaskInput> = {}, resources: Partial<PreparedOperationResources> = {}) => {
    const session = await startPreparedOperation(adapter, { target: TARGET, instruction: 'go', ...offer }, { workspaceDir: cwd, env, agentHome: cwd, ...resources });
    sessions.push(session);
    return session;
  };
  return { cwd, bin, env, adapter, facts, start };
}

async function turn(session: Session) {
  const events = [];
  for await (const event of session.events) {
    events.push(event);
    if (event.type === 'turn_end') break;
  }
  return events;
}

describe.skipIf(process.platform === 'win32')('Cursor fake CLI', () => {
  it.each([
    ['authenticated', '{"status":"authenticated","isAuthenticated":true}', false, true],
    ['partially authenticated', '{"status":"partially-authenticated","isAuthenticated":false,"hasRefreshToken":true}', false, false],
    ['unauthenticated', '{"status":"unauthenticated","isAuthenticated":false}', false, false],
    ['malformed', '{not JSON', false, false],
    ['offline failure', '{"isAuthenticated":true}', true, false],
  ] as const)('reports %s status and skips status during admission', async (_label, status, nonzero, authPresent) => {
    const box = setup({ FAKE_CURSOR_STATUS: status, ...(nonzero ? { FAKE_CURSOR_STATUS_EXIT: '1' } : {}) });
    expect(await box.adapter.detect()).toMatchObject({ kind: 'available', version: VERSION, authPresent, executableSource: 'config', executablePath: box.bin });
    const detected = await observeAdmissionDetection(box.adapter);
    expect(detected).not.toHaveProperty('authPresent');
    expect(box.facts().flatMap(({ argv }) => argv ? [argv] : [])).toEqual([
      ['--version'], ['acp', '--help'], ['status', '--format', 'json'], ['--version'], ['acp', '--help'],
    ]);
  });

  it('uses the override, then cursor-agent on PATH, then the installer link and ignores bare agent', async () => {
    const { bin, cwd, env } = setup();
    const installer = path.join(cwd, '.local', 'bin', 'cursor-agent');
    mkdirSync(path.dirname(installer), { recursive: true });
    copyFileSync(bin, installer);
    copyFileSync(bin, path.join(cwd, 'agent'));
    const runtimeEnv = { ...env, PATH: cwd };
    vi.stubEnv('BYOK_CURSOR_BIN', `  ${path.join(cwd, 'agent')}  `);
    expect(resolveCursorBin(runtimeEnv)).toEqual({ command: path.join(cwd, 'agent'), source: 'env' });
    vi.stubEnv('BYOK_CURSOR_BIN', '   ');
    expect(resolveCursorBin(runtimeEnv)).toEqual({ command: bin, source: 'path' });
    rmSync(bin);
    expect(resolveCursorBin(runtimeEnv)).toEqual({ command: installer, source: 'path' });
    vi.stubEnv('HOME', cwd);
    expect(resolveCursorBin({ ...runtimeEnv, HOME: '' })).toEqual({ command: installer, source: 'path' });
    rmSync(installer);
    expect(() => resolveCursorBin(runtimeEnv)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it.each([['FAKE_CURSOR_NO_ACP', '1'], ['FAKE_CURSOR_VERSION', 'unexpected']])('refuses incompatible installations (%s=%s)', async (name, value) => {
    const { adapter } = setup({ [name]: value });
    await expect(adapter.detect()).resolves.toEqual({ kind: 'refused', reason: 'acp_unavailable' });
  });

  it('builds only when opted in and accepts a Host CalVer version policy', async () => {
    const box = setup({ FAKE_CURSOR_VERSION: `cursor-agent ${VERSION}` });
    const [adapter] = createRuntimeAdapters({ runtimeAllowlist: ['cursor'], runtimes: { cursor: {
      executable: box.bin, model: 'fixture-model', runtimeEnvironment: { base: 'allowlist', pass: ['FAKE_CURSOR_*'] },
      versionPolicy: { qualifiedVersion: '2026.11.22-e9042b2', unqualified: 'block' },
    } } });
    expect(adapter?.descriptor).toMatchObject({ id: 'cursor', platforms: ['darwin', 'linux'], defaultModelModes: ['adapter-model'], supportsEffort: true });
    expect(createRuntimeAdapters({}).map(({ descriptor }) => descriptor.id)).toEqual(['pi', 'claude', 'codex']);
    await expect(adapter?.detect()).resolves.toMatchObject({ version: VERSION, versionVerdict: { state: 'block' } });
  });

  it('opens with picker metadata and user login, confirms model/effort, projects a turn and follows up', async () => {
    const box = setup();
    const imagePath = path.join(box.cwd, 'fixture.png');
    writeFileSync(imagePath, 'hello');
    const session = await box.start({ target: MODEL, effort: 'high', images: [{ path: imagePath, mediaType: 'image/png' }] });
    expect(session.capabilities?.images).toBe(true);
    expect(session.sessionRef).toBe(SESSION);
    expect(await turn(session)).toEqual(expect.arrayContaining([
      { type: 'message_draft_delta', text: 'hello ', startsMessage: false },
      expect.objectContaining({ type: 'tool_use', toolCallId: 'shell' }),
      expect.objectContaining({ type: 'tool_result', toolCallId: 'shell' }),
      { type: 'progress', text: 'world' }, { type: 'turn_end' },
    ]));
    await session.followUp({ target: MODEL, effort: 'high', instruction: 'second' });
    expect(await turn(session)).toContainEqual({ type: 'turn_end' });
    await expect(session.steer('steer')).rejects.toBeInstanceOf(SteerUnsupportedError);
    expect(box.facts().find(({ method }) => method === 'initialize')?.params).toMatchObject({ clientCapabilities: { terminal: false, _meta: { parameterizedModelPicker: true } } });
    expect(box.facts().filter(({ method }) => method === 'session/set_config_option').map(({ params }) => params)).toEqual([
      { sessionId: SESSION, configId: 'model', value: 'fixture-model' }, { sessionId: SESSION, configId: 'reasoning_effort', value: 'high' },
    ]);
    expect(box.facts().find(({ method }) => method === 'session/prompt')?.params).toMatchObject({ prompt: [
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }, { type: 'text', text: 'go' },
    ] });
    expect(box.facts().some(({ method }) => method === 'authenticate')).toBe(false);
  });

  it('opens and follows up on auto-lane offers with the configured device default', async () => {
    const box = setup({}, { model: 'fixture-model' });
    const session = await box.start({ target: AUTO });
    expect(await turn(session)).toContainEqual({ type: 'turn_end' });
    await session.followUp({ target: AUTO, instruction: 'auto follow-up' });
    expect(await turn(session)).toContainEqual({ type: 'turn_end' });
    expect(box.facts().filter(({ method }) => method === 'session/set_config_option').map(({ params }) => params)).toEqual([
      { sessionId: SESSION, configId: 'model', value: 'fixture-model' },
    ]);
  });

  it('refuses service tier and fallback in offers, sealed starts, and follow-ups', async () => {
    const box = setup();
    const { descriptor } = box.adapter;
    expect(descriptor).not.toHaveProperty('supportsServiceTier');
    expect(descriptor).not.toHaveProperty('supportsServiceTierFallback');
    const offer = { target: TARGET, instruction: 'go' };
    const tier = { serviceTier: 'fast', serviceTierFallback: 'default' } as const;
    const prepare = (requested: RuntimeTaskInput) => box.adapter.prepare({ offer: requested, descriptor, requiredToolsetIds: [] });
    for (const request of [{ ...offer, ...tier }, { ...offer, target: { ...TARGET, ...tier } }]) {
      await expect(prepare(request)).resolves.toMatchObject({ kind: 'reject', reason: 'Cursor does not support serviceTier', retryable: false });
    }
    expect(box.facts()).toHaveLength(0);
    await expect(box.start({}, { startTierOptions: tier })).rejects.toMatchObject({
      phase: 'start', retry: 'non-retryable', message: 'Cursor does not support serviceTier',
    });
    expect(box.facts().some(({ method }) => method === 'initialize')).toBe(false);
    const session = await box.start();
    await turn(session);
    await expect(session.followUp({ ...offer, ...tier })).rejects.toThrow('Cursor does not support serviceTier');
    expect(box.facts().filter(({ method }) => method === 'session/prompt')).toHaveLength(1);
  });

  it('refuses unsupported platforms before resolving a binary', async () => {
    const resolveBin = vi.fn();
    const { adapter } = setup({}, { resolveBin });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      await expect(adapter.detect()).resolves.toEqual({ kind: 'refused', reason: 'platform_unsupported' });
      expect(resolveBin).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', platform); }
  });

  it('refuses image input when the CLI omits image capability', async () => {
    const box = setup({ FAKE_CURSOR_NO_IMAGES: '1' });
    const imagePath = path.join(box.cwd, 'fixture.png');
    writeFileSync(imagePath, 'hello');
    await expect(box.start({ images: [{ path: imagePath, mediaType: 'image/png' }] })).rejects.toMatchObject({ phase: 'start' });
    expect(box.facts().some(({ method }) => method === 'session/prompt')).toBe(false);
  });

  it('loads the same session and forwards uncredentialed MCP on both open paths', async () => {
    const box = setup();
    const mcpServers = { local: { command: 'tool', args: ['--stdio'], env: {} } };
    const fresh = await box.start({}, { mcpServers });
    await turn(fresh);
    await fresh.close();
    const resumed = await box.start({ sessionRef: fresh.sessionRef }, { mcpServers });
    expect(resumed.sessionRef).toBe(fresh.sessionRef);
    expect(await turn(resumed)).not.toContainEqual({ type: 'progress', text: 'old reply' });
    const mcp = [{ name: 'local', command: 'tool', args: ['--stdio'], env: [] }];
    expect(box.facts().filter(({ method }) => method === 'session/new' || method === 'session/load').map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'session/new', params: { cwd: box.cwd, mcpServers: mcp } },
      { method: 'session/load', params: { sessionId: SESSION, cwd: box.cwd, mcpServers: mcp } },
    ]);
  });

  it('refuses invalid model and wrong model/effort readback before prompt', async () => {
    const box = setup({ FAKE_CURSOR_WRONG_MODEL: '1', FAKE_CURSOR_WRONG_EFFORT: '1' });
    const invalid = { ...MODEL, selection: { ...MODEL.selection, modelId: 'missing' } };
    const modelFailure = { phase: 'start', retry: 'non-retryable', failure: { class: 'model_unavailable' } };
    await expect(box.start({ target: invalid })).rejects.toMatchObject(modelFailure);
    await expect(box.start({ target: MODEL })).rejects.toMatchObject(modelFailure);
    await expect(box.start({ effort: 'high' })).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', failure: { class: 'invalid_request' } });
    expect(box.facts().some(({ method }) => method === 'session/prompt')).toBe(false);
  });

  it('reads the catalog through owned ACP and strips Cursor credential and endpoint names from every subprocess', async () => {
    const credentials = Object.fromEntries(CURSOR_AUTH_ENV_NAMES.flatMap(name => [[name, 'ambient'], [name.toLowerCase(), 'alias']]));
    const box = setup(credentials);
    expect(CURSOR_AUTH_ENV_NAMES).toContain('CURSOR_WEBSITE_URL');
    const malformed = { 'CURSOR_API_KEY=alias': 'dummy', 'OPENAI_API_KEY=alias': 'dummy' };
    expect(withoutProviderCredentials({ ...credentials, ...malformed, CURSOR_CONFIG_DIR: '/cli-config' })).toEqual({ CURSOR_CONFIG_DIR: '/cli-config' });
    expect(buildAllowlistedEnv({ ambient: malformed, allow: ['CURSOR_*', 'OPENAI_*'] })).toEqual({});
    const { env, report } = await box.adapter.runtimeEnvironment();
    expect(report.removed).toEqual(expect.arrayContaining(Object.keys(credentials).map(name => ({ name, rule: 'deny' }))));
    for (const filtered of [env, agyEnvironment(credentials, box.cwd), dshEnvironment(credentials, box.cwd, 'read-only'), projectPiMcpEnvironment(credentials)]) {
      expect(Object.keys(filtered).filter(name => Object.hasOwn(credentials, name))).toEqual([]);
    }
    await box.adapter.detect();
    expect(await box.adapter.listModels()).toEqual({ kind: 'ok', models: [
      { id: 'default', displayName: 'Auto' },
      { id: 'fixture-model', displayName: 'Fixture', effortLevels: ['medium', 'high'], defaultEffort: 'medium' },
    ] });
    await box.start({}, { env: { ...box.env, ...malformed } });
    const launches = box.facts().filter(({ argv }) => argv !== undefined);
    expect(launches.map(({ argv }) => argv)).toEqual([
      ['--version'], ['acp', '--help'], ['status', '--format', 'json'], ['--version'], ['--force', 'acp'],
      ['--version'], ['acp', '--help'], ['--force', 'acp'],
    ]);
    expect(launches.flatMap(({ credentialNames }) => credentialNames ?? []).filter(name => isCursorAuthEnvironmentName(name))).toEqual([]);
    expect(box.facts().some(({ method }) => method === 'authenticate')).toBe(false);
  });

  it('reports missing login for create, resume and model discovery without starting authentication', async () => {
    const box = setup({ FAKE_CURSOR_LOGGED_OUT: '1' });
    await expect(box.start()).rejects.toMatchObject(LOGIN_FAILURE);
    await expect(box.start({ sessionRef: SESSION })).rejects.toMatchObject(LOGIN_FAILURE);
    await expect(box.adapter.listModels()).resolves.toEqual({ kind: 'unauthenticated' });
    expect(box.facts().some(({ method }) => method === 'authenticate')).toBe(false);
  });

  it('answers every vendor request method-not-found and finishes the turn', async () => {
    const box = setup();
    const session = await box.start({ instruction: 'extensions' });
    expect(await turn(session)).toContainEqual({ type: 'turn_end' });
    expect(box.facts()).toContainEqual({ refusals: [-32601, -32601, -32601, -32601, -32601] });
  });

  it('refuses a reverse terminal request without spawning a terminal', async () => {
    const box = setup();
    const session = await box.start({ instruction: 'terminal' });
    expect(await turn(session)).toContainEqual({ type: 'turn_end' });
    const terminal = box.facts().find(fact => fact.terminal)?.terminal;
    expect(terminal?.error?.code).toBe(-32601);
    expect(terminal?.result).toBeUndefined();
  });

  it('cancels unexpected permissions and surfaces a turn failure', async () => {
    const box = setup();
    const session = await box.start({ instruction: 'permission' });
    await expect(turn(session)).rejects.toMatchObject({ phase: 'run', retry: 'non-retryable' });
    expect(box.facts()).toContainEqual({ permission: { outcome: { outcome: 'cancelled' } } });
  });

  it('aborts a live prompt using session/cancel and reports unexpected child exit', async () => {
    const box = setup();
    const session = await box.start({ instruction: 'wait' });
    await session.interrupt();
    expect(await turn(session)).toContainEqual({ type: 'turn_end' });
    expect(box.facts().some(({ method }) => method === 'session/cancel')).toBe(true);
    await session.followUp({ target: TARGET, instruction: 'exit' });
    await expect(turn(session)).rejects.toMatchObject({ failure: { class: 'runtime_exited' } });
  });

  it('disposes the Cursor process group and its tool child', async () => {
    const box = setup();
    const session = await box.start({ instruction: 'tree' });
    await vi.waitFor(() => expect(box.facts().find(({ descendant }) => descendant)).toBeDefined());
    const child = captureProcessIdentity(box.facts().find(({ descendant }) => descendant)!.descendant!);
    const cli = captureProcessIdentity(box.facts().find(({ argv }) => argv?.join(' ') === '--force acp')!.pid!);
    await session.close();
    expectProcessNotLive(child);
    expectProcessNotLive(cli);
  });

  it('remembers a detached child before native session close reparents it', async () => {
    const box = setup({ FAKE_CURSOR_SESSION_CLOSE: '1' });
    const session = await box.start({ instruction: 'detached-tree' });
    await turn(session);
    const child = captureProcessIdentity(box.facts().find(({ descendant }) => descendant)!.descendant!);
    const cli = box.facts().find(({ argv }) => argv?.join(' ') === '--force acp')!.pid!;
    try {
      expect(observeOwnedProcessTable().table.get(child.pid)).toMatchObject({ ppid: cli, pgid: child.pid });
      await session.close();
      expect(box.facts().some(({ method }) => method === 'session/close')).toBe(true);
      expectProcessNotLive(child);
    } finally {
      const current = observeOwnedProcessTable().table.get(child.pid);
      if (current !== undefined && current.start === child.start && current.zombie !== true) process.kill(child.pid, 'SIGKILL');
    }
  });

  it('uses the shared 10 second ACP cancel fallback if the child ignores cancel', async () => {
    const box = setup({ FAKE_CURSOR_IGNORE_CANCEL: '1' });
    const session = await box.start({ instruction: 'wait' });
    const nativeTimer = globalThis.setTimeout;
    const observed = vi.fn();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      if (ms === 10_000) observed();
      return nativeTimer(fn, ms === 10_000 ? 50 : ms, ...args);
    });
    await session.interrupt();
    expect(observed).toHaveBeenCalled();
    await expect(turn(session)).rejects.toMatchObject({ failure: { class: 'runtime_exited' } });
  });

  it('reuses shared ACP queue and withdraw without sending a withdrawn prompt', async () => {
    const box = setup();
    const scratch = await testExecutionScratch();
    const raw = await cursorSession(spawnOwnedLineProcess, { kind: 'available', via: 'executable', command: box.bin },
      { cwd: box.cwd, env: { ...box.env, ...scratch.env }, retainedBytes: 1_000_000 });
    try {
      await raw.prompt('wait');
      await expect(raw.queue('withdrawn', { inputId: 'withdraw-me' })).resolves.toMatchObject({ response: { body: { kind: 'accepted' } } });
      await expect(raw.withdraw?.('withdraw-me')).resolves.toMatchObject({ response: { body: { kind: 'accepted' } } });
      await expect(raw.queue('queued', { inputId: 'keep-me' })).resolves.toMatchObject({ response: { body: { kind: 'accepted' } } });
      await raw.abort();
      await vi.waitFor(() => expect(box.facts().filter(({ method }) => method === 'session/prompt').map(({ params }) => params)).toMatchObject([
        { prompt: [{ type: 'text', text: 'wait' }] }, { prompt: [{ type: 'text', text: 'queued' }] },
      ]));
      expect(raw.steer).toBeUndefined();
      expect(raw.records()).toContainEqual(expect.objectContaining({ kind: 'frame', body: expect.objectContaining({
        events: expect.arrayContaining([expect.objectContaining({ kind: 'reasoning', content: { kind: 'text', text: 'working' } })]),
      }) }));
    } finally {
      await raw.dispose();
      await scratch.release();
    }
  });

  it('refuses credentialed MCP in prepare and a changed credentialed authority at start before opening ACP', async () => {
    const box = setup();
    const offer = { target: TARGET, instruction: 'go' };
    const admission = { offer, descriptor: box.adapter.descriptor, requiredToolsetIds: [] };
    for (const credential of [{ env: { TOKEN: 'secret' } }, { headers: { Authorization: 'secret' } }]) {
      const mcpServers = { server: { command: 'tool', ...credential } };
      await expect(box.adapter.prepare({ ...admission, mcpServers })).resolves.toMatchObject({ kind: 'reject', retryable: false });
    }
    expect(box.facts()).toHaveLength(0);
    const prepared = await box.adapter.prepare(admission);
    if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
    const scratch = await testExecutionScratch();
    try {
      const input: RuntimeOperationInstructionStartInput = { kind: 'instruction', instruction: 'go', scratch, env: box.env,
        manifest: { taskId: 'cursor-start', runtimeId: 'cursor', descriptor: box.adapter.descriptor,
          selection: TARGET.selection, requiredToolsetIds: [], cwd: box.cwd, workspace: { workspaceDir: box.cwd }, forwardedEnvironmentNames: [] } };
      const unsupported: ReadonlyArray<Partial<RuntimeOperationStartInput> | Record<string, unknown>> = [
        { toolAuthorization: {} }, { approvalChannel: {} }, { systemPrompt: 'system' }, { appendSystemPrompt: 'append' },
        { outputSchema: {} }, { launchArgs: ['invalid'] }, { fork: {} }, { serviceTier: 'fast' }, { serviceTierFallback: 'default' },
        { nativeInteractions: {} }, { kind: 'prepared' }, { mcpServers: { local: { command: 'tool', env: { TOKEN: 'secret' } } } },
        { manifest: { ...input.manifest, homeAccess: 'memory-reader' } },
      ];
      for (const option of unsupported) {
        await expect(prepared.operation.start({ ...input, ...option } as RuntimeOperationStartInput)).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable' });
      }
      expect(box.facts().some(({ argv }) => argv?.join(' ') === '--force acp')).toBe(false);
    } finally {
      await scratch.release();
    }
  });
});
