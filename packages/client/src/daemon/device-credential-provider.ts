import { DeviceCredentialStore, DeviceCredentialStoreError, type DeviceCredentialConfig } from './device-credential-store';
import { OsDeviceMemberCustody, type DeviceMemberCustodyBackend } from './device-member-custody';
import { pickPlainDataProperties } from '../util/plain-data';

interface CredentialProviderOptions {
  productId: string;
  storeDir: string;
  deviceCredentials?: DeviceCredentialConfig;
}

function macosKeychainPathOf(options: CredentialProviderOptions): string | undefined {
  if (options.deviceCredentials === undefined) return undefined;
  let configured: unknown;
  try { configured = pickPlainDataProperties(options.deviceCredentials, ['macosKeychainPath']).macosKeychainPath; }
  catch { throw new DeviceCredentialStoreError('deviceCredentials must be plain data with an optional macosKeychainPath string'); }
  if (configured !== undefined && typeof configured !== 'string') {
    throw new DeviceCredentialStoreError('deviceCredentials.macosKeychainPath must be a string');
  }
  return configured;
}

/** The default OS composition; tests inject their backend at this boundary. */
export function createDeviceCredentialStore(options: CredentialProviderOptions): DeviceCredentialStore {
  return new DeviceCredentialStore({
    productId: options.productId,
    storeDir: options.storeDir,
    macosKeychainPath: macosKeychainPathOf(options),
  });
}

/** The device member entries, in the same OS provider and keychain as the enrollment; tests inject theirs here too. */
export function createDeviceMemberCustody(options: CredentialProviderOptions): DeviceMemberCustodyBackend {
  return new OsDeviceMemberCustody({
    productId: options.productId,
    storeDir: options.storeDir,
    macosKeychainPath: macosKeychainPathOf(options),
  });
}
