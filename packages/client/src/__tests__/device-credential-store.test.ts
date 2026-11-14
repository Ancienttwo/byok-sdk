import { spawn as nodeSpawn } from 'node:child_process';
import { inspect } from 'node:util';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { testScratchRoot } from './fixtures/execution-scratch';
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
  OsCredentialEntry,
  type DeviceCommandRunner,
  type FirstPairingAttempt,
  runDeviceCommand,
} from '../daemon/device-credential-store';
import type { Win32CredentialBindings, Win32CredentialCallback, Win32CredentialWrite } from '../daemon/win32-credential-api';

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

/** advapi32 for a POSIX host. While `hold` is set, a call waits in `held` for the test to return it. */
function fakeCredentialApi() {
  const entries = new Map<string, string>();
  const written: Win32CredentialWrite[] = [];
  const landed: string[] = [];
  const freed: bigint[] = [];
  const held: Array<() => void> = [];
  const state = { hold: false, nativeCalls: 0, lastError: 0, failWith: 0, blob: '' };
  const call = (run: () => number, done: Win32CredentialCallback): void => {
    state.nativeCalls += 1;
    const finish = (): void => {
      const code = state.failWith || run();
      state.lastError = code;
      done(null, code === 0 ? 1 : 0);
    };
    if (state.hold) held.push(finish);
    else setImmediate(finish);
  };
  const bindings: Win32CredentialBindings = {
    credRead: (target, _type, _flags, credential, done) => call(() => {
      const value = entries.get(target);
      if (value === undefined) return 1168;
      state.blob = value;
      credential[0] = 1n;
      return 0;
    }, done),
    credWrite: (credential, _flags, done) => {
      written.push(credential);
      call(() => {
        const value = credential.CredentialBlob.toString('utf8');
        entries.set(credential.TargetName, value);
        landed.push(value);
        return 0;
      }, done);
    },
    credDelete: (target, _type, _flags, done) => call(() => (entries.delete(target) ? 0 : 1168), done),
    credFree: (credential) => { freed.push(credential); },
    getLastError: () => state.lastError,
    readBlob: () => Buffer.from(state.blob, 'utf8'),
  };
  return { bindings, entries, written, landed, freed, held, state };
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

  it.each(['darwin', 'linux'] as const)('uses only the %s OS provider and never a path fallback', async (platform) => {
    const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
    const run: DeviceCommandRunner = async (executable, args, stdin) => {
      calls.push({ executable, args, stdin });
      if (args[0] === 'find-generic-password' || args[0] === 'lookup') {
        return { exitCode: 44, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform, commandRunner: run });
    await store.replace(credentials);
    expect(calls).toHaveLength(2);
    expect(calls.flatMap((call) => call.args).join(' ')).not.toMatch(/device\.json|tmp|cache/i);
    expect(JSON.stringify(calls)).not.toContain(credentials.accessToken);
    expect(JSON.stringify(calls)).not.toContain(credentials.devicePrivateKeyPem);
  });

  it.each(['read', 'replace', 'delete'] as const)('#2184 maps provider %s start failures to typed unavailability with sanitized code', async operation => {
    const canary = 'private-spawn-canary';
    const raw = Object.assign(new Error(canary), { code: 'EACCES', path: canary, spawnargs: [canary], env: { SECRET: canary }, cwd: canary, cause: new Error(canary) });
    expect(inspect(raw, { showHidden: true, depth: null })).toContain(canary);
    const run = vi.fn<DeviceCommandRunner>().mockRejectedValue(raw);
    const entry = new OsCredentialEntry({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'linux', commandRunner: run, account: 'test', label: 'test', subject: 'test' });
    const failure = await (operation === 'replace' ? entry.replace('value') : entry[operation]()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeviceCredentialStoreUnavailableError);
    expect(failure).toMatchObject({ cause: { code: 'EACCES', message: 'spawn failed: EACCES' } });
    expect(inspect(failure, { showHidden: true, depth: null })).not.toContain(canary);
    run.mockResolvedValue({ exitCode: 127, stdout: '', stderr: '' });
    const exited = await (operation === 'replace' ? entry.replace('value') : entry[operation]()).catch((error: unknown) => error);
    expect(exited).toBeInstanceOf(DeviceCredentialStoreError);
    expect(exited).not.toBeInstanceOf(DeviceCredentialStoreUnavailableError);
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

  it('does not echo unowned provider stderr into the error', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'credential operation failed: secret-bearing unexpected output',
    });
    const store = new DeviceCredentialStore({ storeDir: testScratchRoot(), productId: 'credential-store-test', platform: 'linux', commandRunner: run });
    await expect(store.read()).rejects.toThrow(
      'operating-system credential provider could not read device credentials',
    );
    await expect(store.read()).rejects.not.toThrow(/secret-bearing/u);
  });
});

