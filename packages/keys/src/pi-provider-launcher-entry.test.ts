import { execFile } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestKeychain } from '../../../scripts/testing/macos-keychain.mjs';

import type { CommandResult } from './command-runner';
import { parseModelProviderProfile, type ModelProviderProfileInput } from './provider-profile';
import { exactProviderProfileBinding } from './provider-profile-binding';
import { PI_MODEL_FIXTURE } from './fixtures/pi-model-config';
import { MacOsKeychainSecretStore } from './macos-keychain';
import { LinuxSecretServiceSecretStore } from './linux-secret-service';
import {
  PI_AUTH_NONE_API_KEY,
  PI_PROJECTED_KEY_ENV,
  parsePiProviderLauncherOptions,
  runPiProviderLauncher,
} from './index';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable, openSqliteDatabase } from './sqlite-support';
import { ByokKeysError } from './errors';
import { InMemorySecretStore, modelProviderSecretName } from './secret-store';

/**
 * The public launcher entry (#323) and the keyless launch (#325), through a
 * real on-disk profile database and a real child process. The child stands in
 * for the rpc host: it records the key it found in its environment, the key it
 * received over the launcher's private IPC channel (#385), and the projection
 * it was given.
 */

const HOST_PREFIX = 'aiphabee-b64-v1:';
const CANARY = 'sk-canary-host-store-0001';
const timestamps = { created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:00:00.000Z' };
const CHILD_EXIT_CODE = 7;
const CHILD_SOURCE = `
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const out = process.argv[process.argv.indexOf('--config') + 1];
const configDigest = process.argv.find((arg) => arg.startsWith('--config-digest=')).slice('--config-digest='.length);
const receipt = await new Promise((resolve) => {
  process.once('message', resolve);
  process.send({ type: 'byok.pi.rpc.credential-request', configDigest });
});
process.disconnect();
writeFileSync(out, JSON.stringify({
  envKey: process.env.${PI_PROJECTED_KEY_ENV} ?? null,
  receipt,
  model: process.argv[process.argv.indexOf('--model') + 1],
  models: JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8')),
}));
process.exit(${CHILD_EXIT_CODE});
`;

const roots: string[] = [];

it('the executable selects Linux Secret Service with the requested service prefix', async () => {
  let selected: unknown;
  vi.stubGlobal('process', { ...process, platform: 'linux', exitCode: undefined });
  const run = vi.fn(async (_options, dependencies) => {
    selected = dependencies.createSecretStore();
    return 0;
  });
  vi.doMock('./pi-provider-launcher-core', () => ({
    parsePiProviderLauncherOptions: () => ({ secretServicePrefix: 'host.linux' }),
    runPiProviderLauncher: run,
  }));
  try {
    await import('./bin/pi-provider-launcher');
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(selected).toBeInstanceOf(LinuxSecretServiceSecretStore);
    expect((selected as LinuxSecretServiceSecretStore).providerLabel).toBe('Linux Secret Service');
  } finally {
    vi.doUnmock('./pi-provider-launcher-core');
    vi.unstubAllGlobals();
  }
});

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
    '--provider', profile.profile_ref,
  ];
  const launchArgs = (extra: string[] = []) => [
    ...base, ...extra, '--pi-cwd', root, '--pi-projection-dir', projection, '--pi-config-digest', 'a'.repeat(64),
    '--', '--config', output, '--mode', 'rpc',
  ];
  const launch = (extra?: string[]) => parsePiProviderLauncherOptions(launchArgs(extra));
  const validate = (extra: string[] = []) => parsePiProviderLauncherOptions([...base, ...extra, '--validate-only', 'true']);
  const childOutput = async () => JSON.parse(await fs.readFile(output, 'utf8')) as {
    envKey: string | null;
    receipt: { type: string; configDigest: string; secret: string | null };
    model: string;
    models: { providers: Record<string, { apiKey?: string; authHeader?: boolean; models: Array<{ id: string; input: string[] }> }> };
  };
  return { root, profile, profileDb, projection, launch, launchArgs, validate, childOutput, namespaceId: writer.credentialNamespaceId };
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

