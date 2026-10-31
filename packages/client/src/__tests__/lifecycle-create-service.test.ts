import { describe, expect, it, vi } from 'vitest';
import { createServiceLifecycle, UnsupportedServicePlatformError } from '../lifecycle/create-service-lifecycle';
import type { Runner } from '../lifecycle/exec-runner';
import type { ServiceDefinition } from '../lifecycle/service-types';
import { memoryServiceFs } from './support/service-fs';
import { useInProcessServiceLifecycleGate } from './support/service-lifecycle-gate';

function def(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    name: 'acme',
    program: { command: '/usr/bin/node', args: ['/opt/agent.js', 'start'] },
    storeDir: '/store',
    logDir: '/tmp/acme-logs',
    owner: 'cli',
    ...overrides,
  };
}

const fakeFs = memoryServiceFs();

useInProcessServiceLifecycleGate();

describe('lifecycle/create-service-lifecycle: createServiceLifecycle', () => {
  it('dispatches darwin -> launchd (invokes launchctl)', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_command, args) => (args[0] === 'print'
      ? { code: 113, stdout: '', stderr: 'Could not find service' }
      : { code: 0, stdout: '', stderr: '' }));
    const lifecycle = createServiceLifecycle(def(), { platform: 'darwin', deps: { run, fs: fakeFs, homedir: () => '/h', getuid: () => 501 } });
    await lifecycle.install();
    expect(run).toHaveBeenCalledWith('launchctl', expect.any(Array));
  });

  it('dispatches linux -> systemd (invokes systemctl)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const lifecycle = createServiceLifecycle(def(), { platform: 'linux', deps: { run, fs: fakeFs, homedir: () => '/h' } });
    await lifecycle.install();
    expect(run).toHaveBeenCalledWith('systemctl', expect.any(Array));
  });

  it('dispatches win32 -> WinSW (invokes the WinSW exe copy) when windows.winswBin is supplied', async () => {
    const run = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const lifecycle = createServiceLifecycle(def({ windows: { winswBin: '/bundled/WinSW.exe' } }), {
      platform: 'win32',
      deps: { run, fs: fakeFs },
    });
    await lifecycle.install();
    expect(fakeFs.copyFile).toHaveBeenCalledWith('/bundled/WinSW.exe', expect.stringContaining('acme.exe'));
  });

  it('win32 without windows.winswBin throws the WinSW-specific error, surfaced through the dispatcher', () => {
    expect(() => createServiceLifecycle(def(), { platform: 'win32', deps: { fs: fakeFs } })).toThrow(/windows\.winswBin/);
  });

  it('throws UnsupportedServicePlatformError for an unsupported platform', () => {
    expect(() => createServiceLifecycle(def(), { platform: 'aix' })).toThrow(UnsupportedServicePlatformError);
    expect(() => createServiceLifecycle(def(), { platform: 'aix' })).toThrow(/no OS service lifecycle for platform "aix"/);
  });
});
