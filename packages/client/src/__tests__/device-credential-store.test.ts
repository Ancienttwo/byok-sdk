import { describe, expect, it, vi } from 'vitest';
import {
  DeviceCredentialStore,
  DeviceCredentialStoreError,
  DeviceCredentialStoreUnavailableError,
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

describe('DeviceCredentialStore', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('uses only the %s OS provider and never a path fallback', async (platform) => {
    const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
    const run: DeviceCommandRunner = async (executable, args, stdin) => {
      calls.push({ executable, args, stdin });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform, commandRunner: run });
    await store.replace(credentials);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.join(' ')).not.toMatch(/device\.json|tmp|cache/i);
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
    const run: DeviceCommandRunner = async (_executable, _args, stdin) => {
      const request = JSON.parse(stdin ?? '{}') as {
        operation?: string;
        secret_base64?: string;
      };
      if (request.operation === 'replace') {
        stored = Buffer.from(request.secret_base64 ?? '', 'base64').toString('utf8');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (request.operation === 'read') {
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

  it('does not classify a Linux provider error as a missing credential', async () => {
    const run = vi.fn<DeviceCommandRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'secret service is unavailable',
    });
    const store = new DeviceCredentialStore({ productId: 'credential-store-test', platform: 'linux', commandRunner: run });
    await expect(store.read()).rejects.toBeInstanceOf(DeviceCredentialStoreError);
  });
});
