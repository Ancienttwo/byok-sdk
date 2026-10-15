import { InMemoryDeviceCredentialStore } from '../../../../../scripts/testing/device-credentials.mjs';
export { InMemoryDeviceCredentialStore };

const credentials = new Map<string, InMemoryDeviceCredentialStore>();
export function testDeviceCredentials(productId: string): InMemoryDeviceCredentialStore {
  let backend = credentials.get(productId);
  if (backend === undefined) { backend = new InMemoryDeviceCredentialStore(); credentials.set(productId, backend); }
  return backend;
}
