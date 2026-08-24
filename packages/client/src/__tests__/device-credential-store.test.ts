import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceCredentialStore,
  DeviceCredentialStoreError,
  DeviceCredentialStoreUnavailableError,
  type DeviceCommandResult,
  type DeviceCommandRunner,
} from '../daemon/device-credential-store';

const credentials = {
  deviceId: 'device-credential-test',
  tenantId: 'tenant-credential-test',
  devicePublicKey: 'test-public-key',
  accessToken: 'opaque-token',
  expiresAt: '2030-01-01T00:00:00.000Z',
  devicePrivateKeyPem: 'test-private-key',
} as const;

function windowsRunner(result: DeviceCommandResult): DeviceCommandRunner {
  return async (executable) => executable === 'powershell.exe'
    ? { exitCode: 0, stdout: '', stderr: '' }
    : result;
}

describe('DeviceCredentialStore', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('uses only the %s OS provider and never a path fallback', async (platform) => {
    const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
    const run: DeviceCommandRunner = async (executable, args, stdin) => {
      calls.push({ executable, args, stdin });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform, commandRunner: run });
    await store.replace(credentials);
    expect(calls).toHaveLength(platform === 'win32' ? 2 : 1);
    expect(calls.flatMap((call) => call.args).join(' ')).not.toMatch(/device\.json|tmp|cache/i);
    expect(JSON.stringify(calls)).not.toContain(credentials.accessToken);
    expect(JSON.stringify(calls)).not.toContain(credentials.devicePrivateKeyPem);
  });

  it('fails closed with a typed error when the OS provider is unavailable', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockResolvedValue({ exitCode: 127, stdout: '', stderr: 'not found' });
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform: 'linux', commandRunner: run });
    await expect(store.read()).rejects.toBeInstanceOf(DeviceCredentialStoreUnavailableError);
    await expect(store.replace(credentials)).rejects.toBeInstanceOf(DeviceCredentialStoreUnavailableError);
  });

  it('round-trips the Windows Credential Manager UTF-8 blob without a second base64 layer', async () => {
    let stored: string | undefined;
    const run: DeviceCommandRunner = async (executable, _args, stdin) => {
      if (executable === 'powershell.exe') return { exitCode: 0, stdout: '', stderr: '' };
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
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform: 'win32', commandRunner: run });
    await store.replace(credentials);
    await expect(store.read()).resolves.toEqual(credentials);
  });

  it('keeps Windows return-code ownership inside the native bridge process', async () => {
    let script = '';
    let compiledExecutable = '';
    let invokedExecutable = '';
    const run: DeviceCommandRunner = async (executable, args, stdin) => {
      if (executable === 'powershell.exe') {
        script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
        compiledExecutable = stdin ?? '';
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      invokedExecutable = executable;
      return { exitCode: 44, stdout: '', stderr: '' };
    };
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform: 'win32', commandRunner: run });

    await expect(store.read()).resolves.toBeUndefined();
    expect(script).toContain('-OutputType ConsoleApplication');
    expect(script).toContain('public static int Main()');
    expect(script).not.toMatch(/Environment\.Exit|::Execute|if\(\$code/u);
    expect(invokedExecutable).toBe(compiledExecutable);
    expect(path.basename(invokedExecutable)).toBe('credential-bridge.exe');
    expect(existsSync(path.dirname(invokedExecutable))).toBe(false);
  });

  it('scavenges only stale real Windows bridge directories without following symlinks', async () => {
    const staleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-device-credential-'));
    const symlinkTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-device-credential-symlink-target-'));
    const symlinkPath = path.join(os.tmpdir(), `byok-device-credential-symlink-${process.pid}-${Date.now()}`);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await fs.utimes(staleDirectory, old, old);
    await fs.symlink(symlinkTarget, symlinkPath, 'dir');

    try {
      const store = new DeviceCredentialStore({
        productId: 'credential-store-test',
        platform: 'win32',
        commandRunner: windowsRunner({ exitCode: 44, stdout: '', stderr: '' }),
      });
      await expect(store.read()).resolves.toBeUndefined();
      expect(existsSync(staleDirectory)).toBe(false);
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
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform: 'linux', commandRunner: run });
    await expect(store.read()).rejects.toBeInstanceOf(DeviceCredentialStoreError);
  });

  it('surfaces only a bounded Windows native code from provider stderr', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockImplementation(windowsRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'credential operation failed (win32=1312)',
    }));
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform: 'win32', commandRunner: run });
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
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform: 'win32', commandRunner: run });
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
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform: 'win32', commandRunner: run });
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
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform: 'win32', commandRunner: run });
    await expect(store.read()).rejects.toThrow(
      'operating-system credential provider could not read device credentials',
    );
    await expect(store.read()).rejects.not.toThrow(/secret-bearing/u);
  });
});
