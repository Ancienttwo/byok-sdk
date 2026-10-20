import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import { HermesAdapter, type HermesAdapterOptions } from '../adapters/hermes/hermes-adapter';
import { hermesProfileConfig } from '../adapters/hermes/hermes-home';
import { SteerUnsupportedError, type Session } from '../types';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { startPreparedOperation } from './fixtures/prepared-operation';

const fixture = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));
const sessions: Session[] = [];
const dirs: string[] = [];
const task: TaskOfferPayload = { instruction: 'hello' };

/** Short paths: the fake gateway listens on `<profile>/gateway.sock`, and a Unix socket path has a small length limit. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join('/tmp', prefix));
  dirs.push(dir);
  return fs.realpath(dir);
}

async function setup(env: NodeJS.ProcessEnv = {}, options: Partial<HermesAdapterOptions> = {}) {
  const root = await tempDir('bh-');
  const workspaceDir = await tempDir('bw-');
  const receipt = path.join(await tempDir('br-'), 'receipt.jsonl');
  const adapter = new HermesAdapter({ home: root, resolveBin: () => ({ command: fixture, source: 'path' }), ...options });
  const resources = { workspaceDir, env: { PATH: process.env.PATH, HOME: os.homedir(), FAKE_HERMES_RECEIPT: receipt, ...env } };
  const open = async (offer: TaskOfferPayload = task, extra: Partial<typeof resources> & Record<string, unknown> = {}) => {
    const session = await startPreparedOperation(adapter, offer, { ...resources, ...extra });
    sessions.push(session);
    return session;
  };
  const entries = async (): Promise<Array<Record<string, any>>> =>
    (await fs.readFile(receipt, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, workspaceDir, adapter, open, entries };
}

async function turn(session: Session): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    if (event.type === 'turn_end') return events;
  }
  throw new Error('event stream ended without turn_end');
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => {})));
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('HermesAdapter construction and descriptor', () => {
  it('requires an absolute SDK-owned root that is not the user\'s ~/.hermes', () => {
    expect(() => new HermesAdapter({ home: 'relative/root' })).toThrow(/absolute/);
    expect(() => new HermesAdapter({ home: path.join(os.homedir(), '.hermes') })).toThrow(/~\/\.hermes/);
    expect(() => new HermesAdapter({ home: path.join(os.homedir(), '.hermes', 'profiles', 'x') })).toThrow(/~\/\.hermes/);
    expect(() => new HermesAdapter({ home: '/tmp/x', model: { provider: 'custom', model: '' } })).toThrow(/model/);
    expect(() => new HermesAdapter({ home: '/tmp/x', model: { provider: 'custom', model: 'm', keyEnv: 'NOT A NAME' } })).toThrow(/keyEnv/);
    expect(() => new HermesAdapter({ home: '/tmp/x', model: { provider: 'custom', model: 'm', keyEnv: 'BYOK_KEY' } })).toThrow(/BYOK_ or HERMES_/);
    expect(() => new HermesAdapter({ home: '/tmp/x', model: { provider: 'custom', model: 'm', keyEnv: 'HERMES_KEY' } })).toThrow(/BYOK_ or HERMES_/);
  });

  it('declares egress and MCP toolsets only, as a frozen custom harness', () => {
    const { descriptor } = new HermesAdapter({ home: '/tmp/x' });
    expect(descriptor).toEqual({
      id: 'hermes',
      supportsDispatchSelection: false,
      requiresMcpToolsetToolObservation: false,
      capabilities: { steer: false, resume: false, approvalInteractive: false, mcpToolsets: true },
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.capabilities)).toBe(true);
  });

  it('writes a profile config with memory and kanban dispatch off and no credential value', () => {
    const config = hermesProfileConfig({ provider: 'custom', model: 'fake-model', baseUrl: 'http://127.0.0.1:1/v1', keyEnv: 'FAKE_KEY' });
    expect(config).toContain('gateway:\n  standalone: true\n');
    expect(config).toContain('memory:\n  memory_enabled: false\n  user_profile_enabled: false\n');
    expect(config).toContain('kanban:\n  dispatch_in_gateway: false\n');
    expect(config).toContain('model:\n  provider: "custom"\n  default: "fake-model"\n  base_url: "http://127.0.0.1:1/v1"\n  key_env: "FAKE_KEY"\n');
    expect(hermesProfileConfig(undefined)).not.toContain('model:');
  });
});

describe('HermesAdapter detect', () => {
  it('reports the version and provider auth from one ACP initialize in a throwaway profile', async () => {
    const { adapter, root } = await setup();
    // detect() gets the ambient environment a task child gets, not task resources.
    process.env.FAKE_HERMES_RECEIPT = path.join(await tempDir('br-'), 'detect.jsonl');
    try {
      expect(await adapter.detect()).toEqual({
        kind: 'available',
        version: 'Hermes Agent v0.22.2+2364.g0b10b9f (2026.9.24) · stable · local 0b10b9f8155a',
        authPresent: true,
      });
      const probe = (await fs.readFile(process.env.FAKE_HERMES_RECEIPT, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(probe.map((entry) => entry.method ?? entry.mode)).toEqual(['acp', 'initialize']);
      expect(path.dirname(probe[0].home)).toBe(path.join(root, 'profiles'));
      expect(probe[0].argv).toEqual(['acp']);
      // The probe profile is gone; no gateway was started.
      expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
    } finally {
      await fs.rm(process.env.FAKE_HERMES_RECEIPT, { force: true });
      delete process.env.FAKE_HERMES_RECEIPT;
    }
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
    expect(await new HermesAdapter({ home: root, resolveBin: () => ({ command: broken, source: 'path' }) }).detect())
      .toEqual({ kind: 'probe-failed' });
  });
});

describe('HermesAdapter prepare', () => {
  it('rejects a dispatch selection and a native resume before any process starts', async () => {
    const { adapter, entries } = await setup();
    expect(await adapter.prepare({
      offer: { instruction: 'x', dispatchSelection: { lane: 'subscription', runtimeId: 'codex' } } as TaskOfferPayload,
      descriptor: adapter.descriptor, requiredToolsetIds: [],
    })).toMatchObject({ kind: 'reject', retryable: false });
    expect(await adapter.prepare({ offer: { instruction: 'x', sessionRef: 's' }, descriptor: adapter.descriptor, requiredToolsetIds: [] }))
      .toMatchObject({ kind: 'reject', reason: 'hermes does not resume native sessions', retryable: false });
    expect(await entries()).toEqual([]);
  });
});

describe('HermesAdapter session', () => {
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
    await expect(session.resolveApproval(true)).rejects.toThrow(/no interactive approval/);
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

  it('refuses to start when another gateway serves the execution profile', async () => {
    const { open, root } = await setup({ FAKE_HERMES_GATEWAY_WRONG_PID: '1' });
    await expect(open()).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', message: 'another Hermes gateway serves the execution profile' });
    expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
  });

  it('refuses a viewer that attached to a gateway the session does not own', async () => {
    const { open, root } = await setup({ FAKE_HERMES_VIEWER_TAKES_SOCKET: '1' });
    await expect(open()).rejects.toMatchObject({ phase: 'start', message: 'hermes acp attached to a gateway this session does not own' });
    expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
  });

  it('fails retryably when the gateway does not report ready in time', async () => {
    const { open, entries } = await setup({ FAKE_HERMES_GATEWAY_NEVER_READY: '1' }, { gatewayReadyTimeoutMs: 300 });
    await expect(open()).rejects.toMatchObject({ phase: 'start', retry: 'retryable', message: 'hermes gateway did not report ready in time' });
    // The viewer never started, so it could not start a gateway of its own.
    expect((await entries()).filter((entry) => entry.mode === 'acp')).toEqual([]);
  });
});
