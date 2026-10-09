import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandResult } from './command-runner';
import { exactProviderProfileBinding, parseModelProviderProfile, type ModelProviderProfileInput } from './provider-profile';
import { PI_MODEL_FIXTURE } from './fixtures/pi-model-config';
import { MacOsKeychainSecretStore } from './macos-keychain';
import {
  PI_AUTH_NONE_API_KEY,
  PI_PROJECTED_KEY_ENV,
  parsePiProviderLauncherOptions,
  runPiProviderLauncher,
} from './index';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable } from './sqlite-support';

/**
 * The public launcher entry (#323) and the keyless launch (#325), through a
 * real on-disk profile database and a real child process. The child stands in
 * for Pi: it records the key it received and the projection it was given.
 */

const HOST_PREFIX = 'aiphabee-b64-v1:';
const CANARY = 'sk-canary-host-store-0001';
const timestamps = { created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:00:00.000Z' };
const CHILD_EXIT_CODE = 7;
const CHILD_SOURCE = `
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const out = process.argv[process.argv.indexOf('--config') + 1];
writeFileSync(out, JSON.stringify({
  key: process.env.${PI_PROJECTED_KEY_ENV} ?? null,
  models: JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8')),
}));
process.exit(${CHILD_EXIT_CODE});
`;

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function providerProfile(overrides: Partial<ModelProviderProfileInput> = {}) {
  return parseModelProviderProfile({
    ...timestamps, pi_model: PI_MODEL_FIXTURE, adapter: 'openai_compatible', auth_mode: 'bearer',
    base_url: 'http://127.0.0.1:11434/v1', capabilities: [], display_name: 'Local model', enabled: true,
    kind: 'model', model: 'local-model', profile_ref: 'local', provider_kind: 'custom', ...overrides,
  });
}

async function fixture(overrides: Partial<ModelProviderProfileInput> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'keys-pi-entry-')));
  roots.push(root);
  const profileDb = path.join(root, 'profiles.db');
  const projection = path.join(root, 'projection');
  const output = path.join(root, 'child-output.json');
  const entry = path.join(root, 'fake-pi.mjs');
  await fs.mkdir(projection, { mode: 0o700 });
  await fs.writeFile(entry, CHILD_SOURCE);
  const profile = providerProfile(overrides);
  const writer = new SqliteProviderProfileStore({ path: profileDb });
  try { await writer.save(profile); } finally { await writer.close(); }
  const base = [
    '--pi-bin', process.execPath, '--pi-entry', entry, '--runtime-entry', 'pi-rpc',
    '--profile-db', profileDb, '--session-dir', path.join(root, 'sessions'),
    '--provider', profile.profile_ref, '--model', profile.model,
  ];
  const launch = (extra: string[] = []) => parsePiProviderLauncherOptions([
    ...base, ...extra, '--pi-cwd', root, '--pi-projection-dir', projection, '--pi-config-digest', 'a'.repeat(64),
    '--', '--config', output, '--mode', 'rpc',
  ]);
  const validate = (extra: string[] = []) => parsePiProviderLauncherOptions([...base, ...extra, '--validate-only', 'true']);
  const childOutput = async () => JSON.parse(await fs.readFile(output, 'utf8')) as {
    key: string | null;
    models: { providers: Record<string, { apiKey?: string; authHeader?: boolean }> };
  };
  return { root, profile, profileDb, projection, launch, validate, childOutput };
}

