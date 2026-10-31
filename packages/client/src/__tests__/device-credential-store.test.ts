import { testScratchRoot } from './fixtures/execution-scratch';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceCredentialCommandAbortedError,
  DeviceCredentialStore,
  DeviceCredentialStoreError,
  DeviceCredentialStoreUnavailableError,
  OS_CREDENTIAL_ENTRY_MAX_BYTES,
  type DeviceCommandResult,
  type DeviceCommandRunner,
  type FirstPairingAttempt,
  runDeviceCommand,
} from '../daemon/device-credential-store';

const credentials = {
  deviceId: 'device-credential-test',
  tenantId: 'tenant-credential-test',
  devicePublicKey: 'test-public-key',
  accessToken: 'opaque-token',
  expiresAt: '2030-01-01T00:00:00.000Z',
  devicePrivateKeyPem: 'test-private-key',
} as const;

const nativeTemporaryRoot = os.tmpdir();
let suiteTemporaryRoot = '';

function windowsRunner(result: DeviceCommandResult): DeviceCommandRunner {
  return async (executable) => path.win32.basename(executable).toLowerCase() === 'powershell.exe'
    ? { exitCode: 0, stdout: '', stderr: '' }
    : result;
}

describe('DeviceCredentialStore', () => {
  beforeAll(async () => {
    suiteTemporaryRoot = await fs.mkdtemp(path.join(nativeTemporaryRoot, 'byok-device-credential-suite-'));
  });

  beforeEach(() => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.stubEnv('TMPDIR', suiteTemporaryRoot);
    vi.stubEnv('TMP', suiteTemporaryRoot);
    vi.stubEnv('TEMP', suiteTemporaryRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await fs.rm(suiteTemporaryRoot, { recursive: true, force: true });
  });

  it.each(['darwin', 'linux', 'win32'] as const)('uses only the %s OS provider and never a path fallback', async (platform) => {
    const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
    const run: DeviceCommandRunner = async (executable, args, stdin) => {
      calls.push({ executable, args, stdin });
      if (args[0] === 'find-generic-password' || args[0] === 'lookup' || stdin?.startsWith('read\n')) {
        return { exitCode: 44, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform, commandRunner: run });
    await store.replace(credentials);
    expect(calls).toHaveLength(platform === 'win32' ? 4 : 2);
    expect(calls.flatMap((call) => call.args).join(' ')).not.toMatch(/device\.json|tmp|cache/i);
    expect(JSON.stringify(calls)).not.toContain(credentials.accessToken);
    expect(JSON.stringify(calls)).not.toContain(credentials.devicePrivateKeyPem);
  });

  it('fails closed with a typed error when the OS provider is unavailable', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockResolvedValue({ exitCode: 127, stdout: '', stderr: 'not found' });
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'linux', commandRunner: run });
    await expect(store.read()).rejects.toBeInstanceOf(DeviceCredentialStoreUnavailableError);
    await expect(store.replace(credentials)).rejects.toBeInstanceOf(DeviceCredentialStoreUnavailableError);
  });

  it('round-trips the Windows Credential Manager UTF-8 blob without a second base64 layer', async () => {
    let stored: string | undefined;
    const run: DeviceCommandRunner = async (executable, _args, stdin) => {
      if (path.win32.basename(executable).toLowerCase() === 'powershell.exe') return { exitCode: 0, stdout: '', stderr: '' };
      const [operation, _target, _username, secretBase64] = (stdin ?? '').split('\n');
      if (operation === 'replace') {
        stored = Buffer.from(secretBase64 ?? '', 'base64').toString('utf8');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (operation === 'read') {
        return stored === undefined
          ? { exitCode: 44, stdout: '', stderr: '' }
          : { exitCode: 0, stdout: stored, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'win32', commandRunner: run });
    await store.replace(credentials);
    await expect(store.read()).resolves.toEqual(credentials);
  });

  it('keeps Windows return-code ownership inside the native bridge process', async () => {
    let script = '';
    let compiledExecutable = '';
    let invokedExecutable = '';
    const run: DeviceCommandRunner = async (executable, args, stdin) => {
      if (path.win32.basename(executable).toLowerCase() === 'powershell.exe') {
        script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
        compiledExecutable = stdin ?? '';
        expect(executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      invokedExecutable = executable;
      return { exitCode: 44, stdout: '', stderr: '' };
    };
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'win32', commandRunner: run });

    await expect(store.read()).resolves.toBeUndefined();
    expect(script).toContain('-OutputType ConsoleApplication');
    expect(script).toContain('public static int Main()');
    expect(script).toContain('System.Runtime.InteropServices.ComTypes.FILETIME LastWritten');
    expect(script).not.toContain('using System.Runtime.InteropServices.ComTypes');
    expect(script).toContain('TargetObject.ErrorNumber');
    expect(script).not.toMatch(/ErrorText|Exception\.Message|Out-String/u);
    expect(script).not.toMatch(/Environment\.Exit|::Execute|if\(\$code/u);
    expect(invokedExecutable).toBe(compiledExecutable);
    expect(path.basename(invokedExecutable)).toBe('credential-bridge.exe');
    expect(existsSync(path.dirname(invokedExecutable))).toBe(false);
  });

  it('reads the Windows compiler request from stdin as UTF-8, not the console code page', async () => {
    let script = '';
    const run: DeviceCommandRunner = async (executable, args) => {
      if (path.win32.basename(executable).toLowerCase() === 'powershell.exe') {
        script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 44, stdout: '', stderr: '' };
    };
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'win32', commandRunner: run });

    await expect(store.read()).resolves.toBeUndefined();
    expect(script).toContain(
      '$assembly=[System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false, $true)).ReadToEnd()',
    );
    expect(script).not.toContain('[Console]::In');
  });

  it('compiles the Windows credential bridge outside a long store path', async () => {
    // 309 characters: Add-Type/csc fail with CS2021 before the bridge can run
    // when the compiler output sits under this store (#1097).
    const longStore = path.join(suiteTemporaryRoot, ...Array.from({ length: 4 }, () => 'a'.repeat(60)), 'store');
    expect(longStore.length).toBeGreaterThan(300);
    let compiledExecutable = '';
    const run: DeviceCommandRunner = async (executable, _args, stdin) => {
      if (path.win32.basename(executable).toLowerCase() === 'powershell.exe') {
        compiledExecutable = stdin ?? '';
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      expect(executable).toBe(compiledExecutable);
      return { exitCode: 44, stdout: '', stderr: '' };
    };
    const store = new DeviceCredentialStore({ storeDir: longStore, productId: 'credential-store-test', platform: 'win32', commandRunner: run });

    await expect(store.read()).resolves.toBeUndefined();
    expect(compiledExecutable.endsWith(`credential-bridge.exe`)).toBe(true);
    expect(compiledExecutable.length).toBeLessThan(200);
    expect(compiledExecutable.startsWith(longStore)).toBe(false);
  });

  it('leaves legacy OS temp cleanup to the explicit doctor migration', async () => {
    const staleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-device-credential-'));
    const symlinkTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-device-credential-symlink-target-'));
    const symlinkPath = path.join(os.tmpdir(), `byok-device-credential-symlink-${process.pid}-${Date.now()}`);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await fs.utimes(staleDirectory, old, old);
    await fs.symlink(symlinkTarget, symlinkPath, 'dir');

    try {
      const store = new DeviceCredentialStore({ storeDir: testScratchRoot(),
        productId: 'credential-store-test',
        platform: 'win32',
        commandRunner: windowsRunner({ exitCode: 44, stdout: '', stderr: '' }),
      });
      await expect(store.read()).resolves.toBeUndefined();
      expect(existsSync(staleDirectory)).toBe(true);
      expect(existsSync(symlinkPath)).toBe(true);
      expect(existsSync(symlinkTarget)).toBe(true);
    } finally {
      await fs.rm(symlinkPath, { force: true });
      await fs.rm(symlinkTarget, { recursive: true, force: true });
      await fs.rm(staleDirectory, { recursive: true, force: true });
    }
  });

  it('does not classify a Linux provider error as a missing credential', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'secret service is unavailable',
    });
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'linux', commandRunner: run });
    await expect(store.read()).rejects.toBeInstanceOf(DeviceCredentialStoreError);
  });

  it('surfaces only a bounded Windows native code from provider stderr', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockImplementation(windowsRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'credential operation failed (win32=1312)',
    }));
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'win32', commandRunner: run });
    await expect(store.read()).rejects.toThrow(
      'operating-system credential provider could not read device credentials (win32=1312)',
    );
  });

  it('surfaces only a bounded Windows HRESULT when no native code is available', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockImplementation(windowsRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'PowerShell prefix that must not escape\ncredential operation failed (hresult=-2146233087)\nunowned suffix',
    }));
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'win32', commandRunner: run });
    await expect(store.read()).rejects.toThrow(
      'operating-system credential provider could not read device credentials (hresult=-2146233087)',
    );
    await expect(store.read()).rejects.not.toThrow(/PowerShell prefix|unowned suffix/u);
  });

  it('surfaces only bounded numeric bridge stage diagnostics', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockImplementation(windowsRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'unowned prefix\ncredential operation failed (stage=4,kind=2,hresult=-2146233087)\nunowned suffix',
    }));
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'win32', commandRunner: run });
    await expect(store.read()).rejects.toThrow(
      'operating-system credential provider could not read device credentials (stage=4,kind=2,hresult=-2146233087)',
    );
    await expect(store.read()).rejects.not.toThrow(/unowned prefix|unowned suffix/u);
  });

  it('does not echo unowned provider stderr into the error', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockImplementation(windowsRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'credential operation failed: secret-bearing unexpected output',
    }));
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'win32', commandRunner: run });
    await expect(store.read()).rejects.toThrow(
      'operating-system credential provider could not read device credentials',
    );
    await expect(store.read()).rejects.not.toThrow(/secret-bearing/u);
  });
});

