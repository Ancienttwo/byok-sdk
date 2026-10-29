import { describe, expect, it, vi } from 'vitest';
import { createServiceLifecycle } from '../lifecycle/create-service-lifecycle';
import type { Runner } from '../lifecycle/exec-runner';
import type { ServiceDefinition, ServiceLifecycle } from '../lifecycle/service-types';
import {
  claimServiceLifecycleOwner,
  generateServiceLauncher,
  readServiceLifecycleOwner,
  releaseServiceLifecycleOwner,
  SERVICE_UNIT_MARKER,
  ServiceUnitError,
} from '../lifecycle/service-unit';
import { DRIFTED_MARKED_UNIT, memoryServiceFs, UNMARKED_UNIT, type MemoryServiceFs } from './support/service-fs';

const OWNER_RECORD = '/store/service/lifecycle-owner.json';
/** The product-bundled WinSW binary `def().windows.winswBin` names. */
const WINSW_BIN = { 'C:\\WinSW.exe': 'winsw v2.12.0' };

function def(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    name: 'acme',
    displayName: 'Acme',
    program: { command: '/usr/bin/node', args: ['/opt/agent.js', 'start', '--config', '/etc/acme.json', '--service'] },
    storeDir: '/store',
    logDir: '/tmp/acme-service-unit-test-logs',
    owner: 'cli',
    windows: { winswBin: 'C:\\WinSW.exe' },
    ...overrides,
  };
}

const PLATFORMS = [
  { platform: 'darwin', unitPath: '/h/Library/LaunchAgents/acme.plist', launcherPath: '/store/service/acme.launcher.sh' },
  { platform: 'linux', unitPath: '/h/.config/systemd/user/acme.service', launcherPath: '/store/service/acme.launcher.sh' },
  { platform: 'win32', unitPath: '/tmp/acme-service-unit-test-logs/acme.xml', launcherPath: '/tmp/acme-service-unit-test-logs/acme.exe' },
] as const;

function lifecycleFor(platform: NodeJS.Platform, fs: MemoryServiceFs, run: Runner, overrides: Partial<ServiceDefinition> = {}): ServiceLifecycle {
  return createServiceLifecycle(def(overrides), { platform, deps: { run, fs, homedir: () => '/h', getuid: () => 501 } });
}

function okRunner() {
  return vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceUnitError);
    return (error as ServiceUnitError).code;
  }
}

