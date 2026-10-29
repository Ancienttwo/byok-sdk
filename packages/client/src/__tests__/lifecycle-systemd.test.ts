import { describe, expect, it, vi } from 'vitest';
import { createSystemdLifecycle, generateSystemdUnit } from '../lifecycle/systemd';
import type { RunResult, Runner } from '../lifecycle/exec-runner';
import { nodeAgentProgram, sanitizeServiceName, type ServiceDefinition } from '../lifecycle/service-types';
import { SERVICE_UNIT_MARKER } from '../lifecycle/service-unit';
import { DRIFTED_MARKED_UNIT, memoryServiceFs } from './support/service-fs';

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '' };
}
function fail(code = 1, stdout = '', stderr = 'boom'): RunResult {
  return { code, stdout, stderr };
}

describe('lifecycle/systemd: generateSystemdUnit', () => {
  it('renders the marker, a launcher-only ExecStart, the exit-code restart policy and bounded redirect paths', () => {
    const unit = generateSystemdUnit({
      name: 'acme-agent',
      displayName: 'Acme Agent',
      launcherPath: '/home/t/.byok/acme/service/acme-agent.launcher.sh',
      workingDirectory: '/home/t',
      logDir: '/var/log/acme',
    });

    expect(unit.startsWith('# byok-sdk-service-unit:')).toBe(true);
    expect(unit).toContain('[Unit]\nDescription=Acme Agent');
    // #1097: the unit names only the stable launcher — no versioned path, no args, no env.
    expect(unit).toContain('ExecStart="/home/t/.byok/acme/service/acme-agent.launcher.sh"\n');
    expect(unit).not.toContain('Environment');
    expect(unit).toContain('WorkingDirectory=/home/t');
    // Exit-code contract: only exit 0 stops (see exit-codes.ts).
    expect(unit).toContain('Restart=always\nRestartPreventExitStatus=0\nRestartSec=10');
    expect(unit).toContain('StandardOutput=append:/var/log/acme/service-stdout.log');
    expect(unit).toContain('StandardError=append:/var/log/acme/service-stderr.log');
    expect(unit).toContain('[Install]\nWantedBy=default.target');
  });

  it('quotes the launcher path, escaping embedded quotes/backslashes, "$" and "%" (P1 #8)', () => {
    const unit = generateSystemdUnit({ name: 'x', displayName: 'X', launcherPath: '/s "q"\\/$HOME/100%.sh', workingDirectory: '/h', logDir: '/tmp/logs' });
    expect(unit).toContain('ExecStart="/s \\"q\\"\\\\/$$HOME/100%%.sh"');
  });

  it('escapes a literal "%" in Description/WorkingDirectory/StandardOutput/StandardError so systemd specifiers are never expanded (P1 #8)', () => {
    const unit = generateSystemdUnit({ name: 'x', displayName: '100% Agent', launcherPath: '/l.sh', workingDirectory: '/opt/50%agent', logDir: '/var/log/50%dir' });
    expect(unit).toContain('Description=100%% Agent');
    expect(unit).toContain('WorkingDirectory=/opt/50%%agent');
    expect(unit).toContain('StandardOutput=append:/var/log/50%%dir/service-stdout.log');
    expect(unit).toContain('StandardError=append:/var/log/50%%dir/service-stderr.log');
  });

  it('rejects a newline embedded in displayName instead of letting it inject an extra unit directive (P1 #8)', () => {
    expect(() =>
      generateSystemdUnit({
        name: 'x',
        displayName: 'Evil\n[Service]\nExecStartPost=/bin/rm -rf /',
        launcherPath: '/l.sh',
        workingDirectory: '/h',
        logDir: '/tmp/logs',
      }),
    ).toThrow(/control characters/);
  });

  it('rejects a newline embedded in the working directory (P1 #8)', () => {
    expect(() =>
      generateSystemdUnit({ name: 'x', displayName: 'X', launcherPath: '/l.sh', workingDirectory: '/tmp\nExecStartPost=evil', logDir: '/tmp/logs' }),
    ).toThrow(/control characters/);
  });

  it('rejects a newline embedded in the launcher path (P1 #8)', () => {
    expect(() =>
      generateSystemdUnit({ name: 'x', displayName: 'X', launcherPath: '/l\nExecStartPost=evil', workingDirectory: '/h', logDir: '/tmp/logs' }),
    ).toThrow(/control characters/);
  });

  it('rejects a newline in `name` (P1 #8)', () => {
    expect(() =>
      generateSystemdUnit({
        name: 'x\nExecStartPost=evil',
        displayName: 'X',
        launcherPath: '/l.sh',
        workingDirectory: '/h',
        logDir: '/tmp/logs',
      }),
    ).toThrow(/control characters/);
  });
});

