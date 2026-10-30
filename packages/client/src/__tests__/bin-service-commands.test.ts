import { testAgentHomeConfig } from './fixtures/test-agent';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonConfig, ServiceLifecycle } from '../index';
import {
  CLI_SERVICE_OWNER,
  cliServiceDefinition,
  cliServiceInstallation,
  runInstallCommand,
  runServiceStartCommand,
  runServiceStatusCommand,
  runServiceStopCommand,
  runUninstallCommand,
} from '../bin/commands/service';
import { generateWinswXml } from '../lifecycle/winsw';
import { AGENT_PAYLOAD_ENTRY, agentServiceDefinition, agentServiceInstallation } from '../lifecycle/agent-service';
import type { ServiceInstallation, ServiceUpgradeReceipt } from '../lifecycle/service-installation';
import { runUpgradeInstallationCommand } from '../bin/commands/upgrade';
import { appendAuditRecord } from '../bin/audit-log';
import { formatHaltRemedy } from '../bin/format';

function baseConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    productName: 'Acme',
    productId: 'acme-product',
    serverUrl: 'http://example.invalid',
    agentHome: testAgentHomeConfig(),
    storeDir: '/tmp/acme-store',
    ...overrides,
    localAgentRelease: overrides.localAgentRelease ?? { version: '0.0.0-test' },
  };
}

