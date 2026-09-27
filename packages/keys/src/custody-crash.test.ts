/**
 * D5 crash safety, proven with real process death.
 *
 * A child `node` process applies a provider change that moves a bot from one
 * vendor (zai, key A) to another (openai, key B) and SIGKILLs itself at each
 * persistence cut point. The parent then reads exactly what the launcher
 * reads — a read-only SQLite store plus the credential store, through
 * `readProviderCustodySnapshot` — and asserts that "old profile + new key" is
 * never readable: the reader either refuses (pending marker) or gets a
 * consistent pair.
 *
 * The credential store is a file-backed test store so a write made by the
 * killed child stays observable, as it would in the OS credential store.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeviceSealingKeyStore } from './device-sealing-key';
import { FileSecretStore } from './fixtures/file-secret-store';
import { DEVICE, NOW, PROFILE_REF, TENANT, configureRequest, placedIdentity, replaceSecretRequest } from './fixtures/provisioning-requests';
import { readProviderCustodySnapshot } from './pi-provider-launcher-core';
import { exactProviderProfileBinding } from './provider-profile';
import { modelProviderSecretName } from './secret-store';
import { applySealedProviderProvisioning, type ProviderProvisioningCutPoint } from './sealed-provisioning';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable } from './sqlite-support';

const KEY_OLD = 'sk-crash-canary-old-1c9e';
const KEY_NEW = 'sk-crash-canary-new-7d42';
const HOOK = fileURLToPath(new URL('./fixtures/register-ts-hook.mjs', import.meta.url));
const CHILD = fileURLToPath(new URL('./fixtures/custody-child.ts', import.meta.url));
const NODE_ARGS = ['--experimental-strip-types', '--no-warnings', '--import', HOOK, CHILD];

/**
 * The device daemon is a Bun-compiled binary, so the crash and lock suites run
 * the child under Bun too when an interpreter is available. Lookup mirrors the
 * repository bun test gate: `BYOK_REQUIRE_BUN=1` (CI build-test job) turns a
 * missing interpreter into a failure instead of a skip.
 */
function isFile(candidate: string | undefined): candidate is string {
  if (candidate === undefined) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
function resolveBun(): string | undefined {
  const explicit = process.env.BYOK_TEST_BUN_BIN;
  if (process.env.BYOK_REQUIRE_BUN === '1' && explicit !== undefined) {
    if (!isFile(explicit)) throw new Error(`BYOK_REQUIRE_BUN=1 and BYOK_TEST_BUN_BIN=${explicit} is missing or not a file`);
    return explicit;
  }
  const found = [explicit, join(os.homedir(), '.local/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'].find(isFile);
  if (found === undefined && process.env.BYOK_REQUIRE_BUN === '1') throw new Error('BYOK_REQUIRE_BUN=1 but no bun interpreter was found');
  return found;
}
const BUN = resolveBun();
const RUNTIMES: Array<{ name: string; command: string | undefined; args: string[] }> = [
  { name: 'node', command: process.execPath, args: NODE_ARGS },
  { name: 'bun', command: BUN, args: [CHILD] },
];

let directory: string;
let dbPath: string;
let secretPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'byok-keys-crash-'));
  dbPath = join(directory, 'provider-profile.sqlite');
  secretPath = join(directory, 'credentials.json');
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

async function seedOldVendor(): Promise<string> {
  const profileStore = new SqliteProviderProfileStore({ path: dbPath });
  const secretStore = new FileSecretStore(secretPath);
  const enrollment = { tenantId: TENANT, deviceId: DEVICE };
  const sealingKey = await new DeviceSealingKeyStore({ secretStore }).loadOrCreate(enrollment);
  const seeded = await applySealedProviderProvisioning({
    request: await configureRequest(sealingKey, KEY_OLD, { requestId: 'seed', generation: 1 }),
    profileStore,
    secretStore,
    sealingKey,
    resolveProfileRef: () => PROFILE_REF,
    readIdentity: async () => placedIdentity(),
    now: () => new Date(NOW),
  });
  expect(seeded.outcome).toBe('applied');
  const binding = exactProviderProfileBinding((await profileStore.get(PROFILE_REF))!, []);
  const moveRequest = await configureRequest(sealingKey, KEY_NEW, {
    requestId: 'move',
    generation: 2,
    expected: { profileRef: binding.profileRef, profileRevision: binding.profileRevision, profileHash: binding.profileHash },
    providerKind: 'openai',
    modelId: 'gpt-5.2',
  });
  await profileStore.close();
  const requestPath = join(directory, 'move.json');
  writeFileSync(requestPath, JSON.stringify(moveRequest));
  return requestPath;
}

