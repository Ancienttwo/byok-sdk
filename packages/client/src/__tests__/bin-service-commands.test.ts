import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonConfig, ServiceLifecycle } from '../index';
import {
  buildServiceDefinition,
  runInstallCommand,
  runServiceStartCommand,
  runServiceStatusCommand,
  runServiceStopCommand,
  runUninstallCommand,
} from '../bin/commands/service';

function baseConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    productName: 'Acme',
    productId: 'acme-product',
    serverUrl: 'http://example.invalid',
    workspaceRoot: '/ws',
    storeDir: '/tmp/acme-store',
    ...overrides,
    localAgentRelease: overrides.localAgentRelease ?? { version: '0.0.0-test' },
  };
}

describe('bin/commands/service: buildServiceDefinition', () => {
  it('defaults name to productId, agentBin to process.argv[1], nodeBin to process.execPath', () => {
    const def = buildServiceDefinition(baseConfig(), '/config/acme.json', []);
    expect(def.name).toBe('acme-product');
    expect(def.displayName).toBe('Acme');
    expect(def.program.command).toBe(process.execPath);
    // Issue #392 adds `--service` on macOS/Linux (see the platform test below).
    expect(def.program.args).toEqual([
      process.argv[1],
      'start',
      '--config',
      path.resolve('/config/acme.json'),
      ...(process.platform === 'win32' ? [] : ['--service']),
    ]);
    expect(def.logDir).toBe(path.join('/tmp/acme-store', 'service-logs'));
    expect(def.windows).toBeUndefined();
  });

  it('issue #392: the program runs start --service on darwin and linux, and is unchanged on win32', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(buildServiceDefinition(baseConfig(), '/c.json', [], platform).program.args.at(-1)).toBe('--service');
    }
    const windows = buildServiceDefinition(baseConfig(), '/c.json', [], 'win32');
    expect(windows.program.args).toEqual([process.argv[1], 'start', '--config', path.resolve('/c.json')]);
  });

  it('uses branding.displayName over productName when present', () => {
    const def = buildServiceDefinition(baseConfig({ branding: { displayName: 'Acme Coder' } }), '/c.json', []);
    expect(def.displayName).toBe('Acme Coder');
  });

  it('resolves a relative --config path to an absolute path baked into the program args', () => {
    const def = buildServiceDefinition(baseConfig(), 'relative/config.json', []);
    expect(def.program.args[3]).toBe(path.resolve('relative/config.json'));
  });

  it('--name/--agent-bin/--node-bin override the defaults', () => {
    const def = buildServiceDefinition(baseConfig(), '/c.json', [
      '--name',
      'custom-svc',
      '--agent-bin',
      '/opt/agent.js',
      '--node-bin',
      '/usr/local/bin/node',
    ]);
    expect(def.name).toBe('custom-svc');
    expect(def.program.command).toBe('/usr/local/bin/node');
    expect(def.program.args[0]).toBe('/opt/agent.js');
  });

  it('leaves windows undefined without --winsw-bin, and populates it (with optional installDir) when given', () => {
    const withoutWinsw = buildServiceDefinition(baseConfig(), '/c.json', []);
    expect(withoutWinsw.windows).toBeUndefined();

    const withWinsw = buildServiceDefinition(baseConfig(), '/c.json', ['--winsw-bin', 'C:\\bundled\\WinSW.exe']);
    expect(withWinsw.windows).toEqual({ winswBin: 'C:\\bundled\\WinSW.exe' });

    const withInstallDir = buildServiceDefinition(baseConfig(), '/c.json', [
      '--winsw-bin',
      'C:\\bundled\\WinSW.exe',
      '--winsw-install-dir',
      'C:\\svc',
    ]);
    expect(withInstallDir.windows).toEqual({ winswBin: 'C:\\bundled\\WinSW.exe', installDir: 'C:\\svc' });
  });

  it('falls back to DeviceStore.defaultDir(productId) for logDir when config.storeDir is unset', () => {
    const def = buildServiceDefinition(baseConfig({ storeDir: undefined }), '/c.json', []);
    expect(def.logDir.endsWith(path.join('acme-product', 'service-logs'))).toBe(true);
  });
});

function fakeLifecycle(overrides: Partial<ServiceLifecycle> = {}): ServiceLifecycle {
  return {
    install: vi.fn().mockResolvedValue(undefined),
    uninstall: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ installed: true, running: true, determinate: true, detail: 'ok' }),
    ...overrides,
  };
}

function collectLog(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), lines };
}

describe('bin/commands/service: run*Command (DI lifecycle)', () => {
  it('runInstallCommand calls lifecycle.install() and logs the service name', async () => {
    const lifecycle = fakeLifecycle();
    const { log, lines } = collectLog();
    await runInstallCommand(baseConfig(), '/c.json', [], { lifecycle, log });
    expect(lifecycle.install).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['service installed and started: acme-product']);
  });

  it('runUninstallCommand calls lifecycle.uninstall() and honors --name for the logged label', async () => {
    const lifecycle = fakeLifecycle();
    const { log, lines } = collectLog();
    await runUninstallCommand(baseConfig(), '/c.json', ['--name', 'custom'], { lifecycle, log });
    expect(lifecycle.uninstall).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['service uninstalled: custom']);
  });

  it('runServiceStartCommand calls lifecycle.start()', async () => {
    const lifecycle = fakeLifecycle();
    const { log, lines } = collectLog();
    await runServiceStartCommand(baseConfig(), '/c.json', [], { lifecycle, log });
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['service started: acme-product']);
  });

  it('runServiceStopCommand calls lifecycle.stop()', async () => {
    const lifecycle = fakeLifecycle();
    const { log, lines } = collectLog();
    await runServiceStopCommand(baseConfig(), '/c.json', [], { lifecycle, log });
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['service stopped: acme-product']);
  });

  it('runServiceStatusCommand logs installed:no/running:no/detail:(none) for an empty, cleanly-confirmed status', async () => {
    const lifecycle = fakeLifecycle({
      status: vi.fn().mockResolvedValue({ installed: false, running: false, determinate: true, detail: '' }),
    });
    const { log, lines } = collectLog();
    await runServiceStatusCommand(baseConfig(), '/c.json', [], { lifecycle, log });
    expect(lines).toEqual(['installed: no', 'running: no', 'detail: (none)']);
  });

  it('runServiceStatusCommand logs installed:yes/running:yes with real detail text', async () => {
    const lifecycle = fakeLifecycle({
      status: vi.fn().mockResolvedValue({ installed: true, running: true, determinate: true, detail: 'state = running' }),
    });
    const { log, lines } = collectLog();
    await runServiceStatusCommand(baseConfig(), '/c.json', [], { lifecycle, log });
    expect(lines).toEqual(['installed: yes', 'running: yes', 'detail: state = running']);
  });

  it('finding P1 #2 (residual, round 3): runServiceStatusCommand logs "running: unknown (...)" rather than a confirmed "no" when the manager query was indeterminate', async () => {
    const lifecycle = fakeLifecycle({
      status: vi.fn().mockResolvedValue({
        installed: true,
        running: false,
        determinate: false,
        detail: 'Failed to connect to bus: No such file or directory',
      }),
    });
    const { log, lines } = collectLog();
    await runServiceStatusCommand(baseConfig(), '/c.json', [], { lifecycle, log });
    expect(lines).toEqual([
      'installed: yes',
      'running: unknown (could not query the service manager)',
      'detail: Failed to connect to bus: No such file or directory',
    ]);
  });
});