describe('bin/commands/service: cliServiceDefinition', () => {
  it('defaults name to productId, agentBin to process.argv[1], nodeBin to process.execPath', () => {
    const def = cliServiceDefinition(baseConfig(), '/config/acme.json', []);
    expect(def.name).toBe('acme-product');
    expect(def.displayName).toBe('Acme');
    expect(def.program.command).toBe(process.execPath);
    // Issues #392/#394 add `--service` on every platform.
    expect(def.program.args).toEqual([
      process.argv[1],
      'start',
      '--config',
      path.resolve('/config/acme.json'),
      '--service',
    ]);
    expect(def.logDir).toBe(path.join('/tmp/acme-store', 'service-logs'));
    expect(def.storeDir).toBe('/tmp/acme-store');
    expect(def.owner).toBe('cli');
    expect(def.windows).toBeUndefined();
  });

  it('#1097: is the library agentServiceDefinition with the CLI owner — no private copy', () => {
    expect(cliServiceDefinition(baseConfig(), '/c.json', ['--agent-bin', '/opt/agent.js', '--node-bin', '/usr/bin/node'])).toEqual(
      agentServiceDefinition({ config: baseConfig(), configPath: '/c.json', agentBin: '/opt/agent.js', nodeBin: '/usr/bin/node', owner: 'cli' }),
    );
  });

  it('issue #394: the program runs start --service on every platform, WinSW included', () => {
    expect(cliServiceDefinition(baseConfig(), '/c.json', []).program.args).toEqual([
      process.argv[1],
      'start',
      '--config',
      path.resolve('/c.json'),
      '--service',
    ]);
  });

  it('#392: generated WinSW XML installs start --service as the final argument', () => {
    const def = cliServiceDefinition(baseConfig(), '/config/acme.json', ['--winsw-bin', 'C:\\bundled\\WinSW.exe']);
    const xml = generateWinswXml({ id: def.name, displayName: def.displayName!, program: def.program, logDir: def.logDir });
    expect([...xml.matchAll(/<argument>(.*?)<\/argument>/g)].map(match => match[1])).toEqual([
      process.argv[1], 'start', '--config', path.resolve('/config/acme.json'), '--service',
    ]);
  });

  it('uses branding.displayName over productName when present', () => {
    const def = cliServiceDefinition(baseConfig({ branding: { displayName: 'Acme Coder' } }), '/c.json', []);
    expect(def.displayName).toBe('Acme Coder');
  });

  it('resolves a relative --config path to an absolute path baked into the program args', () => {
    const def = cliServiceDefinition(baseConfig(), 'relative/config.json', []);
    expect(def.program.args[3]).toBe(path.resolve('relative/config.json'));
  });

  it('--name/--agent-bin/--node-bin override the defaults', () => {
    const def = cliServiceDefinition(baseConfig(), '/c.json', [
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
    const withoutWinsw = cliServiceDefinition(baseConfig(), '/c.json', []);
    expect(withoutWinsw.windows).toBeUndefined();

    const withWinsw = cliServiceDefinition(baseConfig(), '/c.json', ['--winsw-bin', 'C:\\bundled\\WinSW.exe']);
    expect(withWinsw.windows).toEqual({ winswBin: 'C:\\bundled\\WinSW.exe' });

    const withInstallDir = cliServiceDefinition(baseConfig(), '/c.json', [
      '--winsw-bin',
      'C:\\bundled\\WinSW.exe',
      '--winsw-install-dir',
      'C:\\svc',
    ]);
    expect(withInstallDir.windows).toEqual({ winswBin: 'C:\\bundled\\WinSW.exe', installDir: 'C:\\svc' });
  });

  it('falls back to the default storeDir (defaultStoreDir(productId)) for logDir when config.storeDir is unset', () => {
    const def = cliServiceDefinition(baseConfig({ storeDir: undefined }), '/c.json', []);
    expect(def.logDir.endsWith(path.join('acme-product', 'service-logs'))).toBe(true);
  });
});

const UNIT = { state: 'exact', unitPath: '/u/acme.plist', launcherPath: '/s/acme.launcher.sh' } as const;
const LOGS = { dir: '/logs', status: 'present', totalBytes: 12, files: [{ name: 'daemon.log', kind: 'daemon', sizeBytes: 12 }], truncated: false } as const;
const UNIT_LINES = ['unit: exact path=/u/acme.plist', 'launcher: /s/acme.launcher.sh', 'logs: /logs present totalBytes=12', 'log-file: daemon.log kind=daemon bytes=12'];

function statusOf(fields: { installed: boolean; running: boolean; determinate: boolean; detail: string }) {
  return { ...fields, unit: { ...UNIT }, logs: { ...LOGS, files: [...LOGS.files] } };
}

function fakeLifecycle(overrides: Partial<ServiceLifecycle> = {}): ServiceLifecycle {
  return {
    install: vi.fn().mockResolvedValue(undefined),
    repair: vi.fn().mockResolvedValue({ status: 'not-needed', state: 'exact' }),
    inspect: vi.fn().mockResolvedValue({ ...UNIT }),
    uninstall: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue(statusOf({ installed: true, running: true, determinate: true, detail: 'ok' })),
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
    expect(lifecycle.install).toHaveBeenCalledWith({});
    expect(lines).toEqual(['service installed and started: acme-product']);
  });

  it('#1097: install --replace-unmarked is the only way to pass replaceUnmarked', async () => {
    const lifecycle = fakeLifecycle();
    await runInstallCommand(baseConfig(), '/c.json', ['--replace-unmarked'], { lifecycle, log: () => undefined });
    expect(lifecycle.install).toHaveBeenCalledWith({ replaceUnmarked: true });
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
      status: vi.fn().mockResolvedValue(statusOf({ installed: false, running: false, determinate: true, detail: '' })),
    });
    const { log, lines } = collectLog();
    await runServiceStatusCommand(baseConfig(), '/c.json', [], { lifecycle, log });
    expect(lines).toEqual(['installed: no', 'running: no', 'detail: (none)', ...UNIT_LINES, 'lifecycle: unknown (no lifecycle event yet)']);
  });

  it('runServiceStatusCommand logs installed:yes/running:yes with real detail text', async () => {
    const lifecycle = fakeLifecycle({
      status: vi.fn().mockResolvedValue(statusOf({ installed: true, running: true, determinate: true, detail: 'state = running' })),
    });
    const { log, lines } = collectLog();
    await runServiceStatusCommand(baseConfig(), '/c.json', [], { lifecycle, log });
    expect(lines).toEqual(['installed: yes', 'running: yes', 'detail: state = running', ...UNIT_LINES, 'lifecycle: unknown (no lifecycle event yet)']);
  });

  it('#394: runServiceStatusCommand shows the last lifecycle from the audit log, with the remedy for a halt', async () => {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-service-status-store-'));
    try {
      await appendAuditRecord(storeDir, {
        kind: 'lifecycle',
        ts: '2026-10-13T00:00:00.000Z',
        lifecycle: { phase: 'halted', reason: 'device_revoked', at: '2026-10-13T00:00:00.000Z' },
      });
      const lifecycle = fakeLifecycle({
        status: vi.fn().mockResolvedValue(statusOf({ installed: true, running: false, determinate: true, detail: '' })),
      });
      const { log, lines } = collectLog();
      await runServiceStatusCommand(baseConfig({ storeDir }), '/c.json', [], { lifecycle, log });
      expect(lines.slice(3 + UNIT_LINES.length)).toEqual([
        'lifecycle: last-known phase=halted reason=device_revoked at=2026-10-13T00:00:00.000Z',
        `lifecycle-remedy: ${formatHaltRemedy('device_revoked')}`,
      ]);
    } finally {
      await fs.rm(storeDir, { recursive: true, force: true });
    }
  });

  it('finding P1 #2 (residual, round 3): runServiceStatusCommand logs "running: unknown (...)" rather than a confirmed "no" when the manager query was indeterminate', async () => {
    const lifecycle = fakeLifecycle({
      status: vi.fn().mockResolvedValue(statusOf({
        installed: true,
        running: false,
        determinate: false,
        detail: 'Failed to connect to bus: No such file or directory',
      })),
    });
    const { log, lines } = collectLog();
    await runServiceStatusCommand(baseConfig(), '/c.json', [], { lifecycle, log });
    expect(lines).toEqual([
      'installed: yes',
      'running: unknown (could not query the service manager)',
      'detail: Failed to connect to bus: No such file or directory',
      ...UNIT_LINES,
      'lifecycle: unknown (no lifecycle event yet)',
    ]);
  });
});