describe.each(PLATFORMS)('lifecycle (#1097) unit classification on $platform', ({ platform, unitPath, launcherPath }) => {
  it('absent before install, exact after, repairable after a hand edit, exact again after repair', async () => {
    const fs = memoryServiceFs(WINSW_BIN);
    const run = okRunner();
    const lifecycle = lifecycleFor(platform, fs, run);
    expect(await lifecycle.inspect()).toEqual({ state: 'absent', unitPath, launcherPath });
    expect(await lifecycle.repair()).toEqual({ status: 'not-needed', state: 'absent' });

    await lifecycle.install();
    expect(await lifecycle.inspect()).toEqual({ state: 'exact', unitPath, launcherPath, owner: 'cli' });
    expect(fs.files.get(unitPath)).toContain(SERVICE_UNIT_MARKER);
    expect(await lifecycle.repair()).toEqual({ status: 'not-needed', state: 'exact' });

    fs.files.set(unitPath, DRIFTED_MARKED_UNIT);
    expect((await lifecycle.inspect()).state).toBe('repairable');
    run.mockClear();
    expect(await lifecycle.repair()).toEqual({ status: 'repaired' });
    expect(run).toHaveBeenCalled();
    expect((await lifecycle.inspect()).state).toBe('exact');
  });

  it('a marker-less unit is foreign: inspect reports it and nothing touches it, install included', async () => {
    const fs = memoryServiceFs({ [unitPath]: UNMARKED_UNIT });
    const run = okRunner();
    const lifecycle = lifecycleFor(platform, fs, run);

    expect((await lifecycle.inspect()).state).toBe('foreign');
    expect((await lifecycle.status()).unit.state).toBe('foreign');
    expect(await codeOf(lifecycle.install())).toBe('service_unit_unmarked');
    expect(await codeOf(lifecycle.repair())).toBe('service_unit_unmarked');
    expect(await codeOf(lifecycle.uninstall())).toBe('service_unit_unmarked');
    expect(await codeOf(lifecycle.start())).toBe('service_unit_unmarked');
    expect(await codeOf(lifecycle.stop())).toBe('service_unit_unmarked');

    expect(fs.files.get(unitPath)).toBe(UNMARKED_UNIT);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.copyFile).not.toHaveBeenCalled();
    // `status()` queries the manager; nothing else reached it.
    expect(run.mock.calls.every(([command]) => command === 'launchctl' || command === 'systemctl' || command === 'sc.exe')).toBe(true);
    expect(run.mock.calls.every(([, args]) => args.includes('print') || args.includes('is-active') || args.includes('query'))).toBe(true);
  });

  it('install({ replaceUnmarked: true }) replaces a marker-less unit with a marked one', async () => {
    const fs = memoryServiceFs({ [unitPath]: UNMARKED_UNIT });
    const lifecycle = lifecycleFor(platform, fs, okRunner());
    await lifecycle.install({ replaceUnmarked: true });
    expect(fs.files.get(unitPath)).toContain(SERVICE_UNIT_MARKER);
    expect((await lifecycle.inspect()).state).toBe('exact');
  });

  it('a different launcher target is repairable; the unit itself stays byte-identical', async () => {
    const fs = memoryServiceFs(WINSW_BIN);
    await lifecycleFor(platform, fs, okRunner()).install();
    const unit = fs.files.get(unitPath);
    const moved = lifecycleFor(platform, fs, okRunner(), { program: { command: '/new/node', args: ['/new/agent.js', 'start'] } });
    expect((await moved.inspect()).state).toBe('repairable');
    await moved.repair();
    // On Windows the descriptor is the launcher (the SCM runs the stable <id>.exe), so it changes.
    if (platform !== 'win32') {
      expect(fs.files.get(unitPath)).toBe(unit);
      expect(fs.files.get(launcherPath)).toContain(`exec '/new/node' '/new/agent.js' 'start'`);
    }
  });

  it('uninstall removes the unit, the launcher and the owner record', async () => {
    const fs = memoryServiceFs();
    const lifecycle = lifecycleFor(platform, fs, okRunner());
    await lifecycle.install();
    expect(fs.files.has(OWNER_RECORD)).toBe(true);
    await lifecycle.uninstall();
    expect(fs.files.has(unitPath)).toBe(false);
    if (platform !== 'win32') expect(fs.files.has(launcherPath)).toBe(false);
    expect(fs.files.has(OWNER_RECORD)).toBe(false);
  });

  it('one lifecycle owner per store: another owner cannot install, repair or uninstall', async () => {
    const fs = memoryServiceFs();
    await lifecycleFor(platform, fs, okRunner(), { owner: 'app' }).install();
    const cli = lifecycleFor(platform, fs, okRunner());
    expect(await codeOf(cli.install())).toBe('lifecycle_owner_conflict');
    fs.files.set(unitPath, `${fs.files.get(unitPath)}\n`);
    expect(await codeOf(cli.repair())).toBe('lifecycle_owner_conflict');
    expect(await codeOf(cli.uninstall())).toBe('lifecycle_owner_conflict');
    expect((await cli.inspect()).owner).toBe('app');
  });
});

describe('lifecycle (#1097) owner record', () => {
  it('an App that sets autostart itself claims the store; the CLI install then refuses', async () => {
    const fs = memoryServiceFs();
    await claimServiceLifecycleOwner({ storeDir: '/store', owner: 'app', service: 'com.acme.login-item' }, fs);
    expect(await readServiceLifecycleOwner('/store', fs)).toEqual({ owner: 'app', service: 'com.acme.login-item' });
    expect(await codeOf(lifecycleFor('darwin', fs, okRunner()).install())).toBe('lifecycle_owner_conflict');
    expect(await codeOf(releaseServiceLifecycleOwner({ storeDir: '/store', owner: 'cli' }, fs))).toBe('lifecycle_owner_conflict');
    await releaseServiceLifecycleOwner({ storeDir: '/store', owner: 'app' }, fs);
    expect(await readServiceLifecycleOwner('/store', fs)).toBeUndefined();
  });

  it('fails closed on an unreadable record and an invalid owner', async () => {
    const fs = memoryServiceFs({ [OWNER_RECORD]: '{not json' });
    expect(await codeOf(readServiceLifecycleOwner('/store', fs))).toBe('lifecycle_owner_unreadable');
    expect(await codeOf(claimServiceLifecycleOwner({ storeDir: '/s', owner: 'Bad Owner', service: 'x' }, memoryServiceFs()))).toBe('invalid_owner');
    expect(() => createServiceLifecycle(def({ owner: '' }), { platform: 'linux', deps: { fs: memoryServiceFs() } })).toThrow(ServiceUnitError);
  });
});

describe('lifecycle (#1097) generateServiceLauncher', () => {
  it('execs the program with POSIX single quoting and sets no environment', () => {
    const launcher = generateServiceLauncher({ command: '/Applications/My App/node', args: ["it's", '$HOME', '`x`'] });
    expect(launcher).toBe(`#!/bin/sh\n# ${SERVICE_UNIT_MARKER}\nexec '/Applications/My App/node' 'it'\\''s' '$HOME' '\`x\`'\n`);
    expect(launcher).not.toMatch(/export |env /);
  });

  it('rejects a control character instead of writing it into the script', () => {
    expect(() => generateServiceLauncher({ command: '/bin/node', args: ['a\nrm -rf /'] })).toThrow(/control characters/);
  });
});
