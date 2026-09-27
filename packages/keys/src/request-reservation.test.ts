/**
 * F6 (Codex SDK acceptance round 2): a request id is reserved store-wide with
 * its immutable request digest before any side effect. A redelivery that reuses
 * the id with a different digest is a conflict with zero writes — on the same
 * profile and on another profile — and never displaces the original request's
 * pending or receipt facts. The SIGKILL variant lives in `custody-crash.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryTruthStore, tenantId } from '@byok-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceSealingKeyStore, type DeviceSealingKey } from './device-sealing-key';
import {
  AGENT,
  DEVICE,
  NOW,
  PLACEMENT_REVISION,
  PROFILE_REF,
  TENANT,
  configureRequest,
  placedIdentity,
  replaceSecretRequest,
} from './fixtures/provisioning-requests';
import { InMemoryProviderProfileStore, type ProviderProfileStore } from './profile-store';
import { exactProviderProfileBinding } from './provider-profile';
import {
  applySealedProviderProvisioning,
  readSealedProvisioningResult,
  type ApplySealedProviderProvisioningOptions,
  type ProviderProvisioningCutPoint,
} from './sealed-provisioning';
import { InMemorySecretStore, modelProviderSecretName } from './secret-store';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable } from './sqlite-support';
import { TruthStoreProviderProfileStore } from './truth-profile-store';

const OTHER_AGENT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OTHER_REF = 'salesko-9a8b7c6d5e4f4a3b8c2d1e0f9a8b7c6d';
const enrollment = { tenantId: TENANT, deviceId: DEVICE };

const STORES: Array<{ name: string; enabled: boolean; open: (dir: string) => ProviderProfileStore }> = [
  { name: 'sqlite', enabled: isSqliteAvailable(), open: (dir) => new SqliteProviderProfileStore({ path: join(dir, 'provider-profile.sqlite') }) },
  { name: 'in-memory', enabled: true, open: () => new InMemoryProviderProfileStore() },
  {
    name: 'truth-store (process-local custody)',
    enabled: true,
    open: () => new TruthStoreProviderProfileStore({
      tenant: tenantId('keys-reservation-test'),
      truthStore: new InMemoryTruthStore({ now: () => new Date(NOW) }),
    }),
  },
];

let dir: string;
let profiles: ProviderProfileStore;
let secrets: InMemorySecretStore;
let sealingKey: DeviceSealingKey;

for (const store of STORES) {
describe.skipIf(!store.enabled)(`F6 on the ${store.name} store`, () => {
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'byok-keys-reservation-'));
  profiles = store.open(dir);
  secrets = new InMemorySecretStore();
  sealingKey = await new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate(enrollment);
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
    resolveProfileRef: (agentId) => (agentId === AGENT ? PROFILE_REF : OTHER_REF),
    readIdentity: async (agentId) => ({ ...placedIdentity(), placement: { agentId, placementRevision: PLACEMENT_REVISION } }),
    now: () => new Date(NOW),
    ...other,
  });
}

async function expected() {
  const binding = exactProviderProfileBinding((await profiles.get(PROFILE_REF))!, []);
  return { profileRef: binding.profileRef, profileRevision: binding.profileRevision, profileHash: binding.profileHash };
}

/** Configure PROFILE_REF, then interrupt request `dup` (generation 2) at `cut`. */
async function interruptOriginal(cut: ProviderProvisioningCutPoint) {
  await apply(await configureRequest(sealingKey, 'k-initial', { requestId: 'initial', generation: 1 }));
  const exp = await expected();
  const original = await replaceSecretRequest(sealingKey, 'k-original', { requestId: 'dup', generation: 2, expected: exp });
  await apply(original, { faults: { onCutPoint: (point) => { if (point === cut) throw new Error('boundary'); } } }).catch(() => undefined);
  await expect(profiles.getPending(PROFILE_REF)).resolves.toMatchObject({ requestId: 'dup' });
  return { original, exp };
}

function spyWrites() {
  return { set: vi.spyOn(secrets, 'set'), del: vi.spyOn(secrets, 'delete') };
}

