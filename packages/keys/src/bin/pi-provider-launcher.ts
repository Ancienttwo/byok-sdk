#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ByokKeysError } from '../errors';
import { MacOsKeychainSecretStore } from '../macos-keychain';
import {
  type PiProviderLauncherOptions,
  buildPiProviderChildEnvironment,
  ensurePiSessionDirectory,
  parsePiProviderLauncherOptions,
  resolvePiProviderSecret,
} from '../pi-provider-launcher-core';
import { assertExactProviderProfileBinding } from '../provider-profile';
import {
  buildPiProviderArgs,
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
  let projectionDir: string | undefined;
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
    if (options.validateOnly) return 0;

    const secret = await resolvePiProviderSecret(
      profile,
      () => createSecretStore(
        options.secretServicePrefix,
        options.macosKeychainPath,
      ),
    );

    projectionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-provider-'));
    await fs.chmod(projectionDir, 0o700).catch(() => {});
    await ensurePiSessionDirectory(options.sessionDir);
    await fs.writeFile(
      path.join(projectionDir, 'models.json'),
      `${JSON.stringify(buildPiProviderProjection(profile))}\n`,
      { mode: 0o600 },
    );

    const child = spawn(options.piBin, buildPiProviderArgs(profile, options.piArgs), {
      env: buildPiProviderChildEnvironment({
        ambient: process.env,
        projectionDir,
        sessionDir: options.sessionDir,
        secret,
      }),
      stdio: 'inherit',
    });

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
    if (projectionDir) {
      await fs.rm(projectionDir, { recursive: true, force: true });
    }
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