/** A host keychain whose stored value carries the host's own storage marker. */
function hostKeychain(prefix: string) {
  const calls: string[][] = [];
  const store = new MacOsKeychainSecretStore({
    platform: 'darwin',
    storagePrefix: prefix,
    commandRunner: async (_executable: string, args: string[]): Promise<CommandResult> => {
      calls.push(args);
      if (args[0] === 'find-generic-password') {
        return { exitCode: 0, stderr: '', stdout: `${HOST_PREFIX}${Buffer.from(CANARY, 'utf8').toString('base64')}\n` };
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    },
  });
  return { store, calls };
}

describe.skipIf(!isSqliteAvailable())('runPiProviderLauncher with a host-built store', () => {
  it('launches Pi with the key read from the host store under its own storage marker', async () => {
    const f = await fixture();
    const host = hostKeychain(HOST_PREFIX);
    const createSecretStore = vi.fn(() => host.store);
    await expect(runPiProviderLauncher(f.launch(), { createSecretStore })).resolves.toBe(CHILD_EXIT_CODE);
    expect(createSecretStore).toHaveBeenCalledTimes(1);
    expect((await f.childOutput()).key).toBe(CANARY);
    expect(await fs.readdir(f.projection)).toEqual([]);
  });

  it('fails closed with the default storage marker, which cannot decode the host value', async () => {
    const f = await fixture();
    const host = hostKeychain('byok-b64-v1:');
    await expect(runPiProviderLauncher(f.launch(), { createSecretStore: () => host.store }))
      .rejects.toMatchObject({ code: 'KEYCHAIN_SECRET_DECODE_FAILED' });
    expect(await fs.readdir(f.projection)).toEqual([]);
  });

  it('keeps the exact profile checks before the host store is built', async () => {
    const f = await fixture();
    const createSecretStore = vi.fn(() => hostKeychain(HOST_PREFIX).store);
    const binding = exactProviderProfileBinding(f.profile, []);
    await expect(runPiProviderLauncher({ ...f.launch(), modelId: 'other-model' }, { createSecretStore }))
      .rejects.toThrow(/does not match configured provider model/);
    await expect(runPiProviderLauncher(f.launch([
      '--profile-revision', binding.profileRevision, '--profile-hash', `sha256:${'0'.repeat(64)}`, '--required-capabilities', '[]',
    ]), { createSecretStore })).rejects.toThrow(/provider profile hash mismatch/);
    await expect(runPiProviderLauncher(f.validate([
      '--profile-revision', binding.profileRevision, '--profile-hash', binding.profileHash, '--required-capabilities', '[]',
    ]), { createSecretStore })).resolves.toBe(0);
    expect(createSecretStore).not.toHaveBeenCalled();
    expect(await fs.readdir(f.projection)).toEqual([]);
  });

  it('keeps the custody lock: a pending credential change refuses before the host store is built', async () => {
    const f = await fixture();
    const writer = new SqliteProviderProfileStore({ path: f.profileDb });
    try {
      await writer.markPending({
        profileRef: f.profile.profile_ref, operation: 'configure', requestId: 'r1',
        requestDigest: `sha256:${'3'.repeat(64)}`, operationGeneration: 2, since: timestamps.created_at,
      });
    } finally { await writer.close(); }
    const createSecretStore = vi.fn(() => hostKeychain(HOST_PREFIX).store);
    await expect(runPiProviderLauncher(f.validate(), { createSecretStore }))
      .rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_PENDING' });
    await expect(runPiProviderLauncher(f.launch(), { createSecretStore }))
      .rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_PENDING' });
    expect(createSecretStore).not.toHaveBeenCalled();
    expect(await fs.readdir(f.projection)).toEqual([]);
  });
});

describe.skipIf(!isSqliteAvailable())('keyless (auth_mode none) launch', () => {
  it('projects the fixed placeholder key for the rpc entry and reads no credential', async () => {
    const f = await fixture({ auth_mode: 'none' });
    const createSecretStore = vi.fn(() => hostKeychain(HOST_PREFIX).store);
    await expect(runPiProviderLauncher(f.launch(), { createSecretStore })).resolves.toBe(CHILD_EXIT_CODE);
    const output = await f.childOutput();
    expect(output.key).toBeNull();
    expect(output.models.providers['byok-sdk-local']).toMatchObject({ apiKey: PI_AUTH_NONE_API_KEY });
    expect(output.models.providers['byok-sdk-local']?.authHeader).toBeUndefined();
    expect(createSecretStore).not.toHaveBeenCalled();
  });

  it.each(['pi-durable', 'pi-prepared'] as const)('refuses a keyless profile for %s at admission with a typed error', async (entry) => {
    const f = await fixture({ auth_mode: 'none' });
    const options = { ...f.validate(), runtimeEntry: entry };
    await expect(runPiProviderLauncher(options, { createSecretStore: () => hostKeychain(HOST_PREFIX).store }))
      .rejects.toMatchObject({ code: 'PROVIDER_PROFILE_INVALID' });
  });
});

describe.skipIf(!isSqliteAvailable())('Anthropic base URL admission', () => {
  it('refuses at admission a profile whose endpoint Pi cannot reach exactly', async () => {
    const f = await fixture({
      adapter: 'anthropic', auth_mode: 'x_api_key', base_url: 'https://gateway.example/anthropic',
    });
    await expect(runPiProviderLauncher(f.validate(), { createSecretStore: () => hostKeychain(HOST_PREFIX).store }))
      .rejects.toMatchObject({ code: 'PROVIDER_URL_INVALID' });
  });
});
