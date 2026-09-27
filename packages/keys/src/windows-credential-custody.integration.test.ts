/**
 * SDK Windows v1 gate (plan A11): sealed provisioning against the REAL
 * Windows Credential Manager, run by the CI `windows-latest` leg as the
 * runner's own user (same-user convention: the daemon that applies a
 * provisioning request and the launcher that reads the key run as one user).
 *
 * Enabled only with `BYOK_TEST_WINDOWS_CREDENTIAL_MANAGER=1`; setting the flag
 * off win32 is a hard failure, never a skip. Every entry is written under a
 * unique service prefix and removed afterwards.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DEVICE_SEALING_SECRET_NAME, DeviceSealingKeyStore } from './device-sealing-key';
import { DEVICE, NOW, PROFILE_REF, TENANT, configureRequest, deleteRequest, replaceSecretRequest } from './fixtures/provisioning-requests';
import { readProviderCustodySnapshot } from './pi-provider-launcher-core';
import { exactProviderProfileBinding } from './provider-profile';
import { applySealedProviderProvisioning } from './sealed-provisioning';
import { modelProviderSecretName } from './secret-store';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { runCommand } from './command-runner';
import { WindowsCredentialManagerSecretStore } from './windows-credential-manager';

/**
 * Backend evidence for a failure: exit code plus the bridge's bounded,
 * secret-free stderr classification line. stdout (which carries a read secret)
 * is never recorded, and any stderr that is not the exact classification
 * grammar is reduced to its length.
 */
const backendEvidence: string[] = [];
// PowerShell may wrap stderr in CLIXML, so the classification is located
// inside stderr and only the matched line is reported.
const CLASSIFICATION = /credential operation failed \((?:stage=compile,cs=\d+|stage=operation,win32=-?\d+,hresult=-?\d+)\)/u;
async function recordingRunner(executable: string, args: string[], stdin?: string) {
  const result = await runCommand(executable, args, stdin);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const operation = stdin === undefined ? 'probe' : String((JSON.parse(stdin) as { operation?: unknown }).operation);
    const classified = CLASSIFICATION.exec(stderr)?.[0];
    backendEvidence.push(`${operation}: exit=${result.exitCode} stderr=${classified ?? `<${stderr.length} chars, unclassified>`}`);
  }
  return result;
}
function withEvidence(error: unknown): Error {
  const message = error instanceof Error ? `${(error as { code?: string }).code ?? error.name}: ${error.message}` : String(error);
  return new Error(`${message}\nbackend evidence:\n${backendEvidence.join('\n') || '<none>'}`);
}

const ENABLED = process.env.BYOK_TEST_WINDOWS_CREDENTIAL_MANAGER === '1';
/**
 * Every Credential Manager operation starts PowerShell and compiles the bridge
 * type (about 1-2 s on the hosted runner), and the round trip performs a few
 * dozen of them, so vitest's 5 s default is not a meaningful bound here.
 */
const REAL_BACKEND_TIMEOUT_MS = 180_000;
if (ENABLED && process.platform !== 'win32') {
  throw new Error('BYOK_TEST_WINDOWS_CREDENTIAL_MANAGER=1 requires win32; refusing to skip');
}

const prefix = `com.byok.keys.ci-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const directory = ENABLED ? mkdtempSync(join(tmpdir(), 'byok-keys-wincred-')) : '';

describe.skipIf(!ENABLED)('sealed provisioning on Windows Credential Manager', () => {
  const secrets = new WindowsCredentialManagerSecretStore({ servicePrefix: prefix, commandRunner: recordingRunner });

  afterAll(async () => {
    try {
      await secrets.delete(DEVICE_SEALING_SECRET_NAME);
      await secrets.delete(modelProviderSecretName(PROFILE_REF));
    } catch (error) {
      throw withEvidence(error);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, REAL_BACKEND_TIMEOUT_MS);

  it('root-cause evidence: the pre-fix bridge type definition does not compile on this runner (CS0104)', async () => {
    // The exact struct shape the bridge shipped before the fix: both
    // InteropServices namespaces imported, FILETIME unqualified.
    const script = String.raw`
