import { describe, expect, it, vi } from 'vitest';
import { createServiceLifecycle, UnsupportedServicePlatformError } from '../lifecycle/create-service-lifecycle';
import type { Runner } from '../lifecycle/exec-runner';
import type { ServiceDefinition } from '../lifecycle/service-types';

function def(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    name: 'acme',
    program: { command: '/usr/bin/node', args: ['/opt/agent.js', 'start'] },
    logDir: '/tmp/acme-logs',
    ...overrides,
  };
}

const fakeFs = {
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  copyFile: vi.fn().mockResolvedValue(undefined),
};

describe('lifecycle/create-service-lifecycle: createServiceLifecycle', () => {
  it('dispatches darwin -> launchd (invokes launchctl)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
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
