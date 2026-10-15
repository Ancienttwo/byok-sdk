import { describe, expect, it, vi } from 'vitest';
import { DeviceCredentialStore, DeviceCredentialStoreError } from '../daemon/device-credential-store';
import { readDeviceEnrollmentStatus } from '../daemon/store';
import { DeviceStore } from '../daemon/store';

const record = {
  deviceId: 'isolated-device', tenantId: 'isolated-tenant', devicePublicKey: 'public',
  accessToken: 'synthetic-token', expiresAt: '2030-01-01T00:00:00.000Z', devicePrivateKeyPem: 'private',
};
const encoded = `byok-device-credential-v1:${Buffer.from(JSON.stringify(record)).toString('base64')}`;
const keychain = '/tmp/keychain with "quotes"\\and spaces.keychain-db';

describe('explicit macOS device credential custody', () => {
  it.each([null, true, 'unexpected'])('refuses malformed custody configuration %j instead of composing default custody', async (deviceCredentials) => {
    const { createDeviceCredentialStore } = await vi.importActual<typeof import('../daemon/device-credential-provider')>('../daemon/device-credential-provider');
    expect(() => createDeviceCredentialStore({ productId: 'isolated', storeDir: '/unused',
      deviceCredentials: deviceCredentials as never })).toThrow(DeviceCredentialStoreError);
  });

  it.each([null, undefined, {}])('requires a complete injected backend: %j', (backend) => {
    expect(() => new DeviceStore('/unused', backend as never)).toThrow(TypeError);
  });

  it('targets the same explicit keychain for read, atomic replace and verified deletion', async () => {
    let value: string | undefined;
    const run = vi.fn(async (_exe: string, args: readonly string[], stdin?: string) => {
      if (args[0] === '-i') value = encoded;
      if (args[0] === 'delete-generic-password') value = undefined;
      return { exitCode: args[0] === 'find-generic-password' && value === undefined ? 44 : 0,
        stdout: args[0] === 'find-generic-password' ? value ?? '' : '', stderr: '' };
    });
    const store = new DeviceCredentialStore({ storeDir: '/unused', productId: 'isolated', platform: 'darwin',
      macosKeychainPath: keychain, commandRunner: run });
    expect(await store.read()).toBeUndefined();
    await store.replace(record);
    expect(await store.read()).toEqual(record);
    expect(await store.clear()).toBe(true);
    for (const [, args] of run.mock.calls) {
      if (args[0] !== '-i') expect(args.at(-1)).toBe(keychain);
    }
    const add = run.mock.calls.find(([, args]) => args[0] === '-i')!;
    expect(add[1]).toEqual(['-i']);
    expect(add[2]).toContain('"/tmp/keychain with \\"quotes\\"\\\\and spaces.keychain-db"');
    expect(add[1].join(' ')).not.toContain('synthetic-token');
  });

  it.each(['read', 'replace', 'clear'] as const)('types interaction-required on %s without leaking provider output', async (operation) => {
    let calls = 0;
    const store = new DeviceCredentialStore({ storeDir: '/unused', productId: 'isolated', platform: 'darwin',
      macosKeychainPath: keychain, commandRunner: async () => {
        calls++;
        if (operation === 'clear' && calls === 1) return { exitCode: 0, stdout: encoded, stderr: '' };
        return { exitCode: 36, stdout: '', stderr: 'User interaction is not allowed. SECRET_SENTINEL' };
      } });
    const result = operation === 'replace' ? store.replace(record) : store[operation]();
    const error: unknown = await result.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DeviceCredentialStoreError);
    expect(error).toMatchObject({ name: 'DeviceCredentialInteractionRequiredError' });
    expect(String(error)).toContain('keychain');
    expect(String(error)).not.toContain('SECRET_SENTINEL');
  });

  it.each(['', 'relative.keychain-db', '/tmp/a\nkeychain', '/tmp/a\0keychain'])('rejects invalid explicit path %j before any command', (macosKeychainPath) => {
    const run = vi.fn();
    expect(() => new DeviceCredentialStore({ storeDir: '/unused', productId: 'isolated', platform: 'darwin', macosKeychainPath, commandRunner: run })).toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a macOS path on another platform', () => {
    expect(() => new DeviceCredentialStore({ storeDir: '/unused', productId: 'isolated', platform: 'linux', macosKeychainPath: keychain })).toThrow();
  });

  it('refuses a nested keychain accessor before executing host code or accessing custody', async () => {
    const getter = vi.fn(() => '/tmp/test.keychain-db');
    const deviceCredentials = Object.defineProperty({}, 'macosKeychainPath', { get: getter, enumerable: true });
    await expect(readDeviceEnrollmentStatus({ productId: 'isolated', deviceCredentials })).rejects.toBeInstanceOf(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it('keeps exit 36 platform-specific', async () => {
    const store = new DeviceCredentialStore({ storeDir: '/unused', productId: 'isolated', platform: 'linux',
      commandRunner: async () => ({ exitCode: 36, stdout: '', stderr: 'SENTINEL' }) });
    await expect(store.read()).rejects.toMatchObject({ name: 'DeviceCredentialStoreError' });
  });
});
