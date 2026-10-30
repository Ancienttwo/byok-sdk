import type { RuntimeTaskInput } from '../types';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { HermesAdapter, type HermesAdapterOptions } from '../adapters/hermes/hermes-adapter';
import { hermesProfileConfig } from '../adapters/hermes/hermes-home';
import { sealRuntimeOperationManifest, SteerUnsupportedError, type Session, type MessageDraftDelta } from '../types';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { testExecutionScratch } from './fixtures/execution-scratch';
import { fakeHermesCommand } from './fixtures/fake-hermes-command';

// Pass-through: records the signal the adapter gives the foreign-gateway check; the real check still runs.
const foreignCheckSignals = vi.hoisted(() => [] as Array<AbortSignal | undefined>);
vi.mock('../adapters/hermes/gateway-ownership', async (original) => {
  const real = await original<typeof import('../adapters/hermes/gateway-ownership')>();
  return {
    ...real,
    mayStopForeignHermesGateway: (...args: Parameters<typeof real.mayStopForeignHermesGateway>) => {
      foreignCheckSignals.push(args[3]);
      return real.mayStopForeignHermesGateway(...args);
    },
  };
});

const fixture = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));
const sessions: Session[] = [];
const openings: Promise<Session>[] = [];
const dirs: string[] = [];
const task: RuntimeTaskInput = { instruction: 'hello' };
const windows = process.platform === 'win32';
/** Windows children need SystemRoot for sockets and pipes. */
const platformEnv: NodeJS.ProcessEnv = windows ? { SystemRoot: process.env.SystemRoot } : {};
let command = fixture;
let commandDir: string | undefined;

