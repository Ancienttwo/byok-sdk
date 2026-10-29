import { spawn } from 'node:child_process';
import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  type ServiceOwnerFs,
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

async function memoryRead(fs: MemoryServiceFs, file: string): Promise<string> {
  const content = fs.files.get(file);
  if (content === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  return content;
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

  it('concurrent claims by two owners on an unclaimed store: exactly one wins, the other gets lifecycle_owner_busy or lifecycle_owner_conflict', async () => {
    const storeDir = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'byok-owner-race-'));
    try {
      const results = await Promise.allSettled([
        claimServiceLifecycleOwner({ storeDir, owner: 'app', service: 'com.acme.login-item' }),
        claimServiceLifecycleOwner({ storeDir, owner: 'cli', service: 'acme' }),
      ]);
      const won = results.flatMap((result, index) => (result.status === 'fulfilled' ? [index === 0 ? 'app' : 'cli'] : []));
      const lost = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]).toBeInstanceOf(ServiceUnitError);
      // Busy while the winner holds the gate, conflict once it has written the record.
      expect(['lifecycle_owner_busy', 'lifecycle_owner_conflict']).toContain((lost[0] as ServiceUnitError).code);
      expect((await readServiceLifecycleOwner(storeDir))?.owner).toBe(won[0]);
      expect((await nodeFs.readdir(path.join(storeDir, 'service'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await nodeFs.rm(storeDir, { recursive: true, force: true });
    }
  });

  it('fails closed on an unreadable record and an invalid owner', async () => {
    const fs = memoryServiceFs({ [OWNER_RECORD]: '{not json' });
    expect(await codeOf(readServiceLifecycleOwner('/store', fs))).toBe('lifecycle_owner_unreadable');
    expect(await codeOf(claimServiceLifecycleOwner({ storeDir: '/s', owner: 'Bad Owner', service: 'x' }, memoryServiceFs()))).toBe('invalid_owner');
    expect(() => createServiceLifecycle(def({ owner: '' }), { platform: 'linux', deps: { fs: memoryServiceFs() } })).toThrow(ServiceUnitError);
  });
});

/** A pause the test opens: `wait()` marks it reached, then blocks until `open()`. */
function barrier() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const hit = new Promise<void>((resolve) => { reached = resolve; });
  return { open, hit, async wait() { reached(); await opened; } };
}

/** Real fs whose `method` on `target` (rm's path, rename's destination) waits at `pause` once. */
function pausingFs(method: 'rm' | 'rename', target: string, pause: ReturnType<typeof barrier>): ServiceOwnerFs {
  let paused = false;
  const once = async (file: string) => {
    if (file === target && !paused) {
      paused = true;
      await pause.wait();
    }
  };
  return {
    readFile: nodeFs.readFile, writeFile: nodeFs.writeFile, mkdir: nodeFs.mkdir,
    rm: async (file, options) => { if (method === 'rm') await once(String(file)); return nodeFs.rm(file, options); },
    rename: async (from, to) => { if (method === 'rename') await once(String(to)); return nodeFs.rename(from, to); },
  };
}

function outcome(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') return 'ok';
  return result.reason instanceof ServiceUnitError ? result.reason.code : String(result.reason);
}

/**
 * #1149 review: an owner-record mutation is bound to the record this process
 * read. While one holder's read-then-mutate is in flight, another mutation of
 * the same store is refused (`lifecycle_owner_busy`), so a stale release or
 * rename can never remove or overwrite a successor's record.
 */
