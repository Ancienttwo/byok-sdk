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
import { WindowsCredentialManagerSecretStore } from './windows-credential-manager';

const ENABLED = process.env.BYOK_TEST_WINDOWS_CREDENTIAL_MANAGER === '1';
if (ENABLED && process.platform !== 'win32') {
  throw new Error('BYOK_TEST_WINDOWS_CREDENTIAL_MANAGER=1 requires win32; refusing to skip');
}

const prefix = `com.byok.keys.ci-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const directory = ENABLED ? mkdtempSync(join(tmpdir(), 'byok-keys-wincred-')) : '';

describe.skipIf(!ENABLED)('sealed provisioning on Windows Credential Manager', () => {
  const secrets = new WindowsCredentialManagerSecretStore({ servicePrefix: prefix });

  afterAll(async () => {
    await secrets.delete(DEVICE_SEALING_SECRET_NAME);
    await secrets.delete(modelProviderSecretName(PROFILE_REF));
    rmSync(directory, { force: true, recursive: true });
  });

  it('creates the sealing key, applies configure/replace/delete, and the launcher reads only consistent pairs', async () => {
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
  });
});
