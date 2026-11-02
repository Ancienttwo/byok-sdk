import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from './fixtures/execution-scratch';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAdapterOptions } from '../adapters/claude/claude-adapter';
import type { CodexAdapterOptions } from '../adapters/codex/codex-adapter';
import type { GrokAdapterOptions } from '../adapters/grok/grok-adapter';
import type { PiAdapterOptions } from '../adapters/pi/pi-adapter';
import { createRuntimeAdapters, type RuntimeAdaptersConfig } from '../adapters';
import { createDaemon, type DaemonConfig } from '../daemon/create-daemon';
import { DaemonConfigInvalidError } from '../daemon-config-invalid-error';
import { DAEMON_CONFIG_SCHEMA } from '../daemon/config-schema/schema.generated';
import type { DaemonConfigJsonSchema } from '../daemon/config-schema/schema-types';

/**
 * #1315: `createRuntimeAdapters` builds the adapters `createDaemon` builds.
 * Recording subclasses capture each constructor's options.
 */
const constructed = vi.hoisted(() => [] as Array<{ id: string; options: unknown }>);
vi.mock('../adapters/pi/pi-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/pi/pi-adapter')>();
  class RecordingPiAdapter extends actual.PiAdapter {
    constructor(options: PiAdapterOptions = {}) { super(options); constructed.push({ id: 'pi', options }); }
  }
  return { ...actual, PiAdapter: RecordingPiAdapter };
});
vi.mock('../adapters/claude/claude-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/claude/claude-adapter')>();
  class RecordingClaudeAdapter extends actual.ClaudeAdapter {
    constructor(options: ClaudeAdapterOptions = {}) { super(options); constructed.push({ id: 'claude', options }); }
  }
  return { ...actual, ClaudeAdapter: RecordingClaudeAdapter };
});
vi.mock('../adapters/codex/codex-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/codex/codex-adapter')>();
  class RecordingCodexAdapter extends actual.CodexAdapter {
    constructor(options: CodexAdapterOptions = {}) { super(options); constructed.push({ id: 'codex', options }); }
  }
  return { ...actual, CodexAdapter: RecordingCodexAdapter };
});
vi.mock('../adapters/grok/grok-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/grok/grok-adapter')>();
  class RecordingGrokAdapter extends actual.GrokAdapter {
    constructor(options: GrokAdapterOptions = {}) { super(options); constructed.push({ id: 'grok', options }); }
  }
  return { ...actual, GrokAdapter: RecordingGrokAdapter };
});

afterEach(() => { constructed.splice(0); });

const versionPolicy = { qualifiedVersion: '1.0.0', unqualified: 'warn' } as const;
const FACTORY_CONFIG: RuntimeAdaptersConfig = {
  nativeAssetRoot: path.join(os.tmpdir(), 'byok-native-assets'),
  runtimeAllowlist: ['pi', 'claude', 'codex', 'grok'],
  runtimes: {
    pi: { agentUserContext: 'excluded', versionPolicy, packageDir: path.join(os.tmpdir(), 'byok-pi-assets') },
    claude: { agentUserContext: 'excluded', agentSessionPersistence: 'disabled', versionPolicy },
    codex: { agentUserMcpServers: 'excluded', versionPolicy },
    grok: { compatInstructions: 'disabled', agentUserMcpServers: 'excluded', versionPolicy },
  },
  runtimeEnvironment: { base: 'allowlist', allow: ['LANG'], pass: ['HTTPS_PROXY'] },
  piByokLauncher: { command: '/opt/byok-pi-provider-launcher', profileDbPath: path.join(os.tmpdir(), 'providers.sqlite'), sessionDir: path.join(os.tmpdir(), 'pi-sessions') },
  codexSandbox: 'read-only',
};

function daemonConfig(extra: RuntimeAdaptersConfig): DaemonConfig {
  return {
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'runtime-adapters-test',
    serverUrl: 'http://127.0.0.1:1', agentHome: testAgentHomeConfig(), storage: { scratchRoot: testScratchRoot() },
    storeDir: path.join(os.tmpdir(), 'byok-runtime-adapters-store'), ...extra,
  };
}

