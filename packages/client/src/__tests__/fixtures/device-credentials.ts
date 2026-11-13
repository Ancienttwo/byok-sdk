import { randomUUID } from 'node:crypto';
import { InMemoryDeviceCredentialBackend, testDeviceCredentials } from './credential-backend';
import { DeviceStore } from '../../daemon/store';
import type { EnsureSecureDirOptions } from '../../util/secure-dir';

export { InMemoryDeviceCredentialBackend, testDeviceCredentials };

/** Metadata/auth unit fixtures explicitly own their injected custody. */
export function createTestDeviceStore(storeDir: string, secureDirOptions?: EnsureSecureDirOptions, productId?: string): DeviceStore {
  return new DeviceStore(productId ?? `test-${randomUUID()}`, storeDir, productId === undefined ? new InMemoryDeviceCredentialBackend() : testDeviceCredentials(productId), secureDirOptions);
}
