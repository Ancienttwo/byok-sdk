import path from 'node:path';
import type { SdkHelperHostConfig } from '@byok-sdk/client';
import type { PiByokLauncherConfig } from '@byok-sdk/client/adapters';
import { parsePiProviderLauncherOptions, runPiProviderLauncher } from '@byok-sdk/keys';
import { platformSecretStore } from './secret-store.ts';

/** The argv command under which the Host executable re-enters as the Pi provider launcher. */
export const PI_LAUNCHER_COMMAND = 'byok-pi-provider-launcher';

/** The provider profile store custody writes and the launcher reads (#1499 s1.5). */
export function keysDbPath(hostStorageRoot: string): string {
  return path.join(hostStorageRoot, 'host', 'keys.db');
}

/** `piByokLauncher` for the daemon: Pi launches re-enter this Host's own executable. */
export function piByokLauncher(helperHost: SdkHelperHostConfig & { readonly executable: string }, hostStorageRoot: string): PiByokLauncherConfig {
  return {
    command: helperHost.executable,
    args: [...(helperHost.entry === undefined ? [] : [helperHost.entry]), PI_LAUNCHER_COMMAND],
    profileDbPath: keysDbPath(hostStorageRoot),
    sessionDir: path.join(hostStorageRoot, 'host', 'pi-sessions'),
  };
}

/** Runs the launcher on the arguments after the command; resolves to the Pi child's exit code. */
export async function runPiLauncher(args: string[]): Promise<number> {
  const options = parsePiProviderLauncherOptions(args);
  return runPiProviderLauncher(options, {
    createSecretStore: () => platformSecretStore({
      ...(options.secretServicePrefix === undefined ? {} : { secretServicePrefix: options.secretServicePrefix }),
      ...(options.macosKeychainPath === undefined ? {} : { macosKeychainPath: options.macosKeychainPath }),
    }),
  });
}
