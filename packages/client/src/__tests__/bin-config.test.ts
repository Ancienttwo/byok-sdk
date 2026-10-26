import { testAgentHomeConfig } from './fixtures/test-agent';
import { formatStartErrorReason } from '../bin/commands/start';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { argValue, ConfigError, hasFlag, loadConfig, positionalArgs, resolveStoreDir } from '../bin/config';
import { OFFICIAL_LOCAL_AGENT_RELEASE } from '../bin/official-release';
import { DeviceStore } from '../daemon/store';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('bin/config: loadConfig', () => {
  it('loads a config file and merges overrides on top', async () => {
    const dir = await tmpDir('byok-bin-config-');
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ productName: 'Acme', productId: 'acme', serverUrl: 'http://old.example', workspaceRoot: '/ws' }),
    );

    const config = loadConfig(configPath, { serverUrl: 'http://new.example' });

    expect(config).toEqual({
      productName: 'Acme',
      productId: 'acme',
      serverUrl: 'http://new.example',
      workspaceRoot: '/ws',
      agentHome: testAgentHomeConfig(),
      localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE,
    });
  });

  it('projects the single AuthManager request deadline from JSON config without creating a CLI-specific authority', async () => {
    const dir = await tmpDir('byok-bin-config-auth-deadline-');
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        productName: 'Acme',
        productId: 'acme',
        serverUrl: 'http://example',
        workspaceRoot: '/ws',
        agentHome: testAgentHomeConfig(),
        authRequestDeadlineMs: 250,
      }),
    );

    expect((loadConfig(configPath) as unknown as Record<string, unknown>).authRequestDeadlineMs).toBe(250);
  });

  it('rejects config-authored Local Agent release identity instead of accepting a second authority', async () => {
    const dir = await tmpDir('byok-bin-config-release-');
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        productName: 'Acme',
        productId: 'acme',
        serverUrl: 'http://example',
        workspaceRoot: '/ws',
        agentHome: testAgentHomeConfig(),
        localAgentRelease: { version: '9.9.9' },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(ConfigError);
    expect(() => loadConfig(configPath)).toThrow(/localAgentRelease.*distribution/i);
    expect(() => loadConfig(undefined, {
      productName: 'Acme',
      productId: 'acme',
      serverUrl: 'http://example',
      workspaceRoot: '/ws',
      agentHome: testAgentHomeConfig(),
      localAgentRelease: { version: '9.9.9' },
    } as never)).toThrow(/localAgentRelease.*distribution/i);
  });

  it('throws ConfigError (never calls process.exit) when a required field is missing', () => {
    expect(() => loadConfig(undefined, { productName: 'Acme' })).toThrow(ConfigError);
    expect(() => loadConfig(undefined, { productName: 'Acme' })).toThrow(/productId/);
  });

  it('does not require workspaceRoot: every daemon runs its offers in the Agent home (#319, #925)', () => {
    const base = { productName: 'Acme', productId: 'acme', serverUrl: 'http://example' };
    expect(loadConfig(undefined, base)).toEqual({
      ...base,
      localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE,
    });
  });

  it('throws ConfigError on an unreadable config path', () => {
    expect(() => loadConfig('/no/such/path/config.json')).toThrow(ConfigError);
  });

  it('throws ConfigError on invalid JSON', async () => {
    const dir = await tmpDir('byok-bin-config-badjson-');
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, '{ not json');
    expect(() => loadConfig(configPath)).toThrow(ConfigError);
  });

  it('#395: ConfigError diagnostics retain actionable SDK templates without parser or config content', async () => {
    const dir = await tmpDir('byok-bin-config-safe-errors-');
    const configPath = path.join(dir, 'config.json');
    const sentinel = 'SENTINEL-395';
    try {
      await fs.writeFile(configPath, `{"secret":"${sentinel}", invalid}`);
      const base = { productName: sentinel, productId: sentinel, serverUrl: sentinel, workspaceRoot: sentinel };
      const cases: Array<[() => unknown, string]> = [
        [() => loadConfig(configPath), `config at "${configPath}" is not valid JSON`],
        [() => loadConfig(path.join(dir, 'missing.json')), `could not read config at "${path.join(dir, 'missing.json')}"; check the path and read permissions`],
        [() => loadConfig(undefined, { productName: sentinel }), 'config is missing required field "productId"'],
        [() => loadConfig(undefined, { ...base, workspaceRoot: undefined }), 'config is missing required field "workspaceRoot"'],
        [() => loadConfig(undefined, { ...base, localAgentRelease: { version: sentinel } } as never), 'config field "localAgentRelease" is distribution-owned and must not be supplied'],
        [() => loadConfig(undefined, { ...base, gitWorkspace: sentinel } as never), 'gitWorkspace must be an object'],
        [() => loadConfig(undefined, { ...base, gitWorkspace: { mode: sentinel } } as never), 'gitWorkspace.mode must be local-checkpoints'],
      ];
      for (const [load, message] of cases) {
        let caught: unknown;
        try { load(); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(ConfigError);
        expect(formatStartErrorReason(caught)).toBe(`ConfigError: ${message}`);
        expect(formatStartErrorReason(caught)).not.toContain(sentinel);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('strictly validates the optional Git workspace config', () => {
    const base = { productName: 'Acme', productId: 'acme', serverUrl: 'http://example', workspaceRoot: '/ws' };
    expect(loadConfig(undefined, { ...base, gitWorkspace: { mode: 'local-checkpoints' } }).gitWorkspace).toEqual({ mode: 'local-checkpoints' });
    expect(() => loadConfig(undefined, { ...base, gitWorkspace: { mode: 'local-checkpoints', extra: true } as never })).toThrow(ConfigError);
    expect(() => loadConfig(undefined, { ...base, gitWorkspace: { mode: 'invalid' } as never })).toThrow(ConfigError);
  });

});

describe('bin/config: resolveStoreDir', () => {
  it('uses config.storeDir when set', () => {
    expect(resolveStoreDir({ storeDir: '/custom/dir', productId: 'acme' })).toBe('/custom/dir');
  });

  it('falls back to DeviceStore.defaultDir(productId) — the exact same resolution create-daemon.ts uses internally', () => {
    expect(resolveStoreDir({ productId: 'acme' })).toBe(DeviceStore.defaultDir('acme'));
  });
});

describe('bin/config: arg helpers', () => {
  it('argValue finds the value following a flag', () => {
    expect(argValue(['--config', '/path', '--server', 'url'], '--config')).toBe('/path');
    expect(argValue(['--config', '/path'], '--missing')).toBeUndefined();
    expect(argValue(['--output', '--config', '/path'], '--output')).toBeUndefined();
  });

  it('hasFlag detects a bare boolean flag anywhere in args', () => {
    expect(hasFlag(['tasks', '--follow'], '--follow')).toBe(true);
    expect(hasFlag(['tasks'], '--follow')).toBe(false);
  });

  it('positionalArgs strips known --flag <value> pairs, order-independent', () => {
    expect(positionalArgs(['CODE', '--server', 'url', '--config', '/path'], ['--server', '--config'])).toEqual(['CODE']);
    expect(positionalArgs(['--server', 'url', 'CODE', '--config', '/path'], ['--server', '--config'])).toEqual(['CODE']);
  });

  it('positionalArgs leaves bare boolean flags alone when they are not in valueFlags', () => {
    // --follow isn't a recognized value-flag here, so it passes through as a
    // (harmless, ignored by callers) positional rather than being consumed.
    expect(positionalArgs(['task-1', 'a reason', '--config', '/path'], ['--config'])).toEqual(['task-1', 'a reason']);
  });
});