describe('lifecycle/systemd: sanitizeServiceName leading "-" hardening (P1 #8)', () => {
  it('strips a leading "-" so systemctl never mistakes the unit name for an option', () => {
    expect(sanitizeServiceName('-dangerous-name')).toBe('dangerous-name');
    expect(sanitizeServiceName('--rm-rf')).toBe('rm-rf');
  });

  it('throws if nothing valid remains after stripping leading dashes', () => {
    expect(() => sanitizeServiceName('---')).toThrow(/no valid characters/);
  });
});

describe('lifecycle/systemd: createSystemdLifecycle', () => {
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

  const UNIT = '/h/.config/systemd/user/Acme-Agent-.service';
  const LAUNCHER = '/store/service/Acme-Agent-.launcher.sh';
  function fakeFs() {
    return memoryServiceFs();
  }
  function installedFs() {
    return memoryServiceFs({ [UNIT]: DRIFTED_MARKED_UNIT });
  }

  it('sanitizes the service name into a safe unit filename', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const fs = fakeFs();
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/home/tester' });

    await lifecycle.install();

    expect(fs.writeFile).toHaveBeenCalledWith(
      '/home/tester/.config/systemd/user/Acme-Agent-.service',
      expect.any(String),
      'utf8',
    );
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'enable', 'Acme-Agent-.service']);
  });

  it('install() writes the unit then daemon-reload + enable + restart, in order', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return ok();
    });
    const fs = fakeFs();
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/home/tester' });

    await lifecycle.install();

    expect(fs.mkdir).toHaveBeenCalledWith('/home/tester/.config/systemd/user', { recursive: true });
    expect(fs.mkdir).toHaveBeenCalledWith('/tmp/acme-logs', { recursive: true });
    expect(calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable Acme-Agent-.service', 'systemctl --user restart Acme-Agent-.service']);
  });

  it('install() throws a clear error when enable fails', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args.includes('enable') ? fail(1, '', 'Unit not found') : ok()));
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    await expect(lifecycle.install()).rejects.toThrow(/systemctl enable failed \(exit 1\): Unit not found/);
  });

  it('install() throws when daemon-reload itself fails (before ever calling enable)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, '', 'reload failed'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    await expect(lifecycle.install()).rejects.toThrow(/systemctl daemon-reload failed/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('issue #392/#1097: the launcher execs the Host program verbatim; the unit never changes with it', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const fs = fakeFs();
    await createSystemdLifecycle(def({ program: { command: '/opt/host/bin/host-agent', args: ['run', '--profile', 'default'], cwd: "/opt/it's" } }), { run, fs, homedir: () => '/h' }).install();
    expect(fs.files.get(LAUNCHER)).toBe(`#!/bin/sh\n# ${SERVICE_UNIT_MARKER}\ncd '/opt/it'\\''s' || exit 1\nexec '/opt/host/bin/host-agent' 'run' '--profile' 'default'\n`);
    const unit = fs.files.get(UNIT);

    await createSystemdLifecycle(
      def({ program: nodeAgentProgram({ agentBin: '/opt/agent.js', configPath: '/etc/agent.json', nodeBin: '/usr/bin/node', service: true }) }),
      { run, fs, homedir: () => '/h' },
    ).install();
    expect(fs.files.get(LAUNCHER)).toContain(`exec '/usr/bin/node' '/opt/agent.js' 'start' '--config' '/etc/agent.json' '--service'\n`);
    expect(fs.files.get(UNIT)).toBe(unit);
  });

  it('uninstall() disables (idempotent "not loaded") and removes the unit file, then reloads', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return fail(1, '', 'Unit Acme-Agent-.service not loaded.');
    });
    const fs = fakeFs();
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    await lifecycle.uninstall();

    expect(calls).toEqual(['systemctl --user disable --now Acme-Agent-.service', 'systemctl --user daemon-reload']);
    expect(fs.rm).toHaveBeenCalledWith('/h/.config/systemd/user/Acme-Agent-.service', { force: true });
    expect(fs.rm).toHaveBeenCalledWith(LAUNCHER, { force: true });
  });

  it('uninstall() throws and does NOT delete the unit file when disable --now fails for a real reason (P1 #7)', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return fail(1, '', 'Access denied');
    });
    const fs = fakeFs();
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    await expect(lifecycle.uninstall()).rejects.toThrow(/systemctl disable --now failed \(exit 1\): Access denied/);

    expect(fs.rm).not.toHaveBeenCalled();
    // Never reaches daemon-reload — the function throws before that point.
    expect(calls).toEqual(['systemctl --user disable --now Acme-Agent-.service']);
  });

  it('uninstall() throws and does NOT delete the unit file when there is no reachable --user D-Bus session (P1 #7 round 2: was mis-classified as idempotent absence pre-fix)', async () => {
    // Real, extremely common systemd message on a headless/SSH host with no
    // active --user D-Bus session (no `loginctl enable-linger`) — exactly
    // where this daemon commonly runs. Its "No such file or directory" text
    // is textually indistinguishable from a genuinely-absent unit's ENOENT,
    // which is exactly why an earlier version of this fix's bare
    // `/no such file or directory/i` pattern wrongly classified THIS as
    // "already absent" and proceeded to delete the still-relevant unit file
    // — re-orphaning the service the original P1 #7 fix was meant to
    // prevent. Asserting the unit file survives is the regression guard.
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return fail(1, '', 'Failed to connect to bus: No such file or directory');
    });
    const fs = fakeFs();
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    await expect(lifecycle.uninstall()).rejects.toThrow(/systemctl disable --now failed \(exit 1\): Failed to connect to bus: No such file or directory/);

    expect(fs.rm).not.toHaveBeenCalled();
    expect(calls).toEqual(['systemctl --user disable --now Acme-Agent-.service']);
  });

  it('uninstall() still cleans up on a genuine "unit file does not exist" result (real absence, not a bus failure)', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return fail(1, '', 'Failed to disable unit: Unit file Acme-Agent-.service does not exist.');
    });
    const fs = fakeFs();
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    await lifecycle.uninstall();

    expect(calls).toEqual(['systemctl --user disable --now Acme-Agent-.service', 'systemctl --user daemon-reload']);
    expect(fs.rm).toHaveBeenCalledWith('/h/.config/systemd/user/Acme-Agent-.service', { force: true });
  });

  it('a service name starting with "-" is sanitized before reaching systemctl, never mistaken for a CLI option (P1 #8)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const fs = fakeFs();
    const lifecycle = createSystemdLifecycle(def({ name: '-rm-rf-everything' }), { run, fs, homedir: () => '/h' });

    await lifecycle.install();

    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'enable', 'rm-rf-everything.service']);
  });

  it('start() throws "not installed" when the unit file does not exist on disk', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    await expect(lifecycle.start()).rejects.toThrow(/not installed/);
    expect(run).not.toHaveBeenCalled();
  });

  it('start() calls systemctl --user start when the unit file exists, and throws if that fails', async () => {
    const fs = installedFs();
    const runOk = vi.fn<Runner>().mockResolvedValue(ok());
    const lifecycleOk = createSystemdLifecycle(def(), { run: runOk, fs, homedir: () => '/h' });
    await lifecycleOk.start();
    expect(runOk).toHaveBeenCalledWith('systemctl', ['--user', 'start', 'Acme-Agent-.service']);

    const runFail = vi.fn<Runner>().mockResolvedValue(fail(1));
    const lifecycleFail = createSystemdLifecycle(def(), { run: runFail, fs, homedir: () => '/h' });
    await expect(lifecycleFail.start()).rejects.toThrow(/systemctl start failed/);
  });

  it('stop() stops and tolerates a nonzero exit (already stopped/not loaded)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, '', 'Unit Acme-Agent-.service not loaded.'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'stop', 'Acme-Agent-.service']);
  });

  it('stop() surfaces a REAL failure instead of reporting success (P1 #7 round 2)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, '', 'Access denied'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    await expect(lifecycle.stop()).rejects.toThrow(/systemctl stop failed \(exit 1\): Access denied/);
  });

  it('stop() surfaces a bus-connect failure (no --user D-Bus session) rather than reporting "stopped" (P1 #7 round 2)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, '', 'Failed to connect to bus: No such file or directory'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    await expect(lifecycle.stop()).rejects.toThrow(/systemctl stop failed \(exit 1\): Failed to connect to bus/);
  });

  it('status() reports installed=true/running=true when the unit file exists and is-active reports "active" with exit 0', async () => {
    const fs = installedFs();
    const run = vi.fn<Runner>().mockResolvedValue(ok('active\n'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    const status = await lifecycle.status();
    expect(status).toMatchObject({ installed: true, running: true, determinate: true, detail: 'active', unit: { state: 'repairable', unitPath: UNIT } });
  });

  it('status() reports running=false, determinate=true when is-active exits non-zero (inactive/failed), even though installed', async () => {
    const fs = installedFs();
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'inactive\n'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    const status = await lifecycle.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.determinate).toBe(true);
    expect(status.detail).toBe('inactive');
  });

  it('status() reports installed=false when no unit file exists on disk', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'inactive\n'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    const status = await lifecycle.status();
    expect(status.installed).toBe(false);
  });

  it('finding P1 #2 (residual, round 3): status() reports determinate=false (never a confirmed "not running") on a bus-connect failure (no --user D-Bus session)', async () => {
    const fs = installedFs();
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, '', 'Failed to connect to bus: No such file or directory'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    const status = await lifecycle.status();
    expect(status.running).toBe(false);
    expect(status.determinate).toBe(false);
  });

  it('finding P1 #2 (residual, round 3): status() reports determinate=false on a permission-denied query', async () => {
    const fs = installedFs();
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, '', 'Access denied'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    const status = await lifecycle.status();
    expect(status.running).toBe(false);
    expect(status.determinate).toBe(false);
  });
});
