import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderProvisioningRequestV1 } from '@byok-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_CUSTODY_RECEIPT_LIMIT, type ProviderProvisioningResult } from './custody';
import { DeviceSealingKeyStore, type DeviceSealingKey } from './device-sealing-key';
import { ByokKeysError } from './errors';
import {
  AGENT,
  DEVICE,
  EXPIRES_AT,
  ISSUED_AT,
  NOW,
  PROFILE_REF,
  TENANT,
  configureRequest,
  deleteRequest,
  replaceSecretRequest,
  updateModelRequest,
} from './fixtures/provisioning-requests';
import { PI_MODEL_FIXTURE } from './fixtures/pi-model-config';
import { readProviderCustodySnapshot } from './pi-provider-launcher-core';
import { exactProviderProfileBinding, parseModelProviderProfile } from './provider-profile';
import { ProviderRegistry } from './registry';
import { applySealedProviderProvisioning, type ApplySealedProviderProvisioningOptions } from './sealed-provisioning';
import { InMemorySecretStore, modelProviderSecretName } from './secret-store';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable } from './sqlite-support';

const KEY_A = 'sk-provision-canary-A-4b1d';
const KEY_B = 'sk-provision-canary-B-93e0';
const KEY_C = 'sk-provision-canary-C-51aa';
const CANARIES = [KEY_A, KEY_B, KEY_C];
const SECRET_NAME = modelProviderSecretName(PROFILE_REF);

let directory: string;
let dbPath: string;
let profiles: SqliteProviderProfileStore;
let secrets: InMemorySecretStore;
let sealingKey: DeviceSealingKey;
let clock: Date;
const thrown: unknown[] = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'byok-keys-provision-'));
  dbPath = join(directory, 'provider-profile.sqlite');
  profiles = new SqliteProviderProfileStore({ path: dbPath });
  secrets = new InMemorySecretStore();
  sealingKey = await new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate({ tenantId: TENANT, deviceId: DEVICE });
  clock = new Date(NOW);
  thrown.length = 0;
});

afterEach(async () => {
  await profiles.close();
  rmSync(directory, { force: true, recursive: true });
});

function options(request: unknown, overrides: Partial<ApplySealedProviderProvisioningOptions> = {}): ApplySealedProviderProvisioningOptions {
  return {
    request,
    profileStore: profiles,
    secretStore: secrets,
    sealingKey,
    enrollment: { tenantId: TENANT, deviceId: DEVICE },
    resolveProfileRef: () => PROFILE_REF,
    isPlacedHere: async (agentId) => agentId === AGENT,
    now: () => clock,
    ...overrides,
  };
}

async function apply(request: unknown, overrides: Partial<ApplySealedProviderProvisioningOptions> = {}): Promise<ProviderProvisioningResult> {
  try {
    return await applySealedProviderProvisioning(options(request, overrides));
  } catch (error) {
    thrown.push(error);
    throw error;
  }
}

async function expectedOf(): Promise<{ profileRef: string; profileRevision: string; profileHash: string }> {
  const profile = await profiles.get(PROFILE_REF);
  const binding = exactProviderProfileBinding(profile!, []);
  return { profileRef: binding.profileRef, profileRevision: binding.profileRevision, profileHash: binding.profileHash };
}

async function configured(): Promise<ProviderProvisioningResult> {
  const result = await apply(await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 }));
  expect(result).toMatchObject({ outcome: 'applied', code: null });
  return result;
}