describe('replacement pairing credential authority', () => {
  const attempt: FirstPairingAttempt = {
    kind: 'first-pairing-attempt-v1', deviceName: 'replacement', devicePublicKey: 'replacement-public-key',
    devicePrivateKeyPem: 'replacement-private-key', machineId: 'replacement-machine',
  };
  const encoded = (value: unknown): string => `byok-device-credential-v1:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}`;

  function provider(initial?: string) {
    let value = initial;
    let writes = 0;
    const run: DeviceCommandRunner = async (_executable, args, stdin) => {
      if (args[0] === 'lookup') return { exitCode: value === undefined ? 1 : 0, stdout: value ?? '', stderr: '' };
      if (args[0] === 'clear') value = undefined;
      else { value = stdin; writes++; }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const open = () => new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'replacement-test', platform: 'linux', commandRunner: run });
    return { open, value: () => value, writes: () => writes };
  }

  it('keeps first pairing as a standalone attempt and clears it completely', async () => {
    const entry = provider();
    await entry.open().saveFirstPairingAttempt(attempt);
    expect(entry.value()).toBe(encoded(attempt));
    await expect(entry.open().read()).resolves.toBeUndefined();
    await expect(entry.open().readFirstPairingAttempt()).resolves.toEqual(attempt);
    await expect(entry.open().clear()).resolves.toBe(true);
    await expect(entry.open().readFirstPairingAttempt()).resolves.toBeUndefined();
  });

  it('stages both authorities in one entry and keeps the pending key through current enrollment renewal', async () => {
    const entry = provider(encoded(credentials));
    await entry.open().saveFirstPairingAttempt(attempt);
    expect(entry.writes()).toBe(1);
    expect(entry.value()).toBe(encoded({ kind: 'replacement-pairing-attempt-v1', record: credentials, attempt }));
    await expect(entry.open().read()).resolves.toEqual(credentials);
    await expect(entry.open().readFirstPairingAttempt()).resolves.toEqual(attempt);
    const renewed = { ...credentials, accessToken: 'renewed-token', expiresAt: '2031-01-01T00:00:00.000Z' };
    await entry.open().replace(renewed);
    await expect(entry.open().read()).resolves.toEqual(renewed);
    await expect(entry.open().readFirstPairingAttempt()).resolves.toEqual(attempt);
    await expect(entry.open().clear()).resolves.toBe(true);
    await expect(entry.open().read()).resolves.toBeUndefined();
    await expect(entry.open().readFirstPairingAttempt()).resolves.toBeUndefined();
  });

  it.each(['deviceId', 'tenantId', 'devicePublicKey'] as const)('promotes an authenticated enrollment with a different %s', async (field) => {
    const entry = provider(encoded({ kind: 'replacement-pairing-attempt-v1', record: credentials, attempt }));
    const replacement = { ...credentials, [field]: `replacement-${field}` };
    await entry.open().replace(replacement);
    expect(entry.value()).toBe(encoded(replacement));
    await expect(entry.open().read()).resolves.toEqual(replacement);
    await expect(entry.open().readFirstPairingAttempt()).resolves.toBeUndefined();
  });

  it.each([
    { record: undefined, attempt },
    { record: credentials, attempt: undefined },
    { record: { ...credentials, accessToken: '' }, attempt },
    { record: credentials, attempt: { ...attempt, machineId: 1 } },
    { record: { ...credentials, kind: 'first-pairing-attempt-v1' }, attempt },
  ])('rejects a malformed wrapper without exposing or overwriting either member (%#)', async (members) => {
    // Flat fields cannot turn an invalid wrapper into a usable record.
    const raw = encoded({ ...credentials, kind: 'replacement-pairing-attempt-v1', ...members });
    const entry = provider(raw);
    await expect(entry.open().read()).rejects.toBeInstanceOf(DeviceCredentialStoreError);
    await expect(entry.open().readFirstPairingAttempt()).rejects.toBeInstanceOf(DeviceCredentialStoreError);
    await expect(entry.open().replace(credentials)).rejects.toBeInstanceOf(DeviceCredentialStoreError);
    await expect(entry.open().saveFirstPairingAttempt(attempt)).rejects.toBeInstanceOf(DeviceCredentialStoreError);
    expect(entry.writes()).toBe(0);
    expect(entry.value()).toBe(raw);
  });

  it('refuses an oversized combined entry before writing and keeps the current enrollment', async () => {
    const largeRecord = { ...credentials, accessToken: 'a'.repeat(800) };
    const largeAttempt = { ...attempt, devicePrivateKeyPem: 'b'.repeat(700) };
    expect(Buffer.byteLength(encoded(largeRecord))).toBeLessThanOrEqual(OS_CREDENTIAL_ENTRY_MAX_BYTES);
    expect(Buffer.byteLength(encoded(largeAttempt))).toBeLessThanOrEqual(OS_CREDENTIAL_ENTRY_MAX_BYTES);
    expect(Buffer.byteLength(encoded({ kind: 'replacement-pairing-attempt-v1', record: largeRecord, attempt: largeAttempt })))
      .toBeGreaterThan(OS_CREDENTIAL_ENTRY_MAX_BYTES);
    const raw = encoded(largeRecord);
    const entry = provider(raw);
    await expect(entry.open().saveFirstPairingAttempt(largeAttempt)).rejects.toThrow('exceeds the OS credential entry bound');
    expect(entry.writes()).toBe(0);
    expect(entry.value()).toBe(raw);
    await expect(entry.open().read()).resolves.toEqual(largeRecord);
    await expect(entry.open().readFirstPairingAttempt()).resolves.toBeUndefined();
  });
});

