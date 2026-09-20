#!/usr/bin/env node

import { ByokKeysError } from '../errors';
import { MacOsKeychainSecretStore } from '../macos-keychain';
import {
  type PiProviderLauncherOptions,
  assertPiPreparedProviderProfile,
  parsePiProviderLauncherOptions,
  startPiProvider,
} from '../pi-provider-launcher-core';
import { assertExactProviderProfileBinding } from '../provider-profile';
import {
  buildPiProviderProjection,
} from '../pi-provider-projection';
import { type SecretStore } from '../secret-store';
import { SqliteProviderProfileStore } from '../sqlite-profile-store';
import { WindowsCredentialManagerSecretStore } from '../windows-credential-manager';

function createSecretStore(
  servicePrefix: string | undefined,
  macosKeychainPath: string | undefined,
): SecretStore {
  if (macosKeychainPath !== undefined && process.platform !== 'darwin') {
    throw new ByokKeysError(
      'KEYCHAIN_UNAVAILABLE',
      'macOS keychain path is only supported on darwin',
    );
  }
  switch (process.platform) {
    case 'darwin':
      return new MacOsKeychainSecretStore({
        keychainPath: macosKeychainPath,
        servicePrefix,
      });
    case 'win32':
      return new WindowsCredentialManagerSecretStore({ servicePrefix });
    default:
      throw new ByokKeysError(
        'KEYCHAIN_UNAVAILABLE',
        `Pi BYOK credential launcher has no plaintext fallback on ${process.platform}`,
      );
  }
}

async function run(options: PiProviderLauncherOptions): Promise<number> {
  if (options.macosKeychainPath !== undefined && process.platform !== 'darwin') {
    throw new ByokKeysError(
      'KEYCHAIN_UNAVAILABLE',
      'macOS keychain path is only supported on darwin',
    );
  }
  const profiles = new SqliteProviderProfileStore({
    path: options.profileDbPath,
    readOnly: true,
  });
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const profile = await profiles.get(options.profileRef);
    if (profile === undefined) {
      throw new Error(`provider profile ${options.profileRef} is not configured`);
    }
    if (profile.model !== options.modelId) {
      throw new Error(
        `selected model ${options.modelId} does not match configured provider model ${profile.model}`,
      );
    }
    if (options.expectedBinding !== undefined) {
      assertExactProviderProfileBinding(profile, options.expectedBinding);
    }
    if (options.runtimeEntry === 'pi-prepared') assertPiPreparedProviderProfile(profile);
    buildPiProviderProjection(profile);
    if (options.validateOnly) return 0;
    const launched = await startPiProvider(profile, options, {
      ambient: process.env,
      createSecretStore: () => createSecretStore(options.secretServicePrefix, options.macosKeychainPath),
    });
    cleanup = launched.cleanup;
    const child = launched.child;

    const forward = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = (): void => forward('SIGINT');
    const onSigterm = (): void => forward('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    try {
      return await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          resolve(code ?? (signal ? 1 : 0));
        });
      });
    } finally {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
  } finally {
    await profiles.close();
    await cleanup?.();
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(parsePiProviderLauncherOptions(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi provider launcher: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
