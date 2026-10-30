import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { HermesAdapter } from '../adapters/hermes/hermes-adapter';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { createDaemon, createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { buildAdapter } from '../daemon/create-daemon/support';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { RuntimeEnvironmentUnavailableError, type RuntimeEnvironmentPolicy } from '../runtime/environment';
import { setLoginShellSnapshotSource, type LoginShellSnapshot } from '../login-shell-environment';
import type { RuntimeAdapter } from '../types';
import { FRESH_OFFER } from './fixtures/fresh-offer';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * #1095: every adapter builds its children's environment from the login-shell
 * snapshot under its own policy, so a variable a Host puts into `process.env`
 * reaches a runtime only when `pass` names it — also for an adapter the Host
 * constructs itself.
 */
const SHELL_ENV = Object.freeze({ PATH: '/usr/bin:/bin', HOME: os.homedir(), SHELL_ONLY_SENTINEL: 'from-rc' });
const HOST_NAMES = ['HOST_ONLY_SENTINEL', 'HOST_PASSED_SENTINEL'] as const;

function useSnapshot(snapshot: LoginShellSnapshot): void {
  setLoginShellSnapshotSource(async () => snapshot);
}

const captured: LoginShellSnapshot = { status: { source: 'login-shell', shell: 'zsh', durationMs: 1 }, env: SHELL_ENV };
const failed: LoginShellSnapshot = { status: { source: 'unavailable', code: 'shell-exit-nonzero' } };

const dirs: string[] = [];
async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.HOST_ONLY_SENTINEL = 'not-a-secret';
  process.env.HOST_PASSED_SENTINEL = 'passed';
});