describe('#1117 provider command deadline', () => {
  it('kills a hung provider child on abort and rejects without waiting for it', async () => {
    const pidFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-hung-command-')), 'pid');
    const hung = runDeviceCommand(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
      undefined,
      AbortSignal.timeout(1_000),
    );
    const startedAt = performance.now();
    await expect(hung).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(performance.now() - startedAt).toBeLessThan(2_000);

    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })));
  });

  it('a provider read past its deadline is a typed deadline error', async () => {
    const run: DeviceCommandRunner = (_executable, _args, _stdin, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'darwin', commandRunner: run, commandDeadlineMs: 50 });

    const error: unknown = await store.read().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeviceCredentialCommandAbortedError);
    expect(error).toBeInstanceOf(DeviceCredentialStoreError);
    expect(error).toMatchObject({ reason: 'deadline', message: expect.stringMatching(/keychain may be locked/u) });
  });

  it('a caller abort is a typed cancellation, and an already-aborted call spawns nothing', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'linux', commandRunner: run });
    const controller = new AbortController();
    controller.abort();

    await expect(store.replace(credentials, controller.signal)).rejects.toMatchObject({ name: 'DeviceCredentialCommandAbortedError', reason: 'cancelled' });
    expect(run).not.toHaveBeenCalled();
  });
});
