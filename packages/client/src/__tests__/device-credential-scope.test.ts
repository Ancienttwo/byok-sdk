import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeviceStore } from '../daemon/store';
import { DeviceCredentialStore } from '../daemon/device-credential-store';
import type { DeviceCommandRunner } from '../util/system-command';
import { exportPrivateKeyPem, generateDeviceKeyPair } from '../daemon/device-keys';

describe('device credential identity', () => {
  it('shares product credentials across metadata directories and isolates other products', async () => {
    // Fake the OS command boundary, not product/backend selection. The real
    // store derives the service identity; the provider just holds its bytes.
    const entries = new Map<string, string>();
    const run: DeviceCommandRunner = async (_executable, args, stdin) => {
      if (args[0] === '-i') {
        const service = / -s "([^"]+)"/u.exec(stdin!)?.[1];
        const value = / -w "([^"]+)"/u.exec(stdin!)?.[1];
        if (service === undefined || value === undefined) throw new Error('invalid fixture command');
        entries.set(service, value);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      const service = args[args.indexOf('-s') + 1]!;
      if (args[0] === 'delete-generic-password') entries.delete(service);
      return { exitCode: args[0] === 'find-generic-password' && !entries.has(service) ? 44 : 0,
        stdout: entries.get(service) ?? '', stderr: '' };
    };
    const store = (storeDir: string, productId: string) => new DeviceStore(productId, storeDir,
      new DeviceCredentialStore({ storeDir, productId, platform: 'darwin', commandRunner: run }));
    const productId = randomUUID();
    const first = store('/unused/first', productId);
    const second = store('/unused/second', productId);
    const other = store('/unused/first', randomUUID());
    const keys = generateDeviceKeyPair();
    const record = { deviceId: 'device', tenantId: 'tenant',
      devicePublicKey: keys.publicKeyBase64Url, devicePrivateKeyPem: exportPrivateKeyPem(keys.privateKey) };
    try {
      await first.credentials.replace(record);
      expect(await second.credentials.read()).toEqual(record);
      expect(await other.credentials.read()).toBeUndefined();
      await second.credentials.clear();
      expect(await first.credentials.read()).toBeUndefined();
    } finally {
      await first.credentials.clear();
    }
  });
});
