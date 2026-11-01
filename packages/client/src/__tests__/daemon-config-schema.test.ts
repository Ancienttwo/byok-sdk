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
  createDaemon,
  createDaemonWithAdapters,
  validateDaemonConfig,
  type DaemonConfig,
} from '../index';
import { parseToolAuthorizationPolicy, toolAuthorizationResolver } from '../tool-authorization';
import { describeEffectiveDaemonConfig } from '../daemon/config-schema/effective';
import { AgentEgressPolicyError, DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
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
  it('runs the generator entrypoint across platforms from an unrelated working directory', async () => {
    // Fails with a regenerate hint when either generated file drifts from create-daemon.ts.
    execFileSync(process.execPath, [path.join(clientRoot, 'src/daemon/config-schema/generate-schema.mjs'), '--check'], { cwd: await tmpDir('byok-schema entrypoint-'), stdio: 'pipe' });
  }, 60_000);

  it('is versioned, shipped beside package.json, and marks the surfaces a config file cannot set', () => {
    const manifest = JSON.parse(readFileSync(path.join(clientRoot, 'package.json'), 'utf8'));
    expect(manifest.files).toContain('daemon-config.schema.json');
    expect(schema['x-byok-schemaVersion']).toBe(DAEMON_CONFIG_SCHEMA_VERSION);
    expect(schema.required).toEqual(['productName', 'productId', 'serverUrl']);
    for (const field of ['machineId', 'providerProvisioning', 'agentMemoryIntents', 'inputPreparation']) {
      expect(schema.properties[field]).toMatchObject({ 'x-byok-surface': 'embedded-only', not: {} });
    }
    // One policy document for a config file and an embedded Host alike.
    expect(schema.properties.toolAuthorization).toMatchObject({
      type: 'object', required: ['default'],
      properties: {
        default: { enum: ['all', 'auto'] }, byRuntime: { type: 'object', additionalProperties: { enum: ['all', 'auto'] } },
        rules: { type: 'object' },
      },
    });
    expect(schema.properties.toolAuthorization).not.toHaveProperty('x-byok-surface');
    expect(schema.properties.toolAuthorization).not.toHaveProperty('x-byok-embeddedAlternative');
    expect(schema.properties.runtimes.properties).toMatchObject({
      pi: { properties: { agentUserContext: { enum: ['excluded', 'inherit'] } } },
      claude: { properties: { agentUserContext: { enum: ['excluded', 'inherit'] }, agentSessionPersistence: { enum: ['disabled', 'enabled'] } } },
      codex: { properties: { agentUserMcpServers: { enum: ['excluded', 'inherit'] } } },
      grok: { properties: { compatInstructions: { enum: ['disabled', 'inherit'] }, agentUserMcpServers: { enum: ['excluded', 'inherit'] } } },
    });
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

  it('takes the tool authorization policy from a config file and keeps distribution-owned fields embedded-only', () => {
    // One shape: the policy document. A config file carries exactly what an
    // embedded Host passes, so the earlier "function is embedded-only" rule is
    // gone with the function form itself.
    const accepted = validateDaemonConfig({ ...base, toolAuthorization: { default: 'auto', byRuntime: { pi: 'all' } } }, { source: 'cli' });
    expect(accepted).toEqual({ ok: true, issues: [] });
    const functionIssues = validateDaemonConfig({ ...base, toolAuthorization: () => 'auto', localAgentRelease: { version: '1' } }, { source: 'cli' }).issues;
    expect(functionIssues.map((issue) => issue.code)).toEqual(['invalid_type', 'distribution_owned']);
    const embedded = validateDaemonConfig({ ...base, toolAuthorization: { default: 'auto' }, localAgentRelease: { version: '1' } }, { source: 'embedded' });
    expect(embedded).toEqual({ ok: true, issues: [] });
  });

  it('accepts a $schema key at the root for editors', () => {
    expect(validateDaemonConfig({ $schema: './daemon-config.schema.json', ...base }, { source: 'cli' })).toEqual({ ok: true, issues: [] });
  });
});

describe('static toolAuthorization and runtimes (#1094)', () => {
  const base = { productName: 'Acme', productId: 'acme', serverUrl: 'https://acme.example' };

  async function bundled(extra: Partial<DaemonConfig>): Promise<DaemonConfig> {
    return {
      ...base, localAgentRelease: { version: '0.0.0-test' }, storeDir: await tmpDir('byok-static-auth-store-'),
      storage: { scratchRoot: testScratchRoot() }, agentMemoryMcp: 'off', ...extra,
    };
  }

  /** The same config as a config file would carry it: without the distribution-owned release identity. */
  function cliInput(config: DaemonConfig): Record<string, unknown> {
    const { localAgentRelease: _release, ...input } = config;
    return input;
  }

  function constructionIssues(build: () => unknown): readonly unknown[] {
    let thrown: unknown;
    try { build(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DaemonConfigInvalidError);
    return (thrown as DaemonConfigInvalidError).issues;
  }

  it.each<[string, Record<string, unknown>, string, string]>([
    ['a bad default mode', { toolAuthorization: { default: 'ask' } }, 'invalid_value', 'toolAuthorization.default'],
    ['a missing default mode', { toolAuthorization: { byRuntime: { claude: 'all' } } }, 'missing_required', 'toolAuthorization.default'],
    ['a bad byRuntime mode', { toolAuthorization: { default: 'all', byRuntime: { claude: 'never' } } }, 'invalid_value', 'toolAuthorization.byRuntime.claude'],
    ['a bad isolation value', { runtimes: { claude: { agentUserContext: 'none' } } }, 'invalid_value', 'runtimes.claude.agentUserContext'],
    ['a bad codex isolation value', { runtimes: { codex: { agentUserMcpServers: true } } }, 'invalid_value', 'runtimes.codex.agentUserMcpServers'],
    ['a bad grok compatInstructions value', { runtimeAllowlist: ['grok'], toolAuthorization: { default: 'all' }, runtimes: { grok: { compatInstructions: 'off' } } }, 'invalid_value', 'runtimes.grok.compatInstructions'],
    ['a bad grok isolation value', { runtimeAllowlist: ['grok'], toolAuthorization: { default: 'all' }, runtimes: { grok: { agentUserMcpServers: 'none' } } }, 'invalid_value', 'runtimes.grok.agentUserMcpServers'],
    ['a grok prefix without a component boundary', { runtimeAllowlist: ['grok'], toolAuthorization: { default: 'all' }, runtimes: { grok: { versionPolicy: { qualifiedVersion: '0.2.3', unqualified: 'warn', block: [{ kind: 'prefix', prefix: '0.2' }] } } } }, 'invalid_version_policy', 'runtimes.grok.versionPolicy.block[0].prefix'],
    ['a prefix without a component boundary', { runtimeAllowlist: ['codex'], runtimes: { codex: { versionPolicy: { qualifiedVersion: '0.160.0', unqualified: 'warn', block: [{ kind: 'prefix', prefix: '0.16' }] } } } }, 'invalid_version_policy', 'runtimes.codex.versionPolicy.block[0].prefix'],
    ['an empty exact version', { runtimeAllowlist: ['codex'], runtimes: { codex: { versionPolicy: { qualifiedVersion: '0.160.0', unqualified: 'warn', block: [{ kind: 'exact', version: '' }] } } } }, 'invalid_version_policy', 'runtimes.codex.versionPolicy.block[0].version'],
    ['a duplicate spec', { runtimeAllowlist: ['claude'], runtimes: { claude: { versionPolicy: { qualifiedVersion: '2.1.312', unqualified: 'allow', allow: [{ kind: 'exact', version: '2.1.313' }], warn: [{ kind: 'exact', version: '2.1.313' }] } } } }, 'invalid_version_policy', 'runtimes.claude.versionPolicy.warn[0]'],
  ])('refuses %s in a config file and at construction', async (_name, extra, code, issuePath) => {
    const fileCheck = checkDaemonConfig({ ...base, ...extra }, { source: 'cli', localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE });
    expect(fileCheck.ok).toBe(false);
    expect(fileCheck.issues).toEqual([expect.objectContaining({ severity: 'error', code, path: issuePath })]);
    const config = await bundled(extra as Partial<DaemonConfig>);
    expect(constructionIssues(() => createDaemon(config))).toEqual(fileCheck.issues);
  });

  it('accepts a valid version policy from DaemonConfig and reports it as effective', async () => {
    const versionPolicy = {
      qualifiedVersion: '0.160.0',
      unqualified: 'allow' as const,
      block: [{ kind: 'prefix' as const, prefix: '0.16.' }],
    };
    const config = await bundled({ runtimeAllowlist: ['codex'], runtimes: { codex: { versionPolicy } } });
    const report = checkDaemonConfig(cliInput(config), { source: 'cli', localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE });
    expect(report.ok).toBe(true);
    expect(report.effective?.runtimes).toEqual([
      { id: 'codex', source: 'sdk-built', toolAuthorizationAuto: false, isolation: { agentUserMcpServers: 'inherit', sandbox: 'danger-full-access' }, versionPolicy },
    ]);
    const daemon = createDaemon(config);
    expect(daemon.status().config.runtimes[0]).toMatchObject({ id: 'codex', versionPolicy });
  });

  it('refuses a byRuntime key that names no runtime of the daemon', async () => {
    const extra: Partial<DaemonConfig> = { runtimeAllowlist: ['claude'], toolAuthorization: { default: 'all', byRuntime: { codex: 'all' } } };
    const issue = {
      severity: 'error', code: 'invalid_value', path: 'toolAuthorization.byRuntime.codex',
      message: 'DaemonConfig.toolAuthorization.byRuntime.codex names no runtime of this daemon (runtimes: claude)',
    };
    const config = await bundled(extra);
    expect(checkDaemonConfig(cliInput(config), { source: 'cli', localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE })).toEqual({ ok: false, issues: [issue] });
    expect(constructionIssues(() => createDaemon(config))).toEqual([issue]);
    // Injected adapters: the key must be one of their ids.
    const injected = await bundled({ toolAuthorization: { default: 'all', byRuntime: { cladue: 'all' } } });
    const adapters = [new StubRuntimeAdapter('claude')];
    expect(constructionIssues(() => createDaemonWithAdapters(injected, adapters))).toEqual([expect.objectContaining({ path: 'toolAuthorization.byRuntime.cladue' })]);
    expect(checkDaemonConfig(injected, { source: 'embedded', adapters }).issues).toEqual([expect.objectContaining({ path: 'toolAuthorization.byRuntime.cladue' })]);
  });

  it('refuses auto for a runtime without toolAuthorizationAuto (codex), at the field that sets it', async () => {
    const fromDefault: Partial<DaemonConfig> = { runtimeAllowlist: ['claude', 'codex'], toolAuthorization: { default: 'auto' } };
    const defaultIssue = {
      severity: 'error', code: 'invalid_value', path: 'toolAuthorization.default',
      message: 'DaemonConfig.toolAuthorization.default gives runtime codex the auto mode, which codex does not support (no toolAuthorizationAuto); set toolAuthorization.byRuntime.codex to "all" or remove codex from runtimeAllowlist',
    };
    const defaultConfig = await bundled(fromDefault);
    expect(checkDaemonConfig(cliInput(defaultConfig), { source: 'cli', localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE })).toEqual({ ok: false, issues: [defaultIssue] });
    expect(constructionIssues(() => createDaemon(defaultConfig))).toEqual([defaultIssue]);

    const fromEntry = await bundled({ runtimeAllowlist: ['codex'], toolAuthorization: { default: 'all', byRuntime: { codex: 'auto' } } });
    expect(constructionIssues(() => createDaemon(fromEntry))).toEqual([expect.objectContaining({ path: 'toolAuthorization.byRuntime.codex' })]);

    const injected = await bundled({ toolAuthorization: { default: 'auto' } });
    expect(constructionIssues(() => createDaemonWithAdapters(injected, [new StubRuntimeAdapter('pi')]))).toEqual([expect.objectContaining({
      path: 'toolAuthorization.default', message: expect.stringContaining('or do not pass the pi adapter'),
    })]);
  });

  it('reports the resolved mode of every injected runtime', async () => {
    const config = await bundled({ toolAuthorization: { default: 'auto', byRuntime: { pi: 'all' } } });
    const adapters = [new StubRuntimeAdapter('pi'), new StubRuntimeAdapter('claude', undefined, { steer: true, resume: true, approvalInteractive: true, mcpToolsets: true, toolAuthorizationAuto: true })];
    const daemon = createDaemonWithAdapters(config, adapters);
    expect(daemon.status().config.toolAuthorization).toEqual({ mode: 'static', byRuntime: { pi: 'all', claude: 'auto' }, localToolApproval: 'host-only' });
    expect(checkDaemonConfig(config, { source: 'embedded', adapters }).effective).toEqual(daemon.status().config);
  });

  it('accepts one policy object from a config file and an embedded Host', async () => {
    const policy = { default: 'all' as const, rules: { alwaysAsk: [{ id: 'status', match: { commandGlob: 'git status' } }] } };
    expect(validateDaemonConfig({ ...base, toolAuthorization: policy }, { source: 'embedded' })).toEqual({ ok: true, issues: [] });
    expect(validateDaemonConfig({ ...base, toolAuthorization: policy }, { source: 'cli' })).toEqual({ ok: true, issues: [] });
    // Neither a function nor a bare mode string is a policy document.
    for (const value of [() => 'auto', 'auto']) {
      expect(validateDaemonConfig({ ...base, toolAuthorization: value }, { source: 'embedded' }).issues).toEqual([
        expect.objectContaining({ code: 'invalid_type', path: 'toolAuthorization' }),
      ]);
    }
    const daemon = createDaemonWithAdapters(await bundled({ toolAuthorization: policy }), [new StubRuntimeAdapter('pi')]);
    expect(daemon.status().config.toolAuthorization).toEqual({ mode: 'static', byRuntime: { pi: 'all' }, localToolApproval: 'host-only' });
  });

  // #1091 F3: an invalid policy never reaches an offer; construction rejects it.
  it.each([
    ['duplicate rule ids', { default: 'auto', rules: { alwaysAsk: [
      { id: 'PRIVATE_RULE', match: { toolName: 'read' } }, { id: 'PRIVATE_RULE', match: { toolName: 'write' } },
    ] } }, 'toolAuthorization', 'invalid_value'],
    ['an empty rule match', { default: 'auto', rules: { alwaysAsk: [{ id: 'empty', match: {} }] } }, 'toolAuthorization', 'invalid_value'],
    ['a non-array rule list', { default: 'auto', rules: { allowWithoutAsking: 'all' } }, 'toolAuthorization.rules.allowWithoutAsking', 'invalid_type'],
    ['a duplicate id across the two lists', { default: 'all', rules: {
      alwaysAsk: [{ id: 'same', match: { toolName: 'read' } }], allowWithoutAsking: [{ id: 'same', match: { toolName: 'write' } }],
    } }, 'toolAuthorization', 'invalid_value'],
    ['an unknown selector', { default: 'auto', rules: { alwaysAsk: [{ id: 'bad', match: { commandRegex: '.*' } }] } }, 'toolAuthorization', 'invalid_value'],
    ['a relative pathGlob', { default: 'auto', rules: { alwaysAsk: [{ id: 'rel', match: { pathGlob: 'src/**' } }] } }, 'toolAuthorization', 'invalid_value'],
    ['an invalid fileScope', { default: 'auto', fileScope: { mode: 'workspaces' } }, 'toolAuthorization.fileScope', 'invalid_file_scope'],
  ])('rejects %s at construction with DaemonConfigInvalidError', async (_label, policy, issuePath, code) => {
    const config = await bundled({ agentHome: testAgentHomeConfig(), toolAuthorization: policy as DaemonConfig['toolAuthorization'] });
    const adapters = [new StubRuntimeAdapter('pi', undefined, { steer: true, resume: true, approvalInteractive: true, toolAuthorizationAuto: true })];
    const issues = constructionIssues(() => createDaemonWithAdapters(config, adapters));
    expect(issues).toEqual([expect.objectContaining({ severity: 'error', code, path: issuePath })]);
    const check = checkDaemonConfig(config, { source: 'embedded', adapters });
    expect(check.ok).toBe(false);
    expect(check.issues.filter(issue => issue.severity === 'error')).toEqual(issues);
  });

  it.each([
    ['codexSandbox', 'configure the injected Codex adapter directly'],
    ['runtimeEnvironment', 'pass runtimeEnvironment to each injected adapter'],
    ['runtimes', 'pass the isolation options to each injected adapter'],
  ])('checkDaemonConfig refuses %s for injected adapters exactly where createDaemonWithAdapters throws', async (key, remedy) => {
    const config = { ...await bundled({}), [key]: undefined };
    const adapters = [new StubRuntimeAdapter('pi')];
    const message = `DaemonConfig.${key} is only supported by createDaemon; ${remedy}`;
    expect(() => createDaemonWithAdapters(config, adapters)).toThrow(new TypeError(message));
    expect(checkDaemonConfig(config, { source: 'embedded', adapters })).toEqual({
      ok: false, issues: [{ severity: 'error', code: 'invalid_value', path: key, message }],
    });
  });

  it('checkDaemonConfig accepts injected adapters without the createDaemon-only keys', async () => {
    const config = await bundled({});
    const adapters = [new StubRuntimeAdapter('pi')];
    expect(() => createDaemonWithAdapters(config, adapters)).not.toThrow();
    expect(checkDaemonConfig(config, { source: 'embedded', adapters })).toEqual(expect.objectContaining({ ok: true, issues: [] }));
  });

  it('derives a per-runtime resolver from one policy snapshot', () => {
    const byRuntime: Record<string, 'auto' | 'all'> = { codex: 'all' };
    const rules = { alwaysAsk: [{ id: 'read', match: { toolName: 'read' as const } }] } as const;
    const resolve = toolAuthorizationResolver(parseToolAuthorizationPolicy({ default: 'auto', byRuntime, rules }));
    byRuntime.claude = 'all';
    const policy = (runtimeId: string) => resolve({ taskId: 't', runtimeId });
    expect([policy('codex').default, policy('claude').default, policy('pi').default, policy('constructor').default, policy('__proto__').default])
      .toEqual(['all', 'auto', 'auto', 'auto', 'auto']);
    // Rules apply to every runtime, including one overridden by byRuntime.
    expect(policy('codex').rules).toEqual(policy('pi').rules);
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
    let thrown: unknown;
    try { loadConfig(file); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DaemonConfigFieldRemovedError);
    expect(thrown).toMatchObject({ code: 'daemon_config_field_removed', field: 'workspaceRoot', migration });
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

  it('rejects invalid egress policy values at their path with construction parity', async () => {
    const config = await embeddedConfig({
      agentHome: testAgentHomeConfig(),
      agentEgress: { policy: {
        ...DEFAULT_AGENT_EGRESS_POLICY,
        activity: { ...DEFAULT_AGENT_EGRESS_POLICY.activity, maxCoalesceMs: -1 },
      } },
    });
    expect(validateDaemonConfig(config, { source: 'embedded' }).ok).toBe(true);
    let thrown: unknown;
    try { createDaemonWithAdapters(config, []); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AgentEgressPolicyError);
    expect((thrown as AgentEgressPolicyError).issues).toEqual([
      { path: ['activity', 'maxCoalesceMs'], message: expect.any(String) },
    ]);
    expect(checkDaemonConfig(config, { source: 'embedded', adapters: [] })).toEqual({
      ok: false, issues: [{
        severity: 'error', code: 'invalid_value', path: 'agentEgress.policy.activity.maxCoalesceMs',
        message: (thrown as AgentEgressPolicyError).issues[0]!.message,
      }],
    });
  });

  const limits = {
    revision: 'config-check-v1', maxRequestBytes: 32_000, maxArtifactBytes: 256_000,
    maxScopeAggregateBytes: 512_000, maxInFlight: 4, maxCounterCallsPerScope: 16,
    counterTimeoutMs: 2_000, preparationDeadlineMs: 4_000, retentionMs: 60_000,
    retryHorizonMs: 30_000,
  };
  const resolveScope = vi.fn(async (): Promise<never> => { throw new Error('must not resolve authority during config check'); });
  const resolveSource = vi.fn(async (): Promise<never> => { throw new Error('must not resolve source during config check'); });
  const preparation = { limits, authorityResolver: { resolveScope, resolveSource } };

  it.each<Partial<DaemonConfig>>([
    { presence: { intervalMs: 0 } },
    { presence: { intervalMs: 5_000, minimumIntervalMs: 5_000 } },
    { presence: { intervalMs: 90_000, ttlMs: 90_000 } },
    { deviceAssertion: { audiences: [''] } },
    { deviceAssertion: { audiences: ['duplicate', 'duplicate'] } },
    { deviceAssertion: { audiences: ['界'.repeat(1_000)] } },
    { deviceAssertion: { audiences: ['audience'], ttlMs: 0 } },
    { deviceAssertion: { audiences: ['audience'], ttlMs: Number.MAX_SAFE_INTEGER } },
    { inputPreparation: { ...preparation, limits: { ...limits, maxInFlight: 0 } } },
    { inputPreparation: { ...preparation, limits: { ...limits, revision: '' } } },
    { inputPreparation: { ...preparation, limits: { ...limits, counterTimeoutMs: 5_000 } } },
    { inputPreparation: { ...preparation, limits: { ...limits, retentionMs: 3_000 } } },
    { inputPreparation: { ...preparation, limits: { ...limits, maxScopeAggregateBytes: 1 } } },
  ])('refuses operational config just as construction does: %j', async (extra) => {
    const config = await embeddedConfig(extra);
    let constructionError: unknown;
    try { createDaemonWithAdapters(config, []); } catch (error) { constructionError = error; }
    expect(constructionError).toBeInstanceOf(Error);
    const report = checkDaemonConfig(config, { source: 'embedded', adapters: [] });
    expect(report.ok).toBe(false);
    expect(report.effective).toBeUndefined();
    expect(report.issues).toEqual([expect.objectContaining({
      code: 'invalid_value', severity: 'error', message: (constructionError as Error).message,
    })]);
  });

  it.each<Partial<DaemonConfig>>([
    {},
    { deviceAssertion: { audiences: [] } },
    {
      presence: { minimumIntervalMs: 1, intervalMs: 2, ttlMs: 3 },
      deviceAssertion: { audiences: ['audience'], ttlMs: 1 }, inputPreparation: preparation,
    },
  ])('accepts defaults and valid operational bounds with construction parity: %j', async (extra) => {
    const config = await embeddedConfig(extra);
    const report = checkDaemonConfig(config, { source: 'embedded', adapters: [] });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    const daemon = createDaemonWithAdapters(config, []);
    expect(report.effective).toEqual(daemon.status().config);
    expect(resolveScope).not.toHaveBeenCalled();
    expect(resolveSource).not.toHaveBeenCalled();
  });

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
        mcpToolsets: { crm: { mcpServers: { salesko: { command: '/bin/salesko-mcp' } } } }, toolAuthorization: { default: 'auto' }, localToolApproval: 'allow',
      },
      warnings: [], memoryHelper: { state: 'not-needed' }, agentMemoryMcpAdmission: 'unavailable', storeDir: '/s', scratchRoot: '/s/tmp',
      adapters: [], runtimeSource: 'injected', platform: 'linux',
    });
    expect(effective.mcpServers).toContainEqual({ name: 'salesko', kind: 'host-toolset', mount: 'per-task', detail: 'offers that require toolset crm' });
    expect(effective.toolAuthorization).toEqual({ mode: 'static', byRuntime: {}, localToolApproval: 'allow' });
    expect(effective.directories.scratchRoot).toEqual({ path: '/s/tmp', source: 'store', socketPathBytes: 6, socketPathMaximumBytes: expect.any(Number) });
  });
});
