import { describe, expect, it, vi } from 'vitest';
import { createLaunchdLifecycle, generateLaunchdPlist, LAUNCHD_UNLOAD_TIMEOUT_MS } from '../lifecycle/launchd';
import type { RunResult, Runner } from '../lifecycle/exec-runner';
import { nodeAgentProgram, type ServiceDefinition } from '../lifecycle/service-types';
import { SERVICE_UNIT_MARKER, ServiceUnitError } from '../lifecycle/service-unit';
import { DRIFTED_MARKED_UNIT, memoryServiceFs } from './support/service-fs';
import { useInProcessServiceLifecycleGate } from './support/service-lifecycle-gate';

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '' };
}
function fail(code = 1, stderr = 'boom'): RunResult {
  return { code, stdout: '', stderr };
}
/** What `launchctl print` exits with once a job has left the domain. */
const ABSENT = fail(113, 'Bad request.\nCould not find service "Acme-Agent-" in domain for user gui: 501');

useInProcessServiceLifecycleGate();

describe('lifecycle/launchd: generateLaunchdPlist', () => {
  it('renders the marker, a launcher-only ProgramArguments, RunAtLoad, KeepAlive and bounded redirect paths', () => {
    const xml = generateLaunchdPlist({
      label: 'com.acme.agent',
      launcherPath: '/Users/t/.byok/acme/service/com.acme.agent.launcher.sh',
      workingDirectory: '/Users/t',
      logDir: '/var/log/acme',
    });

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!-- byok-sdk-service-unit:')).toBe(true);
    expect(xml).toContain('<key>Label</key>\n  <string>com.acme.agent</string>');
    // #1097: the unit names only the stable launcher — no versioned path, no args, no env.
    expect(xml).toContain('<key>ProgramArguments</key>\n  <array>\n    <string>/Users/t/.byok/acme/service/com.acme.agent.launcher.sh</string>\n  </array>');
    expect(xml).not.toContain('EnvironmentVariables');
    expect(xml).toContain('<key>WorkingDirectory</key>\n  <string>/Users/t</string>');
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>');
    // Exit-code contract: only exit 0 stops (see exit-codes.ts).
    expect(xml).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>');
    expect(xml).toContain('<key>ThrottleInterval</key>\n  <integer>10</integer>');
    expect(xml).toContain('<key>StandardOutPath</key>\n  <string>/var/log/acme/service-stdout.log</string>');
    expect(xml).toContain('<key>StandardErrorPath</key>\n  <string>/var/log/acme/service-stderr.log</string>');
  });

  it('XML-escapes special characters in the launcher path', () => {
    const xml = generateLaunchdPlist({ label: 'x', launcherPath: '/a & <b>/"q"/l.sh', workingDirectory: '/h', logDir: '/tmp/logs' });
    expect(xml).toContain('/a &amp; &lt;b&gt;/&quot;q&quot;/l.sh');
  });
});

