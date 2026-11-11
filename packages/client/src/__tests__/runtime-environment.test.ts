import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { HermesAdapter } from '../adapters/hermes/hermes-adapter';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { createDaemon, createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { createRuntimeAdapters } from '../adapters/runtime-adapters';
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
    const { env } = await (await create()).runtimeEnvironment();
    expect(env.SHELL_ONLY_SENTINEL).toBe('from-rc');
    expect(env).not.toHaveProperty('HOST_ONLY_SENTINEL');
    expect(env).not.toHaveProperty('HOST_PASSED_SENTINEL');
    expect(env.NO_PROXY?.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost']));
  });

  it('pass: the named Host variable, read when the environment is built', async () => {
    useSnapshot(captured);
    const adapter = await create({ pass: ['HOST_PASSED_SENTINEL'] });
    process.env.HOST_PASSED_SENTINEL = 'written-after-construction';
    const { env, report } = await adapter.runtimeEnvironment();
    expect(env.HOST_PASSED_SENTINEL).toBe('written-after-construction');
    expect(env).not.toHaveProperty('HOST_ONLY_SENTINEL');
    // The report doctor shows comes from the same build.
    expect(report.names).toEqual(expect.arrayContaining([{ name: 'HOST_PASSED_SENTINEL', source: 'pass' }, { name: 'SHELL_ONLY_SENTINEL', source: 'login-shell' }]));
    expect(report.names.map(({ name }) => name).sort()).toEqual(Object.keys(env).sort());
  });

  it('a failed capture: the environment is refused, and detect reports runtime_environment_unavailable with the code', async () => {
    useSnapshot(failed);
    const adapter = await create();
    await expect(adapter.runtimeEnvironment()).rejects.toBeInstanceOf(RuntimeEnvironmentUnavailableError);
    expect(await adapter.detect()).toEqual({ kind: 'refused', reason: 'runtime_environment_unavailable', code: 'shell-exit-nonzero' });
  });

  it('allowlist: needs no snapshot and takes only the baseline from the live environment', async () => {
    useSnapshot(failed);
    const { env } = await (await create({ base: 'allowlist', pass: ['HOST_PASSED_SENTINEL'] })).runtimeEnvironment();
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
      const { env, report } = await new ClaudeAdapter({ runtimeEnvironment: { pass: ['ANTHROPIC_BASE_URL'] } }).runtimeEnvironment();
      expect(report.removed).toEqual([
        { name: 'ANTHROPIC_MODEL', rule: 'conflict' },
        { name: 'CLAUDE_CODE_OAUTH_TOKEN', rule: 'conflict' },
        { name: 'CLAUDE_CODE_USE_BEDROCK', rule: 'conflict' },
      ]);
      expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
      expect(env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
      expect(env).not.toHaveProperty('ANTHROPIC_MODEL');
      expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
      expect(env.SHELL_ONLY_SENTINEL).toBe('from-rc');
      const { env: unpassed } = await new ClaudeAdapter().runtimeEnvironment();
      expect(unpassed.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });
});

// #1315: runtimes.pi.packageDir is the one Pi asset root; no other runtime gets it.
describe('runtimes.pi.packageDir', () => {
  it.skipIf(process.platform === 'win32')('is the PI_PACKAGE_DIR of Pi alone, over a Host and a login-shell value', async () => {
    process.env.PI_PACKAGE_DIR = '/host/pi-assets';
    try {
      useSnapshot(captured);
      const adapters = createRuntimeAdapters({ runtimeAllowlist: ['pi', 'claude', 'codex', 'grok'], runtimes: { pi: { packageDir: '/product/pi-assets' } } });
      const environments = await Promise.all(adapters.map(async (adapter) => [adapter.descriptor.id, await adapter.runtimeEnvironment()] as const));
      for (const [id, { env }] of environments) expect(env.PI_PACKAGE_DIR, id).toBe(id === 'pi' ? '/product/pi-assets' : undefined);
      expect(environments[0]![1].report.names).toContainEqual({ name: 'PI_PACKAGE_DIR', source: 'sdk' });
      useSnapshot({ ...captured, env: { ...SHELL_ENV, PI_PACKAGE_DIR: '/shell/pi-assets' } });
      const [configured, unset] = [...createRuntimeAdapters({ runtimeAllowlist: ['pi'], runtimes: { pi: { packageDir: '/product/pi-assets' } } }), ...createRuntimeAdapters({ runtimeAllowlist: ['pi'] })];
      expect((await configured!.runtimeEnvironment()).env.PI_PACKAGE_DIR).toBe('/product/pi-assets');
      const { env, report } = await unset!.runtimeEnvironment();
      expect(env).not.toHaveProperty('PI_PACKAGE_DIR');
      expect(report.removed).toContainEqual({ name: 'PI_PACKAGE_DIR', rule: 'conflict' });
    } finally {
      delete process.env.PI_PACKAGE_DIR;
    }
  });
});

