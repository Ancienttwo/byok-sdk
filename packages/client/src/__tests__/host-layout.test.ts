import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServiceDefinition } from '../bin/commands/service';
import { HostLayoutInputError, resolveHostLayout, type DaemonConfig } from '../index';
import { DeviceStore } from '../daemon/store';
import { describeEffectiveDaemonConfig } from '../daemon/config-schema/effective';
import { defaultScratchRoot, scratchRootSocketBudget } from '../daemon/retention/scratch';

const product = { productId: 'salesko', productName: 'Salesko' } as const;

describe('resolveHostLayout (#1094)', () => {
  it('recommends a per-platform layout: SDK store under ~/.byok, Host root in the platform app-data directory', () => {
    expect(resolveHostLayout({ ...product, platform: 'darwin', homeDir: '/Users/ana', env: {} })).toEqual({
      platform: 'darwin',
      storeDir: '/Users/ana/.byok/salesko',
      scratchRoot: { path: '/Users/ana/.byok/salesko/tmp', source: 'store', socketPathBytes: 28, socketPathMaximumBytes: 61 },
      hostStorageRoot: '/Users/ana/Library/Application Support/Salesko',
      agentHomes: '/Users/ana/Library/Application Support/Salesko/agents',
      logDir: '/Users/ana/.byok/salesko/service-logs',
    });
    expect(resolveHostLayout({ ...product, platform: 'linux', homeDir: '/home/ana', env: {} })).toEqual({
      platform: 'linux',
      storeDir: '/home/ana/.byok/salesko',
      scratchRoot: { path: '/home/ana/.byok/salesko/tmp', source: 'store', socketPathBytes: 27, socketPathMaximumBytes: 65 },
      hostStorageRoot: '/home/ana/.local/share/salesko',
      agentHomes: '/home/ana/.local/share/salesko/agents',
      logDir: '/home/ana/.byok/salesko/service-logs',
    });
    expect(resolveHostLayout({ ...product, platform: 'win32', homeDir: 'C:\\Users\\ana', env: {} })).toEqual({
      platform: 'win32',
      storeDir: 'C:\\Users\\ana\\.byok\\salesko',
      scratchRoot: { path: 'C:\\Users\\ana\\.byok\\salesko\\tmp', source: 'store', socketPathBytes: 30 },
      hostStorageRoot: 'C:\\Users\\ana\\AppData\\Local\\Salesko',
      agentHomes: 'C:\\Users\\ana\\AppData\\Local\\Salesko\\agents',
      logDir: 'C:\\Users\\ana\\.byok\\salesko\\service-logs',
    });
  });

  it('honours absolute XDG_DATA_HOME and LOCALAPPDATA and ignores relative ones (XDG rule)', () => {
    expect(resolveHostLayout({ ...product, platform: 'linux', homeDir: '/home/ana', env: { XDG_DATA_HOME: '/data/ana' } }).hostStorageRoot).toBe('/data/ana/salesko');
    expect(resolveHostLayout({ ...product, platform: 'linux', homeDir: '/home/ana', env: { XDG_DATA_HOME: 'rel/data' } }).hostStorageRoot).toBe('/home/ana/.local/share/salesko');
    expect(resolveHostLayout({ ...product, platform: 'win32', homeDir: 'C:\\Users\\ana', env: { LOCALAPPDATA: 'D:\\Local' } }).hostStorageRoot).toBe('D:\\Local\\Salesko');
  });

  it.each(['//server/share', '\\\\server\\share'])('accepts a complete Windows UNC root %j', (root) => {
    const layout = resolveHostLayout({ ...product, platform: 'win32', homeDir: root, env: { LOCALAPPDATA: root } });
    expect(layout.storeDir).toBe('\\\\server\\share\\.byok\\salesko');
    expect(layout.hostStorageRoot).toBe('\\\\server\\share\\Salesko');
  });

  it.each(['//server', '//server/', '\\\\server', '\\\\server\\'])('rejects incomplete Windows UNC home %j', (root) => {
    expect(() => resolveHostLayout({ ...product, platform: 'win32', homeDir: root, env: {} })).toThrow(HostLayoutInputError);
  });

  it.each(['//server', '//server/', '\\\\server', '\\\\server\\'])('ignores incomplete Windows UNC LOCALAPPDATA %j', (root) => {
    expect(resolveHostLayout({ ...product, platform: 'win32', homeDir: 'C:\\Users\\ana', env: { LOCALAPPDATA: root } }).hostStorageRoot).toBe('C:\\Users\\ana\\AppData\\Local\\Salesko');
  });

  it('applies the #493 socket budget: a store whose tmp is too long gets the same short root the daemon picks', () => {
    const homeDir = `/Users/${'u'.repeat(40)}`;
    const layout = resolveHostLayout({ ...product, platform: 'darwin', homeDir, env: {} });
    expect(layout.storeDir).toBe(`${homeDir}/.byok/salesko`);
    expect(layout.scratchRoot.source).toBe('short-root');
    expect(layout.scratchRoot.path).toMatch(/^\/private\/tmp\/byok-scratch-[0-9a-f]{16}$/u);
    // One placement rule: the daemon's default resolves the same root for this (non-existent, link-free) store.
    expect(layout.scratchRoot.path).toBe(defaultScratchRoot(layout.storeDir, 'darwin'));
    expect(layout.scratchRoot.socketPathBytes).toBeLessThanOrEqual(layout.scratchRoot.socketPathMaximumBytes!);
    expect(scratchRootSocketBudget(layout.scratchRoot.path, 'darwin')).toEqual({ bytes: layout.scratchRoot.socketPathBytes, maximumBytes: layout.scratchRoot.socketPathMaximumBytes });
    // The pre-#493 AiphaBee-style store under Application Support would not fit; the recommended one does.
    expect(resolveHostLayout({ ...product, platform: 'linux', homeDir, env: {} }).scratchRoot.source).toBe('store');
  });

  it('is the only storeDir default and the only service log directory', () => {
    const layout = resolveHostLayout(product);
    expect(DeviceStore.defaultDir(product.productId)).toBe(layout.storeDir);
    expect(DeviceStore.resolveDir(product.productId)).toBe(layout.storeDir);
    const config = { ...product, serverUrl: 'https://byok.example' } as DaemonConfig;
    expect(buildServiceDefinition(config, '/etc/salesko.json', []).logDir).toBe(layout.logDir);
    const effective = describeEffectiveDaemonConfig({
      config, warnings: [], memoryHelper: { state: 'not-needed' }, agentMemoryMcpAdmission: 'unavailable',
      storeDir: layout.storeDir, scratchRoot: path.join(layout.storeDir, 'tmp'), adapters: [], runtimeSource: 'injected',
    });
    expect(effective.directories.logDir).toBe(layout.logDir);
  });

  it.each([
    [{ ...product, productId: '../x' }, 'productId'],
    [{ ...product, productId: 'a/b' }, 'productId'],
    [{ ...product, productName: 'CON' }, 'productName'],
    [{ ...product, productName: 'Salesko.' }, 'productName'],
    [{ ...product, platform: 'linux', homeDir: 'home/ana' }, 'homeDir'],
    [{ ...product, platform: 'win32', homeDir: '/Users/ana' }, 'homeDir'],
    [{ ...product, platform: 'freebsd' }, 'platform'],
  ] as const)('rejects %j with a typed error naming %s', (options, field) => {
    let caught: unknown;
    try { resolveHostLayout(options as Parameters<typeof resolveHostLayout>[0]); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(HostLayoutInputError);
    expect(caught).toMatchObject({ code: 'host_layout_input_invalid', field });
  });
});
