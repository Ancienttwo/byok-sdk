import { execFileSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../bin/config';
import { runConfigCheckCommand } from '../bin/commands/config-check';
import { OFFICIAL_LOCAL_AGENT_RELEASE } from '../bin/official-release';
import {
  DAEMON_CONFIG_SCHEMA_VERSION,
  DaemonConfigFieldRemovedError,
  DaemonConfigInvalidError,
  checkDaemonConfig,
  createDaemonWithAdapters,
  validateDaemonConfig,
  type DaemonConfig,
} from '../index';
import { describeEffectiveDaemonConfig } from '../daemon/config-schema/effective';
import { REMOVED_DAEMON_CONFIG_FIELDS } from '../daemon/config-schema/removed-fields';
import { testScratchRoot } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testAgentHomeConfig } from './fixtures/test-agent';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(readFileSync(path.join(clientRoot, 'daemon-config.schema.json'), 'utf8'));
const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function writeConfig(value: unknown): Promise<string> {
  const file = path.join(await tmpDir('byok-config-check-'), 'config.json');
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}

function runCheck(file: string, options: { strict?: boolean; json?: boolean } = {}): { code: number; out: string } {
  const lines: string[] = [];
  const code = runConfigCheckCommand(file, { strict: options.strict ?? false, json: options.json ?? false }, { log: (line) => lines.push(line) });
  return { code, out: lines.join('\n') };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('generated DaemonConfig schema (#1094)', () => {
  it('is regenerated from the DaemonConfig interface (no stale or hand-edited copy)', () => {
    // Fails with a regenerate hint when either generated file drifts from create-daemon.ts.
    execFileSync(process.execPath, [path.join(clientRoot, 'src/daemon/config-schema/generate-schema.mjs'), '--check'], { stdio: 'pipe' });
  }, 60_000);

  it('is versioned, shipped beside package.json, and marks the surfaces a config file cannot set', () => {
    const manifest = JSON.parse(readFileSync(path.join(clientRoot, 'package.json'), 'utf8'));
    expect(manifest.files).toContain('daemon-config.schema.json');
    expect(schema['x-byok-schemaVersion']).toBe(DAEMON_CONFIG_SCHEMA_VERSION);
    expect(schema.required).toEqual(['productName', 'productId', 'serverUrl']);
    for (const field of ['toolAuthorization', 'machineId', 'providerProvisioning', 'agentMemoryIntents', 'inputPreparation']) {
      expect(schema.properties[field]).toMatchObject({ 'x-byok-surface': 'embedded-only', not: {} });
    }
    expect(schema.properties.agentHome.properties.projection).toMatchObject({ 'x-byok-surface': 'embedded-only' });
    expect(schema.properties.localAgentRelease).toMatchObject({ 'x-byok-surface': 'distribution-owned', not: {} });
    expect(schema.properties.codexSandbox).toMatchObject({ enum: ['danger-full-access', 'inherit', 'read-only', 'workspace-write'] });
    expect(schema['x-byok-removedFields']).toEqual(REMOVED_DAEMON_CONFIG_FIELDS.map(({ path: field, migration }) => ({ path: field, migration })));
  });
});

describe('validateDaemonConfig', () => {
  const base = { productName: 'Acme', productId: 'acme', serverUrl: 'https://acme.example' };

  it('checks nested JSON types and record values by path, without echoing values', () => {
    const { ok, issues } = validateDaemonConfig({
      ...base, storage: { scratchRoot: 5 }, runtimePreference: ['claude', 'SECRET-VALUE'],
      mcpToolsets: { docs: { mcpServers: { srv: { command: 7 } } } },
    }, { source: 'cli' });
    expect(ok).toBe(false);
    expect(issues.map(({ code, path: issuePath }) => [code, issuePath])).toEqual([
      ['invalid_type', 'storage.scratchRoot'],
      ['invalid_value', 'runtimePreference[1]'],
      ['invalid_type', 'mcpToolsets.docs.mcpServers.srv.command'],
    ]);
    expect(JSON.stringify(issues)).not.toContain('SECRET-VALUE');
  });

  it('refuses embedded-only and distribution-owned fields only from a config file', () => {
    const fileIssues = validateDaemonConfig({ ...base, toolAuthorization: 'auto', localAgentRelease: { version: '1' } }, { source: 'cli' }).issues;
    expect(fileIssues.map((issue) => issue.code)).toEqual(['embedded_only', 'distribution_owned']);
    const embedded = validateDaemonConfig({ ...base, toolAuthorization: () => 'auto', localAgentRelease: { version: '1' } }, { source: 'embedded' });
    expect(embedded).toEqual({ ok: true, issues: [] });
  });

  it('accepts a $schema key at the root for editors', () => {
    expect(validateDaemonConfig({ $schema: './daemon-config.schema.json', ...base }, { source: 'cli' })).toEqual({ ok: true, issues: [] });
  });
});

describe('byok-agent config check: Salesko-shaped CLI config (#1094 acceptance)', () => {
  // Salesko 0.22 wrote ~/.salesko/config.json without productName.
  const salesko = { productId: 'salesko', serverUrl: 'https://salesko.example', storeDir: '/Users/x/.salesko/computer' };

  it('reports the missing productName as an error', async () => {
    const { code, out } = runCheck(await writeConfig(salesko));
    expect(code).toBe(1);
    expect(out).toContain('error   productName: config is missing required field "productName"');
    expect(() => loadConfig(undefined, salesko)).toThrow(new ConfigError('config is missing required field "productName"'));
  });

  it('warns on a misspelled field, passes without --strict and fails with it', async () => {
    const storeDir = await tmpDir('byok-config-check-store-');
    const file = await writeConfig({ ...salesko, productName: 'Salesko', storeDir, runtimeAlowlist: ['codex'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plain = runCheck(file);
    expect(warn).not.toHaveBeenCalled();
    expect(plain.code).toBe(0);
    expect(plain.out).toContain('warning runtimeAlowlist: DaemonConfig.runtimeAlowlist is not a known field and is ignored; did you mean "runtimeAllowlist"?');
    expect(plain.out).toContain('result: ok (0 errors, 1 warning)');
    const strict = runCheck(file, { strict: true });
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('result: invalid (0 errors, 1 warning; --strict fails on warnings)');
    // Q4': loading the same file for `start` never rejects an unknown field.
    expect(loadConfig(file)).toMatchObject({ productName: 'Salesko', localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE });
  });

  it('prints the same report as JSON, with the effective values', async () => {
    const storeDir = await tmpDir('byok-config-check-store-');
    const { code, out } = runCheck(await writeConfig({ ...salesko, productName: 'Salesko', storeDir }), { json: true });
    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(report).toMatchObject({ ok: true, strict: false, issues: [] });
    expect(report.effective).toMatchObject({
      schemaVersion: DAEMON_CONFIG_SCHEMA_VERSION,
      directories: { storeDir: { path: storeDir, source: 'config' } },
      toolAuthorization: { mode: 'all', localToolApproval: 'host-only' },
    });
    expect(report.effective.runtimes.map((runtime: { id: string; source: string }) => [runtime.id, runtime.source]))
      .toEqual([['pi', 'sdk-built'], ['claude', 'sdk-built'], ['codex', 'sdk-built']]);
    expect(report.effective.runtimes[2].isolation).toEqual({ agentUserMcpServers: 'inherit', sandbox: 'danger-full-access' });
  });
});

describe('removed workspaceRoot (#925) is a typed error with its migration note', () => {
  const migration = 'docs/spec.md#removed-daemonconfig-fields';

  it('on the CLI path', async () => {
    const config = { productName: 'AiphaBee', productId: 'aiphabee', serverUrl: 'http://127.0.0.1:1', workspaceRoot: '/tmp/ws' };
    expect(validateDaemonConfig(config, { source: 'cli' }).issues).toEqual([expect.objectContaining({ code: 'removed_field', path: 'workspaceRoot', migration })]);
    const file = await writeConfig(config);
    expect(() => loadConfig(file)).toThrow(`DaemonConfig.workspaceRoot was removed: since wire v4 every offer runs in its SDK-owned Agent home, never in a workspaceRoot/<taskId> directory; configure agentHome (migration: ${migration})`);
    expect(runCheck(await writeConfig(config)).code).toBe(1);
  });

  it('on the embedded path', () => {
    let thrown: unknown;
    try {
      createDaemonWithAdapters({ localAgentRelease: { version: '0.0.0-test' }, productName: 'AiphaBee', productId: 'aiphabee', serverUrl: 'http://127.0.0.1:1', workspaceRoot: '/tmp/ws' } as unknown as DaemonConfig, []);
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DaemonConfigFieldRemovedError);
    expect(thrown).toMatchObject({ code: 'daemon_config_field_removed', field: 'workspaceRoot', migration });
  });

  it('a wrong JSON type at construction is DaemonConfigInvalidError', () => {
    expect(() => createDaemonWithAdapters({ localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme', serverUrl: 'http://127.0.0.1:1', durablePi: 'yes' } as unknown as DaemonConfig, []))
      .toThrow(new DaemonConfigInvalidError([{ severity: 'error', code: 'invalid_type', path: 'durablePi', message: 'DaemonConfig.durablePi must be boolean, got string' }]));
  });
});

describe('effective values', () => {
  async function embeddedConfig(extra: Partial<DaemonConfig> = {}): Promise<DaemonConfig> {
    return {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-effective',
      serverUrl: 'http://127.0.0.1:1', storeDir: await tmpDir('byok-effective-store-'),
      storage: { scratchRoot: testScratchRoot() }, agentMemoryMcp: 'off', ...extra,
    };
  }

  it('Daemon.status().config is the report checkDaemonConfig builds, unknown fields included as warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = { ...await embeddedConfig({ agentHome: testAgentHomeConfig() }), stroeDir: '/typo' } as DaemonConfig;
    const adapters = [new StubRuntimeAdapter('pi')];
    const daemon = createDaemonWithAdapters(config, adapters);
    const status = daemon.status();
    expect(status.config).toEqual(checkDaemonConfig(config, { source: 'embedded', adapters }).effective);
    expect(status.config.warnings).toEqual([expect.objectContaining({ code: 'unknown_field', path: 'stroeDir', severity: 'warning' })]);
    // Logged exactly once, at construction; checkDaemonConfig above only reports it.
    expect(warn.mock.calls.filter(([line]) => String(line).includes('stroeDir'))).toEqual([['[byok/client] DaemonConfig.stroeDir is not a known field and is ignored; did you mean "storeDir"?']]);
    expect(status.config.runtimes).toEqual([{ id: 'pi', source: 'injected', toolAuthorizationAuto: false }]);
    expect(status.config.directories.agentHomes).toBe(path.join(path.resolve(config.agentHome!.hostStorageRoot), 'agents'));
    expect(status.config.memory.mcp).toBe(status.agentMemoryMcp);
  });

  describe.skipIf(process.platform === 'win32')('#493 execution scratch root and the socket path budget', () => {
    it('keeps scratch beside a short store', async () => {
      const config = await embeddedConfig({ storage: undefined });
      const { effective } = checkDaemonConfig(config, { source: 'embedded', adapters: [] });
      expect(effective?.directories.scratchRoot).toMatchObject({ source: 'store', path: path.join(await fs.realpath(config.storeDir!), 'tmp') });
      expect(effective!.directories.scratchRoot.socketPathBytes).toBeLessThanOrEqual(effective!.directories.scratchRoot.socketPathMaximumBytes!);
    });

    it('moves scratch to a short root when the application-data store is too long (AiphaBee)', async () => {
      const storeDir = path.join(await tmpDir('byok-effective-long-'), 'Library', 'Application Support', 'AiphaBee', 'Local Agent', 'x'.repeat(40));
      const { ok, effective } = checkDaemonConfig(await embeddedConfig({ storeDir, storage: undefined }), { source: 'embedded', adapters: [] });
      expect(ok).toBe(true);
      expect(effective?.directories.scratchRoot.source).toBe('short-root');
      expect(effective?.directories.scratchRoot.path).toMatch(/\/byok-scratch-[0-9a-f]{16}$/);
    });

    it('reports an explicit scratch root past the budget as an error at storage.scratchRoot', async () => {
      const scratchRoot = path.join(os.tmpdir(), 'y'.repeat(120));
      const { ok, issues } = checkDaemonConfig(await embeddedConfig({ storage: { scratchRoot } }), { source: 'embedded', adapters: [] });
      expect(ok).toBe(false);
      expect(issues).toEqual([expect.objectContaining({ code: 'invalid_value', path: 'storage.scratchRoot', message: expect.stringContaining('is too long for runtime Unix sockets') })]);
    });
  });

  const reportInput = (memory: Pick<Parameters<typeof describeEffectiveDaemonConfig>[0], 'memoryHelper' | 'agentMemoryMcpAdmission'>) => describeEffectiveDaemonConfig({
    config: { localAgentRelease: { version: '1' }, productName: 'A', productId: 'a', serverUrl: 'http://127.0.0.1:1', agentHome: { hostStorageRoot: '/h' } },
    warnings: [], storeDir: '/s', scratchRoot: '/s/tmp', adapters: [], runtimeSource: 'injected', platform: 'darwin', ...memory,
  });

  it('#614: a resolvable memory helper mounts the memory MCP on every Agent task', () => {
    const effective = reportInput({ memoryHelper: { state: 'resolved', path: '/sdk/agent-memory-fs' }, agentMemoryMcpAdmission: 'admitted' });
    expect(effective.memory).toEqual({ mcp: 'admitted', helper: { state: 'resolved', path: '/sdk/agent-memory-fs' } });
    expect(effective.mcpServers[0]).toEqual({ name: 'byokagentmemory', kind: 'sdk-reserved', mount: 'per-task', detail: expect.stringContaining('every Agent task') });
  });

  it('#603: a missing memory helper is reported with its reason instead of silently disabling memory', () => {
    const reason = 'SDK Agent memory helper release assets missing; build with `bun run build:release`';
    const effective = reportInput({ memoryHelper: { state: 'missing', reason }, agentMemoryMcpAdmission: 'unavailable' });
    expect(effective.memory.helper).toEqual({ state: 'missing', reason });
    expect(effective.mcpServers[0]).toEqual({ name: 'byokagentmemory', kind: 'sdk-reserved', mount: 'unavailable', detail: `SDK Agent memory helper did not resolve: ${reason}` });
  });

  it('lists host toolset servers and the tool-authorization mode', () => {
    const effective = describeEffectiveDaemonConfig({
      config: {
        localAgentRelease: { version: '1' }, productName: 'A', productId: 'a', serverUrl: 'http://127.0.0.1:1',
        mcpToolsets: { crm: { mcpServers: { salesko: { command: '/bin/salesko-mcp' } } } }, toolAuthorization: () => 'auto', localToolApproval: 'allow',
      },
      warnings: [], memoryHelper: { state: 'not-needed' }, agentMemoryMcpAdmission: 'unavailable', storeDir: '/s', scratchRoot: '/s/tmp',
      adapters: [], runtimeSource: 'injected', platform: 'linux',
    });
    expect(effective.mcpServers).toContainEqual({ name: 'salesko', kind: 'host-toolset', mount: 'per-task', detail: 'offers that require toolset crm' });
    expect(effective.toolAuthorization).toEqual({ mode: 'host-resolver', localToolApproval: 'allow' });
    expect(effective.directories.scratchRoot).toEqual({ path: '/s/tmp', source: 'store', socketPathBytes: 6, socketPathMaximumBytes: expect.any(Number) });
  });
});