// #1759: runtimes.<id>.runtimeEnvironment replaces the top-level policy for that runtime alone.
describe('runtimes.<id>.runtimeEnvironment', () => {
  const envOf = async (adapters: RuntimeAdapter[]) => Object.fromEntries(await Promise.all(adapters.map(async (adapter) => [adapter.descriptor.id, (await adapter.runtimeEnvironment()).env] as const)));

  it('replaces the top-level policy wholesale: a top-level pass name does not reach that runtime', async () => {
    useSnapshot(captured);
    const env = await envOf(createRuntimeAdapters({
      runtimeAllowlist: ['claude', 'codex'], runtimeEnvironment: { pass: ['HOST_PASSED_SENTINEL'] },
      runtimes: { claude: { runtimeEnvironment: { pass: ['HOST_ONLY_SENTINEL'] } } },
    }));
    expect(env.claude).toMatchObject({ HOST_ONLY_SENTINEL: 'not-a-secret' });
    expect(env.claude).not.toHaveProperty('HOST_PASSED_SENTINEL');
    expect(env.codex).toMatchObject({ HOST_PASSED_SENTINEL: 'passed' });
    expect(env.codex).not.toHaveProperty('HOST_ONLY_SENTINEL');
  });

  it.skipIf(process.platform === 'win32')('a name passed only on runtimes.dsh reaches dsh and no other runtime', async () => {
    useSnapshot(captured);
    process.env.TEST_DSH_PROVIDER_KEY = 'fake-dsh-key';
    try {
      const dsh = { home: await tmpDir('byok-env-dsh-'), model: { provider: 'deepseek', model: 'deepseek-v4-flash', keyEnv: 'TEST_DSH_PROVIDER_KEY' }, runtimeEnvironment: { pass: ['TEST_DSH_PROVIDER_KEY'] } };
      const env = await envOf(createRuntimeAdapters({ runtimeAllowlist: ['pi', 'claude', 'codex', 'grok', 'dsh'], runtimes: { dsh } }));
      expect(Object.keys(env)).toEqual(['pi', 'claude', 'codex', 'grok', 'dsh']);
      for (const [id, childEnv] of Object.entries(env)) expect(childEnv.TEST_DSH_PROVIDER_KEY, id).toBe(id === 'dsh' ? 'fake-dsh-key' : undefined);
    } finally {
      delete process.env.TEST_DSH_PROVIDER_KEY;
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
    const [adapter] = createRuntimeAdapters({ runtimeAllowlist: ['claude'], runtimeEnvironment: { pass: ['HOST_PASSED_SENTINEL'] } });
    expect((await adapter!.runtimeEnvironment()).env.HOST_PASSED_SENTINEL).toBe('passed');
    expect(() => createDaemonWithAdapters({ ...base, runtimeEnvironment: {} }, [new StubRuntimeAdapter()]))
      .toThrow('DaemonConfig.runtimeEnvironment is only supported by createDaemon');
    expect(() => createDaemon({ ...base, runtimeEnvironment: { base: 'inherit' } as never })).toThrow(new TypeError('DaemonConfig.runtimeEnvironment.base must be login-shell or allowlist'));
    expect(() => createDaemon({ ...base, runtimeEnvironment: { base: 'inherit' } as never })).toThrow(TypeError);
    expect(() => createRuntimeAdapters({ runtimes: { codex: { runtimeEnvironment: { pass: ['BYOK_X'] } } } }))
      .toThrow(new TypeError('DaemonConfig.runtimes.codex.runtimeEnvironment.pass must not name CLAUDECODE or BYOK_*'));
  });

  it('a task child gets the adapter environment; a failed capture declines the offer and reports the refusal', async () => {
    useSnapshot(captured);
    const adapter = new StubRuntimeAdapter();
    adapter.runtimeEnvironment = async () => ({ env: { PATH: '/usr/bin', ADAPTER_ENV_SENTINEL: '1' }, report: { names: [], removed: [] } });
    daemon = createDaemonWithAdapters(await config(), [adapter]);
    await daemon.pair('code');
    await daemon.start();
    server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'go' }, { taskId: 'env-task', seq: server.nextSeq() }));
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'env-task');
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]!.ctx.env).toMatchObject({ PATH: '/usr/bin', ADAPTER_ENV_SENTINEL: '1' });
    expect(adapter.startCalls[0]!.ctx.env).not.toHaveProperty('HOST_ONLY_SENTINEL');

    adapter.runtimeEnvironment = async () => { throw new RuntimeEnvironmentUnavailableError('timeout'); };
    server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'go' }, { taskId: 'env-declined', seq: server.nextSeq() }));
    const decline = await server.waitFor((e) => e.type === 'task.decline' && e.task_id === 'env-declined');
    expect(decline.payload).toMatchObject({
      reason: 'runtime environment unavailable: timeout',
      code: 'runtime_unavailable',
      retryable: false,
      runtimeUnavailable: { cause: 'environment_unavailable', code: 'timeout' },
    });
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