/** Short paths: the fake gateway listens on `<profile>/gateway.sock`, and a Unix socket path has a small length limit. Windows uses a named pipe. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(windows ? os.tmpdir() : '/tmp', prefix));
  dirs.push(dir);
  return fs.realpath(dir);
}

/** On Windows os.homedir() reads USERPROFILE, not HOME. */
function withUserHome(home: string, run: () => void): void {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  if (windows) process.env.USERPROFILE = home;
  try {
    run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

beforeAll(async () => {
  if (!windows) return;
  commandDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bx-'));
  command = fakeHermesCommand(fixture, commandDir);
}, 60_000);

afterAll(async () => {
  if (commandDir !== undefined) await fs.rm(commandDir, { recursive: true, force: true });
});

async function setup(env: NodeJS.ProcessEnv = {}, options: Partial<HermesAdapterOptions> = {}) {
  const root = await tempDir('bh-');
  const workspaceDir = await tempDir('bw-');
  const receipt = path.join(await tempDir('br-'), 'receipt.jsonl');
  const adapter = new HermesAdapter({ home: root, resolveBin: () => ({ command, source: 'path' }), runtimeEnvironment: { pass: ['FAKE_HERMES_*'] }, ...options });
  const resources = { workspaceDir, env: { PATH: process.env.PATH, HOME: os.homedir(), ...platformEnv, FAKE_HERMES_RECEIPT: receipt, ...env } };
  const open = (offer: RuntimeTaskInput = task, extra: Partial<typeof resources> & Record<string, unknown> = {}) => {
    const opening = startPreparedOperation(adapter, offer, { ...resources, ...extra }).then((session) => {
      sessions.push(session);
      return session;
    });
    openings.push(opening);
    return opening;
  };
  const entries = async (): Promise<Array<Record<string, any>>> =>
    (await fs.readFile(receipt, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, workspaceDir, adapter, open, entries, env: resources.env };
}

/** detect() and prepare() use the ambient environment a task child gets, not task resources. */
async function withAmbientReceipt<T>(run: (read: () => Promise<Array<Record<string, any>>>) => Promise<T>): Promise<T> {
  const file = path.join(await tempDir('br-'), 'ambient.jsonl');
  process.env.FAKE_HERMES_RECEIPT = file;
  try {
    return await run(async () => (await fs.readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  } finally {
    delete process.env.FAKE_HERMES_RECEIPT;
  }
}

async function turn(session: Session): Promise<Array<AgentEvent | MessageDraftDelta>> {
  const events: Array<AgentEvent | MessageDraftDelta> = [];
  for await (const event of session.events) {
    events.push(event);
    if (event.type === 'turn_end') return events;
  }
  throw new Error('event stream ended without turn_end');
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function cleanupFixtures(): Promise<void> {
  // A test timeout does not cancel startup. Register late sessions before closing
  // them, so no gateway can retain its profile as cwd when the roots are removed.
  await Promise.allSettled(openings.splice(0));
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => {})));
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
}

afterEach(cleanupFixtures);

describe('HermesAdapter construction and descriptor', () => {
  it('requires an absolute SDK-owned root that is not the user\'s ~/.hermes', () => {
    expect(() => new HermesAdapter({ home: 'relative/root' })).toThrow(/absolute/);
    expect(() => new HermesAdapter({ home: path.join(os.homedir(), '.hermes') })).toThrow(/~\/\.hermes/);
    expect(() => new HermesAdapter({ home: path.join(os.homedir(), '.hermes', 'profiles', 'x') })).toThrow(/~\/\.hermes/);
    expect(() => new HermesAdapter({ home: '/tmp/x', model: { provider: 'custom', model: '' } })).toThrow(/model/);
    expect(() => new HermesAdapter({ home: '/tmp/x', model: { provider: 'custom', model: 'm', keyEnv: 'NOT A NAME' } })).toThrow(/keyEnv/);
    expect(() => new HermesAdapter({ home: '/tmp/x', model: { provider: 'custom', model: 'm', keyEnv: 'BYOK_KEY' } })).toThrow(/BYOK_ or HERMES_/);
    expect(() => new HermesAdapter({ home: '/tmp/x', model: { provider: 'custom', model: 'm', keyEnv: 'HERMES_KEY' } })).toThrow(/BYOK_ or HERMES_/);
    expect(() => new HermesAdapter({ home: '/tmp/x', model: { provider: 'custom', model: 'm', baseUrl: 'https://user:secret@example.test/v1' } })).toThrow(/credentials/);
  });

  // Hermes's Windows default home is %LOCALAPPDATA%\hermes, not ~/.hermes.
  it.runIf(windows)('refuses the user\'s %LOCALAPPDATA%\\hermes root on Windows', async () => {
    const localAppData = await tempDir('bla-');
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = localAppData;
    try {
      expect(() => new HermesAdapter({ home: path.join(localAppData, 'hermes') })).toThrow(/LOCALAPPDATA/);
      expect(() => new HermesAdapter({ home: path.join(localAppData, 'HERMES', 'profiles', 'x') })).toThrow(/LOCALAPPDATA/);
      expect(() => new HermesAdapter({ home: path.join(localAppData, 'hermes-sdk') })).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
    }
  });

  it('refuses a root that reaches ~/.hermes through a symlink', async () => {
    const fakeUserHome = await tempDir('bu-');
    await fs.mkdir(path.join(fakeUserHome, '.hermes'));
    const link = path.join(await tempDir('bl-'), 'link');
    await fs.symlink(path.join(fakeUserHome, '.hermes'), link);
    withUserHome(fakeUserHome, () => {
      expect(() => new HermesAdapter({ home: link })).toThrow(/~\/\.hermes/);
    });
  });

  it('refuses a ~/.hermes root that does not exist yet below a symlinked home', async () => {
    const fakeUserHome = await tempDir('bu-');
    const link = path.join(await tempDir('bl-'), 'link');
    await fs.symlink(fakeUserHome, link);
    withUserHome(fakeUserHome, () => {
      expect(() => new HermesAdapter({ home: path.join(link, '.hermes') })).toThrow(/~\/\.hermes/);
    });
  });

  it('declares egress and MCP toolsets only, as a frozen custom harness', () => {
    const { descriptor } = new HermesAdapter({ home: '/tmp/x' });
    expect(descriptor).toEqual({
      id: 'hermes',
      supportsDispatchSelection: false,
      requiresMcpToolsetToolObservation: false,
      platforms: ['darwin', 'linux', 'win32'],
      capabilities: {
        steer: false, resume: false, approvalInteractive: false, mcpToolsets: true, messageDraft: true, preparedLane: false,
        isolation: { userContext: true, userMcpServers: true, sessionPersistence: false },
      },
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.capabilities)).toBe(true);
  });

  it('writes a profile config with memory and kanban dispatch off and no credential value', () => {
    const config = hermesProfileConfig({ provider: 'custom', model: 'fake-model', baseUrl: 'http://127.0.0.1:1/v1', keyEnv: 'FAKE_KEY' });
    expect(config).toContain('gateway:\n  standalone: true\n');
    expect(config).toContain('memory:\n  memory_enabled: false\n  user_profile_enabled: false\n');
    expect(config).toContain('kanban:\n  dispatch_in_gateway: false\n');
    expect(config).toContain('updates:\n  check: false\n');
    expect(config).toContain('model:\n  provider: "custom"\n  default: "fake-model"\n  base_url: "http://127.0.0.1:1/v1"\n  key_env: "FAKE_KEY"\n');
    expect(hermesProfileConfig(undefined)).not.toContain('model:');
  });
});

describe('HermesAdapter detect', () => {
  it('reports the version and provider auth from one ACP initialize in a throwaway profile, all under the SDK root', async () => {
    const { adapter, root } = await setup();
    await withAmbientReceipt(async (read) => {
      expect(await adapter.detect()).toEqual({
        kind: 'available',
        version: 'Hermes Agent v0.22.2+2364.g0b10b9f (2026.9.24) · stable · local 0b10b9f8155a',
        authPresent: true,
      });
      const probe = await read();
      expect(probe.map((entry) => entry.method ?? entry.mode)).toEqual(['version', 'acp', 'initialize']);
      // Never the user's ~/.hermes: the version probe runs with the root as HERMES_HOME, update check off.
      expect(probe[0]).toMatchObject({ home: root, hermesEnv: ['HERMES_HOME'] });
      expect(await fs.readFile(path.join(root, 'config.yaml'), 'utf8')).toContain('updates:\n  check: false\n');
      expect(path.dirname(probe[1]!.home)).toBe(path.join(root, 'profiles'));
      expect(path.basename(probe[1]!.home)).toMatch(/^byok-detect-/);
      expect(probe[1]!.argv).toEqual(['acp']);
      // The probe profile is gone; no gateway was started.
      expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
    });
  });

  it('deletes stale SDK profiles that no gateway serves and keeps everything else', async () => {
    const { adapter, root } = await setup();
    const profiles = path.join(root, 'profiles');
    for (const name of ['byok-stale', 'byok-recent', 'user-profile']) await fs.mkdir(path.join(profiles, name), { recursive: true });
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    for (const name of ['byok-stale', 'user-profile']) await fs.utimes(path.join(profiles, name), hourAgo, hourAgo);
    expect((await adapter.detect()).kind).toBe('available');
    expect((await fs.readdir(profiles)).sort()).toEqual(['byok-recent', 'user-profile']);
  });

  it('reports missing provider credentials and an unqualified build without refusing', async () => {
    process.env.FAKE_HERMES_AUTH = '0';
    process.env.FAKE_HERMES_VERSION = 'Hermes Agent v0.23.0 (2026.10.1) · stable';
    try {
      const { adapter } = await setup();
      expect(await adapter.detect()).toEqual({
        kind: 'available',
        version: 'Hermes Agent v0.23.0 (2026.10.1) · stable',
        authPresent: false,
        advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '0.22.2+2364.g0b10b9f' },
      });
    } finally {
      delete process.env.FAKE_HERMES_AUTH;
      delete process.env.FAKE_HERMES_VERSION;
    }
  });

  it('classifies a missing binary and a failed ACP probe', async () => {
    const root = await tempDir('bh-');
    expect(await new HermesAdapter({ home: root, resolveBin: () => ({ command: path.join(root, 'no-such-hermes'), source: 'path' }) }).detect())
      .toEqual({ kind: 'not-found' });
    const broken = path.join(root, 'broken-hermes.mjs');
    await fs.writeFile(broken, '#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log("Hermes Agent v0.22.2+2364.g0b10b9f");\nelse process.exit(3);\n', { mode: 0o755 });
    expect(await new HermesAdapter({ home: root, resolveBin: () => ({ command: fakeHermesCommand(broken, root), source: 'path' }) }).detect())
      .toEqual({ kind: 'probe-failed' });
  });
});

describe('HermesAdapter prepare', () => {
  it('rejects a dispatch selection and a native resume before any process starts', async () => {
    const { adapter } = await setup();
    await withAmbientReceipt(async (read) => {
      expect(await adapter.prepare({
        offer: { instruction: 'x', dispatchSelection: { lane: 'subscription', runtimeId: 'codex' } } as RuntimeTaskInput,
        descriptor: adapter.descriptor, requiredToolsetIds: [],
      })).toMatchObject({ kind: 'reject', retryable: false });
      expect(await adapter.prepare({ offer: { instruction: 'x', sessionRef: 's' }, descriptor: adapter.descriptor, requiredToolsetIds: [] }))
        .toMatchObject({ kind: 'reject', reason: 'hermes does not resume native sessions', retryable: false });
      expect(await read()).toEqual([]);
    });
  });

  it('admits with the version probe only; the ACP probe stays in detect()', async () => {
    const { adapter, root } = await setup();
    await withAmbientReceipt(async (read) => {
      expect((await adapter.prepare({ offer: task, descriptor: adapter.descriptor, requiredToolsetIds: [] })).kind).toBe('prepared');
      expect((await read()).map((entry) => entry.mode)).toEqual(['version']);
      expect(await fs.readdir(root)).toEqual(['config.yaml']);
    });
  });
});

describe('HermesAdapter session', () => {
  it('settles an opening session before teardown removes its profile', async () => {
    const { open, entries, root } = await setup({ FAKE_HERMES_GATEWAY_READY_DELAY_MS: '750' }, { gatewayReadyTimeoutMs: 3_000 });
    const opening = open();
    // Keep startup rejection observable while teardown awaits it.
    const outcome = opening.then((session) => ({ session }), (error: unknown) => ({ error }));
    await vi.waitFor(async () => {
      expect((await entries()).some((entry) => entry.mode === 'gateway')).toBe(true);
    }, { timeout: 5_000 });
    const gateway = (await entries()).find((entry) => entry.mode === 'gateway')!;
    expect(alive(gateway.pid)).toBe(true);
    try {
      await cleanupFixtures();
      expect(await outcome).toHaveProperty('session');
      expect(alive(gateway.pid)).toBe(false);
      await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      const result = await outcome;
      if ('session' in result) await result.session.close();
    }
  });

  it('runs a turn through an owned gateway and an attached ACP viewer', async () => {
    const { open, entries, root, workspaceDir } = await setup({ HERMES_TUI_GATEWAY_URL: 'ws://203.0.113.1:1', HERMES_PROFILE: 'other' });
    const session = await open(task, {
      mcpServers: { byokagentmessage: { command: '/bin/echo-mcp', args: ['--stdio'], env: { BYOK_CHANNEL: 'c1' } } },
    });
    expect(session.sessionRef).toBe('fake-hermes-session-1');
    expect(await turn(session)).toEqual([
      { type: 'progress', text: 'Hello' },
      { type: 'progress', text: ' turn 1' },
      { type: 'tool_use', tool: 'terminal: ls', toolCallId: 't1', input: { command: 'ls' } },
      { type: 'tool_result', tool: 'terminal: ls', toolCallId: 't1', output: 'file.txt' },
      { type: 'progress', text: 'Done.' },
      { type: 'usage', inputTokens: 11, outputTokens: 3, totalTokens: 14, contextTokens: 20, contextWindow: 1000, contextSource: 'provider' },
      { type: 'turn_end' },
    ]);
    const log = await entries();
    const gateway = log.find((entry) => entry.mode === 'gateway')!;
    const viewer = log.find((entry) => entry.mode === 'acp' && entry.method === undefined)!;
    expect(gateway.argv).toEqual(['gateway', 'run', '--quiet', '--external-supervisor', '--force']);
    expect(viewer.argv).toEqual(['--yolo', 'acp']);
    expect(path.dirname(gateway.home)).toBe(path.join(root, 'profiles'));
    expect(viewer.home).toBe(gateway.home);
    expect(viewer.cwd).toBe(workspaceDir);
    // Ambient HERMES_* never reaches Hermes; the SDK sets HERMES_HOME only.
    expect(gateway.hermesEnv).toEqual(['HERMES_HOME']);
    expect(viewer.hermesEnv).toEqual(['HERMES_HOME']);
    const opened = log.find((entry) => entry.method === 'session/new')!;
    expect(opened.gatewayPid).toBe(gateway.pid);
    expect(opened.params).toEqual({
      cwd: workspaceDir,
      mcpServers: [{ name: 'byokagentmessage', command: '/bin/echo-mcp', args: ['--stdio'], env: [{ name: 'BYOK_CHANNEL', value: 'c1' }] }],
    });
    expect(log.find((entry) => entry.method === 'session/set_mode')!.params).toEqual({ sessionId: 'fake-hermes-session-1', modeId: 'dont_ask' });
    expect(log.find((entry) => entry.method === 'initialize')!.params).toEqual({
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(await fs.readFile(path.join(gateway.home, 'config.yaml'), 'utf8')).toBe(hermesProfileConfig(undefined));
  });

  it('disposes the gateway tree, the viewer and the profile at close, and carries model caches forward', async () => {
    const processTreeFile = path.join(await tempDir('bt-'), 'tree.json');
    const { open, entries, root } = await setup({ FAKE_HERMES_PROCESS_TREE_FILE: processTreeFile, FAKE_HERMES_GATEWAY_IGNORE_SIGTERM: '1' });
    const session = await open();
    await turn(session);
    const tree = JSON.parse(await fs.readFile(processTreeFile, 'utf8')) as { rootPid: number; descendantPid: number; grandchildPid: number };
    const viewerPid = (await entries()).find((entry) => entry.mode === 'acp')!.pid as number;
    for (const pid of [tree.rootPid, tree.descendantPid, tree.grandchildPid, viewerPid]) expect(alive(pid)).toBe(true);
    await session.close();
    await session.close();
    for (const pid of [tree.rootPid, tree.descendantPid, tree.grandchildPid, viewerPid]) expect(alive(pid)).toBe(false);
    expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
    expect(await fs.readFile(path.join(root, 'byok-cache', 'models_dev_cache.json'), 'utf8')).toBe('{"synthetic":true}');

    const next = await open();
    await turn(next);
    const gateways = (await entries()).filter((entry) => entry.mode === 'gateway');
    expect(gateways.map((entry) => entry.seededCache)).toEqual([false, true]);
  });

  it('answers a permission request with cancelled, never allow', async () => {
    const { open, entries } = await setup({ FAKE_HERMES_PERMISSION: '1' });
    await turn(await open());
    expect((await entries()).find((entry) => entry.method === 'permission-answer')!.answer).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('runs an idle follow-up on the same native session and refuses steering', async () => {
    const { open, entries } = await setup();
    const session = await open();
    await turn(session);
    await session.followUp({ instruction: 'second' });
    expect((await turn(session)).filter((event) => event.type === 'progress').map((event) => (event as { text: string }).text))
      .toEqual(['Hello', ' turn 2', 'Done.']);
    expect(session.sessionRef).toBe('fake-hermes-session-1');
    expect((await entries()).filter((entry) => entry.method === 'session/prompt').map((entry) => entry.text)).toEqual(['hello', 'second']);
    await expect(session.steer('redirect')).rejects.toBeInstanceOf(SteerUnsupportedError);
  });

  it('cancels an active turn through session/cancel and ends it', async () => {
    const { open, entries } = await setup({ FAKE_HERMES_HANG: '1' });
    const session = await open();
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'progress', text: 'Hello' });
    expect((await iterator.next()).value).toEqual({ type: 'progress', text: ' turn 1' });
    await session.interrupt();
    expect((await iterator.next()).value).toEqual({ type: 'usage', inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect((await iterator.next()).value).toEqual({ type: 'turn_end' });
    expect((await entries()).find((entry) => entry.method === 'session/cancel')!.params).toEqual({ sessionId: 'fake-hermes-session-1' });
  });

  it('disposes idempotently while a turn is still active, without a turn failure', async () => {
    const { open, entries, root } = await setup({ FAKE_HERMES_HANG: '1' });
    const session = await open();
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'progress', text: 'Hello' });
    await Promise.all([session.close(), session.close()]);
    const rest: unknown[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value);
    expect(rest).toEqual([{ type: 'progress', text: ' turn 1' }]);
    const pids = (await entries()).filter((entry) => entry.method === undefined).map((entry) => entry.pid as number);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
  });

  it('fails the session when a cancelled turn does not settle', async () => {
    const { open } = await setup({ FAKE_HERMES_IGNORE_CANCEL: '1' }, { interruptTimeoutMs: 200 });
    const session = await open();
    await expect(session.interrupt()).rejects.toThrow(/cancel timed out/);
    await expect(turn(session)).rejects.toThrow(/cancel timed out/);
  });

  it('maps a failed Hermes turn to a non-retryable semantic failure', async () => {
    const { open } = await setup({ FAKE_HERMES_FAIL_DETAILS: 'admitted_turn_failed' });
    const session = await open();
    const failure = await turn(session).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'run', category: 'semantic', retry: 'non-retryable', message: 'hermes turn failed' });
  });

  it('reports unknown for a failed turn and runtime_exited for a gateway exit (#869)', async () => {
    const failed = await setup({ FAKE_HERMES_FAIL_DETAILS: 'admitted_turn_failed' });
    const failure = await turn(await failed.open()).then(() => undefined, (error: unknown) => error);
    expect((failure as RuntimeExecutionFailure).failure).toEqual({ class: 'unknown' });
    const exited = await setup({ FAKE_HERMES_KILL_GATEWAY_ON_PROMPT: '1' });
    const session = await exited.open();
    const exit = await turn(session).then(() => undefined, (error: unknown) => error);
    expect(exit).toMatchObject({ category: 'infrastructure', message: 'hermes gateway exited', failure: { class: 'runtime_exited' } });
    await session.close();
  });

  it('refuses to start when another gateway serves the execution profile', async () => {
    const { open, root, entries } = await setup({ FAKE_HERMES_GATEWAY_WRONG_PID: '1' });
    await expect(open()).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', message: 'another Hermes gateway serves the execution profile' });
    expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
    for (const entry of await entries()) expect(alive(entry.pid)).toBe(false);
  });

  // Windows: a pipe name has one listener (EADDRINUSE), so a second gateway cannot take over the owned gateway's control channel.
  it.skipIf(windows)('refuses a viewer that attached to a gateway the session does not own, and stops that gateway', async () => {
    const { open, root, entries } = await setup({ FAKE_HERMES_VIEWER_TAKES_SOCKET: '1' });
    await expect(open()).rejects.toMatchObject({ phase: 'start', message: 'hermes acp attached to a gateway this session does not own' });
    expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
    const log = await entries();
    const foreign = log.find((entry) => entry.mode === 'foreign-gateway');
    expect(foreign?.pid).toEqual(expect.any(Number));
    // SIGKILL acceptance precedes exit of the detached, unowned gateway.
    await vi.waitFor(() => {
      for (const entry of log) expect(alive(entry.pid)).toBe(false);
    });
  });

  it.skipIf(windows)('bounds the foreign-gateway check by 10 s and by the start signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { adapter, workspaceDir, env } = await setup({ FAKE_HERMES_VIEWER_TAKES_SOCKET: '1' });
      const prepared = await adapter.prepare({ offer: task, descriptor: adapter.descriptor, requiredToolsetIds: [] });
      if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
      const controller = new AbortController();
      foreignCheckSignals.length = 0;
      await expect(prepared.operation.start({
        kind: 'instruction', instruction: 'hello', signal: controller.signal, env,
        scratch: await testExecutionScratch(),
        manifest: sealRuntimeOperationManifest({
          taskId: 'foreign-check', runtimeId: 'hermes', descriptor: adapter.descriptor, requiredToolsetIds: [],
          workspace: { workspaceDir }, forwardedEnvironmentNames: [],
        }),
      })).rejects.toMatchObject({ phase: 'start', message: 'hermes acp attached to a gateway this session does not own' });
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(foreignCheckSignals).toHaveLength(1);
      const signal = foreignCheckSignals[0]!;
      expect(signal.aborted).toBe(false);
      controller.abort();
      expect(signal.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it('fails retryably when the gateway does not report ready in time', async () => {
    // The deadline must outlast the fake gateway's process start, because its receipt is written after module load.
    const { open, entries } = await setup({ FAKE_HERMES_GATEWAY_NEVER_READY: '1' }, { gatewayReadyTimeoutMs: 3_000 });
    await expect(open()).rejects.toMatchObject({ phase: 'start', retry: 'retryable', message: 'hermes gateway did not report ready in time' });
    const log = await entries();
    // The viewer never started, so it could not start a gateway of its own.
    expect(log.map((entry) => entry.mode)).toEqual(['gateway']);
    expect(alive(log[0]!.pid)).toBe(false);
  });

  it('keeps the runtime_exited class when the gateway exits before it reports ready (#869)', async () => {
    const { open } = await setup({ FAKE_HERMES_GATEWAY_EXIT_BEFORE_READY: '1' });
    const failure = await open().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'start', category: 'infrastructure', message: 'hermes gateway exited', failure: { class: 'runtime_exited' } });
  });

  it('keeps the runtime_exited class when the ACP viewer exits before it answers initialize (#869)', async () => {
    const { open } = await setup({ FAKE_HERMES_VIEWER_EXIT_ON_INITIALIZE: '1' });
    const failure = await open().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'start', category: 'infrastructure', message: 'hermes acp viewer exited', failure: { class: 'runtime_exited' } });
  });

  it('keeps an ownership start failure unknown (#869)', async () => {
    const { open } = await setup({ FAKE_HERMES_GATEWAY_WRONG_PID: '1' });
    await expect(open()).rejects.toMatchObject({ phase: 'start', message: 'another Hermes gateway serves the execution profile', failure: { class: 'unknown' } });
  });

  it('stops startup on an abort signal and disposes the owned gateway', async () => {
    const { adapter, entries, workspaceDir, root, env } = await setup({ FAKE_HERMES_GATEWAY_READY_DELAY_MS: '10000' });
    const prepared = await adapter.prepare({ offer: task, descriptor: adapter.descriptor, requiredToolsetIds: [] });
    if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
    const controller = new AbortController();
    const starting = prepared.operation.start({
      kind: 'instruction', instruction: 'hello', signal: controller.signal, env,
      scratch: await testExecutionScratch(),
      manifest: sealRuntimeOperationManifest({
        taskId: 'abort', runtimeId: 'hermes', descriptor: adapter.descriptor, requiredToolsetIds: [],
        workspace: { workspaceDir }, forwardedEnvironmentNames: [],
      }),
    });
    setTimeout(() => controller.abort(), 500);
    await expect(starting).rejects.toMatchObject({ phase: 'start', retry: 'retryable', message: 'hermes start was aborted' });
    const log = await entries();
    expect(log.map((entry) => entry.mode)).toEqual(['gateway']);
    expect(alive(log[0]!.pid)).toBe(false);
    expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
  });

  it('fails the session and disposes everything when the gateway dies mid-turn', async () => {
    const { open, entries, root } = await setup({ FAKE_HERMES_KILL_GATEWAY_ON_PROMPT: '1' });
    const session = await open();
    const failure = await turn(session).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'run', category: 'infrastructure', message: 'hermes gateway exited' });
    await session.close();
    for (const entry of await entries()) if (entry.method === undefined) expect(alive(entry.pid)).toBe(false);
    expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
  });
});
