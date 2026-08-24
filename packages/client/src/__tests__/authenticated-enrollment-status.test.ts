import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDeviceEnrollmentStatus } from '../index';
import { DeviceStore } from '../daemon/store';
import { seedDeviceEnrollment } from './fixtures/device-enrollment';

const roots: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('credential-blind authenticated enrollment status', () => {
  it('distinguishes missing, complete and legacy-invalid records without projecting credentials', async () => {
    const storeDir = await tmpDir('byok-enrollment-status-');
    const options = { productId: 'status-test', storeDir };
    expect(await readDeviceEnrollmentStatus(options)).toEqual({ state: 'unpaired' });

    const record = {
      deviceId: 'device-status',
      tenantId: 'tenant-status',
      accessToken: 'secret-access-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
      devicePrivateKeyPem: 'secret-private-key',
      devicePublicKey: 'public-key',
    };
    await seedDeviceEnrollment(new DeviceStore(storeDir, undefined, options.productId), record);

    const paired = await readDeviceEnrollmentStatus(options);
    expect(paired).toEqual({ state: 'paired', deviceId: 'device-status' });
    expect(JSON.stringify(paired)).not.toContain(record.tenantId);
    expect(JSON.stringify(paired)).not.toContain(record.accessToken);
    expect(JSON.stringify(paired)).not.toContain(record.devicePrivateKeyPem);

    await new DeviceStore(storeDir, undefined, options.productId).credentials.clear();
    expect(await readDeviceEnrollmentStatus(options)).toEqual({ state: 're_pair_required' });

    await fs.writeFile(path.join(storeDir, 'device.json'), JSON.stringify({
      deviceId: 'legacy-device',
      accessToken: 'legacy-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
      devicePrivateKeyPem: 'legacy-private-key',
      devicePublicKey: 'legacy-public-key',
    }));
    expect(await readDeviceEnrollmentStatus(options)).toEqual({ state: 're_pair_required' });
  });

  it('does not collapse unsafe filesystem state into a pairing status', async () => {
    const storeDir = await tmpDir('byok-enrollment-status-unsafe-');
    await fs.mkdir(path.join(storeDir, 'device.json'));

    await expect(readDeviceEnrollmentStatus({ productId: 'status-test', storeDir }))
      .rejects.toThrow('not a real regular file');
  });
});