/** What the launcher can read after the crash: a refusal or a consistent pair. */
async function launcherView(): Promise<{ refused: string } | { vendor: string; key: string | undefined }> {
  const profiles = new SqliteProviderProfileStore({ path: dbPath, readOnly: true });
  try {
    const profile = (await profiles.get(PROFILE_REF))!;
    try {
      const key = await readProviderCustodySnapshot({ profiles, profile, createSecretStore: () => new FileSecretStore(secretPath) });
      return { vendor: profile.provider_kind, key };
    } catch (error) {
      return { refused: (error as { code?: string }).code ?? 'unknown' };
    }
  } finally {
    await profiles.close();
  }
}

for (const runtime of RUNTIMES) {
describe.skipIf(!isSqliteAvailable() || runtime.command === undefined)(`custody under SIGKILL (D5), child on ${runtime.name}`, () => {
  function runChild(mode: string, args: object): ReturnType<typeof spawnSync> {
    return spawnSync(runtime.command!, [...runtime.args, mode, JSON.stringify(args)], { encoding: 'utf8', timeout: 60_000 });
  }

  const expectations: Record<ProviderProvisioningCutPoint, 'refused' | 'new'> = {
    'after-pending': 'refused',
    'after-secret-write': 'refused',
    'after-commit': 'new',
  };

  for (const [cutPoint, expected] of Object.entries(expectations) as Array<[ProviderProvisioningCutPoint, 'refused' | 'new']>) {
    it(`killed ${cutPoint}: never old profile + new key`, async () => {
      const requestPath = await seedOldVendor();
      const child = runChild('apply', {
        dbPath, secretPath, requestPath, cutPoint, now: NOW, tenantId: TENANT, deviceId: DEVICE, profileRef: PROFILE_REF,
      });
      expect(child.signal, String(child.stderr)).toBe('SIGKILL');

      const view = await launcherView();
      expect(view).not.toEqual({ vendor: 'zai', key: KEY_NEW });
      if (expected === 'refused') {
        expect(view).toEqual({ refused: 'PROVIDER_CONFIGURATION_PENDING' });
      } else {
        expect(view).toEqual({ vendor: 'openai', key: KEY_NEW });
      }

      // A re-delivered copy of the interrupted request never resumes it.
      const profileStore = new SqliteProviderProfileStore({ path: dbPath });
      const secretStore = new FileSecretStore(secretPath);
      const enrollment = { tenantId: TENANT, deviceId: DEVICE };
      const sealingKey = await new DeviceSealingKeyStore({ secretStore }).loadOrCreate(enrollment);
      const again = await applySealedProviderProvisioning({
        request: JSON.parse(readFileSync(requestPath, 'utf8')),
        profileStore, secretStore, sealingKey,
        resolveProfileRef: () => PROFILE_REF, readIdentity: async () => placedIdentity(), now: () => new Date(NOW),
      });
      if (expected === 'refused') {
        expect(again).toMatchObject({ outcome: 'rejected', code: 'local_commit_interrupted' });
        expect(await launcherView()).toEqual({ refused: 'PROVIDER_CONFIGURATION_PENDING' });
      } else {
        // Applied before the kill: the same request reads back its stored result.
        expect(again).toMatchObject({ outcome: 'applied', requestId: 'move' });
      }
      await profileStore.close();
    });
  }

  for (const cutPoint of ['after-pending', 'after-secret-write'] as const) {
    it(`F1 killed ${cutPoint}: an older generation stays fenced after restart; only a higher generation with a key recovers`, async () => {
      const requestPath = await seedOldVendor();
      const enrollment = { tenantId: TENANT, deviceId: DEVICE };
      let profileStore = new SqliteProviderProfileStore({ path: dbPath });
      const secretStore = new FileSecretStore(secretPath);
      const sealingKey = await new DeviceSealingKeyStore({ secretStore }).loadOrCreate(enrollment);
      const binding = exactProviderProfileBinding((await profileStore.get(PROFILE_REF))!, []);
      const expected = { profileRef: binding.profileRef, profileRevision: binding.profileRevision, profileHash: binding.profileHash };
      const older = await replaceSecretRequest(sealingKey, 'sk-crash-older-2', { requestId: 'older', generation: 2, expected });
      const newer = await replaceSecretRequest(sealingKey, 'sk-crash-newer-3', { requestId: 'newer', generation: 3, expected });
      await profileStore.close();
      writeFileSync(requestPath, JSON.stringify(newer));

      const child = runChild('apply', {
        dbPath, secretPath, requestPath, cutPoint, now: NOW, tenantId: TENANT, deviceId: DEVICE, profileRef: PROFILE_REF,
      });
      expect(child.signal, String(child.stderr)).toBe('SIGKILL');

      // A fresh process view (restart): new store handles over the same files.
      profileStore = new SqliteProviderProfileStore({ path: dbPath });
      const apply = (request: unknown) => applySealedProviderProvisioning({
        request, profileStore, secretStore, sealingKey,
        resolveProfileRef: () => PROFILE_REF, readIdentity: async () => placedIdentity(), now: () => new Date(NOW),
      });
      const keyBefore = await secretStore.get(modelProviderSecretName(PROFILE_REF));
      expect(await apply(older)).toMatchObject({ outcome: 'rejected', code: 'operation_generation_stale' });
      expect(await apply(newer)).toMatchObject({ outcome: 'rejected', code: 'local_commit_interrupted' });
      await expect(secretStore.get(modelProviderSecretName(PROFILE_REF))).resolves.toBe(keyBefore);
      expect(await launcherView()).toEqual({ refused: 'PROVIDER_CONFIGURATION_PENDING' });

      const recovery = await replaceSecretRequest(sealingKey, 'sk-crash-recovered-4', { requestId: 'recover', generation: 4, expected });
      expect(await apply(recovery)).toMatchObject({ outcome: 'applied' });
      await profileStore.close();
      expect(await launcherView()).toEqual({ vendor: 'zai', key: 'sk-crash-recovered-4' });
    });
  }

  it('F6 killed after-secret-write: a same-id different-digest request (same and other profile) is a conflict after restart', async () => {
    const requestPath = await seedOldVendor();
    const enrollment = { tenantId: TENANT, deviceId: DEVICE };
    let profileStore = new SqliteProviderProfileStore({ path: dbPath });
    const secretStore = new FileSecretStore(secretPath);
    const sealingKey = await new DeviceSealingKeyStore({ secretStore }).loadOrCreate(enrollment);
    const binding = exactProviderProfileBinding((await profileStore.get(PROFILE_REF))!, []);
    const expected = { profileRef: binding.profileRef, profileRevision: binding.profileRevision, profileHash: binding.profileHash };
    const original = await replaceSecretRequest(sealingKey, 'sk-f6-original', { requestId: 'dup', generation: 2, expected });
    await profileStore.close();
    writeFileSync(requestPath, JSON.stringify(original));
    const child = runChild('apply', {
      dbPath, secretPath, requestPath, cutPoint: 'after-secret-write', now: NOW, tenantId: TENANT, deviceId: DEVICE, profileRef: PROFILE_REF,
    });
    expect(child.signal, String(child.stderr)).toBe('SIGKILL');

    profileStore = new SqliteProviderProfileStore({ path: dbPath });
    const otherAgent = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const otherRef = 'salesko-9a8b7c6d5e4f4a3b8c2d1e0f9a8b7c6d';
    const apply = (request: unknown) => applySealedProviderProvisioning({
      request, profileStore, secretStore, sealingKey,
      resolveProfileRef: (agentId) => (agentId === otherAgent ? otherRef : PROFILE_REF),
      readIdentity: async (agentId) => ({ ...placedIdentity(), placement: { agentId, placementRevision: 'placement-1' } }),
      now: () => new Date(NOW),
    });
    const keyBefore = await secretStore.get(modelProviderSecretName(PROFILE_REF));
    const sameProfile = await replaceSecretRequest(sealingKey, 'sk-f6-same', { requestId: 'dup', generation: 3, expected });
    const otherProfile = await configureRequest(sealingKey, 'sk-f6-other', { requestId: 'dup', generation: 1, agentId: otherAgent });
    expect(await apply(sameProfile)).toMatchObject({ outcome: 'rejected', code: 'request_conflict' });
    expect(await apply(otherProfile)).toMatchObject({ outcome: 'rejected', code: 'request_conflict' });
    await expect(secretStore.has(modelProviderSecretName(otherRef))).resolves.toBe(false);
    await expect(secretStore.get(modelProviderSecretName(PROFILE_REF))).resolves.toBe(keyBefore);
    expect(await apply(original)).toMatchObject({ outcome: 'rejected', code: 'local_commit_interrupted', requestId: 'dup' });
    await profileStore.close();
    expect(await launcherView()).toEqual({ refused: 'PROVIDER_CONFIGURATION_PENDING' });
  });

  it('the configuration lock is cross-process and released by process death', async () => {
    await new SqliteProviderProfileStore({ path: dbPath }).close();
    const holder = spawn(runtime.command!, [...runtime.args, 'hold-lock', JSON.stringify({ dbPath })], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once('data', (chunk: Buffer) => (String(chunk).includes('locked') ? resolve() : reject(new Error(String(chunk)))));
        holder.once('exit', () => reject(new Error('lock holder exited early')));
      });
      const contender = new SqliteProviderProfileStore({ path: dbPath, configurationLockWaitMs: 200 });
      await expect(contender.acquireConfigurationLock()).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_BUSY' });
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.once('exit', resolve));
      const lock = await contender.acquireConfigurationLock();
      await lock.release();
      await contender.close();
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    }
  });
});
}