describe.skipIf(!isSqliteAvailable())('applySealedProviderProvisioning', () => {
  describe('configure', () => {
    it('derives the endpoint from the catalog, stores the key, and commits profile + receipt', async () => {
      const result = await configured();
      const profile = await profiles.get(PROFILE_REF);
      expect(profile).toMatchObject({
        provider_kind: 'zai',
        base_url: 'https://api.z.ai/api/coding/paas/v4',
        adapter: 'openai_compatible',
        auth_mode: 'bearer',
        model: 'glm-5.3-flash',
        pi_model: PI_MODEL_FIXTURE,
        enabled: false,
      });
      await expect(secrets.get(SECRET_NAME)).resolves.toBe(KEY_A);
      expect(result).toEqual({
        requestId: 'req-1',
        operation: 'configure',
        operationGeneration: 1,
        outcome: 'applied',
        code: null,
        profileRef: PROFILE_REF,
        binding: { ...(await expectedOf()), modelId: 'glm-5.3-flash' },
        secretConfigured: true,
        keyCheck: 'not_run',
      });
      await expect(profiles.getPending(PROFILE_REF)).resolves.toBeUndefined();
      await expect(profiles.getOperationWatermark(PROFILE_REF)).resolves.toBe(1);
      expect((await profiles.getReceipt('req-1'))?.result).toEqual(result);
    });

    it('rejects custom and unknown provider kinds without writing anything', async () => {
      for (const [index, providerKind] of ['custom', 'not-a-vendor'].entries()) {
        const result = await apply(await configureRequest(sealingKey, KEY_A, { requestId: `bad-${index}`, generation: index + 1, providerKind }));
        expect(result).toMatchObject({ outcome: 'rejected', code: 'provider_kind_unsupported' });
      }
      await expect(profiles.get(PROFILE_REF)).resolves.toBeUndefined();
      await expect(secrets.has(SECRET_NAME)).resolves.toBe(false);
    });

    it('rejects an invalid pi_model and an unsupported capability', async () => {
      const badPi = await configureRequest(sealingKey, KEY_A, { requestId: 'pi', generation: 1, piModel: { ...PI_MODEL_FIXTURE, maxTokens: 2_000_000 } });
      expect(await apply(badPi)).toMatchObject({ code: 'pi_model_invalid' });
      const badCapability = await configureRequest(sealingKey, KEY_A, { requestId: 'cap', generation: 2, capabilities: ['vision'] });
      expect(await apply(badCapability)).toMatchObject({ code: 'capabilities_invalid' });
      await expect(secrets.has(SECRET_NAME)).resolves.toBe(false);
    });

    it('requires the expected provider triple to match under the lock', async () => {
      await configured();
      const stale = await configureRequest(sealingKey, KEY_B, { requestId: 'req-2', generation: 2 });
      expect(await apply(stale)).toMatchObject({ outcome: 'rejected', code: 'profile_changed' });
      const wrong = await configureRequest(sealingKey, KEY_B, {
        requestId: 'req-3', generation: 3, expected: { ...(await expectedOf()), profileRevision: '1' },
      });
      expect(await apply(wrong)).toMatchObject({ outcome: 'rejected', code: 'profile_changed' });
      await expect(secrets.get(SECRET_NAME)).resolves.toBe(KEY_A);
      const right = await configureRequest(sealingKey, KEY_B, { requestId: 'req-4', generation: 4, expected: await expectedOf(), providerKind: 'openai', modelId: 'gpt-5.2' });
      expect(await apply(right)).toMatchObject({ outcome: 'applied' });
      await expect(profiles.get(PROFILE_REF)).resolves.toMatchObject({ provider_kind: 'openai', base_url: 'https://api.openai.com/v1' });
      await expect(secrets.get(SECRET_NAME)).resolves.toBe(KEY_B);
    });
  });

  describe('identity, integrity and routing checks', () => {
    it('rejects another enrollment, a rotated sealing key, and an agent placed elsewhere', async () => {
      const request = await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 });
      expect(await apply(request, { enrollment: { tenantId: TENANT, deviceId: 'device-other' } })).toMatchObject({ code: 'enrollment_mismatch' });
      const rotated = await new DeviceSealingKeyStore({ secretStore: new InMemorySecretStore() }).loadOrCreate({ tenantId: TENANT, deviceId: DEVICE });
      expect(await apply(request, { sealingKey: rotated })).toMatchObject({ code: 'sealing_key_rotated' });
      expect(await apply(request, { isPlacedHere: async () => false })).toMatchObject({ code: 'agent_not_placed' });
      await expect(profiles.getOperationWatermark(PROFILE_REF)).resolves.toBeUndefined();
    });

    it('rejects tampered AAD fields and a config that does not match its digest', async () => {
      const request = await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 });
      for (const header of [
        { ...request.header, operationGeneration: 2 },
        { ...request.header, expiresAt: '2026-09-28T05:14:00.000Z' },
        { ...request.header, requestId: 'req-x' },
      ]) {
        expect(await apply({ ...request, header })).toMatchObject({ outcome: 'rejected', code: 'seal_open_failed' });
      }
      expect(await apply({ ...request, config: { ...request.config, modelId: 'glm-5.3' } })).toMatchObject({ code: 'config_digest_mismatch' });
      expect(await apply({ ...request, sealed: { ...request.sealed!, suite: 'unknown' } })).toMatchObject({ code: 'request_invalid', requestId: null });
      await expect(profiles.get(PROFILE_REF)).resolves.toBeUndefined();
      await expect(profiles.getOperationWatermark(PROFILE_REF)).resolves.toBeUndefined();
    });

    it('fails closed when the host resolver returns an invalid ref', async () => {
      const request = await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 });
      await expect(apply(request, { resolveProfileRef: () => 'Not Valid' })).rejects.toMatchObject({ code: 'PROVIDER_PROFILE_INVALID' });
    });
  });

  describe('replay, generations and time windows (A3, A9)', () => {
    it('returns the stored result for the same request and rejects a different body under the same id', async () => {
      const request = await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 });
      const first = await apply(request);
      const setSpy = vi.spyOn(secrets, 'set');
      expect(await apply(request)).toEqual(first);
      expect(setSpy).not.toHaveBeenCalled();
      const sameId = await configureRequest(sealingKey, KEY_B, { requestId: 'req-1', generation: 1 });
      expect(await apply(sameId)).toMatchObject({ outcome: 'rejected', code: 'request_conflict' });
      await expect(secrets.get(SECRET_NAME)).resolves.toBe(KEY_A);
    });

    it('rejects any generation at or below the watermark, even after 257 operations evicted its receipt', async () => {
      const first = await configureRequest(sealingKey, KEY_A, { requestId: 'op-1', generation: 1 });
      await apply(first);
      for (let generation = 2; generation <= PROVIDER_CUSTODY_RECEIPT_LIMIT + 2; generation += 1) {
        const request = await replaceSecretRequest(sealingKey, KEY_A, { requestId: `op-${generation}`, generation, expected: await expectedOf() });
        expect(await apply(request)).toMatchObject({ outcome: 'applied' });
      }
      await expect(profiles.getReceipt('op-1')).resolves.toBeUndefined();
      expect(await apply(first)).toMatchObject({ outcome: 'rejected', code: 'operation_generation_stale' });
      const lower = await replaceSecretRequest(sealingKey, KEY_B, { requestId: 'op-new', generation: 5, expected: await expectedOf() });
      expect(await apply(lower)).toMatchObject({ code: 'operation_generation_stale' });
      await expect(secrets.get(SECRET_NAME)).resolves.toBe(KEY_A);
    });

    it('enforces 0 < ttl <= 15 min, bounded skew, and expiry; a rolled-back clock cannot revive an expired request', async () => {
      const tooLong = await configureRequest(sealingKey, KEY_A, { requestId: 'w1', generation: 1, expiresAt: '2026-09-28T05:15:00.001Z' });
      expect(await apply(tooLong)).toMatchObject({ code: 'request_window_invalid' });
      const empty = await configureRequest(sealingKey, KEY_A, { requestId: 'w2', generation: 2, expiresAt: ISSUED_AT });
      expect(await apply(empty)).toMatchObject({ code: 'request_window_invalid' });
      const future = await configureRequest(sealingKey, KEY_A, {
        requestId: 'w3', generation: 3, issuedAt: '2026-09-28T05:06:00.001Z', expiresAt: '2026-09-28T05:10:00.000Z',
      });
      expect(await apply(future)).toMatchObject({ code: 'request_not_yet_valid' });

      const late = await configureRequest(sealingKey, KEY_A, { requestId: 'w4', generation: 4 });
      clock = new Date('2026-09-28T05:15:00.001Z');
      const expired = await apply(late);
      expect(expired).toMatchObject({ outcome: 'rejected', code: 'request_expired' });
      clock = new Date(NOW);
      expect(await apply(late)).toEqual(expired);
      await expect(profiles.get(PROFILE_REF)).resolves.toBeUndefined();
      await expect(secrets.has(SECRET_NAME)).resolves.toBe(false);
    });

    it('reads back an applied result after its deadline (applied, ACK late)', async () => {
      const request = await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 });
      const applied = await apply(request);
      clock = new Date('2026-09-28T06:00:00.000Z');
      expect(await apply(request)).toEqual(applied);
    });
  });

  describe('update_model (A7)', () => {
    it('keeps the key and bumps the revision when kind, endpoint, auth and adapter are unchanged', async () => {
      await configured();
      const before = await expectedOf();
      const result = await apply(await updateModelRequest({ requestId: 'u1', generation: 2, expected: before, modelId: 'glm-5.3' }));
      expect(result).toMatchObject({ outcome: 'applied', secretConfigured: true });
      const after = await expectedOf();
      expect(after.profileRevision).not.toBe(before.profileRevision);
      expect(result.binding).toEqual({ ...after, modelId: 'glm-5.3' });
      await expect(secrets.get(SECRET_NAME)).resolves.toBe(KEY_A);
    });

    it('refuses a different provider kind', async () => {
      await configured();
      const result = await apply(await updateModelRequest({ requestId: 'u1', generation: 2, expected: await expectedOf(), providerKind: 'deepseek', modelId: 'deepseek-chat' }));
      expect(result).toMatchObject({ outcome: 'rejected', code: 'credential_scope_mismatch' });
    });

    it('refuses when the stored record has the same kind but an old custom URL, or a pre-upgrade catalog URL', async () => {
      for (const base_url of ['https://gateway.example.com/zai/v4', 'https://api.z.ai/api/paas/v4']) {
        const store = new SqliteProviderProfileStore({ path: join(directory, `${base_url.length}.sqlite`) });
        const registry = new ProviderRegistry({ profileStore: store, secretStore: secrets, now: () => clock });
        await registry.configure({
          profile_ref: PROFILE_REF, provider_kind: 'zai', adapter: 'openai_compatible', auth_mode: 'bearer',
          base_url, display_name: 'Z.AI', model: 'glm-5.3-flash', pi_model: PI_MODEL_FIXTURE, capabilities: [],
        }, KEY_A);
        const binding = exactProviderProfileBinding((await store.get(PROFILE_REF))!, []);
        const result = await applySealedProviderProvisioning(options(
          await updateModelRequest({ requestId: 'u1', generation: 1, expected: { profileRef: binding.profileRef, profileRevision: binding.profileRevision, profileHash: binding.profileHash }, modelId: 'glm-5.3' }),
          { profileStore: store },
        ));
        expect(result).toMatchObject({ outcome: 'rejected', code: 'credential_scope_mismatch' });
        await expect(store.get(PROFILE_REF)).resolves.toMatchObject({ base_url, model: 'glm-5.3-flash' });
        await store.close();
      }
    });

    it('refuses to act on an unknown profile', async () => {
      expect(await apply(await updateModelRequest({ requestId: 'u1', generation: 1, modelId: 'glm-5.3' }))).toMatchObject({ code: 'profile_not_found' });
    });
  });

  describe('replace_secret (D4)', () => {
    it('replaces only the key: provider revision and hash stay identical', async () => {
      await configured();
      const before = await profiles.get(PROFILE_REF);
      const expected = await expectedOf();
      clock = new Date('2026-09-28T05:05:00.000Z');
      const result = await apply(await replaceSecretRequest(sealingKey, KEY_B, { requestId: 'r1', generation: 2, expected }));
      expect(result).toMatchObject({ outcome: 'applied', binding: { ...expected, modelId: 'glm-5.3-flash' }, secretConfigured: true });
      expect(await profiles.get(PROFILE_REF)).toEqual(before);
      expect(await expectedOf()).toEqual(expected);
      await expect(secrets.get(SECRET_NAME)).resolves.toBe(KEY_B);
    });

    it('refuses a key declared for a different provider kind or a missing profile', async () => {
      expect(await apply(await replaceSecretRequest(sealingKey, KEY_B, { requestId: 'r0', generation: 1 }))).toMatchObject({ code: 'profile_not_found' });
      expect(await apply(await configureRequest(sealingKey, KEY_A, { requestId: 'req-2', generation: 2 }))).toMatchObject({ outcome: 'applied' });
      const result = await apply(await replaceSecretRequest(sealingKey, KEY_B, { requestId: 'r3', generation: 3, expected: await expectedOf(), providerKind: 'openai' }));
      expect(result).toMatchObject({ code: 'credential_scope_mismatch' });
      await expect(secrets.get(SECRET_NAME)).resolves.toBe(KEY_A);
    });
  });

  describe('delete and tombstones (A8)', () => {
    it('removes profile and key, and the watermark keeps rejecting older requests', async () => {
      const first = await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 });
      await apply(first);
      const result = await apply(await deleteRequest({ requestId: 'd1', generation: 2, expected: await expectedOf() }));
      expect(result).toMatchObject({ outcome: 'applied', binding: null, secretConfigured: false });
      await expect(profiles.get(PROFILE_REF)).resolves.toBeUndefined();
      await expect(secrets.has(SECRET_NAME)).resolves.toBe(false);
      const replay = await configureRequest(sealingKey, KEY_C, { requestId: 'old-2', generation: 2 });
      expect(await apply(replay)).toMatchObject({ code: 'operation_generation_stale' });
      const fresh = await configureRequest(sealingKey, KEY_C, { requestId: 'req-3', generation: 3 });
      expect(await apply(fresh)).toMatchObject({ outcome: 'applied' });
    });

    it('treats deleting an absent profile with no expectation as applied', async () => {
      expect(await apply(await deleteRequest({ requestId: 'd1', generation: 1 }))).toMatchObject({ outcome: 'applied', secretConfigured: false });
    });
  });

  describe('pending markers (D5)', () => {
    async function leaveInterrupted(requestId: string, generation: number): Promise<void> {
      await profiles.markPending({ profileRef: PROFILE_REF, operation: 'configure', requestId, operationGeneration: generation, since: NOW });
      await secrets.set(SECRET_NAME, KEY_B);
    }

    it('never auto-recovers: the same request, update_model and readers all refuse; a new key resolves it', async () => {
      await configured();
      const expected = await expectedOf();
      const interrupted = await configureRequest(sealingKey, KEY_B, { requestId: 'req-2', generation: 2, expected, providerKind: 'openai', modelId: 'gpt-5.2' });
      await leaveInterrupted('req-2', 2);

      expect(await apply(interrupted)).toMatchObject({ outcome: 'rejected', code: 'local_commit_interrupted' });
      await expect(profiles.getPending(PROFILE_REF)).resolves.toMatchObject({ requestId: 'req-2' });
      expect(await apply(await updateModelRequest({ requestId: 'u3', generation: 3, expected, modelId: 'glm-5.3' })))
        .toMatchObject({ code: 'local_commit_interrupted' });
      const profile = (await profiles.get(PROFILE_REF))!;
      await expect(readProviderCustodySnapshot({ profiles, profile, createSecretStore: () => secrets }))
        .rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_PENDING' });
      const registry = new ProviderRegistry({ profileStore: profiles, secretStore: secrets });
      await expect(registry.get(PROFILE_REF)).resolves.toMatchObject({ configuration_pending: true });

      const repaired = await apply(await replaceSecretRequest(sealingKey, KEY_C, { requestId: 'r4', generation: 4, expected }));
      expect(repaired).toMatchObject({ outcome: 'applied' });
      await expect(profiles.getPending(PROFILE_REF)).resolves.toBeUndefined();
      await expect(readProviderCustodySnapshot({ profiles, profile, createSecretStore: () => secrets })).resolves.toBe(KEY_C);
    });

    it('records a credential-store failure as secret_store_unavailable and keeps the marker', async () => {
      await configured();
      vi.spyOn(secrets, 'set').mockRejectedValueOnce(new ByokKeysError('KEYCHAIN_WRITE_FAILED', `security: ${KEY_B} exit 45`));
      const result = await apply(await replaceSecretRequest(sealingKey, KEY_B, { requestId: 'r2', generation: 2, expected: await expectedOf() }));
      expect(result).toMatchObject({ outcome: 'rejected', code: 'secret_store_unavailable' });
      expect(JSON.stringify(result)).not.toContain('exit 45');
      await expect(profiles.getPending(PROFILE_REF)).resolves.toMatchObject({ requestId: 'r2' });
    });

    it('rejects before marking when the credential store is unavailable', async () => {
      vi.spyOn(secrets, 'available').mockResolvedValueOnce(false);
      const result = await apply(await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 }));
      expect(result).toMatchObject({ code: 'secret_store_unavailable' });
      await expect(profiles.getPending(PROFILE_REF)).resolves.toBeUndefined();
    });
  });

  describe('key check (D13, A10)', () => {
    const response = (status: number, body: unknown = { choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    it.each([
      [200, 'ok'],
      [401, 'credential_rejected'],
      [403, 'model_not_permitted'],
      [404, 'model_not_permitted'],
      [402, 'quota_or_billing'],
      [429, 'rate_limited'],
      [500, 'provider_error'],
    ] as const)('HTTP %i → %s, recorded on the receipt', async (status, outcome) => {
      const fetchImpl = vi.fn(async () => response(status, status === 200 ? undefined : { error: { message: 'x' } }));
      const result = await apply(await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 }), { keyCheck: { fetchImpl } });
      expect(result.keyCheck).toBe(outcome);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect((await profiles.getReceipt('req-1'))?.result.keyCheck).toBe(outcome);
    });

    it('maps a network failure to unreachable and its own deadline to timeout', async () => {
      const network = await apply(await configureRequest(sealingKey, KEY_A, { requestId: 'n1', generation: 1 }), {
        keyCheck: { fetchImpl: async () => { throw new TypeError('fetch failed'); } },
      });
      expect(network.keyCheck).toBe('unreachable');
      const slow = await apply(await replaceSecretRequest(sealingKey, KEY_B, { requestId: 'n2', generation: 2, expected: await expectedOf() }), {
        keyCheck: {
          timeoutMs: 20,
          fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
        },
      });
      expect(slow.keyCheck).toBe('timeout');
    });

    it('never runs for delete or a replayed request', async () => {
      const fetchImpl = vi.fn(async () => response(200));
      const request = await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 });
      await apply(request, { keyCheck: { fetchImpl } });
      await apply(request, { keyCheck: { fetchImpl } });
      await apply(await deleteRequest({ requestId: 'd1', generation: 2, expected: await expectedOf() }), { keyCheck: { fetchImpl } });
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('does not let a stale check overwrite a newer operation', async () => {
      await configured();
      await apply(await replaceSecretRequest(sealingKey, KEY_B, { requestId: 'r2', generation: 2, expected: await expectedOf() }));
      await expect(profiles.recordKeyCheck('req-1', 1, 'ok')).resolves.toBe(false);
      expect((await profiles.getReceipt('req-1'))?.result.keyCheck).toBe('not_run');
    });
  });

  describe('no secret in results, receipts, errors or the database', () => {
    it('keeps every canary out of every observable output', async () => {
      const results: ProviderProvisioningResult[] = [];
      results.push(await apply(await configureRequest(sealingKey, KEY_A, { requestId: 'req-1', generation: 1 })));
      results.push(await apply(await replaceSecretRequest(sealingKey, KEY_B, { requestId: 'r2', generation: 2, expected: await expectedOf() })));
      results.push(await apply(await replaceSecretRequest(sealingKey, KEY_C, { requestId: 'r3', generation: 3 })));
      vi.spyOn(secrets, 'set').mockRejectedValueOnce(new Error(`os said ${KEY_C}`));
      results.push(await apply(await replaceSecretRequest(sealingKey, KEY_C, { requestId: 'r4', generation: 4, expected: await expectedOf() })));
      const registry = new ProviderRegistry({ profileStore: profiles, secretStore: secrets });
      const statuses = JSON.stringify(await registry.list());
      const receipts = JSON.stringify(await Promise.all(['req-1', 'r2', 'r3', 'r4'].map((id) => profiles.getReceipt(id))));
      await profiles.close();
      const databaseBytes = readdirSync(directory)
        .filter((name) => name.startsWith('provider-profile.sqlite'))
        .map((name) => readFileSync(join(directory, name)));
      profiles = new SqliteProviderProfileStore({ path: dbPath });
      for (const canary of CANARIES) {
        expect(JSON.stringify(results)).not.toContain(canary);
        expect(statuses).not.toContain(canary);
        expect(receipts).not.toContain(canary);
        for (const bytes of databaseBytes) expect(bytes.includes(Buffer.from(canary))).toBe(false);
        for (const error of thrown) expect(String((error as Error).message)).not.toContain(canary);
      }
    });
  });
});

describe('parseModelProviderProfile fixture sanity', () => {
  it('the zai catalog entry accepts the Pi fixture', () => {
    expect(() => parseModelProviderProfile({
      adapter: 'openai_compatible', auth_mode: 'bearer', base_url: 'https://api.z.ai/api/coding/paas/v4', capabilities: [],
      created_at: EXPIRES_AT, updated_at: EXPIRES_AT, display_name: 'Z.AI', enabled: false, kind: 'model',
      model: 'glm-5.3-flash', pi_model: PI_MODEL_FIXTURE, profile_ref: PROFILE_REF, provider_kind: 'zai',
    })).not.toThrow();
  });
});

export type { ProviderProvisioningRequestV1 };
