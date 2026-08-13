import {
  MacOsKeychainSecretStore,
  WindowsCredentialManagerSecretStore,
  type SecretStore,
} from '@byok-sdk/keys';
import { ConnectorBrokerError } from './broker';

export const SALESKO_CONNECTOR_SECRET_SERVICE_PREFIX = 'com.salesko.connector-broker';

/** OS-backed custody only. Linux has no plaintext fallback in this reference composition. */
export function createSaleskoConnectorSecretStore(
  platform: NodeJS.Platform = process.platform,
): SecretStore<string> {
  if (platform === 'darwin') {
    return new MacOsKeychainSecretStore({
      platform,
      servicePrefix: SALESKO_CONNECTOR_SECRET_SERVICE_PREFIX,
    });
  }
  if (platform === 'win32') {
    return new WindowsCredentialManagerSecretStore({
      platform,
      servicePrefix: SALESKO_CONNECTOR_SECRET_SERVICE_PREFIX,
    });
  }
  throw new ConnectorBrokerError(
    'CREDENTIAL_STORE_UNAVAILABLE',
    'The reference connector broker requires macOS Keychain or Windows Credential Manager',
  );
}
