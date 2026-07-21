import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createLaunchdLifecycle, generateLaunchdPlist } from '../lifecycle/launchd';
import type { RunResult, Runner } from '../lifecycle/exec-runner';
import type { ServiceDefinition } from '../lifecycle/service-types';

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '' };
}
function fail(code = 1, stderr = 'boom'): RunResult {
  return { code, stdout: '', stderr };
}

describe('lifecycle/launchd: generateLaunchdPlist', () => {
  it('renders Label/ProgramArguments/WorkingDirectory/RunAtLoad/KeepAlive/log paths', () => {
    const xml = generateLaunchdPlist({
      label: 'com.acme.agent',
      program: { command: '/usr/local/bin/node', args: ['/opt/agent/byok-agent.js', 'start', '--config', '/etc/agent/config.json'], cwd: '/opt/agent' },
      logDir: '/var/log/acme',
    });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<key>Label</key>\n  <string>com.acme.agent</string>');
    expect(xml).toContain(
      '<key>ProgramArguments</key>\n  <array>\n    <string>/usr/local/bin/node</string>\n    <string>/opt/agent/byok-agent.js</string>\n    <string>start</string>\n    <string>--config</string>\n    <string>/etc/agent/config.json</string>\n  </array>',
    );
    expect(xml).toContain('<key>WorkingDirectory</key>\n  <string>/opt/agent</string>');
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>');
    // Crash-restart only, not on a clean exit(0) — see launchd.ts's doc comment.
    expect(xml).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>');
    expect(xml).toContain('<key>ThrottleInterval</key>\n  <integer>10</integer>');
    expect(xml).toContain('<key>StandardOutPath</key>\n  <string>/var/log/acme/com.acme.agent.out.log</string>');
    expect(xml).toContain('<key>StandardErrorPath</key>\n  <string>/var/log/acme/com.acme.agent.err.log</string>');
  });

  it('defaults WorkingDirectory to the homedir when program.cwd is omitted', () => {
    const xml = generateLaunchdPlist({ label: 'x', program: { command: 'node', args: [] }, logDir: '/tmp/logs' });
    expect(xml).toContain(`<string>${os.homedir()}</string>`);
  });

  it('XML-escapes special characters in args', () => {
    const xml = generateLaunchdPlist({
      label: 'x',
      program: { command: 'node', args: ['--flag=<a & b> "quoted" \'single\''] },
      logDir: '/tmp/logs',
    });
    expect(xml).toContain('&lt;a &amp; b&gt; &quot;quoted&quot; &apos;single&apos;');
  });
});

describe('lifecycle/launchd: createLaunchdLifecycle', () => {
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

  it('sanitizes the service name into a safe launchd label used for the plist path and service target', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
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
      return ok();
    });
    const fs = fakeFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/Users/tester', getuid: () => 501 });

    await lifecycle.install();

    expect(fs.mkdir).toHaveBeenCalledWith('/Users/tester/Library/LaunchAgents', { recursive: true });
    expect(fs.mkdir).toHaveBeenCalledWith('/tmp/acme-logs', { recursive: true });
    expect(calls).toEqual([
      'launchctl bootout gui/501/Acme-Agent-',
      'launchctl bootstrap gui/501 /Users/tester/Library/LaunchAgents/Acme-Agent-.plist',
      'launchctl enable gui/501/Acme-Agent-',
      'launchctl kickstart -k gui/501/Acme-Agent-',
    ]);
  });

  it('install() ignores a failing (nonzero-exit) bootout — expected when nothing was previously loaded', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'bootout' ? fail(3, 'Could not find service') : ok()));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.install()).resolves.toBeUndefined();
  });

  it('install() throws a clear error when bootstrap itself fails', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'bootstrap' ? fail(1, 'Input/output error') : ok()));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.install()).rejects.toThrow(/launchctl bootstrap failed \(exit 1\): Input\/output error/);
  });

  it('install() opts.program overrides the definition program for that call only', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const fs = fakeFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });
    await lifecycle.install({ program: { command: '/other/node', args: ['x'] } });
    const written = fs.writeFile.mock.calls[0]?.[1] as string;
    expect(written).toContain('<string>/other/node</string>');
  });

  it('uninstall() bootouts (best-effort) and removes the plist file', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'not loaded'));
    const fs = fakeFs();
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });

    await lifecycle.uninstall();

    expect(run).toHaveBeenCalledWith('launchctl', ['bootout', 'gui/501/Acme-Agent-']);
    expect(fs.rm).toHaveBeenCalledWith('/h/Library/LaunchAgents/Acme-Agent-.plist', { force: true });
  });

  it('start() throws "not installed" when the plist does not exist on disk', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.start()).rejects.toThrow(/not installed/);
    expect(run).not.toHaveBeenCalled();
  });

  it('start() bootstraps (best-effort) then kickstarts (hard-fail) when the plist exists', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });

    await lifecycle.start();
    expect(run).toHaveBeenCalledWith('launchctl', ['bootstrap', 'gui/501', '/h/Library/LaunchAgents/Acme-Agent-.plist']);
    expect(run).toHaveBeenCalledWith('launchctl', ['kickstart', '-k', 'gui/501/Acme-Agent-']);
  });

  it('start() throws if kickstart fails even though the plist exists', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'kickstart' ? fail(1) : ok()));
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.start()).rejects.toThrow(/launchctl kickstart failed/);
  });

  it('stop() bootouts and tolerates a nonzero exit (already stopped)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'not loaded'));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('launchctl', ['bootout', 'gui/501/Acme-Agent-']);
  });

  it('status() reports installed=true/running=true when the plist exists and launchctl print reports "state = running"', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok('gui/501/Acme-Agent- = {\n\tstate = running\n}'));
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });

    const status = await lifecycle.status();
    expect(status).toEqual({ installed: true, running: true, detail: expect.stringContaining('state = running') });
  });

  it('status() reports running=false when launchctl print fails (not loaded), even though the plist file exists', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'Could not find service'));
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const lifecycle = createLaunchdLifecycle(def(), { run, fs, homedir: () => '/h', getuid: () => 501 });

    const status = await lifecycle.status();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
  });

  it('status() reports installed=false when no plist file exists on disk', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(3, 'Could not find service'));
    const lifecycle = createLaunchdLifecycle(def(), { run, fs: fakeFs(), homedir: () => '/h', getuid: () => 501 });
    const status = await lifecycle.status();
    expect(status.installed).toBe(false);
  });

  it('throws a clear error if getuid is unavailable (non-POSIX) and no override was given', async () => {
    const originalGetuid = process.getuid;
    delete process.getuid;
    try {
      const fs = fakeFs();
      fs.stat.mockResolvedValue({} as never);
      const lifecycle = createLaunchdLifecycle(def(), { run: vi.fn().mockResolvedValue(ok()), fs, homedir: () => '/h' });
      await expect(lifecycle.status()).rejects.toThrow(/process\.getuid unavailable/);
    } finally {
      process.getuid = originalGetuid;
    }
  });
});
