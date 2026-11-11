import path from 'node:path';
import { bundledSdkHelperHost, sdkPackagingAssetLayout } from '@byok-sdk/client';
import { loadSdkKoffiAsset } from '@byok-sdk/client/packaging';
import {
  ByokKeysError, LinuxSecretServiceSecretStore, MacOsKeychainSecretStore, WindowsCredentialManagerSecretStore,
  type ModelProviderSecretName, type SecretStore,
} from '@byok-sdk/keys';

export interface PlatformSecretStoreOptions {
  readonly secretServicePrefix?: string;
  readonly macosKeychainPath?: string;
}

/**
 * The OS credential store that custody writes and the Pi launcher reads; both
 * must name the same entries, so both build it here. There is no plaintext
 * fallback: Linux without `secret-tool` fails at the first operation with the
 * store's own message.
 */
export function platformSecretStore(options: PlatformSecretStoreOptions = {}): SecretStore<ModelProviderSecretName> {
  const servicePrefix = options.secretServicePrefix;
  switch (process.platform) {
    case 'darwin':
      return new MacOsKeychainSecretStore({ keychainPath: options.macosKeychainPath, servicePrefix });
    case 'linux':
      return new LinuxSecretServiceSecretStore({ servicePrefix });
    case 'win32': {
      // A SEA carries no node_modules: koffi comes from the asset root beside the executable.
      const helperHost = bundledSdkHelperHost();
      const koffi = helperHost.entry === undefined
        ? loadSdkKoffiAsset(path.join(path.dirname(helperHost.executable), sdkPackagingAssetLayout.native))
        : undefined;
      return new WindowsCredentialManagerSecretStore({ servicePrefix, ...(koffi === undefined ? {} : { koffi }) });
    }
    default:
      throw new ByokKeysError('KEYCHAIN_UNAVAILABLE', `No OS credential store on ${process.platform}`);
  }
}
