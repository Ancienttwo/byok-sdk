import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createSystemdLifecycle, generateSystemdUnit } from '../lifecycle/systemd';
import type { RunResult, Runner } from '../lifecycle/exec-runner';
import type { ServiceDefinition } from '../lifecycle/service-types';

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '' };
}
function fail(code = 1, stdout = '', stderr = 'boom'): RunResult {
  return { code, stdout, stderr };
}

describe('lifecycle/systemd: generateSystemdUnit', () => {
  it('renders Description/ExecStart/WorkingDirectory/Restart/log paths/WantedBy', () => {
    const unit = generateSystemdUnit({
      name: 'acme-agent',
      displayName: 'Acme Agent',
      program: { command: '/usr/bin/node', args: ['/opt/agent/byok-agent.js', 'start', '--config', '/etc/agent/config.json'], cwd: '/opt/agent' },
      logDir: '/var/log/acme',
    });

    expect(unit).toContain('[Unit]\nDescription=Acme Agent');
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/opt/agent/byok-agent.js" "start" "--config" "/etc/agent/config.json"',
    );
    expect(unit).toContain('WorkingDirectory=/opt/agent');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=10');
    expect(unit).toContain('StandardOutput=append:/var/log/acme/acme-agent.out.log');
    expect(unit).toContain('StandardError=append:/var/log/acme/acme-agent.err.log');
    expect(unit).toContain('[Install]\nWantedBy=default.target');
  });

  it('defaults WorkingDirectory to the homedir when program.cwd is omitted', () => {
    const unit = generateSystemdUnit({ name: 'x', displayName: 'X', program: { command: 'node', args: [] }, logDir: '/tmp/logs' });
    expect(unit).toContain(`WorkingDirectory=${os.homedir()}`);
  });

  it('quotes every ExecStart token unconditionally, escaping embedded quotes/backslashes', () => {
    const unit = generateSystemdUnit({
      name: 'x',
      displayName: 'X',
      program: { command: 'node', args: ['--path', 'C:\\some "quoted" path'] },
      logDir: '/tmp/logs',
    });
    expect(unit).toContain('ExecStart="node" "--path" "C:\\\\some \\"quoted\\" path"');
  });
});

describe('lifecycle/systemd: createSystemdLifecycle', () => {
  function def(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
    return {
      name: 'Acme Agent!!',
      program: { command: '/usr/bin/node', args: ['/opt/agent.js', 'start'] },
      logDir: '/tmp/acme-logs',
      ...overrides,
    };
  }

  function fakeFs() {
    return {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    };
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
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'enable', '--now', 'Acme-Agent-.service']);
  });

  it('install() writes the unit then daemon-reload + enable --now, in order', async () => {
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
    expect(calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now Acme-Agent-.service']);
  });

  it('install() throws a clear error when enable --now fails', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args.includes('enable') ? fail(1, '', 'Unit not found') : ok()));
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    await expect(lifecycle.install()).rejects.toThrow(/systemctl enable --now failed \(exit 1\): Unit not found/);
  });

  it('install() throws when daemon-reload itself fails (before ever calling enable)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, '', 'reload failed'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    await expect(lifecycle.install()).rejects.toThrow(/systemctl daemon-reload failed/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('install() opts.program overrides the definition program for that call only', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const fs = fakeFs();
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });
    await lifecycle.install({ program: { command: '/other/node', args: ['x'] } });
    const written = fs.writeFile.mock.calls[0]?.[1] as string;
    expect(written).toContain('ExecStart="/other/node" "x"');
  });

  it('uninstall() disables (best-effort) and removes the unit file, then reloads', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return fail(1, '', 'not found');
    });
    const fs = fakeFs();
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    await lifecycle.uninstall();

    expect(calls).toEqual(['systemctl --user disable --now Acme-Agent-.service', 'systemctl --user daemon-reload']);
    expect(fs.rm).toHaveBeenCalledWith('/h/.config/systemd/user/Acme-Agent-.service', { force: true });
  });

  it('start() throws "not installed" when the unit file does not exist on disk', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    await expect(lifecycle.start()).rejects.toThrow(/not installed/);
    expect(run).not.toHaveBeenCalled();
  });

  it('start() calls systemctl --user start when the unit file exists, and throws if that fails', async () => {
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const runOk = vi.fn<Runner>().mockResolvedValue(ok());
    const lifecycleOk = createSystemdLifecycle(def(), { run: runOk, fs, homedir: () => '/h' });
    await lifecycleOk.start();
    expect(runOk).toHaveBeenCalledWith('systemctl', ['--user', 'start', 'Acme-Agent-.service']);

    const runFail = vi.fn<Runner>().mockResolvedValue(fail(1));
    const lifecycleFail = createSystemdLifecycle(def(), { run: runFail, fs, homedir: () => '/h' });
    await expect(lifecycleFail.start()).rejects.toThrow(/systemctl start failed/);
  });

  it('stop() stops and tolerates a nonzero exit (already stopped)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, '', 'not active'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'stop', 'Acme-Agent-.service']);
  });

  it('status() reports installed=true/running=true when the unit file exists and is-active reports "active" with exit 0', async () => {
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const run = vi.fn<Runner>().mockResolvedValue(ok('active\n'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    const status = await lifecycle.status();
    expect(status).toEqual({ installed: true, running: true, detail: 'active' });
  });

  it('status() reports running=false when is-active exits non-zero (inactive/failed), even though installed', async () => {
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'inactive\n'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs, homedir: () => '/h' });

    const status = await lifecycle.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.detail).toBe('inactive');
  });

  it('status() reports installed=false when no unit file exists on disk', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'inactive\n'));
    const lifecycle = createSystemdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h' });
    const status = await lifecycle.status();
    expect(status.installed).toBe(false);
  });
});