describe('lifecycle/launchd: createLaunchdLifecycle', () => {
  function def(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
    return {
      name: 'Acme Agent!!',
      program: { command: '/usr/bin/node', args: ['/opt/agent.js', 'start'] },
      storeDir: '/store',
      logDir: '/tmp/acme-logs',
      owner: 'cli',
      ...overrides,
    };
  }

  const PLIST = '/h/Library/LaunchAgents/Acme-Agent-.plist';
  const LAUNCHER = '/store/service/Acme-Agent-.launcher.sh';
  function fakeFs() {
    return memoryServiceFs();
  }
  function installedFs() {
    return memoryServiceFs({ [PLIST]: DRIFTED_MARKED_UNIT });
  }

  it('sanitizes the service name into a safe launchd label used for the plist path and service target', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'print' ? ABSENT : ok()));
    const fs = fakeFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/Users/tester', getuid: () => 501 });

    await lifecycle.install();

    expect(fs.writeFile).toHaveBeenCalledWith('/Users/tester/Library/LaunchAgents/Acme-Agent-.plist', expect.any(String), 'utf8');
    expect(run).toHaveBeenCalledWith('launchctl', ['bootstrap', 'gui/501', '/Users/tester/Library/LaunchAgents/Acme-Agent-.plist']);
    expect(run).toHaveBeenCalledWith('launchctl', ['enable', 'gui/501/Acme-Agent-']);
  });

  it('install() writes the plist, then bootout(best-effort)+bootstrap+enable+kickstart in order', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return args[0] === 'print' ? ABSENT : ok();
    });
    const fs = fakeFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/Users/tester', getuid: () => 501 });

    await lifecycle.install();

    expect(fs.mkdir).toHaveBeenCalledWith('/Users/tester/Library/LaunchAgents', { recursive: true });
    expect(fs.mkdir).toHaveBeenCalledWith('/tmp/acme-logs', { recursive: true });
    expect(calls).toEqual([
      'launchctl bootout gui/501/Acme-Agent-',
      'launchctl print gui/501/Acme-Agent-',
      'launchctl bootstrap gui/501 /Users/tester/Library/LaunchAgents/Acme-Agent-.plist',
      'launchctl enable gui/501/Acme-Agent-',
      'launchctl kickstart -k gui/501/Acme-Agent-',
    ]);
  });

  it('install() ignores a failing (nonzero-exit) bootout — expected when nothing was previously loaded', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'bootout' ? fail(3, 'Could not find service') : args[0] === 'print' ? ABSENT : ok()));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.install()).resolves.toBeUndefined();
  });

  it('install() throws a clear error when bootstrap itself fails', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'bootstrap' ? fail(1, 'Input/output error') : args[0] === 'print' ? ABSENT : ok()));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.install()).rejects.toThrow(/launchctl bootstrap failed \(exit 1\): Input\/output error/);
  });

  it('issue #392/#1097: the launcher execs the Host program verbatim; the plist never changes with it', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'print' ? ABSENT : ok()));
    const fs = fakeFs();
    await createLaunchdLifecycle(
      def({ program: { command: '/opt/host/bin/host-agent', args: ['run', '--profile', 'default'] } }),
      { run, fs, homedir: () => '/h', getuid: () => 501 },
    ).install();
    expect(fs.files.get(LAUNCHER)).toBe(`#!/bin/sh\n# ${SERVICE_UNIT_MARKER}\nexec '/opt/host/bin/host-agent' 'run' '--profile' 'default'\n`);
    expect(fs.chmod).toHaveBeenCalledWith(LAUNCHER, 0o755);
    const plist = fs.files.get(PLIST);

    await createLaunchdLifecycle(
      def({ program: nodeAgentProgram({ agentBin: '/opt/agent.js', configPath: '/etc/agent.json', nodeBin: '/usr/bin/node', service: true }) }),
      { run, fs, homedir: () => '/h', getuid: () => 501 },
    ).install();
    expect(fs.files.get(LAUNCHER)).toContain(`exec '/usr/bin/node' '/opt/agent.js' 'start' '--config' '/etc/agent.json' '--service'\n`);
    expect(fs.files.get(PLIST)).toBe(plist);
  });

  it('uninstall() bootouts (idempotent "not loaded") and removes the plist file', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'not loaded'));
    const fs = fakeFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });

    await lifecycle.uninstall();

    expect(run).toHaveBeenCalledWith('launchctl', ['bootout', 'gui/501/Acme-Agent-']);
    expect(fs.rm).toHaveBeenCalledWith('/h/Library/LaunchAgents/Acme-Agent-.plist', { force: true });
    expect(fs.rm).toHaveBeenCalledWith(LAUNCHER, { force: true });
  });

  it('uninstall() removes the plist only once the booted-out job has left the domain (#1097)', async () => {
    const calls: string[] = [];
    let loadedPrints = 2;
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => {
      calls.push(args[0]!);
      if (args[0] !== 'print') return ok();
      return loadedPrints-- > 0 ? ok('state = exiting') : ABSENT;
    });
    const fs = fakeFs();
    fs.rm.mockImplementation(async () => { calls.push('rm'); });
    await createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501, sleep: async () => undefined, now: () => 0 }).uninstall();
    expect(calls.slice(0, 5)).toEqual(['bootout', 'print', 'print', 'print', 'rm']);
  });

  it('uninstall() throws and does NOT delete the plist when bootout fails for a real reason (P1 #7)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, 'Operation not permitted'));
    const fs = fakeFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });

    await expect(lifecycle.uninstall()).rejects.toThrow(/launchctl bootout failed \(exit 1\): Operation not permitted/);

    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('uninstall() throws and does NOT delete the plist when the GUI domain is unreachable for this uid (P1 #7 round 2)', async () => {
    // Verified real `launchctl` output (Darwin 25.5.0): `launchctl bootout
    // gui/1/<id>` when uid 1 has no active GUI session at all →
    // "Could not find domain for user gui: 1", exit 112. This is a genuine
    // "can't even ask" failure, not evidence the job was never loaded — the
    // same re-orphan shape as systemd's bus-connect false-positive.
    const run = vi.fn<Runner>().mockResolvedValue(fail(112, 'Could not find domain for user gui: 501'));
    const fs = fakeFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });

    await expect(lifecycle.uninstall()).rejects.toThrow(/launchctl bootout failed \(exit 112\): Could not find domain for user gui: 501/);

    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('start() throws "not installed" when the plist does not exist on disk', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.start()).rejects.toThrow(/not installed/);
    expect(run).not.toHaveBeenCalled();
  });

  it('start() chooses by launchd state: kickstart -k a loaded job, bootstrap an unloaded one', async () => {
    for (const [printed, expected] of [
      [ok('state = not running'), ['kickstart', '-k', 'gui/501/Acme-Agent-']],
      [ABSENT, ['bootstrap', 'gui/501', '/h/Library/LaunchAgents/Acme-Agent-.plist']],
    ] as const) {
      const calls: string[][] = [];
      const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => { calls.push(args); return args[0] === 'print' ? printed : ok(); });
      await createLaunchdLifecycle(def(), { run, fs: installedFs(), homedir: () => '/h', getuid: () => 501 }).start();
      expect(calls).toEqual([['print', 'gui/501/Acme-Agent-'], expected]);
    }
  });

  it('start() throws when bootstrap fails instead of kickstarting a job that is not loaded (#1097)', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (
      args[0] === 'print' ? ABSENT : args[0] === 'bootstrap' ? fail(5, 'Bootstrap failed: 5: Input/output error') : ok()));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: installedFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.start()).rejects.toThrow(/launchctl bootstrap failed \(exit 5\): Bootstrap failed: 5: Input\/output error/);
    expect(run).not.toHaveBeenCalledWith('launchctl', ['kickstart', '-k', 'gui/501/Acme-Agent-']);
  });

  it('start() throws when launchctl print fails for a real reason', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(112, 'Could not find domain for user gui: 501'));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: installedFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.start()).rejects.toThrow(/launchctl print failed \(exit 112\)/);
  });

  it('start() throws if kickstart fails even though the plist exists', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'kickstart' ? fail(1) : ok()));
    const fs = installedFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.start()).rejects.toThrow(/launchctl kickstart failed/);
  });

  it('stop() bootouts and tolerates a nonzero exit (already stopped)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'not loaded'));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('launchctl', ['bootout', 'gui/501/Acme-Agent-']);
  });

  it('stop() returns only once launchd reports the booted-out job absent (#1097)', async () => {
    const calls: string[] = [];
    let loadedPrints = 3;
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => {
      calls.push(args[0]!);
      if (args[0] !== 'print') return ok();
      return loadedPrints-- > 0 ? ok('state = exiting') : ABSENT;
    });
    const sleep = vi.fn(async () => undefined);
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501, sleep, now: () => 0 });
    await lifecycle.stop();
    expect(calls).toEqual(['bootout', 'print', 'print', 'print', 'print']);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('stop() throws service_unload_timeout when the job is still loaded at the deadline', async () => {
    let clock = 0;
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'print' ? ok('state = exiting') : ok()));
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501, sleep, now: () => clock });
    const error = await lifecycle.stop().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnitError);
    expect(error).toMatchObject({ code: 'service_unload_timeout' });
    expect(clock).toBe(LAUNCHD_UNLOAD_TIMEOUT_MS);
  });

  it('install() waits for a previous load to leave the domain before bootstrap (#1097)', async () => {
    const calls: string[] = [];
    let loadedPrints = 2;
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => {
      calls.push(args[0]!);
      if (args[0] !== 'print') return ok();
      return loadedPrints-- > 0 ? ok('state = exiting') : ABSENT;
    });
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501, sleep: async () => undefined, now: () => 0 });
    await lifecycle.install();
    expect(calls).toEqual(['bootout', 'print', 'print', 'print', 'bootstrap', 'enable', 'kickstart']);
  });

  it('stop() surfaces a REAL failure instead of reporting success (P1 #7 round 2)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, 'Operation not permitted'));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.stop()).rejects.toThrow(/launchctl bootout failed \(exit 1\): Operation not permitted/);
  });

  it('status() reports installed=true/running=true when the plist exists and launchctl print reports "state = running"', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok('gui/501/Acme-Agent- = {\n\tstate = running\n}'));
    const fs = installedFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });

    const status = await lifecycle.status();
    expect(status).toMatchObject({
      installed: true,
      running: true,
      determinate: true,
      detail: expect.stringContaining('state = running'),
      unit: { state: 'repairable', unitPath: PLIST, launcherPath: LAUNCHER },
      logs: { dir: '/tmp/acme-logs' },
    });
  });

  it('status() reports running=false, determinate=true when launchctl print fails (not loaded), even though the plist file exists', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'Could not find service'));
    const fs = installedFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });

    const status = await lifecycle.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.determinate).toBe(true);
  });

  it('status() reports installed=false when no plist file exists on disk', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'Could not find service'));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    const status = await lifecycle.status();
    expect(status.installed).toBe(false);
  });

  it('finding P1 #2 (residual, round 3): status() reports determinate=false (never a confirmed "not running") when launchctl cannot find the GUI domain for this uid', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(112, 'Could not find domain for user gui: 1'));
    const fs = installedFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 1 });

    const status = await lifecycle.status();
    expect(status.running).toBe(false);
    expect(status.determinate).toBe(false);
  });

  it('finding P1 #2 (residual, round 3): status() reports determinate=false on "Operation not permitted"', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, 'Operation not permitted'));
    const fs = installedFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });

    const status = await lifecycle.status();
    expect(status.running).toBe(false);
    expect(status.determinate).toBe(false);
  });

  it('throws a clear error if getuid is unavailable (non-POSIX) and no override was given', async () => {
    const originalGetuid = process.getuid;
    delete process.getuid;
    try {
      const fs = installedFs();
      const lifecycle = createLaunchdLifecycle(def(), { run: vi.fn().mockResolvedValue(ok()), fs, homedir: () => '/h' });
      await expect(lifecycle.status()).rejects.toThrow(/process\.getuid unavailable/);
    } finally {
      process.getuid = originalGetuid;
    }
  });
});