afterEach(async () => {
  for (const name of HOST_NAMES) delete process.env[name];
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type AdapterFactory = (runtimeEnvironment?: RuntimeEnvironmentPolicy) => Promise<RuntimeAdapter>;
const ADAPTERS: Array<[string, AdapterFactory]> = [
  ['claude', async (runtimeEnvironment) => new ClaudeAdapter(runtimeEnvironment === undefined ? {} : { runtimeEnvironment })],
  ['codex', async (runtimeEnvironment) => new CodexAdapter(runtimeEnvironment === undefined ? {} : { runtimeEnvironment })],
  ['grok', async (runtimeEnvironment) => new GrokAdapter(runtimeEnvironment === undefined ? {} : { runtimeEnvironment })],
  ['pi', async (runtimeEnvironment) => new PiAdapter(runtimeEnvironment === undefined ? {} : { runtimeEnvironment })],
  ['hermes', async (runtimeEnvironment) => new HermesAdapter({ home: await tmpDir('byok-env-hermes-'), ...(runtimeEnvironment === undefined ? {} : { runtimeEnvironment }) })],
];

describe.each(ADAPTERS)('%s adapter constructed directly', (_id, create) => {
  it('default: the snapshot, without the Host variables', async () => {
    useSnapshot(captured);
    const env = await (await create()).runtimeEnvironment();
    expect(env.SHELL_ONLY_SENTINEL).toBe('from-rc');
    expect(env).not.toHaveProperty('HOST_ONLY_SENTINEL');
    expect(env).not.toHaveProperty('HOST_PASSED_SENTINEL');
    expect(env.NO_PROXY?.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost']));
  });

  it('pass: the named Host variable, read when the environment is built', async () => {
    useSnapshot(captured);
    const adapter = await create({ pass: ['HOST_PASSED_SENTINEL'] });
    process.env.HOST_PASSED_SENTINEL = 'written-after-construction';
    const env = await adapter.runtimeEnvironment();
    expect(env.HOST_PASSED_SENTINEL).toBe('written-after-construction');
    expect(env).not.toHaveProperty('HOST_ONLY_SENTINEL');
  });

  it('a failed capture: the environment is refused, and detect reports runtime_environment_unavailable with the code', async () => {
    useSnapshot(failed);
    const adapter = await create();
    await expect(adapter.runtimeEnvironment()).rejects.toBeInstanceOf(RuntimeEnvironmentUnavailableError);
    expect(await adapter.detect()).toEqual({ kind: 'refused', reason: 'runtime_environment_unavailable', code: 'shell-exit-nonzero' });
  });

  it('allowlist: needs no snapshot and takes only the baseline from the live environment', async () => {
    useSnapshot(failed);
    const env = await (await create({ base: 'allowlist', pass: ['HOST_PASSED_SENTINEL'] })).runtimeEnvironment();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOST_PASSED_SENTINEL).toBe('passed');
    expect(env).not.toHaveProperty('HOST_ONLY_SENTINEL');
    expect(env).not.toHaveProperty('SHELL_ONLY_SENTINEL');
  });

  it('rejects an invalid policy at construction', async () => {
    await expect(create({ pass: ['BYOK_SECRET'] })).rejects.toThrow(/runtimeEnvironment\.pass must not name CLAUDECODE or BYOK_\*/);
  });
});

describe('Claude conflict rule', () => {
  it('a passed provider replaces the shell provider selection', async () => {
    useSnapshot({ ...captured, env: { ...SHELL_ENV, CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'shell-model', CLAUDE_CODE_OAUTH_TOKEN: 'shell-oauth' } });
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example';
    try {
      const env = await new ClaudeAdapter({ runtimeEnvironment: { pass: ['ANTHROPIC_BASE_URL'] } }).runtimeEnvironment();
      expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
      expect(env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
      expect(env).not.toHaveProperty('ANTHROPIC_MODEL');
      expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
      expect(env.SHELL_ONLY_SENTINEL).toBe('from-rc');
      const unpassed = await new ClaudeAdapter().runtimeEnvironment();
      expect(unpassed.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });
});

describe('daemon wiring', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  async function config(): Promise<DaemonConfig> {
    return {
      agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY }, storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, storeDir: await tmpDir('byok-env-store-'),
    };
  }

  it('createDaemon gives its adapters DaemonConfig.runtimeEnvironment; createDaemonWithAdapters refuses the field', async () => {
    useSnapshot(captured);
    const base = await config();
    const adapter = buildAdapter('claude', { ...base, runtimeEnvironment: { pass: ['HOST_PASSED_SENTINEL'] } }, undefined);
    expect((await adapter.runtimeEnvironment()).HOST_PASSED_SENTINEL).toBe('passed');
    expect(() => createDaemonWithAdapters({ ...base, runtimeEnvironment: {} }, [new StubRuntimeAdapter()]))
      .toThrow('DaemonConfig.runtimeEnvironment is only supported by createDaemon');
    expect(() => createDaemon({ ...base, runtimeEnvironment: { base: 'inherit' } as never })).toThrow('DaemonConfig.runtimeEnvironment.base must be login-shell or allowlist');
  });

  it('a task child gets the adapter environment; a failed capture declines the offer and reports the refusal', async () => {
    useSnapshot(captured);
    const adapter = new StubRuntimeAdapter();
    adapter.runtimeEnvironment = async () => ({ PATH: '/usr/bin', ADAPTER_ENV_SENTINEL: '1' });
    daemon = createDaemonWithAdapters(await config(), [adapter]);
    await daemon.pair('code');
    await daemon.start();
    server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'go' }, { taskId: 'env-task', seq: server.nextSeq() }));
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    expect(adapter.startCalls[0]!.ctx.env).toMatchObject({ PATH: '/usr/bin', ADAPTER_ENV_SENTINEL: '1' });
    expect(adapter.startCalls[0]!.ctx.env).not.toHaveProperty('HOST_ONLY_SENTINEL');

    adapter.runtimeEnvironment = async () => { throw new RuntimeEnvironmentUnavailableError('timeout'); };
    server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'go' }, { taskId: 'env-declined', seq: server.nextSeq() }));
    const decline = await server.waitFor((e) => e.type === 'task.decline' && e.task_id === 'env-declined', 10_000);
    expect(decline.payload).toMatchObject({ reason: 'runtime environment unavailable: timeout' });
    expect(adapter.startCalls).toHaveLength(1);
  });

  it('status reports a failed capture as the environment and as each runtime refusal', async () => {
    useSnapshot(failed);
    daemon = createDaemonWithAdapters(await config(), [new ClaudeAdapter()]);
    await daemon.pair('code');
    await daemon.start();
    expect(daemon.status().environment).toEqual({ source: 'unavailable', code: 'shell-exit-nonzero' });
    expect(daemon.status().runtimes).toMatchObject([{ id: 'claude', present: false, outcome: 'refused', reason: 'runtime_environment_unavailable', code: 'shell-exit-nonzero' }]);
  });
});
