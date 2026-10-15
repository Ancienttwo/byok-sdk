import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeviceStore } from '../daemon/store';
import { DeviceCredentialStore, type DeviceCommandRunner } from '../daemon/device-credential-store';

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
    const store = (storeDir: string, productId: string) => new DeviceStore(storeDir,
      new DeviceCredentialStore({ storeDir, productId, platform: 'darwin', commandRunner: run }));
    const productId = randomUUID();
    const first = store('/unused/first', productId);
    const second = store('/unused/second', productId);
    const other = store('/unused/first', randomUUID());
    const record = { deviceId: 'device', tenantId: 'tenant', devicePublicKey: 'public',
      accessToken: 'token', expiresAt: '2030-01-01T00:00:00.000Z', devicePrivateKeyPem: 'private' };
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