try {
Add-Type -ErrorAction Stop -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace ByokPreFixProbe {
  public static class Probe {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential { public UInt32 Flags; public FILETIME LastWritten; }
  }
}
"@
  [Console]::Out.Write("compiled")
} catch {
  $compilerCode = 99
  $errorNumber = [string]$_.TargetObject.ErrorNumber
  if ($errorNumber -match '\ACS([0-9]{4})\z') { $compilerCode = [Convert]::ToInt32($Matches[1]) }
  [Console]::Out.Write("cs=" + $compilerCode)
}
`;
    const result = await runCommand('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ]);
    process.stdout.write(`[windows-credential-root-cause] pre-fix bridge compile: ${result.stdout.trim()}\n`);
    expect(result.stdout.trim()).toBe('cs=104');
  }, REAL_BACKEND_TIMEOUT_MS);

  it('reports an absent credential as absent (read) and as false (delete)', async () => {
    try {
      await expect(secrets.get('model-absent-probe-api-key')).resolves.toBeUndefined();
      await expect(secrets.delete('model-absent-probe-api-key')).resolves.toBe(false);
    } catch (error) {
      throw withEvidence(error);
    }
  }, REAL_BACKEND_TIMEOUT_MS);

  it('creates the sealing key, applies configure/replace/delete, and the launcher reads only consistent pairs', async () => {
    try {
      await roundTrip();
    } catch (error) {
      throw withEvidence(error);
    }
  }, REAL_BACKEND_TIMEOUT_MS);

  async function roundTrip(): Promise<void> {
    await expect(secrets.available()).resolves.toBe(true);
    const enrollment = { tenantId: TENANT, deviceId: DEVICE };
    const sealingKey = await new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate(enrollment);
    const reloaded = await new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate(enrollment);
    expect(reloaded.keyId).toBe(sealingKey.keyId);

    const profileStore = new SqliteProviderProfileStore({ path: join(directory, 'provider-profile.sqlite') });
    const apply = (request: unknown) => applySealedProviderProvisioning({
      request, profileStore, secretStore: secrets, sealingKey, enrollment,
      resolveProfileRef: () => PROFILE_REF, isPlacedHere: async () => true, now: () => new Date(NOW),
    });
    const expected = async () => {
      const binding = exactProviderProfileBinding((await profileStore.get(PROFILE_REF))!, []);
      return { profileRef: binding.profileRef, profileRevision: binding.profileRevision, profileHash: binding.profileHash };
    };

    expect(await apply(await configureRequest(sealingKey, 'sk-wincred-canary-first', { requestId: 'w1', generation: 1 })))
      .toMatchObject({ outcome: 'applied', secretConfigured: true });
    const profile = (await profileStore.get(PROFILE_REF))!;
    await expect(readProviderCustodySnapshot({ profiles: profileStore, profile, createSecretStore: () => secrets }))
      .resolves.toBe('sk-wincred-canary-first');

    expect(await apply(await replaceSecretRequest(sealingKey, 'sk-wincred-canary-second', { requestId: 'w2', generation: 2, expected: await expected() })))
      .toMatchObject({ outcome: 'applied' });
    await expect(readProviderCustodySnapshot({ profiles: profileStore, profile, createSecretStore: () => secrets }))
      .resolves.toBe('sk-wincred-canary-second');

    expect(await apply(await deleteRequest({ requestId: 'w3', generation: 3, expected: await expected() })))
      .toMatchObject({ outcome: 'applied', secretConfigured: false });
    await expect(secrets.has(modelProviderSecretName(PROFILE_REF))).resolves.toBe(false);
    await profileStore.close();
  }
});