function expectInvalid(config: RuntimeAdaptersConfig, path: string, message: RegExp): void {
  let error: unknown;
  try { createRuntimeAdapters(config); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(DaemonConfigInvalidError);
  expect((error as DaemonConfigInvalidError).issues).toContainEqual(expect.objectContaining({ code: 'invalid_value', path, message: expect.stringMatching(message) }));
}

describe('createRuntimeAdapters', () => {
  it('builds the adapter set createDaemon builds from the same configuration', () => {
    const adapters = createRuntimeAdapters(FACTORY_CONFIG);
    const factory = constructed.splice(0);
    createDaemon(daemonConfig(FACTORY_CONFIG));
    expect(factory.map(({ id }) => id)).toEqual(['pi', 'claude', 'codex', 'grok']);
    expect(constructed).toEqual(factory);
    expect(adapters.map((adapter) => adapter.descriptor.versionPolicy)).toEqual([versionPolicy, versionPolicy, versionPolicy, versionPolicy]);
  });

  it('throws a TypeError for an invalid codexSandbox or runtimeEnvironment', () => {
    expect(() => createRuntimeAdapters({ codexSandbox: 'yolo' as never })).toThrow(TypeError);
    expect(() => createRuntimeAdapters({ runtimeEnvironment: { base: 'inherit' } as never })).toThrow(TypeError);
    expect(constructed).toHaveLength(0);
  });

  it('refuses a relative packageDir, a pass of PI_PACKAGE_DIR, the durable lane and any other invalid value', () => {
    expectInvalid({ runtimes: { pi: { packageDir: 'pi-assets' } } }, 'runtimes.pi.packageDir', /absolute path/);
    expectInvalid({ runtimeEnvironment: { pass: ['PATH', 'PI_PACKAGE_DIR'] } }, 'runtimeEnvironment.pass', /runtimes\.pi\.packageDir/);
    expectInvalid({ runtimes: { pi: { durableLane: true } as never } }, 'runtimes.pi.durableLane', /only the SDK daemon builds the durable Pi lane/);
    expectInvalid({ runtimes: { claude: { agentSessionPersistence: 'off' as never } } }, 'runtimes.claude.agentSessionPersistence', /one of "disabled", "enabled"/);
    expectInvalid({ runtimeAllowlist: 'pi' as never }, 'runtimeAllowlist', /an array of strings/);
    expect(constructed).toHaveLength(0);
  });

  it('createDaemon refuses a relative packageDir and a pass of PI_PACKAGE_DIR the same way', () => {
    expect(() => createDaemon(daemonConfig({ runtimes: { pi: { packageDir: 'pi-assets' } } }))).toThrow(DaemonConfigInvalidError);
    expect(() => createDaemon(daemonConfig({ runtimeEnvironment: { pass: ['PI_PACKAGE_DIR'] } }))).toThrow(/must not name PI_PACKAGE_DIR; set runtimes\.pi\.packageDir/);
  });
});

/**
 * Drift: every constructor option of an adapter the factory builds is either
 * expressible in `DaemonConfig` (a `runtimes.<id>` field or a top-level key
 * the factory takes) or listed as embedded-only. A new option fails the
 * typecheck until it is classified here.
 */
type OptionSource = `runtimes.${string}` | keyof RuntimeAdaptersConfig | 'embedded-only';
const OPTION_SOURCES = {
  pi: {
    agentUserContext: 'runtimes.pi.agentUserContext', agentSkillPaths: 'embedded-only', agentExtensionPaths: 'embedded-only',
    nativeAssetRoot: 'nativeAssetRoot', runtimeEnvironment: 'runtimeEnvironment', packageDir: 'runtimes.pi.packageDir',
    durableLane: 'runtimes.pi.durableLane', resolveBin: 'embedded-only', spawnFn: 'embedded-only', byokLauncher: 'piByokLauncher',
    sdkHelperHost: 'sdkHelperHost', validateProviderProfileBinding: 'embedded-only', versionPolicy: 'runtimes.pi.versionPolicy',
    versionPolicySource: 'runtimes.pi.versionPolicy',
  } satisfies Record<keyof PiAdapterOptions, OptionSource>,
  claude: {
    nativeAssetRoot: 'nativeAssetRoot', runtimeEnvironment: 'runtimeEnvironment', resolveBin: 'embedded-only', spawnFn: 'embedded-only',
    interruptTimeoutMs: 'embedded-only', nativeInteractions: 'embedded-only', agentUserContext: 'runtimes.claude.agentUserContext',
    agentSessionPersistence: 'runtimes.claude.agentSessionPersistence', versionPolicy: 'runtimes.claude.versionPolicy',
    versionPolicySource: 'runtimes.claude.versionPolicy',
  } satisfies Record<keyof ClaudeAdapterOptions, OptionSource>,
  codex: {
    nativeAssetRoot: 'nativeAssetRoot', runtimeEnvironment: 'runtimeEnvironment', sandbox: 'codexSandbox', resolveBin: 'embedded-only',
    spawnFn: 'embedded-only', maxRetainedBytes: 'embedded-only', interruptTimeoutMs: 'embedded-only', operationTimeoutMs: 'embedded-only',
    nativeInteractions: 'embedded-only', agentUserMcpServers: 'runtimes.codex.agentUserMcpServers', versionPolicy: 'runtimes.codex.versionPolicy',
    versionPolicySource: 'runtimes.codex.versionPolicy',
  } satisfies Record<keyof CodexAdapterOptions, OptionSource>,
  grok: {
    nativeAssetRoot: 'nativeAssetRoot', runtimeEnvironment: 'runtimeEnvironment', model: 'embedded-only',
    compatInstructions: 'runtimes.grok.compatInstructions', agentUserMcpServers: 'runtimes.grok.agentUserMcpServers',
    versionPolicy: 'runtimes.grok.versionPolicy', versionPolicySource: 'runtimes.grok.versionPolicy', resolveBin: 'embedded-only',
    spawnFn: 'embedded-only', maxRetainedBytes: 'embedded-only', interruptTimeoutMs: 'embedded-only',
  } satisfies Record<keyof GrokAdapterOptions, OptionSource>,
};

describe('adapter option drift', () => {
  it.each(Object.entries(OPTION_SOURCES))('every %s option names a DaemonConfig field or is embedded-only', (_id, sources) => {
    for (const source of Object.values(sources) as OptionSource[]) {
      if (source === 'embedded-only') continue;
      let schema: DaemonConfigJsonSchema | undefined = DAEMON_CONFIG_SCHEMA;
      for (const key of source.split('.')) schema = schema?.properties?.[key];
      expect(schema, source).toBeDefined();
    }
  });
});
