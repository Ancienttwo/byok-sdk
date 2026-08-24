import { describe, expect, it, vi } from 'vitest';
import {
  DeviceCredentialStore,
  DeviceCredentialStoreUnavailableError,
  type DeviceCommandRunner,
} from '../daemon/device-credential-store';

const credentials = {
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
});
