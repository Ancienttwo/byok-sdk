import { InMemoryDeviceCredentialStore } from '../../../../../scripts/testing/device-credentials.mjs';
export { InMemoryDeviceCredentialStore };

const credentials = new Map<string, InMemoryDeviceCredentialStore>();
export function testDeviceCredentials(productId: string): InMemoryDeviceCredentialStore {
  let backend = credentials.get(productId);
  if (backend === undefined) { backend = new InMemoryDeviceCredentialStore(); credentials.set(productId, backend); }
  return backend;
}

/** Test-owned device member entries, one set per product as the OS provider keys them. */
export class InMemoryDeviceMemberCustody {
  readonly entries = new Map<string, string>();
  async read(entry: string): Promise<string | undefined> { return this.entries.get(entry); }
  async replace(entry: string, value: string): Promise<void> { this.entries.set(entry, value); }
  async delete(entry: string): Promise<void> { this.entries.delete(entry); }
}

const memberCustody = new Map<string, InMemoryDeviceMemberCustody>();
export function testDeviceMemberCustody(productId: string): InMemoryDeviceMemberCustody {
  let backend = memberCustody.get(productId);
  if (backend === undefined) { backend = new InMemoryDeviceMemberCustody(); memberCustody.set(productId, backend); }
  return backend;
}