describe('replacement pairing credential authority', () => {
  const attempt: FirstPairingAttempt = {
    kind: 'first-pairing-attempt-v1', deviceName: 'replacement', devicePublicKey: 'replacement-public-key',
    devicePrivateKeyPem: 'replacement-private-key', machineId: 'replacement-machine', storeIdentity: 'a'.repeat(64),
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
  it.runIf(process.platform !== 'win32')('#2184 preserves signal termination as a distinct outcome', async () => {
    await expect(runDeviceCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']))
      .resolves.toEqual({ exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' });
  });
  it('#2184 returns a real exit 127 and rejects missing trusted tools with a fixed code', async () => {
    await expect(runDeviceCommand(process.execPath, ['-e', 'process.exit(127)']))
      .resolves.toEqual({ exitCode: 127, stdout: '', stderr: '' });
    await expect(runDeviceCommand('private-spawn-canary', []))
      .rejects.toMatchObject({ code: 'SYSTEM_TOOL_UNAVAILABLE', message: 'spawn failed: SYSTEM_TOOL_UNAVAILABLE' });
  });
  it('#2184 refuses NUL input before spawn with a slot-only diagnostic', async () => {
    vi.mocked(nodeSpawn).mockClear();
    await expect(runDeviceCommand(process.execPath, ['private-spawn-canary\0'])).rejects.toThrow('spawn argument 0 contains a NUL byte');
    expect(nodeSpawn).not.toHaveBeenCalled();
  });

  it.each(['sync', 'async'])('#2184 sanitizes %s start failures and retains classification codes', async mode => {
    for (const code of ['ENOENT', 'EACCES', undefined]) {
      const canary = 'private-spawn-canary';
      const raw = Object.assign(new Error(canary), { code, path: canary, spawnargs: [canary], env: { SECRET: canary }, cwd: canary, cause: new Error(canary) });
      expect(inspect(raw, { showHidden: true, depth: null })).toContain(canary);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      vi.mocked(nodeSpawn).mockImplementationOnce(() => {
        if (mode === 'sync') throw raw;
        queueMicrotask(() => { child.emit('error', raw); child.emit('close', null); });
        return child as unknown as ReturnType<typeof nodeSpawn>;
      });
      const failure = await runDeviceCommand(process.execPath, []).catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: `spawn failed: ${code ?? 'unknown'}`, code });
      expect(inspect(failure, { showHidden: true, depth: null })).not.toContain(canary);
      for (const key of ['path', 'spawnargs', 'env', 'cwd', 'cause']) expect(failure).not.toHaveProperty(key);
    }
  });

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

describe('Windows Credential Manager through the native API', () => {
  const options = { storeDir: 'unused', productId: 'credential-store-test', platform: 'win32' } as const;
  const entry = (api: ReturnType<typeof fakeCredentialApi>, commandDeadlineMs?: number): OsCredentialEntry => new OsCredentialEntry({
    ...options, windowsCredentialBindings: api.bindings, account: 'test-entry', label: 'test', subject: 'test values',
    ...(commandDeadlineMs === undefined ? {} : { commandDeadlineMs }),
  });

  it('round-trips the unchanged entry format, frees each read and clears each written buffer', async () => {
    const api = fakeCredentialApi();
    const store = new DeviceCredentialStore({ ...options, windowsCredentialBindings: api.bindings });

    await expect(store.read()).resolves.toBeUndefined();
    await store.replace(credentials);
    await expect(store.read()).resolves.toEqual(credentials);
    await expect(store.clear()).resolves.toBe(true);

    expect(api.written).toHaveLength(1);
    expect(api.written[0]).toMatchObject({
      Type: 1, Persist: 2, UserName: 'device-enrollment',
      TargetName: expect.stringMatching(/^com\.byok\.client\.device\.[0-9a-f]{64}$/u),
      CredentialBlobSize: api.written[0]!.CredentialBlob.length,
    });
    expect(api.written[0]!.CredentialBlob.every((byte) => byte === 0)).toBe(true);
    expect(api.freed).toHaveLength(2);
  });

  it('maps a missing entry to absent on read and delete, and any other code to its bounded diagnostic', async () => {
    const api = fakeCredentialApi();
    await expect(entry(api).read()).resolves.toBeUndefined();
    await expect(entry(api).delete()).resolves.toBeUndefined();

    api.state.failWith = 1312;
    await expect(entry(api).read()).rejects.toThrow('could not read test values (win32=1312)');
    api.state.failWith = 1168;
    await expect(entry(api).replace('value')).rejects.toThrow('could not replace test values (win32=1168)');
  });

  it('ends a native call past its deadline, and still clears and frees on its late return', async () => {
    const api = fakeCredentialApi();
    api.state.hold = true;
    await expect(entry(api, 20).replace('secret')).rejects.toMatchObject({ reason: 'deadline' });
    const write = api.written[0]!;
    expect(write.CredentialBlob.toString('utf8')).toBe('secret');
    api.held.shift()!();
    await vi.waitFor(() => expect(write.CredentialBlob.every((byte) => byte === 0)).toBe(true));

    const target = write.TargetName;
    await expect(entry(api, 20).read()).rejects.toMatchObject({ reason: 'deadline' });
    await vi.waitFor(() => expect(api.held).toHaveLength(1));
    expect(api.entries.get(target)).toBe('secret');
    api.held.shift()!();
    await vi.waitFor(() => expect(api.freed).toEqual([1n]));
  });

  it('cancels before and during a native call', async () => {
    const api = fakeCredentialApi();
    const before = new AbortController();
    before.abort();
    await expect(entry(api).read(before.signal)).rejects.toMatchObject({ reason: 'cancelled' });
    expect(api.state.nativeCalls).toBe(0);

    api.state.hold = true;
    const during = new AbortController();
    const read = entry(api).read(during.signal);
    await vi.waitFor(() => expect(api.held).toHaveLength(1));
    during.abort();
    await expect(read).rejects.toMatchObject({ reason: 'cancelled' });
    api.held.shift()!();
  });

  it('never lands a late old write after a newer one, and the wait spends the caller deadline', async () => {
    const api = fakeCredentialApi();
    api.state.hold = true;
    await expect(entry(api, 20).replace('old')).rejects.toMatchObject({ reason: 'deadline' });

    await expect(entry(api, 20).read()).rejects.toMatchObject({ reason: 'deadline' });
    const newer = entry(api).replace('new');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(api.state.nativeCalls).toBe(1);

    api.state.hold = false;
    api.held.shift()!();
    await newer;

    expect(api.landed).toEqual(['old', 'new']);
    expect(api.state.nativeCalls).toBe(2);
  });

  it('reports invalid SDK native assets as an unavailable provider', async () => {
    const store = new DeviceCredentialStore({ ...options, nativeAssetRoot: path.join(os.tmpdir(), 'byok-no-native-assets') });
    await expect(store.read()).rejects.toBeInstanceOf(DeviceCredentialStoreUnavailableError);
  });
});
