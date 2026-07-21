import { describe, expect, it, vi } from 'vitest';
import { createWinswLifecycle, generateWinswXml } from '../lifecycle/winsw';
import type { RunResult, Runner } from '../lifecycle/exec-runner';
import type { ServiceDefinition } from '../lifecycle/service-types';

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '' };
}
function fail(code = 1, stdout = '', stderr = 'boom'): RunResult {
  return { code, stdout, stderr };
}

describe('lifecycle/winsw: generateWinswXml', () => {
  it('renders id/name/description/executable/one <argument> per arg/logpath/log/startmode/onfailure', () => {
    const xml = generateWinswXml({
      id: 'acme-agent',
      displayName: 'Acme Agent',
      program: {
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['C:\\acme\\byok-agent.js', 'start', '--config', 'C:\\acme\\config.json'],
        cwd: 'C:\\acme',
      },
      logDir: 'C:\\acme\\logs',
    });

    expect(xml).toContain('<id>acme-agent</id>');
    expect(xml).toContain('<name>Acme Agent</name>');
    expect(xml).toContain('<description>Acme Agent (managed by byok-agent; see templates/service/winsw/README.md)</description>');
    expect(xml).toContain('<executable>C:\\Program Files\\nodejs\\node.exe</executable>');
    expect(xml).toContain(
      '<argument>C:\\acme\\byok-agent.js</argument>\n  <argument>start</argument>\n  <argument>--config</argument>\n  <argument>C:\\acme\\config.json</argument>',
    );
    expect(xml).toContain('<workingdirectory>C:\\acme</workingdirectory>');
    expect(xml).toContain('<logpath>C:\\acme\\logs</logpath>');
    expect(xml).toContain('<log mode="roll"></log>');
    expect(xml).toContain('<startmode>Automatic</startmode>');
    expect(xml).toContain('<onfailure action="restart" delay="10 sec"/>');
    expect(xml).toContain('<onfailure action="restart" delay="30 sec"/>');
    expect(xml).toContain('<resetfailure>1 hour</resetfailure>');
  });

  it('omits <workingdirectory> entirely when program.cwd is not given', () => {
    const xml = generateWinswXml({ id: 'x', displayName: 'X', program: { command: 'node', args: [] }, logDir: 'C:\\logs' });
    expect(xml).not.toContain('<workingdirectory>');
  });

  it('XML-escapes special characters in displayName/args', () => {
    const xml = generateWinswXml({
      id: 'x',
      displayName: 'Acme & Co <Test>',
      program: { command: 'node', args: ['--flag="quoted"'] },
      logDir: 'C:\\logs',
    });
    expect(xml).toContain('<name>Acme &amp; Co &lt;Test&gt;</name>');
    expect(xml).toContain('<argument>--flag=&quot;quoted&quot;</argument>');
  });
});

