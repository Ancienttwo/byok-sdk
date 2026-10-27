import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createTestKeychain } from '../../../../scripts/testing/macos-keychain.mjs';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { readDeviceEnrollmentIdentity, readDeviceEnrollmentStatus } from '../daemon/store';
import { createStoredDeviceProofSigner } from '../daemon/device-proof-signer';
import { repairDeviceEnrollmentMetadata } from '../diagnostics/device-doctor';
import { TestServer } from './fixtures/test-server';
import { testScratchRoot } from './fixtures/execution-scratch';

vi.unmock('../daemon/device-credential-provider');

it.runIf(process.platform === 'darwin')('shares explicit custody across pair, cold reads, proof signing, repair and unpair', async () => {
  const keychain = await createTestKeychain();
  const other = await createTestKeychain();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-keychain-composition-'));
  const server = await TestServer.start();
  const config = {
    productId: randomUUID(), productName: 'Keychain isolation', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: server.url, storeDir: root,
    storage: { scratchRoot: testScratchRoot() }, deviceCredentials: { macosKeychainPath: keychain.path },
  };
  const daemon = createDaemonWithAdapters(config, []);
  try {
    expect(await readDeviceEnrollmentStatus(config)).toEqual({ state: 'unpaired' });
    const paired = await daemon.pair('pairing-code');
    expect(await readDeviceEnrollmentStatus(config)).toEqual({ state: 'paired', deviceId: paired.deviceId });
    const identity = await readDeviceEnrollmentIdentity(config);
    expect(identity.state).toBe('paired');
    if (identity.state !== 'paired') throw new Error('missing paired identity');
    const signer = createStoredDeviceProofSigner({ ...config, identity, operations: ['test-operation'] });
    const proof = await signer.sign({ method: 'POST', path: '/test', operation: 'test-operation',
      resource: 'test-resource', requestId: randomUUID(), body: new Uint8Array() });
    expect(proof).toBeDefined();
    expect(await readDeviceEnrollmentStatus({ ...config, deviceCredentials: { macosKeychainPath: other.path } })).toEqual({ state: 're_pair_required' });
    await fs.unlink(path.join(root, 'device.json'));
    expect(await repairDeviceEnrollmentMetadata(config, { confirmed: true, expectedDeviceId: identity.deviceId,
      expectedTenantId: identity.tenantId })).toMatchObject({ status: 'repaired' });
    await daemon.unpair();
    expect(await readDeviceEnrollmentStatus(config)).toEqual({ state: 'unpaired' });
  } finally {
    await daemon.stop();
    await server.close();
    await Promise.all([keychain.dispose(), other.dispose()]);
    await fs.rm(root, { recursive: true, force: true });
  }
});
