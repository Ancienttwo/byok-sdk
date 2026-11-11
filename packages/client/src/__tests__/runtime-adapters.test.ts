import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from './fixtures/execution-scratch';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAdapterOptions } from '../adapters/claude/claude-adapter';
import type { CodexAdapterOptions } from '../adapters/codex/codex-adapter';
import type { AgyAdapterOptions } from '../adapters/antigravity/agy-adapter';
import type { DshAdapterOptions } from '../adapters/dsh/dsh-adapter';
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
vi.mock('../adapters/antigravity/agy-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/antigravity/agy-adapter')>();
  class RecordingAgyAdapter extends actual.AgyAdapter {
    constructor(options: AgyAdapterOptions) { super(options); constructed.push({ id: 'agy', options }); }
  }
  return { ...actual, AgyAdapter: RecordingAgyAdapter };
});
vi.mock('../adapters/dsh/dsh-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/dsh/dsh-adapter')>();
  class RecordingDshAdapter extends actual.DshAdapter {
    constructor(options: DshAdapterOptions) { super(options); constructed.push({ id: 'dsh', options }); }
  }
  return { ...actual, DshAdapter: RecordingDshAdapter };
});

afterEach(() => { constructed.splice(0); });

const versionPolicy = { qualifiedVersion: '1.0.0', unqualified: 'warn' } as const;
const DSH = { home: path.join(os.tmpdir(), 'byok-dsh-home'), model: { provider: 'deepseek', model: 'deepseek-v4-flash', keyEnv: 'TEST_DSH_PROVIDER_KEY' } };
const AGY = { home: path.join(os.tmpdir(), 'byok-agy-home') };
const FACTORY_CONFIG: RuntimeAdaptersConfig = {
  nativeAssetRoot: path.join(os.tmpdir(), 'byok-native-assets'),
  runtimeAllowlist: ['pi', 'claude', 'codex', 'grok', 'dsh', 'agy'],
  runtimes: {
    pi: { agentUserContext: 'excluded', versionPolicy, packageDir: path.join(os.tmpdir(), 'byok-pi-assets') },
    claude: { agentUserContext: 'excluded', agentSessionPersistence: 'disabled', versionPolicy },
    codex: { agentUserMcpServers: 'excluded', versionPolicy },
    grok: { compatInstructions: 'disabled', agentUserMcpServers: 'excluded', versionPolicy },
    dsh: { ...DSH, sandbox: 'read-only', versionPolicy },
    agy: { ...AGY, model: 'gemini-3.8-flash', versionPolicy },
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
  it.each(['inherit', 'excluded'] as const)('projects %s user context through the factory', agentUserContext => {
    const adapters = createRuntimeAdapters({ runtimes: { pi: { agentUserContext }, claude: { agentUserContext }, codex: { agentUserContext } } });
    expect(adapters.map(({ descriptor }) => [descriptor.id, descriptor.capabilities.isolation?.userInstructions, descriptor.capabilities.isolation?.userMemory]))
      .toEqual(['pi', 'claude', 'codex'].map(id => [id, agentUserContext === 'excluded', id === 'pi' || agentUserContext === 'excluded']));
  });

  it('builds the adapter set createDaemon builds from the same configuration', () => {
    const adapters = createRuntimeAdapters(FACTORY_CONFIG);
    const factory = constructed.splice(0);
    createDaemon(daemonConfig(FACTORY_CONFIG));
    expect(factory.map(({ id }) => id)).toEqual(['pi', 'claude', 'codex', 'grok', 'dsh', 'agy']);
    expect(constructed).toEqual(factory);
    expect(adapters.map((adapter) => adapter.descriptor.versionPolicy)).toEqual([versionPolicy, versionPolicy, versionPolicy, versionPolicy, versionPolicy, versionPolicy]);
    expect(factory.at(-2)?.options).toMatchObject({ ...DSH, sandbox: 'read-only', versionPolicy });
    expect(factory.at(-1)?.options).toMatchObject({ ...AGY, model: 'gemini-3.8-flash', versionPolicy });
  });

  it('builds dsh only when listed, and needs runtimes.dsh when it is', () => {
    expect(createRuntimeAdapters({ runtimes: { dsh: DSH } }).map((adapter) => adapter.descriptor.id)).toEqual(['pi', 'claude', 'codex']);
    expect(() => createRuntimeAdapters({ runtimeAllowlist: ['dsh'] })).toThrow(expect.objectContaining({
      issues: [expect.objectContaining({ code: 'missing_required', path: 'runtimes.dsh' })],
    }));
  });

  it('builds agy only when listed, and needs runtimes.agy when it is', () => {
    expect(createRuntimeAdapters({ runtimes: { agy: AGY } }).map((adapter) => adapter.descriptor.id)).toEqual(['pi', 'claude', 'codex']);
    expect(() => createRuntimeAdapters({ runtimeAllowlist: ['agy'] })).toThrow(expect.objectContaining({
      issues: [expect.objectContaining({ code: 'missing_required', path: 'runtimes.agy' })],
    }));
    expectInvalid({ runtimeAllowlist: ['agy'], runtimes: { agy: { home: 'relative' } } }, 'runtimes.agy', /absolute/);
    expectInvalid({ runtimes: { agy: { ...AGY, home: 1 as never } } }, 'runtimes.agy.home', /a string/);
  });

  it('reports what the dsh adapter refuses as a config issue', () => {
    expectInvalid({ runtimeAllowlist: ['dsh'], runtimes: { dsh: { ...DSH, home: 'relative' } } }, 'runtimes.dsh', /home must be an absolute path/);
    expectInvalid({ runtimes: { dsh: { ...DSH, home: 1 as never } } }, 'runtimes.dsh.home', /a string/);
    expectInvalid({ runtimes: { dsh: { home: DSH.home } as never } }, 'runtimes.dsh.model', /an object/);
    expectInvalid({ runtimes: { dsh: { ...DSH, sandbox: 'auto' as never } } }, 'runtimes.dsh.sandbox', /one of "danger-full-access"/);
    expect(constructed).toHaveLength(0);
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
  } satisfies Record<keyof PiAdapterOptions, OptionSource>,
  claude: {
    nativeAssetRoot: 'nativeAssetRoot', runtimeEnvironment: 'runtimeEnvironment', resolveBin: 'embedded-only', spawnFn: 'embedded-only',
    interruptTimeoutMs: 'embedded-only', nativeInteractions: 'embedded-only', agentUserContext: 'runtimes.claude.agentUserContext',
    agentSessionPersistence: 'runtimes.claude.agentSessionPersistence', versionPolicy: 'runtimes.claude.versionPolicy',
  } satisfies Record<keyof ClaudeAdapterOptions, OptionSource>,
  codex: {
    nativeAssetRoot: 'nativeAssetRoot', runtimeEnvironment: 'runtimeEnvironment', sandbox: 'codexSandbox', resolveBin: 'embedded-only',
    spawnFn: 'embedded-only', maxRetainedBytes: 'embedded-only', interruptTimeoutMs: 'embedded-only', operationTimeoutMs: 'embedded-only',
    nativeInteractions: 'embedded-only', agentUserMcpServers: 'runtimes.codex.agentUserMcpServers', agentUserContext: 'runtimes.codex.agentUserContext', versionPolicy: 'runtimes.codex.versionPolicy',
  } satisfies Record<keyof CodexAdapterOptions, OptionSource>,
  grok: {
    nativeAssetRoot: 'nativeAssetRoot', runtimeEnvironment: 'runtimeEnvironment', model: 'embedded-only',
    compatInstructions: 'runtimes.grok.compatInstructions', agentUserMcpServers: 'runtimes.grok.agentUserMcpServers',
    versionPolicy: 'runtimes.grok.versionPolicy', resolveBin: 'embedded-only',
    spawnFn: 'embedded-only', maxRetainedBytes: 'embedded-only', interruptTimeoutMs: 'embedded-only',
  } satisfies Record<keyof GrokAdapterOptions, OptionSource>,
  agy: {
    home: 'runtimes.agy.home', model: 'runtimes.agy.model', nativeAssetRoot: 'nativeAssetRoot',
    runtimeEnvironment: 'runtimeEnvironment', versionPolicy: 'runtimes.agy.versionPolicy',
    resolveBin: 'embedded-only', spawnFn: 'embedded-only', maxRetainedBytes: 'embedded-only', interruptTimeoutMs: 'embedded-only',
  } satisfies Record<keyof AgyAdapterOptions, OptionSource>,
  dsh: {
    home: 'runtimes.dsh.home', model: 'runtimes.dsh.model', sandbox: 'runtimes.dsh.sandbox', nativeAssetRoot: 'nativeAssetRoot',
    runtimeEnvironment: 'runtimeEnvironment', versionPolicy: 'runtimes.dsh.versionPolicy',
    resolveBin: 'embedded-only', spawnFn: 'embedded-only', maxRetainedBytes: 'embedded-only', interruptTimeoutMs: 'embedded-only',
  } satisfies Record<keyof DshAdapterOptions, OptionSource>,
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
