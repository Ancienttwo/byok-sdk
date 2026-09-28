/**
 * Regressions for Codex SDK acceptance round 1 (F1, F2, F4). Each scenario
 * reproduces the reviewer's adversarial probe; the F1 variants with real
 * process death live in `custody-crash.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { providerProvisioningRequestDigest } from '@byok-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceSealingKeyStore, type DeviceSealingKey } from './device-sealing-key';
import {
  DEVICE,
  NOW,
  PROFILE_REF,
  TENANT,
  configureRequest,
  placedIdentity,
  replaceSecretRequest,
} from './fixtures/provisioning-requests';
import { exactProviderProfileBinding } from './provider-profile';
import {
  applySealedProviderProvisioning,
  readSealedProvisioningResult,
  type ApplySealedProviderProvisioningOptions,
  type ProviderProvisioningIdentitySnapshot,
} from './sealed-provisioning';
import { InMemorySecretStore, modelProviderSecretName } from './secret-store';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable } from './sqlite-support';

const enrollment = { tenantId: TENANT, deviceId: DEVICE };
const SECRET_NAME = modelProviderSecretName(PROFILE_REF);

let dir: string;
let profiles: SqliteProviderProfileStore;
let secrets: InMemorySecretStore;
let keyStore: DeviceSealingKeyStore;
let sealingKey: DeviceSealingKey;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'byok-keys-acceptance-'));
  profiles = new SqliteProviderProfileStore({ path: join(dir, 'provider-profile.sqlite') });
  secrets = new InMemorySecretStore();
  keyStore = new DeviceSealingKeyStore({ secretStore: secrets });
  sealingKey = await keyStore.loadOrCreate(enrollment);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await profiles.close();
  rmSync(dir, { recursive: true, force: true });
});

function apply(request: unknown, other: Partial<ApplySealedProviderProvisioningOptions> = {}) {
  return applySealedProviderProvisioning({
    request,
    profileStore: profiles,
    secretStore: secrets,
    sealingKey,
    resolveProfileRef: () => PROFILE_REF,
    readIdentity: async () => placedIdentity(),
    now: () => new Date(NOW),
    ...other,
  });
}

async function expected() {
  const binding = exactProviderProfileBinding((await profiles.get(PROFILE_REF))!, []);
  return { profileRef: binding.profileRef, profileRevision: binding.profileRevision, profileHash: binding.profileHash };
}

describe.skipIf(!isSqliteAvailable())('F1: a started generation fences older generations', () => {
  for (const cut of ['after-pending', 'after-secret-write'] as const) {
    it(`F1 older generation is fenced by a pending newer generation (${cut})`, async () => {
      await apply(await configureRequest(sealingKey, 'k-initial', { requestId: 'initial', generation: 1 }));
      const exp = await expected();
      const older = await replaceSecretRequest(sealingKey, 'k-older', { requestId: 'older', generation: 2, expected: exp });
      const newer = await replaceSecretRequest(sealingKey, 'k-newer', { requestId: 'newer', generation: 3, expected: exp });
      await apply(newer, { faults: { onCutPoint: (point) => { if (point === cut) throw new Error('boundary'); } } }).catch(() => undefined);
      await expect(profiles.getOperationWatermark(PROFILE_REF)).resolves.toBe(3);
      const before = await secrets.get(SECRET_NAME);
      const set = vi.spyOn(secrets, 'set');

      expect(await apply(older)).toMatchObject({ outcome: 'rejected', code: 'operation_generation_stale' });
      expect(await apply(newer)).toMatchObject({ outcome: 'rejected', code: 'local_commit_interrupted' });
      expect(set).not.toHaveBeenCalled();
      await expect(secrets.get(SECRET_NAME)).resolves.toBe(before);

      const recovery = await replaceSecretRequest(sealingKey, 'k-recovered', { requestId: 'recover', generation: 4, expected: exp });
      expect(await apply(recovery)).toMatchObject({ outcome: 'applied' });
      await expect(secrets.get(SECRET_NAME)).resolves.toBe('k-recovered');
      await expect(profiles.getPending(PROFILE_REF)).resolves.toBeUndefined();
    });
  }
});

describe.skipIf(!isSqliteAvailable())('F2: identity is re-validated inside the write critical section', () => {
  async function raceWhileLocked(change: (identity: { current: ProviderProvisioningIdentitySnapshot }) => void) {
    const request = await configureRequest(sealingKey, 'k-placement', { requestId: 'placement', generation: 1 });
    const identity = { current: placedIdentity() as ProviderProvisioningIdentitySnapshot };
    let reads = 0;
    const set = vi.spyOn(secrets, 'set');
    const del = vi.spyOn(secrets, 'delete');
    const acquire = profiles.acquireConfigurationLock.bind(profiles);
    const lock = await acquire();
    // Deterministic interleaving: the change happens only once the applier is
    // provably blocked on the configuration lock this test holds.
    let atLock!: () => void;
    const contenderAtLock = new Promise<void>((resolve) => { atLock = resolve; });
    vi.spyOn(profiles, 'acquireConfigurationLock').mockImplementation(() => { atLock(); return acquire(); });
    const pending = apply(request, {
      readIdentity: async () => { reads += 1; return identity.current; },
    });
    await contenderAtLock;
    change(identity);
    await lock.release();
    const result = await pending;
    return { result, reads, set, del };
  }

  it('F2 placement change while waiting for the lock is rejected with zero secret writes', async () => {
    const { result, reads, set, del } = await raceWhileLocked((identity) => { identity.current = placedIdentity({ placed: false }); });
    expect(result).toMatchObject({ outcome: 'rejected', code: 'agent_not_placed' });
    expect(reads).toBe(2);
    expect(set).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('F2 placement revision change on the same device is rejected with zero secret writes', async () => {
    const { result, set, del } = await raceWhileLocked((identity) => { identity.current = placedIdentity({ placementRevision: 'placement-2' }); });
    expect(result).toMatchObject({ outcome: 'rejected', code: 'agent_not_placed' });
    expect(set).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('F2 enrollment update while waiting for the lock is rejected with zero secret writes', async () => {
    const { result, set, del } = await raceWhileLocked((identity) => { identity.current = placedIdentity({ enrollmentRevision: 'enrollment-2' }); });
    expect(result).toMatchObject({ outcome: 'rejected', code: 'enrollment_mismatch' });
    expect(set).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('F2 a request issued for another placement or enrollment revision is rejected before decryption', async () => {
    const stalePlacement = await configureRequest(sealingKey, 'k', { requestId: 'p', generation: 1, placementRevision: 'placement-0' });
    expect(await apply(stalePlacement)).toMatchObject({ code: 'agent_not_placed' });
    const staleEnrollment = await configureRequest(sealingKey, 'k', { requestId: 'e', generation: 1, enrollmentRevision: 'enrollment-0' });
    expect(await apply(staleEnrollment)).toMatchObject({ code: 'enrollment_mismatch' });
    await expect(secrets.has(SECRET_NAME)).resolves.toBe(false);
  });
});

describe.skipIf(!isSqliteAvailable())('F4: durable results are read before the sealing key, placement, or ciphertext', () => {
  it('F4 applied + ACK lost + sealing key rotation: retry returns the stored applied result', async () => {
    const request = await configureRequest(sealingKey, 'k-ack', { requestId: 'ack-lost', generation: 1 });
    const first = await apply(request);
    expect(first.outcome).toBe('applied');
    const rotated = await keyStore.rotate(enrollment);
    const set = vi.spyOn(secrets, 'set');
    expect(await apply(request, { sealingKey: rotated })).toEqual(first);
    expect(set).not.toHaveBeenCalled();
  });

  it('F4 readback-only after the Host ciphertext is gone returns the stored result by requestId + digest', async () => {
    const request = await configureRequest(sealingKey, 'k-gone', { requestId: 'gone', generation: 1 });
    const first = await apply(request);
    const requestDigest = await providerProvisioningRequestDigest(request);
    expect(first.requestDigest).toBe(requestDigest);
    await expect(readSealedProvisioningResult({ profileStore: profiles, requestId: 'gone', requestDigest }))
      .resolves.toEqual({ status: 'completed', result: first });
    await expect(readSealedProvisioningResult({ profileStore: profiles, requestId: 'gone', requestDigest: `sha256:${'0'.repeat(64)}` }))
      .resolves.toEqual({ status: 'conflict' });
    await expect(readSealedProvisioningResult({ profileStore: profiles, requestId: 'never', requestDigest }))
      .resolves.toEqual({ status: 'absent' });
  });

  it('F4 a placement change after completion does not rewrite the historical result', async () => {
    const request = await configureRequest(sealingKey, 'k-moved', { requestId: 'moved', generation: 1 });
    const first = await apply(request);
    expect(await apply(request, { readIdentity: async () => placedIdentity({ placed: false }) })).toEqual(first);
    expect(await apply(request, { readIdentity: async () => placedIdentity({ enrollmentRevision: 'enrollment-9' }) })).toEqual(first);
  });

  it('F4 the same requestId with a different digest is a conflict and writes nothing', async () => {
    await apply(await configureRequest(sealingKey, 'k-a', { requestId: 'same-id', generation: 1 }));
    const set = vi.spyOn(secrets, 'set');
    const other = await configureRequest(sealingKey, 'k-b', { requestId: 'same-id', generation: 2 });
    expect(await apply(other)).toMatchObject({ outcome: 'rejected', code: 'request_conflict' });
    expect(set).not.toHaveBeenCalled();
    await expect(secrets.get(SECRET_NAME)).resolves.toBe('k-a');
  });

  it('F4 a request for another tenant or device never reads local results', async () => {
    const request = await configureRequest(sealingKey, 'k', { requestId: 'r', generation: 1 });
    await apply(request);
    const getReceipt = vi.spyOn(profiles, 'getReceipt');
    expect(await apply(request, { readIdentity: async () => placedIdentity({ deviceId: 'device-other' }) }))
      .toMatchObject({ outcome: 'rejected', code: 'enrollment_mismatch' });
    expect(getReceipt).not.toHaveBeenCalled();
  });
});
