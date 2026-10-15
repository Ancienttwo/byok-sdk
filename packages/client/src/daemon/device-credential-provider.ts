import { DeviceCredentialStore, DeviceCredentialStoreError, type DeviceCredentialConfig } from './device-credential-store';
import { pickPlainDataProperties } from '../util/plain-data';

/** The default OS composition; tests inject their backend at this boundary. */
export function createDeviceCredentialStore(options: {
  productId: string;
  storeDir: string;
  deviceCredentials?: DeviceCredentialConfig;
}): DeviceCredentialStore {
  let macosKeychainPath: string | undefined;
  if (options.deviceCredentials !== undefined) {
    let configured: unknown;
    try { configured = pickPlainDataProperties(options.deviceCredentials, ['macosKeychainPath']).macosKeychainPath; }
    catch { throw new DeviceCredentialStoreError('deviceCredentials must be plain data with an optional macosKeychainPath string'); }
    if (configured !== undefined && typeof configured !== 'string') {
      throw new DeviceCredentialStoreError('deviceCredentials.macosKeychainPath must be a string');
    }
    macosKeychainPath = configured;
  }
  return new DeviceCredentialStore({
    productId: options.productId,
    storeDir: options.storeDir,
    macosKeychainPath,
  });
}