describe('lifecycle/winsw: createWinswLifecycle', () => {
  function def(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
    return {
      name: 'Acme Agent!!',
      program: { command: 'C:\\node.exe', args: ['C:\\agent.js', 'start'] },
      logDir: 'C:\\acme\\logs',
      windows: { winswBin: 'C:\\bundled\\WinSW.exe' },
      ...overrides,
    };
  }

  function fakeFs() {
    return {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      copyFile: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    };
  }

  it('throws synchronously if ServiceDefinition.windows is missing', () => {
    expect(() => createWinswLifecycle(def({ windows: undefined }))).toThrow(/windows\.winswBin/);
  });

  it('install() copies the WinSW binary + writes the XML under installDir (default: logDir), then winsw install + start', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return ok();
    });
    const fs = fakeFs();
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    await lifecycle.install();

    expect(fs.copyFile).toHaveBeenCalledWith('C:\\bundled\\WinSW.exe', 'C:\\acme\\logs/Acme-Agent-.exe');
    expect(fs.writeFile).toHaveBeenCalledWith('C:\\acme\\logs/Acme-Agent-.xml', expect.any(String), 'utf8');
    expect(calls).toEqual(['C:\\acme\\logs/Acme-Agent-.exe install', 'C:\\acme\\logs/Acme-Agent-.exe start']);
  });

  it('install() uses windows.installDir when given instead of logDir', async () => {
    const fs = fakeFs();
    const lifecycle = createWinswLifecycle(def({ windows: { winswBin: 'C:\\bundled\\WinSW.exe', installDir: 'C:\\svc' } }), {
      run: vi.fn<Runner>().mockResolvedValue(ok()),
      fs,
    });
    await lifecycle.install();
    expect(fs.copyFile).toHaveBeenCalledWith('C:\\bundled\\WinSW.exe', 'C:\\svc/Acme-Agent-.exe');
  });

  it('install() throws a clear error when "winsw install" fails, and never calls "start"', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'install' ? fail(1, '', 'access denied') : ok()));
    const lifecycle = createWinswLifecycle(def(), { run, fs: fakeFs() });
    await expect(lifecycle.install()).rejects.toThrow(/winsw install failed \(exit 1\): access denied/);
    expect(run).not.toHaveBeenCalledWith(expect.any(String), ['start']);
  });

  it('install() throws a clear error when "winsw start" fails after a successful install', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'start' ? fail(1, '', 'could not start') : ok()));
    const lifecycle = createWinswLifecycle(def(), { run, fs: fakeFs() });
    await expect(lifecycle.install()).rejects.toThrow(/winsw start failed/);
  });

  it('uninstall() stops + uninstalls (both idempotent "does not exist") and removes the copied exe + xml', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return fail(1060, '', 'The specified service does not exist as an installed service.');
    });
    const fs = fakeFs();
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    await lifecycle.uninstall();

    expect(calls).toEqual(['C:\\acme\\logs/Acme-Agent-.exe stop', 'C:\\acme\\logs/Acme-Agent-.exe uninstall']);
    expect(fs.rm).toHaveBeenCalledWith('C:\\acme\\logs/Acme-Agent-.exe', { force: true });
    expect(fs.rm).toHaveBeenCalledWith('C:\\acme\\logs/Acme-Agent-.xml', { force: true });
  });

  it('uninstall() throws and does NOT delete exe/xml when "stop" fails for a real reason, and never calls "uninstall" (P1 #7)', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return fail(1, '', 'Access is denied.');
    });
    const fs = fakeFs();
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    await expect(lifecycle.uninstall()).rejects.toThrow(/winsw stop failed \(exit 1\): Access is denied\./);

    expect(calls).toEqual(['C:\\acme\\logs/Acme-Agent-.exe stop']);
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('uninstall() throws and does NOT delete exe/xml when "stop" succeeds but "uninstall" fails for a real reason (P1 #7)', async () => {
    const run = vi.fn<Runner>().mockImplementation(async (_cmd, args) => (args[0] === 'uninstall' ? fail(1, '', 'Access is denied.') : ok()));
    const fs = fakeFs();
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    await expect(lifecycle.uninstall()).rejects.toThrow(/winsw uninstall failed \(exit 1\): Access is denied\./);

    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('start() throws "not installed" when the xml config does not exist on disk', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const lifecycle = createWinswLifecycle(def(), { run, fs: fakeFs() });
    await expect(lifecycle.start()).rejects.toThrow(/not installed/);
    expect(run).not.toHaveBeenCalled();
  });

  it('start() calls "winsw start" when the xml exists, and throws if that fails', async () => {
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const run = vi.fn<Runner>().mockResolvedValue(fail(1));
    const lifecycle = createWinswLifecycle(def(), { run, fs });
    await expect(lifecycle.start()).rejects.toThrow(/winsw start failed/);
  });

  it('stop() calls "winsw stop" and tolerates a nonzero exit (already stopped)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, '', 'not running'));
    const lifecycle = createWinswLifecycle(def(), { run, fs: fakeFs() });
    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('C:\\acme\\logs/Acme-Agent-.exe', ['stop']);
  });

  it('stop() tolerates ERROR_SERVICE_NOT_ACTIVE (1062, "has not been started")', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1062, '', 'The service has not been started.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs: fakeFs() });
    await expect(lifecycle.stop()).resolves.toBeUndefined();
  });

  it('stop() tolerates "not installed" (1060) too — nothing to stop', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1060, '', 'The specified service does not exist as an installed service.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs: fakeFs() });
    await expect(lifecycle.stop()).resolves.toBeUndefined();
  });

  it('stop() surfaces a REAL failure instead of reporting success (P1 #7 round 2)', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1, '', 'Access is denied.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs: fakeFs() });
    await expect(lifecycle.stop()).rejects.toThrow(/winsw stop failed \(exit 1\): Access is denied\./);
  });

  it('status() queries sc.exe (not WinSW\'s own status) and reports running=true on a RUNNING state line', async () => {
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const scOutput = [
      'SERVICE_NAME: Acme-Agent-',
      '        TYPE               : 10  WIN32_OWN_PROCESS',
      '        STATE              : 4  RUNNING',
      '                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)',
      '        WIN32_EXIT_CODE    : 0  (0x0)',
    ].join('\r\n');
    const run = vi.fn<Runner>().mockResolvedValue(ok(scOutput));
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    const status = await lifecycle.status();
    expect(run).toHaveBeenCalledWith('sc.exe', ['query', 'Acme-Agent-']);
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.determinate).toBe(true);
  });

  it('status() reports running=false, determinate=true on a STOPPED state line', async () => {
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const scOutput = ['SERVICE_NAME: Acme-Agent-', '        STATE              : 1  STOPPED'].join('\r\n');
    const run = vi.fn<Runner>().mockResolvedValue(ok(scOutput));
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    const status = await lifecycle.status();
    expect(status.running).toBe(false);
    expect(status.determinate).toBe(true);
  });

  it('status() reports installed=false, determinate=true when sc query fails (service does not exist) and no xml file exists locally', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(fail(1060, '', 'The specified service does not exist as an installed service.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs: fakeFs() });
    const status = await lifecycle.status();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.determinate).toBe(true);
  });

  it('finding P1 #2 (residual, round 3): status() reports determinate=false (never a confirmed "not running") when sc.exe reports access denied', async () => {
    const fs = fakeFs();
    fs.stat.mockResolvedValue({} as never);
    const run = vi.fn<Runner>().mockResolvedValue(fail(5, '', 'Access is denied.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    const status = await lifecycle.status();
    expect(status.running).toBe(false);
    expect(status.determinate).toBe(false);
  });
});
