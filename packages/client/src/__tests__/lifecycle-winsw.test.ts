import { afterEach, describe, expect, it, vi } from 'vitest';
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

  // The image-lock retry tests below fake the timer queue instead of paying
  // the real flat-250ms-per-retry backoff in wall-clock time (~2.3s for the
  // budget-exhaustion case alone). Constraint found by probing both runners
  // this file is executed by: bun:test's vi has NO *Async timer-advance API
  // (`vi.advanceTimersByTimeAsync` is vitest-only), so this drives the retry
  // loop with the runner-common subset — microtask hops let the retry
  // await-chain run up to (or past) its next fake `setTimeout`, then the
  // sync `vi.advanceTimersByTime` fires it. No early exit on "no pending
  // timer": the uninstall preamble (two runIdempotent awaits plus the rm
  // await) chains ~5 microtask links before the FIRST sleep is even
  // registered, and a timer count of 0 there would abort the drain and park
  // the test on a sleep that never fires. Extra trailing advances are
  // harmless no-ops. Verified under `bun test` (jest-compat vi) AND
  // `vitest run` (what `bun run test` executes for this package).
  async function drainImageLockRetry(maxSteps: number): Promise<void> {
    for (let step = 0; step < maxSteps; step += 1) {
      for (let hop = 0; hop < 10; hop += 1) {
        await Promise.resolve();
      }
      vi.advanceTimersByTime(250);
    }
  }

  afterEach(() => {
    vi.useRealTimers();
  });

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

  // CI job "Windows service install smoke" flake: Windows releases the just-
  // stopped service process's image section asynchronously after SCM
  // STOPPED/deregistration, so an unlink issued immediately after
  // `winsw uninstall` returns can lose that race and get EPERM
  // (`EPERM: unlink ...logs\byok-winsw-smoke-<pid>.exe`), voiding an
  // otherwise-passing run. These tests pin BOTH directions of the bounded
  // retry: transient image-lock errors are retried to resolution, but a
  // persistently locked exe still fails closed after the budget (no
  // masking, no silent success).
  it('uninstall() retries rm past a transient Windows image-lock EPERM on the exe and still resolves', async () => {
    vi.useFakeTimers();
    const eperm = () =>
      Object.assign(new Error("EPERM: operation not permitted, unlink 'C:\\acme\\logs/Acme-Agent-.exe'"), { code: 'EPERM' });
    const fs = fakeFs();
    let exeRmAttempts = 0;
    fs.rm.mockImplementation(async (p: string) => {
      if (p.endsWith('.exe')) {
        exeRmAttempts += 1;
        if (exeRmAttempts <= 2) {
          throw eperm();
        }
      }
    });
    const run = vi.fn<Runner>().mockResolvedValue(fail(1060, '', 'The specified service does not exist as an installed service.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    const uninstalling = lifecycle.uninstall();
    await drainImageLockRetry(4); // 2 backoff sleeps, then attempt 3 succeeds
    await uninstalling;

    expect(exeRmAttempts).toBe(3);
    expect(fs.rm).toHaveBeenCalledWith('C:\\acme\\logs/Acme-Agent-.exe', { force: true });
    expect(fs.rm).toHaveBeenCalledWith('C:\\acme\\logs/Acme-Agent-.xml', { force: true });
  });

  it('uninstall() retries rm past a transient EBUSY on the exe too (same image-lock class) and still resolves', async () => {
    vi.useFakeTimers();
    const fs = fakeFs();
    let exeRmAttempts = 0;
    fs.rm.mockImplementation(async (p: string) => {
      if (p.endsWith('.exe')) {
        exeRmAttempts += 1;
        if (exeRmAttempts <= 2) {
          throw Object.assign(new Error("EBUSY: resource busy or locked, unlink 'C:\\acme\\logs/Acme-Agent-.exe'"), { code: 'EBUSY' });
        }
      }
    });
    const run = vi.fn<Runner>().mockResolvedValue(fail(1060, '', 'The specified service does not exist as an installed service.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    const uninstalling = lifecycle.uninstall();
    await drainImageLockRetry(4); // 2 backoff sleeps, then attempt 3 succeeds
    await uninstalling;

    expect(exeRmAttempts).toBe(3);
    expect(fs.rm).toHaveBeenCalledWith('C:\\acme\\logs/Acme-Agent-.exe', { force: true });
    expect(fs.rm).toHaveBeenCalledWith('C:\\acme\\logs/Acme-Agent-.xml', { force: true });
  });

  it('uninstall() retries the XML config deletion through the same image-lock retry (exe deleted first try)', async () => {
    vi.useFakeTimers();
    const fs = fakeFs();
    let xmlRmAttempts = 0;
    fs.rm.mockImplementation(async (p: string) => {
      if (p.endsWith('.xml')) {
        xmlRmAttempts += 1;
        if (xmlRmAttempts <= 2) {
          throw Object.assign(new Error("EPERM: operation not permitted, unlink 'C:\\acme\\logs/Acme-Agent-.xml'"), { code: 'EPERM' });
        }
      }
    });
    const run = vi.fn<Runner>().mockResolvedValue(fail(1060, '', 'The specified service does not exist as an installed service.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    const uninstalling = lifecycle.uninstall();
    await drainImageLockRetry(4); // 2 backoff sleeps on the xml, then success
    await uninstalling;

    expect(xmlRmAttempts).toBe(3);
    // The exe removal needed no retry: exe once + xml three times = 4 rm calls.
    expect(fs.rm).toHaveBeenCalledTimes(4);
    expect(fs.rm).toHaveBeenCalledWith('C:\\acme\\logs/Acme-Agent-.exe', { force: true });
    expect(fs.rm).toHaveBeenCalledWith('C:\\acme\\logs/Acme-Agent-.xml', { force: true });
  });

  it('uninstall() still rejects (fail-closed) after the retry budget when the exe stays EPERM-locked, rethrowing the ORIGINAL last error', async () => {
    vi.useFakeTimers();
    const fs = fakeFs();
    // One stable error identity thrown on EVERY attempt: the final rejection
    // must be this exact object rethrown as-is, never a wrapped/re-created
    // "retries exhausted" error (the genuine lock cause must surface).
    const persistentLock = Object.assign(
      new Error("EPERM: operation not permitted, unlink 'C:\\acme\\logs/Acme-Agent-.exe'"),
      { code: 'EPERM' },
    );
    fs.rm.mockImplementation(async () => {
      throw persistentLock;
    });
    const run = vi.fn<Runner>().mockResolvedValue(fail(1060, '', 'The specified service does not exist as an installed service.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    const rejection = lifecycle.uninstall().catch((error: unknown) => error);
    await drainImageLockRetry(11); // 9 backoff sleeps, then attempt 10 rethrows
    const caught = (await rejection) as NodeJS.ErrnoException;

    // The budget itself: 10 attempts (initial + 9 retries) before rethrow.
    expect(fs.rm).toHaveBeenCalledTimes(10);
    // Original-error contract: same identity as the thrown error...
    expect(caught).toBe(persistentLock);
    // ...same code and exact message — not a wrapped/new error.
    expect(caught.code).toBe('EPERM');
    expect(caught.message).toBe("EPERM: operation not permitted, unlink 'C:\\acme\\logs/Acme-Agent-.exe'");
  });

  it('uninstall() does NOT retry rm for errors outside the image-lock class (EACCES rethrows immediately)', async () => {
    vi.useFakeTimers();
    const fs = fakeFs();
    fs.rm.mockImplementation(async () => {
      throw Object.assign(new Error("EACCES: permission denied, unlink 'C:\\acme\\logs/Acme-Agent-.exe'"), { code: 'EACCES' });
    });
    const run = vi.fn<Runner>().mockResolvedValue(fail(1060, '', 'The specified service does not exist as an installed service.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    await expect(lifecycle.uninstall()).rejects.toMatchObject({ code: 'EACCES' });
    expect(fs.rm).toHaveBeenCalledTimes(1);
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
