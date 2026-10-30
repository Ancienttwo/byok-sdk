import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWinswLifecycle, generateWinswXml } from '../lifecycle/winsw';
import type { RunResult, Runner } from '../lifecycle/exec-runner';
import { nodeAgentProgram, type ServiceDefinition } from '../lifecycle/service-types';
import { DRIFTED_MARKED_UNIT, memoryServiceFs } from './support/service-fs';
import { useInProcessServiceLifecycleGate } from './support/service-lifecycle-gate';

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '' };
}
function fail(code = 1, stdout = '', stderr = 'boom'): RunResult {
  return { code, stdout, stderr };
}

useInProcessServiceLifecycleGate();

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

    // #1097: the SCM registration names only the stable <id>.exe; this descriptor is the launcher.
    expect(xml.startsWith('<!-- byok-sdk-service-unit:')).toBe(true);
    expect(xml).toContain('<id>acme-agent</id>');
    expect(xml).toContain('<name>Acme Agent</name>');
    expect(xml).toContain('<description>Acme Agent (managed by @byok-sdk/client)</description>');
    expect(xml).toContain('<executable>C:\\Program Files\\nodejs\\node.exe</executable>');
    expect(xml).toContain(
      '<argument>C:\\acme\\byok-agent.js</argument>\n  <argument>start</argument>\n  <argument>--config</argument>\n  <argument>C:\\acme\\config.json</argument>',
    );
    expect(xml).toContain('<workingdirectory>C:\\acme</workingdirectory>');
    expect(xml).toContain('<logpath>C:\\acme\\logs</logpath>');
    // The redirect is bounded like the launchd/systemd one (SERVICE_REDIRECT_LIMITS).
    expect(xml).toContain('<log mode="roll-by-size">\n    <sizeThreshold>1024</sizeThreshold>\n    <keepFiles>2</keepFiles>\n  </log>');
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
      storeDir: 'C:\\store',
      logDir: 'C:\\acme\\logs',
      owner: 'cli',
      windows: { winswBin: 'C:\\bundled\\WinSW.exe' },
      ...overrides,
    };
  }

  const XML = 'C:\\acme\\logs/Acme-Agent-.xml';
  const EXE = 'C:\\acme\\logs/Acme-Agent-.exe';
  const WINSW_BIN = 'C:\\bundled\\WinSW.exe';
  // The product-bundled WinSW binary always exists.
  function fakeFs() {
    return memoryServiceFs({ [WINSW_BIN]: 'winsw v2.12.0' });
  }
  function installedFs() {
    return memoryServiceFs({ [WINSW_BIN]: 'winsw v2.12.0', [XML]: DRIFTED_MARKED_UNIT });
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

  it('issue #394: the descriptor runs the Host program verbatim; nodeAgentProgram({ service: true }) carries --service last', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(ok());
    const fs = fakeFs();
    await createWinswLifecycle(def(), { run, fs }).install();
    expect(fs.files.get(XML)).toContain('<argument>start</argument>');
    expect(fs.files.get(XML)).not.toContain('--service');

    await createWinswLifecycle(
      def({ program: nodeAgentProgram({ agentBin: 'C:\\agent.js', configPath: 'C:\\agent.json', nodeBin: 'C:\\node.exe', service: true }) }),
      { run, fs },
    ).install();
    expect(fs.files.get(XML)).toContain('<argument>C:\\agent.json</argument>\n  <argument>--service</argument>');
  });

  it('a re-install waits for the running service to stop before writing, and keeps an existing SCM registration (1073)', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return args[0] === 'install' ? fail(1073, '', 'The specified service already exists.') : ok();
    });
    const fs = memoryServiceFs({ [XML]: DRIFTED_MARKED_UNIT, [EXE]: 'winsw v2.12.0', [WINSW_BIN]: 'winsw v2.12.0' });
    await createWinswLifecycle(def(), { run, fs }).install();
    expect(calls).toEqual(['C:\\acme\\logs/Acme-Agent-.exe stopwait', 'C:\\acme\\logs/Acme-Agent-.exe install', 'C:\\acme\\logs/Acme-Agent-.exe start']);
  });

  it('repair() of a drifted descriptor rewrites the XML and leaves an identical wrapper exe untouched', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return args[0] === 'install' ? fail(1073, '', 'The specified service already exists.') : ok();
    });
    const fs = memoryServiceFs({ [XML]: DRIFTED_MARKED_UNIT, [EXE]: 'winsw v2.12.0', [WINSW_BIN]: 'winsw v2.12.0' });

    await expect(createWinswLifecycle(def(), { run, fs }).repair()).resolves.toEqual({ status: 'repaired' });

    expect(fs.copyFile).not.toHaveBeenCalled();
    expect(fs.files.get(XML)).toContain('<id>Acme-Agent-</id>');
    expect(calls).toEqual(['C:\\acme\\logs/Acme-Agent-.exe stopwait', 'C:\\acme\\logs/Acme-Agent-.exe install', 'C:\\acme\\logs/Acme-Agent-.exe start']);
  });

  it('a re-install replaces a wrapper exe whose bytes differ from winswBin, after stopwait', async () => {
    const calls: string[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'sc.exe') return ok('SERVICE_NAME: Acme-Agent-\r\n        STATE              : 4  RUNNING');
      return args[0] === 'install' ? fail(1073, '', 'The specified service already exists.') : ok();
    });
    const fs = memoryServiceFs({ [XML]: DRIFTED_MARKED_UNIT, [EXE]: 'winsw v2.11.0', [WINSW_BIN]: 'winsw v2.12.0' });
    fs.copyFile.mockImplementation(async (from: string, to: string) => {
      calls.push(`copy ${from} -> ${to}`);
      fs.files.set(to, fs.files.get(from) ?? '');
    });

    await createWinswLifecycle(def(), { run, fs }).install();

    expect(fs.files.get(EXE)).toBe('winsw v2.12.0');
    expect(calls).toEqual([
      'sc.exe query Acme-Agent-',
      'C:\\acme\\logs/Acme-Agent-.exe stopwait',
      `copy ${WINSW_BIN} -> ${EXE}`,
      'C:\\acme\\logs/Acme-Agent-.exe install',
      'C:\\acme\\logs/Acme-Agent-.exe start',
    ]);
  });

  describe('the installed wrapper exe is part of the installed unit', () => {
    const EXACT_XML = generateWinswXml({ id: 'Acme-Agent-', displayName: 'Acme Agent!!', program: def().program, logDir: 'C:\\acme\\logs' });
    function scState(state: string): RunResult {
      return ok(['SERVICE_NAME: Acme-Agent-', '        TYPE               : 10  WIN32_OWN_PROCESS', `        STATE              : ${state}`].join('\r\n'));
    }
    const NOT_INSTALLED = fail(1060, '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.', '');
    function recording(fs: ReturnType<typeof memoryServiceFs>, sc: RunResult) {
      const calls: string[] = [];
      const run = vi.fn<Runner>().mockImplementation(async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'sc.exe') return sc;
        return args[0] === 'install' ? fail(1073, '', 'The specified service already exists.') : ok();
      });
      fs.copyFile.mockImplementation(async (from: string, to: string) => {
        calls.push(`copy ${from} -> ${to}`);
        fs.files.set(to, fs.files.get(from) ?? '');
      });
      return { calls, run };
    }
    function eacces(file: string): NodeJS.ErrnoException {
      return Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });
    }

    it('a missing wrapper exe under an exact descriptor is repairable, and a stopped service gets it back without running it', async () => {
      const fs = memoryServiceFs({ [XML]: EXACT_XML, [WINSW_BIN]: 'winsw v2.12.0' });
      const { calls, run } = recording(fs, scState('1  STOPPED'));
      const lifecycle = createWinswLifecycle(def(), { run, fs });

      expect((await lifecycle.inspect()).state).toBe('repairable');
      await expect(lifecycle.repair()).resolves.toEqual({ status: 'repaired' });

      expect(calls).toEqual(['sc.exe query Acme-Agent-', `copy ${WINSW_BIN} -> ${EXE}`, `${EXE} install`, `${EXE} start`]);
      expect(fs.files.get(EXE)).toBe('winsw v2.12.0');
      expect((await lifecycle.inspect()).state).toBe('exact');
    });

    it('a wrapper exe whose bytes differ under an exact descriptor is repairable; while the SCM runs it, stopwait goes first', async () => {
      const fs = memoryServiceFs({ [XML]: EXACT_XML, [EXE]: 'winsw v2.11.0', [WINSW_BIN]: 'winsw v2.12.0' });
      const { calls, run } = recording(fs, scState('4  RUNNING'));
      const lifecycle = createWinswLifecycle(def(), { run, fs });

      expect((await lifecycle.inspect()).state).toBe('repairable');
      await expect(lifecycle.repair()).resolves.toEqual({ status: 'repaired' });

      expect(calls).toEqual(['sc.exe query Acme-Agent-', `${EXE} stopwait`, `copy ${WINSW_BIN} -> ${EXE}`, `${EXE} install`, `${EXE} start`]);
      expect((await lifecycle.inspect()).state).toBe('exact');
    });

    it.each([
      ['stopped', scState('1  STOPPED')],
      ['not installed (1060)', NOT_INSTALLED],
    ])('a missing wrapper exe under a drifted descriptor: %s, the exe is copied before anything runs it', async (_name, sc) => {
      const fs = memoryServiceFs({ [XML]: DRIFTED_MARKED_UNIT, [WINSW_BIN]: 'winsw v2.12.0' });
      const { calls, run } = recording(fs, sc);

      await expect(createWinswLifecycle(def(), { run, fs }).repair()).resolves.toEqual({ status: 'repaired' });

      expect(calls).toEqual(['sc.exe query Acme-Agent-', `copy ${WINSW_BIN} -> ${EXE}`, `${EXE} install`, `${EXE} start`]);
      expect(fs.files.get(XML)).toBe(EXACT_XML);
    });

    it('a stopped service with a corrupt wrapper exe never runs that exe: it is replaced first', async () => {
      const fs = memoryServiceFs({ [XML]: EXACT_XML, [EXE]: 'MZ', [WINSW_BIN]: 'winsw v2.12.0' });
      const { calls, run } = recording(fs, scState('1  STOPPED'));

      await expect(createWinswLifecycle(def(), { run, fs }).repair()).resolves.toEqual({ status: 'repaired' });

      expect(calls).toEqual(['sc.exe query Acme-Agent-', `copy ${WINSW_BIN} -> ${EXE}`, `${EXE} install`, `${EXE} start`]);
      expect(fs.files.get(EXE)).toBe('winsw v2.12.0');
    });

    it.each([
      ['missing', 'running', scState('4  RUNNING')],
      ['missing', 'start pending', scState('2  START_PENDING')],
      ['missing', 'stop pending', scState('3  STOP_PENDING')],
      ['missing', 'paused', scState('7  PAUSED')],
      ['missing', 'exit 0 without a STATE', ok('SERVICE_NAME: Acme-Agent-')],
      ['missing', 'access denied', fail(5, '[SC] OpenService FAILED 5:\r\n\r\nAccess is denied.', '')],
      ['missing', '1060 with access denied', fail(1060, '', 'Access is denied.')],
      ['missing', 'an unknown failure', fail(1, '', 'boom')],
      ['differing', 'stop pending', scState('3  STOP_PENDING')],
      ['differing', 'paused', scState('7  PAUSED')],
      ['differing', 'exit 0 without a STATE', ok('')],
      ['differing', 'access denied', fail(5, '', 'Access is denied.')],
    ])('a %s wrapper exe while the SCM reports %s fails closed: nothing is written, copied or activated', async (wrapper, _state, sc) => {
      const fs = memoryServiceFs({ [XML]: DRIFTED_MARKED_UNIT, [WINSW_BIN]: 'winsw v2.12.0', ...(wrapper === 'differing' ? { [EXE]: 'winsw v2.11.0' } : {}) });
      const { calls, run } = recording(fs, sc);

      await expect(createWinswLifecycle(def(), { run, fs }).repair()).rejects.toThrow(/must be stopped in the Service Control Manager before repair/);

      expect(calls).toEqual(['sc.exe query Acme-Agent-']);
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(fs.files.get(XML)).toBe(DRIFTED_MARKED_UNIT);
    });

    it('an exact descriptor and an identical wrapper exe are exact: repair is not needed and runs nothing', async () => {
      const fs = memoryServiceFs({ [XML]: EXACT_XML, [EXE]: 'winsw v2.12.0', [WINSW_BIN]: 'winsw v2.12.0' });
      const run = vi.fn<Runner>().mockResolvedValue(ok());
      const lifecycle = createWinswLifecycle(def(), { run, fs });

      expect((await lifecycle.inspect()).state).toBe('exact');
      await expect(lifecycle.repair()).resolves.toEqual({ status: 'not-needed', state: 'exact' });
      expect(run).not.toHaveBeenCalled();
      expect(fs.copyFile).not.toHaveBeenCalled();
    });

    it.each([
      ['the installed wrapper exe', EXE],
      ['the winswBin source', WINSW_BIN],
    ])('a read error other than ENOENT on %s propagates from inspect and repair', async (_name, unreadable) => {
      const fs = memoryServiceFs({ [XML]: DRIFTED_MARKED_UNIT, [EXE]: 'winsw v2.12.0', [WINSW_BIN]: 'winsw v2.12.0' });
      const read = fs.readFile.getMockImplementation()!;
      fs.readFile.mockImplementation(async (file: string) => {
        if (file === unreadable) throw eacces(file);
        return read(file);
      });
      const run = vi.fn<Runner>().mockResolvedValue(ok());
      const lifecycle = createWinswLifecycle(def(), { run, fs });

      fs.files.set(XML, EXACT_XML);
      await expect(lifecycle.inspect()).rejects.toMatchObject({ code: 'EACCES' });
      fs.files.set(XML, DRIFTED_MARKED_UNIT);
      await expect(lifecycle.repair()).rejects.toMatchObject({ code: 'EACCES' });
      expect(run).not.toHaveBeenCalled();
      expect(fs.copyFile).not.toHaveBeenCalled();
      expect(fs.files.get(XML)).toBe(DRIFTED_MARKED_UNIT);
    });
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
    const fs = installedFs();
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
    const fs = installedFs();
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
    const fs = installedFs();
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
    const fs = installedFs();
    const run = vi.fn<Runner>().mockResolvedValue(fail(5, '', 'Access is denied.'));
    const lifecycle = createWinswLifecycle(def(), { run, fs });

    const status = await lifecycle.status();
    expect(status.running).toBe(false);
    expect(status.determinate).toBe(false);
  });
});
