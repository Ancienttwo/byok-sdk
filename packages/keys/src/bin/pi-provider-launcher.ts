#!/usr/bin/env node

import { ByokKeysError } from '../errors';
import { MacOsKeychainSecretStore } from '../macos-keychain';
import {
  type PiProviderLauncherOptions,
  parsePiProviderLauncherOptions,
  runPiProviderLauncher,
} from '../pi-provider-launcher-core';
import { type SecretStore } from '../secret-store';
import { WindowsCredentialManagerSecretStore } from '../windows-credential-manager';

/** The bundled executable's store: the platform OS store with the default storage options. */
function createSecretStore(options: PiProviderLauncherOptions): SecretStore {
  switch (process.platform) {
    case 'darwin':
      return new MacOsKeychainSecretStore({
        keychainPath: options.macosKeychainPath,
        servicePrefix: options.secretServicePrefix,
      });
    case 'win32':
      return new WindowsCredentialManagerSecretStore({ servicePrefix: options.secretServicePrefix });
    default:
      throw new ByokKeysError(
        'KEYCHAIN_UNAVAILABLE',
        `Pi BYOK credential launcher has no plaintext fallback on ${process.platform}`,
      );
  }
}

async function main(): Promise<void> {
  try {
    const options = parsePiProviderLauncherOptions(process.argv.slice(2));
    if (options.macosKeychainPath !== undefined && process.platform !== 'darwin') {
      throw new ByokKeysError(
        'KEYCHAIN_UNAVAILABLE',
        'macOS keychain path is only supported on darwin',
      );
    }
    process.exitCode = await runPiProviderLauncher(options, {
      createSecretStore: () => createSecretStore(options),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi provider launcher: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
