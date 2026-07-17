import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { argValue, ConfigError, hasFlag, loadConfig, positionalArgs, resolveStoreDir } from '../bin/config';
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
    });
  });

  it('throws ConfigError (never calls process.exit) when a required field is missing', () => {
    expect(() => loadConfig(undefined, { productName: 'Acme' })).toThrow(ConfigError);
    expect(() => loadConfig(undefined, { productName: 'Acme' })).toThrow(/productId/);
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

  it('works with no configPath at all, given full overrides', () => {
    const config = loadConfig(undefined, {
      productName: 'Acme',
      productId: 'acme',
      serverUrl: 'http://example',
      workspaceRoot: '/ws',
    });
    expect(config.productId).toBe('acme');
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