describe('F6: store-wide request id reservation', () => {
  for (const cut of ['after-pending', 'after-secret-write'] as const) {
    it(`F6 same-profile different-digest redelivery while pending (${cut}) is a conflict with zero writes`, async () => {
      const { original, exp } = await interruptOriginal(cut);
      const keyBefore = await secrets.get(modelProviderSecretName(PROFILE_REF));
      const writes = spyWrites();
      const impostor = await replaceSecretRequest(sealingKey, 'k-impostor', { requestId: 'dup', generation: 3, expected: exp });

      expect(await apply(impostor)).toMatchObject({ outcome: 'rejected', code: 'request_conflict' });
      expect(writes.set).not.toHaveBeenCalled();
      expect(writes.del).not.toHaveBeenCalled();
      await expect(profiles.getReceipt('dup')).resolves.toBeUndefined();
      await expect(profiles.getPending(PROFILE_REF)).resolves.toMatchObject({ requestId: 'dup', operationGeneration: 2 });

      // The original still reads back as its own interrupted request.
      const originalDigest = (await profiles.getReservation('dup'))!.requestDigest;
      await expect(readSealedProvisioningResult({ profileStore: profiles, requestId: 'dup', requestDigest: originalDigest }))
        .resolves.toEqual({ status: 'interrupted' });
      expect(await apply(original)).toMatchObject({ outcome: 'rejected', code: 'local_commit_interrupted', requestId: 'dup' });
      expect(await apply(original)).toMatchObject({ outcome: 'rejected', code: 'local_commit_interrupted' });
      await expect(readSealedProvisioningResult({ profileStore: profiles, requestId: 'dup', requestDigest: originalDigest }))
        .resolves.toMatchObject({ status: 'completed', result: { code: 'local_commit_interrupted' } });
      expect(await apply(impostor)).toMatchObject({ outcome: 'rejected', code: 'request_conflict' });
      await expect(secrets.get(modelProviderSecretName(PROFILE_REF))).resolves.toBe(keyBefore);

      // A higher generation under a new request id still recovers explicitly.
      const recovery = await replaceSecretRequest(sealingKey, 'k-recovered', { requestId: 'recover', generation: 4, expected: exp });
      expect(await apply(recovery)).toMatchObject({ outcome: 'applied' });
      await expect(profiles.getPending(PROFILE_REF)).resolves.toBeUndefined();
    });

    it(`F6 cross-profile different-digest redelivery while pending (${cut}) is a conflict with zero writes`, async () => {
      const { original } = await interruptOriginal(cut);
      const writes = spyWrites();
      const impostor = await configureRequest(sealingKey, 'k-other', { requestId: 'dup', generation: 1, agentId: OTHER_AGENT });

      expect(await apply(impostor)).toMatchObject({ outcome: 'rejected', code: 'request_conflict' });
      expect(writes.set).not.toHaveBeenCalled();
      expect(writes.del).not.toHaveBeenCalled();
      await expect(profiles.get(OTHER_REF)).resolves.toBeUndefined();
      await expect(profiles.getPending(OTHER_REF)).resolves.toBeUndefined();
      await expect(profiles.getOperationWatermark(OTHER_REF)).resolves.toBeUndefined();

      expect(await apply(original)).toMatchObject({ outcome: 'rejected', code: 'local_commit_interrupted', requestId: 'dup' });
      await expect(profiles.getPending(PROFILE_REF)).resolves.toMatchObject({ requestId: 'dup' });
    });
  }

  it('F6 different-digest redelivery before the original was ever seen does not block the original from other profiles', async () => {
    // Nothing reserved yet: the first request to arrive owns the id.
    const first = await configureRequest(sealingKey, 'k-first', { requestId: 'fresh', generation: 1 });
    const second = await configureRequest(sealingKey, 'k-second', { requestId: 'fresh', generation: 1, agentId: OTHER_AGENT });
    expect(await apply(first)).toMatchObject({ outcome: 'applied' });
    const writes = spyWrites();
    expect(await apply(second)).toMatchObject({ outcome: 'rejected', code: 'request_conflict' });
    expect(writes.set).not.toHaveBeenCalled();
    await expect(profiles.get(OTHER_REF)).resolves.toBeUndefined();
  });

  it('F6 different-digest redelivery after completion (same and other profile) never displaces the original receipt', async () => {
    const original = await configureRequest(sealingKey, 'k-done', { requestId: 'done', generation: 1 });
    const applied = await apply(original);
    const writes = spyWrites();
    const sameProfile = await replaceSecretRequest(sealingKey, 'k-x', { requestId: 'done', generation: 2, expected: await expected() });
    const otherProfile = await configureRequest(sealingKey, 'k-y', { requestId: 'done', generation: 1, agentId: OTHER_AGENT });
    expect(await apply(sameProfile)).toMatchObject({ code: 'request_conflict' });
    expect(await apply(otherProfile)).toMatchObject({ code: 'request_conflict' });
    expect(writes.set).not.toHaveBeenCalled();
    expect(await apply(original)).toEqual(applied);
  });
});
});
}