describe('lifecycle (#1097) owner record mutations across a change of owner', () => {
  async function store(): Promise<{ storeDir: string; marker: string; done: () => Promise<void> }> {
    const storeDir = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'byok-owner-aba-'));
    return { storeDir, marker: path.join(storeDir, 'service', 'lifecycle-owner.json'), done: () => nodeFs.rm(storeDir, { recursive: true, force: true }) };
  }

  it('release: a stale releaser paused before rm cannot delete the App record that a later claim wrote', async () => {
    const { storeDir, marker, done } = await store();
    try {
      await claimServiceLifecycleOwner({ storeDir, owner: 'cli', service: 'acme' });
      const pause = barrier();
      const stale = releaseServiceLifecycleOwner({ storeDir, owner: 'cli' }, pausingFs('rm', marker, pause));
      await pause.hit;
      const release = await Promise.allSettled([releaseServiceLifecycleOwner({ storeDir, owner: 'cli' })]);
      const appClaim = await Promise.allSettled([claimServiceLifecycleOwner({ storeDir, owner: 'app', service: 'com.acme.login-item' })]);
      pause.open();
      await stale;
      expect({ release: outcome(release[0]!), appClaim: outcome(appClaim[0]!), owner: (await readServiceLifecycleOwner(storeDir))?.owner ?? null })
        .toEqual({ release: 'lifecycle_owner_busy', appClaim: 'lifecycle_owner_busy', owner: null });
      await claimServiceLifecycleOwner({ storeDir, owner: 'app', service: 'com.acme.login-item' });
      expect(await codeOf(claimServiceLifecycleOwner({ storeDir, owner: 'cli', service: 'acme' }))).toBe('lifecycle_owner_conflict');
      expect(await readServiceLifecycleOwner(storeDir)).toEqual({ owner: 'app', service: 'com.acme.login-item' });
    } finally {
      await done();
    }
  });

  it('same-owner rename: a stale service-name change paused before rename cannot overwrite the App record', async () => {
    const { storeDir, marker, done } = await store();
    try {
      await claimServiceLifecycleOwner({ storeDir, owner: 'cli', service: 'acme-old' });
      const pause = barrier();
      const stale = claimServiceLifecycleOwner({ storeDir, owner: 'cli', service: 'acme-new' }, pausingFs('rename', marker, pause));
      await pause.hit;
      const release = await Promise.allSettled([releaseServiceLifecycleOwner({ storeDir, owner: 'cli' })]);
      const appClaim = await Promise.allSettled([claimServiceLifecycleOwner({ storeDir, owner: 'app', service: 'com.acme.login-item' })]);
      pause.open();
      await stale;
      expect({ release: outcome(release[0]!), appClaim: outcome(appClaim[0]!), record: (await readServiceLifecycleOwner(storeDir)) ?? null })
        .toEqual({ release: 'lifecycle_owner_busy', appClaim: 'lifecycle_owner_busy', record: { owner: 'cli', service: 'acme-new' } });
      expect((await nodeFs.readdir(path.dirname(marker))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await done();
    }
  });

  it('across two OS processes: a releaser in another process paused before rm excludes this process until it exits the gate', async () => {
    const { storeDir, marker, done } = await store();
    try {
      await claimServiceLifecycleOwner({ storeDir, owner: 'cli', service: 'acme' });
      // The child is the stale CLI releaser: the built package, its rm of the
      // record paused until the parent writes a line to its stdin.
      const childSource = `
        const { releaseServiceLifecycleOwner } = await import(process.argv[1]);
        const fs = await import('node:fs/promises');
        const marker = process.argv[3];
        const resume = new Promise((resolve) => process.stdin.once('data', resolve));
        const pausing = { ...fs, rm: async (file, options) => {
          if (file === marker) { process.stdout.write('paused\\n'); await resume; }
          return fs.rm(file, options);
        } };
        await releaseServiceLifecycleOwner({ storeDir: process.argv[2], owner: 'cli' }, pausing);
        process.stdout.write('released\\n');
        process.exit(0);
      `;
      const clientEntry = new URL('../../dist/index.js', import.meta.url).href;
      const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, clientEntry, storeDir, marker], { stdio: ['pipe', 'pipe', 'inherit'] });
      let stdout = '';
      const line = (text: string) => new Promise<void>((resolve, reject) => {
        const check = () => { if (stdout.includes(`${text}\n`)) resolve(); };
        child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); check(); });
        child.once('exit', (code) => { check(); reject(new Error(`child exited ${code} before "${text}": ${stdout}`)); });
        check();
      });
      await line('paused');
      const release = await Promise.allSettled([releaseServiceLifecycleOwner({ storeDir, owner: 'cli' })]);
      const appClaim = await Promise.allSettled([claimServiceLifecycleOwner({ storeDir, owner: 'app', service: 'com.acme.login-item' })]);
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      child.stdin!.end('go\n');
      await line('released');
      expect(await exited).toBe(0);
      expect({ release: outcome(release[0]!), appClaim: outcome(appClaim[0]!), owner: (await readServiceLifecycleOwner(storeDir))?.owner ?? null })
        .toEqual({ release: 'lifecycle_owner_busy', appClaim: 'lifecycle_owner_busy', owner: null });
      await claimServiceLifecycleOwner({ storeDir, owner: 'app', service: 'com.acme.login-item' });
      expect(await codeOf(claimServiceLifecycleOwner({ storeDir, owner: 'cli', service: 'acme' }))).toBe('lifecycle_owner_conflict');
    } finally {
      await done();
    }
  });

  it('managed uninstall: a stale uninstall paused before the record rm cannot delete the App record', async () => {
    const { storeDir, marker, done } = await store();
    try {
      const fs = memoryServiceFs();
      const cli = lifecycleFor('linux', fs, okRunner(), { storeDir });
      await cli.install();
      // The record lives on the real fs so the App, another process, sees it; the unit files stay in memory.
      fs.files.delete(marker);
      await claimServiceLifecycleOwner({ storeDir, owner: 'cli', service: 'acme' });
      const pause = barrier();
      const ownerFs = pausingFs('rm', marker, pause);
      fs.readFile.mockImplementation(async (file: string) => (file === marker ? nodeFs.readFile(file, 'utf8') : memoryRead(fs, file)));
      fs.rm.mockImplementation(async (file: string) => { if (file === marker) return ownerFs.rm(file, { force: true }); fs.files.delete(file); });
      const stale = cli.uninstall();
      await pause.hit;
      const release = await Promise.allSettled([releaseServiceLifecycleOwner({ storeDir, owner: 'cli' })]);
      const appClaim = await Promise.allSettled([claimServiceLifecycleOwner({ storeDir, owner: 'app', service: 'com.acme.login-item' })]);
      pause.open();
      await stale;
      expect({ release: outcome(release[0]!), appClaim: outcome(appClaim[0]!), owner: (await readServiceLifecycleOwner(storeDir))?.owner ?? null })
        .toEqual({ release: 'lifecycle_owner_busy', appClaim: 'lifecycle_owner_busy', owner: null });
    } finally {
      await done();
    }
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