describe.skipIf(!(isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1'))('runPiProviderLauncher with a host-built store', () => {
  it('sanitizes a failed child spawn', async () => {
    const f = await fixture({ auth_mode: 'none' });
    const options = { ...f.launch(), piBin: path.join(f.root, CANARY, 'missing'), piFixedArgs: [CANARY] };
    const error = await runPiProviderLauncher(options, { createSecretStore: () => new InMemorySecretStore() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'ENOENT', message: 'spawn failed: ENOENT' });
    expect((error as Error).cause).toBeUndefined();
    for (const value of Object.values(Object.getOwnPropertyDescriptors(error))) {
      expect(JSON.stringify(value)).not.toContain(CANARY);
    }
    expect(await fs.readdir(f.projection)).toEqual([]);
  });

  it('sanitizes credential store read errors', async () => {
    const f = await fixture();
    const store = new InMemorySecretStore();
    const scoped = store.scope(f.namespaceId);
    vi.spyOn(scoped, 'get').mockRejectedValue(new ByokKeysError('KEYCHAIN_UNAVAILABLE', CANARY, { cause: new Error(CANARY) }));
    vi.spyOn(store, 'scope').mockReturnValue(scoped);
    const error = await runPiProviderLauncher(f.launch(), { createSecretStore: () => store }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'KEYCHAIN_UNAVAILABLE' });
    expect((error as Error).cause).toBeUndefined();
    for (const value of Object.values(Object.getOwnPropertyDescriptors(error))) {
      expect(JSON.stringify(value)).not.toContain(CANARY);
    }
    expect(await fs.readdir(f.projection)).toEqual([]);
  });
  it('launches Pi with the key read from the host store under its own storage marker', async () => {
    const f = await fixture();
    const host = hostKeychain(HOST_PREFIX);
    const createSecretStore = vi.fn(() => host.store);
    await expect(runPiProviderLauncher(f.launch(), { createSecretStore })).resolves.toBe(CHILD_EXIT_CODE);
    expect(createSecretStore).toHaveBeenCalledTimes(1);
    const args = host.calls.find(argv => argv[0] === 'find-generic-password')!;
    expect(args[args.indexOf('-s') + 1]).toBe(`com.byok.keys.scope.${f.namespaceId}.${modelProviderSecretName(f.profile.profile_ref)}`);
    const output = await f.childOutput();
    expect(output.envKey).toBeNull();
    expect(output.receipt).toEqual({ type: 'byok.pi.rpc.credential', configDigest: 'a'.repeat(64), secret: CANARY });
    expect(JSON.stringify(output.models)).not.toContain(CANARY);
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
    const changed = exactProviderProfileBinding({ ...f.profile, base_url: 'http://127.0.0.1:11500/v1' }, []);
    await expect(runPiProviderLauncher(f.launch([
      '--model', 'other-model', '--profile-revision', binding.profileRevision, '--profile-hash', changed.profileHash, '--required-capabilities', '[]',
    ]), { createSecretStore })).rejects.toThrow(/provider profile hash mismatch/);
    await expect(runPiProviderLauncher(f.validate([
      '--profile-revision', binding.profileRevision, '--profile-hash', binding.profileHash, '--required-capabilities', '[]',
    ]), { createSecretStore })).resolves.toBe(0);
    expect(createSecretStore).not.toHaveBeenCalled();
    expect(await fs.readdir(f.projection)).toEqual([]);
  });

  it('launches two overrides and the saved default against one exact profile', async () => {
    const f = await fixture();
    const host = { createSecretStore: () => hostKeychain(HOST_PREFIX).store };
    const binding = exactProviderProfileBinding(f.profile, []);
    for (const modelId of ['other-model', 'org/model:high', undefined]) {
      const options = f.launch([
        ...(modelId === undefined ? [] : ['--model', modelId]),
        '--profile-revision', binding.profileRevision, '--profile-hash', binding.profileHash, '--required-capabilities', '[]',
      ]);
      await expect(runPiProviderLauncher(options, host)).resolves.toBe(CHILD_EXIT_CODE);
      const output = await f.childOutput();
      expect(output.model).toBe(modelId ?? f.profile.model);
      expect(output.models.providers['byok-sdk-local']?.models[0]?.id).toBe(output.model);
      expect(output.receipt.secret).toBe(CANARY);
    }
  });

  it('projects the selected catalog model input instead of the saved model input', async () => {
    const f = await fixture({ provider_kind: 'openrouter', base_url: 'https://openrouter.ai/api/v1',
      model: 'amazon/nova-lite-v1', capabilities: ['image-input'] });
    const host = { createSecretStore: () => hostKeychain(HOST_PREFIX).store };
    const options = f.launch();
    const readInput = async () => (await f.childOutput()).models.providers['byok-sdk-local']?.models[0]?.input;
    await expect(runPiProviderLauncher({ ...options, modelId: 'amazon/nova-micro-v1',
      expectedBinding: exactProviderProfileBinding(f.profile, []) }, host)).resolves.toBe(CHILD_EXIT_CODE);
    expect(await readInput()).toEqual(['text']);
    await expect(runPiProviderLauncher({ ...options, modelId: 'amazon/nova-pro-v1',
      expectedBinding: exactProviderProfileBinding(f.profile) }, host)).resolves.toBe(CHILD_EXIT_CODE);
    expect(await readInput()).toEqual(['text', 'image']);
  });

  it('refuses an invalid database identity at admission before the host store is built', async () => {
    const f = await fixture();
    const writer = openSqliteDatabase(f.profileDb);
    try { writer.prepare('UPDATE provider_store_metadata SET credential_namespace_id = ?').run('invalid'); }
    finally { writer.close(); }
    const createSecretStore = vi.fn(() => new InMemorySecretStore());
    await expect(runPiProviderLauncher(f.validate(), { createSecretStore })).rejects.toMatchObject({ code: 'PROVIDER_STORE_SCHEMA_STALE' });
    expect(createSecretStore).not.toHaveBeenCalled();
  });

  it('reads each launched DB through the exact Linux service and account', async () => {
    const first = await fixture();
    const second = await fixture();
    const basePrefix = 'byok.test.2405';
    const account = 'test-account';
    const name = modelProviderSecretName(first.profile.profile_ref);
    const service = (id: string) => `${basePrefix}.scope.${id}.${name}`;
    const values = new Map([[service(first.namespaceId), CANARY], [service(second.namespaceId), 'second-canary']]);
    const commandRunner = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      expect(command).toBe('secret-tool');
      const [operation, serviceKey, target, accountKey, user] = args;
      expect([operation, serviceKey, accountKey, user]).toEqual(['lookup', 'service', 'account', account]);
      const value = values.get(target!);
      return value === undefined
        ? { exitCode: 1, stdout: '', stderr: '' }
        : { exitCode: 0, stdout: `byok-b64-v1:${Buffer.from(value).toString('base64')}\n`, stderr: '' };
    });
    const host = { createSecretStore: () => new LinuxSecretServiceSecretStore({ servicePrefix: basePrefix, account, platform: 'linux', commandRunner }) };
    for (const f of [first, second]) {
      await expect(runPiProviderLauncher(f.launch(), host)).resolves.toBe(CHILD_EXIT_CODE);
      expect((await f.childOutput()).receipt.secret).toBe(values.get(service(f.namespaceId)));
      expect(commandRunner).toHaveBeenLastCalledWith('secret-tool', ['lookup', 'service', service(f.namespaceId), 'account', account], undefined);
    }
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

// This test writes only to its disposable macOS keychain and test service prefix.
it.skipIf(process.platform !== 'darwin' || process.env.BYOK_TEST_MACOS_PROVIDER_NAMESPACE !== '1')(
  'the built launcher uses the selected DB identity in a real macOS Keychain', async () => {
    const profile_ref = 'r'.repeat(64);
    const first = await fixture({ profile_ref });
    const second = await fixture({ profile_ref });
    const name = modelProviderSecretName(profile_ref);
    const prefix = `byok-test-240.scope.acct_${'1'.repeat(64)}`;
    expect(Buffer.byteLength(`${prefix}.scope.${first.namespaceId}.${name}`)).toBe(210);
    const keychain = await createTestKeychain();
    const store = new MacOsKeychainSecretStore({ servicePrefix: prefix, keychainPath: keychain.path });
    const a = store.scope(first.namespaceId);
    const b = store.scope(second.namespaceId);
    const bin = fileURLToPath(new URL('../dist/bin/pi-provider-launcher.js', import.meta.url));
    const run = (f: typeof first) => promisify(execFile)(process.execPath, [bin, ...f.launchArgs([
      '--secret-service-prefix', prefix, '--macos-keychain-path', keychain.path,
    ])]);
    try {
      await a.set(name, CANARY);
      await b.set(name, 'second-canary');
      await store.set(name, 'base-decoy');
      for (const [f, key] of [[first, CANARY], [second, 'second-canary']] as const) {
        await expect(run(f)).rejects.toMatchObject({ code: CHILD_EXIT_CODE });
        expect((await f.childOutput()).receipt.secret).toBe(key);
      }
      await expect(a.delete(name)).resolves.toBe(true);
      await expect(run(first)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('requires a secret') });
      await expect(b.get(name)).resolves.toBe('second-canary');
    } finally {
      try { await Promise.all([a.delete(name), b.delete(name), store.delete(name)]); }
      finally { await keychain.dispose(); }
    }
  }, 30_000,
);

describe.skipIf(!(isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1'))('keyless (auth_mode none) launch', () => {
  it('projects the fixed placeholder key for the rpc entry and reads no credential', async () => {
    const f = await fixture({ auth_mode: 'none' });
    const createSecretStore = vi.fn(() => hostKeychain(HOST_PREFIX).store);
    await expect(runPiProviderLauncher(f.launch(), { createSecretStore })).resolves.toBe(CHILD_EXIT_CODE);
    const output = await f.childOutput();
    expect(output.envKey).toBeNull();
    expect(output.receipt).toEqual({ type: 'byok.pi.rpc.credential', configDigest: 'a'.repeat(64), secret: null });
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

describe.skipIf(!(isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1'))('Anthropic base URL admission', () => {
  it('refuses at admission a profile whose endpoint Pi cannot reach exactly', async () => {
    const f = await fixture({
      adapter: 'anthropic', auth_mode: 'x_api_key', base_url: 'https://gateway.example/anthropic',
    });
    await expect(runPiProviderLauncher(f.validate(), { createSecretStore: () => hostKeychain(HOST_PREFIX).store }))
      .rejects.toMatchObject({ code: 'PROVIDER_URL_INVALID' });
  });
});