describe('#1097 slice 2: payload installations through the CLI', () => {
  function fakeInstallation(): ServiceInstallation & { calls: string[] } {
    const calls: string[] = [];
    const receipt: ServiceUpgradeReceipt = { format: 'byok-service-upgrade-receipt', version: 1, state: 'switched', from: '1', to: '2', at: 'now' };
    return {
      calls,
      lifecycle: {} as ServiceLifecycle,
      install: async (payload, opts) => { calls.push(`install ${payload} ${JSON.stringify(opts)}`); },
      upgrade: async (payload) => { calls.push(`upgrade ${payload}`); return receipt; },
      rollback: async () => { calls.push('rollback'); return { ...receipt, state: 'rolled-back' }; },
      recover: async () => { calls.push('recover'); return undefined; },
      uninstall: async () => { calls.push('uninstall'); },
      receipt: async () => receipt,
      currentVersion: async () => '2',
    };
  }

  it('install --payload installs through the payload installation and needs --install-root', async () => {
    const installation = fakeInstallation();
    const log = vi.fn();
    await runInstallCommand(baseConfig(), '/config/acme.json', ['--payload', 'rel/payload', '--install-root', '/opt/acme', '--replace-unmarked'], { installation, log });
    expect(installation.calls).toEqual([`install ${path.resolve('rel/payload')} {"replaceUnmarked":true}`]);
    expect(log).toHaveBeenCalledWith('service installed and started: acme-product version=2');
    await expect(runInstallCommand(baseConfig(), '/config/acme.json', ['--payload', 'p'], { installation })).rejects.toThrow('--payload requires --install-root <dir>');
  });

  it('uninstall removes a recorded payload installation through it', async () => {
    const installation = fakeInstallation();
    await runUninstallCommand(baseConfig(), '/config/acme.json', [], { installation, log: vi.fn() });
    expect(installation.calls).toEqual(['uninstall']);
  });

  it('builds the recorded installation with the CLI owner and a program that runs current', async () => {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-cli-installation-'));
    try {
      const config = baseConfig({ storeDir });
      expect(await cliServiceInstallation(config, '/config/acme.json', [], {})).toBeUndefined();
      await fs.mkdir(path.join(storeDir, 'service'), { recursive: true });
      await fs.writeFile(path.join(storeDir, 'service', 'installation.json'), JSON.stringify({ format: 'byok-service-installation', version: 1, installRoot: '/opt/acme' }));
      const options = agentServiceInstallation({ config, configPath: '/config/acme.json', installRoot: '/opt/acme', owner: CLI_SERVICE_OWNER });
      expect(options.program('/opt/acme/current').args.slice(0, 2)).toEqual([path.join('/opt/acme/current', AGENT_PAYLOAD_ENTRY), 'start']);
      expect(options.precheck('/opt/acme/versions/2').args).toEqual([
        path.join('/opt/acme/versions/2', AGENT_PAYLOAD_ENTRY), 'upgrade', 'check', '--store', '--json', '--config', path.resolve('/config/acme.json'),
      ]);
      expect(options.service.owner).toBe('cli');
      expect(await cliServiceInstallation(config, '/config/acme.json', [], {})).toBeDefined();
    } finally {
      await fs.rm(storeDir, { recursive: true, force: true });
    }
  });

  it('upgrade apply|rollback|status report the current version and receipt', async () => {
    const installation = fakeInstallation();
    const lines: string[] = [];
    await runUpgradeInstallationCommand(installation, { action: 'apply', payload: 'p2', json: true, log: (line) => lines.push(line) });
    await runUpgradeInstallationCommand(installation, { action: 'rollback', json: false, log: (line) => lines.push(line) });
    expect(installation.calls).toEqual([`upgrade ${path.resolve('p2')}`, 'rollback']);
    expect(JSON.parse(lines[0]!)).toMatchObject({ current: '2', receipt: { state: 'switched' } });
    expect(lines.slice(1)).toEqual(['current: 2', 'receipt: rolled-back from=1 to=2 at=now']);
  });
});
