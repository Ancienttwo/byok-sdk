import { InMemoryDeviceCredentialStore, testDeviceCredentials } from './credential-backend';
import { DeviceStore } from '../../daemon/store';
import type { EnsureSecureDirOptions } from '../../util/secure-dir';

export { InMemoryDeviceCredentialStore, testDeviceCredentials };

/** Metadata/auth unit fixtures explicitly own their injected custody. */
export function createTestDeviceStore(storeDir: string, secureDirOptions?: EnsureSecureDirOptions, productId?: string): DeviceStore {
  return new DeviceStore(storeDir, productId === undefined ? new InMemoryDeviceCredentialStore() : testDeviceCredentials(productId), secureDirOptions);
}
