import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemorySecretStore, LinuxSecretServiceSecretStore, ProviderRegistry, modelProviderSecretName, SqliteProviderProfileStore,
  type ModelProviderSecretName, type ProviderConfiguration, type SecretStore,
} from '@byok-sdk/keys';
import type { ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { executionCatalog } from '../host/conversation/catalog.ts';
import { catalogEntryFor, ProviderProfiles } from '../host/keys/catalog.ts';
import { refusalReceipt, runCustody } from './child.ts';
import { keysMainHandlers } from './main-handlers.ts';
import { BridgeError } from '../bridge/protocol.ts';
import { CustodyError } from './protocol.ts';
import { CUSTODY_DEADLINE_MS, listFromCustody, submitToCustody, type CustodyChild } from './submit.ts';
import type { CommandChild } from '../main/host-command.ts';

const SECRET = 'sk-custody-test-secret-0123456789';
const CONFIGURATION: ProviderConfiguration = {
  adapter: 'openai_compatible', auth_mode: 'bearer', base_url: 'https://models.example.com/v1', capabilities: [],
  display_name: 'Writer model', enabled: false, model: 'writer-model', profile_ref: 'writer', provider_kind: 'custom',
  pi_model: { contextWindow: 8192, maxTokens: 1024, reasoning: false, thinkingLevel: 'off',
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' } },
};

let root: string;
let keysDb: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'byok-custody-'));
  keysDb = path.join(root, 'host', 'keys.db');
});
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

/** The custody child in process: its stdin, stdout and exit, around `runCustody` with an injected store. */
function custodyChild(secrets: SecretStore<ModelProviderSecretName>, receipts: string[]): CustodyChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  void runCustody(stdin, keysDb, secrets).then(result => ({ ok: true as const, ...result }), refusalReceipt).then(receipt => {
    const line = `${JSON.stringify(receipt)}\n`;
    receipts.push(line);
    stdout.end(line);
    events.emit('exit', receipt.ok ? 0 : 1);
  });
  const child: CustodyChild = { stdin, stdout, kill: vi.fn(() => true), once: (event, listener) => { events.once(event, listener); return child; } };
  return child;
}

describe('custody child', () => {
  it('commits the profile and key from one stdin request and returns a receipt without the secret', async () => {
    const secrets = new InMemorySecretStore<ModelProviderSecretName>();
    const receipts: string[] = [];
    const status = await submitToCustody(custodyChild(secrets, receipts), { op: 'configure', configuration: CONFIGURATION, secret: SECRET });

    expect(status).toMatchObject({ profile_ref: 'writer', secret_configured: true, configuration_pending: false });
    expect(await secrets.get(modelProviderSecretName('writer'))).toBe(SECRET);
    expect(receipts.join('')).not.toContain(SECRET);
    expect((await readFile(keysDb)).includes(SECRET)).toBe(false);

    // A non-default profile pins the catalog entry with the registry's own binding; a key rotation keeps it valid.
    const profiles = new ProviderProfiles(keysDb);
    const seen: string[] = [];
    profiles.subscribe(next => seen.push(...next.map(profile => profile.profile_ref)));
    const base = { deviceId: 'device', payload: { runtime: 'pi', instruction: 'reply' } } as unknown as ExecutionTemplate;
    const [profile] = await profiles.load();
    expect(catalogEntryFor(profile!, base)?.payload.dispatchSelection).toEqual({ lane: 'byok-profile', runtimeId: 'pi',
      providerProfile: { profileRef: 'writer', profileRevision: status.profile_revision, profileHash: status.profile_hash,
        modelId: 'writer-model', requiredCapabilities: [] } });
    // K8's catalog: the brand entries, then one pinned Pi entry per profile Pi can launch; nothing for a profile without pi_model.
    const { pi_model: _piModel, ...withoutPi } = profile!;
    const catalog = executionCatalog({ instruction: 'reply', models: { pi: { label: 'Pi', runtime: 'pi' } } }, 'device',
      [profile!, { ...withoutPi, profile_ref: 'no-pi' }]);
    expect(catalog.choices).toEqual([{ id: 'pi', label: 'Pi' }, { id: 'pi:writer', label: 'Writer model' }]);
    expect(catalog.models['pi:writer']).toEqual(catalogEntryFor(profile!, catalog.models.pi!));
    expect(() => executionCatalog({ instruction: 'reply', models: { 'pi:writer': { label: 'Brand', runtime: 'pi' } } }, 'device', [profile!]))
      .toThrow('brand.config.ts model pi:writer collides with the keys profile writer');
    // A store that is neither absent nor accepted refuses with the store's own reason.
    await expect(new ProviderProfiles(root).load()).rejects.toThrow(`Keys store ${root} is rejected: The store path is not a regular file`);
    const rotated = await submitToCustody(custodyChild(secrets, receipts), { op: 'replace_secret', profileRef: 'writer', secret: `${SECRET}-2` });
    expect([rotated.profile_revision, rotated.profile_hash]).toEqual([status.profile_revision, status.profile_hash]);
    await profiles.changed();
    expect(seen).toEqual(['writer']);
  });

  it('refuses a new profile without its secret even when the OS store still holds one under its ref', async () => {
    // As after start fresh: the keys store moved aside, its secret stayed in the OS store.
    const secrets = new InMemorySecretStore<ModelProviderSecretName>();
    await secrets.set(modelProviderSecretName('writer'), SECRET);
    await expect(submitToCustody(custodyChild(secrets, []), { op: 'configure', configuration: CONFIGURATION }))
      .rejects.toMatchObject({ code: 'custody_request_invalid' });
    expect(await listFromCustody(custodyChild(secrets, []))).toEqual([]);
  });

  it('lists every stored profile with the registry\'s own secret and pending state, and no secret', async () => {
    const secrets = new InMemorySecretStore<ModelProviderSecretName>();
    expect(await listFromCustody(custodyChild(secrets, []))).toEqual([]);
    await submitToCustody(custodyChild(secrets, []), { op: 'configure', configuration: CONFIGURATION, secret: SECRET });
    await submitToCustody(custodyChild(secrets, []), { op: 'configure', configuration: { ...CONFIGURATION, auth_mode: 'none', profile_ref: 'local' } });
    const receipts: string[] = [];
    const statuses = await listFromCustody(custodyChild(secrets, receipts));
    expect(statuses.map(status => [status.profile_ref, status.secret_configured, status.configuration_pending]))
      .toEqual([['local', false, false], ['writer', true, false]]);
    expect(receipts.join('')).not.toContain(SECRET);

    // A credential change that never finished: the registry reports it, and the list shows it.
    const store = new SqliteProviderProfileStore({ path: keysDb });
    await store.markPending({ profileRef: 'writer', operation: 'configure', requestId: null, requestDigest: null, operationGeneration: null, since: new Date().toISOString() });
    await store.close();
    expect((await listFromCustody(custodyChild(secrets, []))).find(status => status.profile_ref === 'writer')?.configuration_pending).toBe(true);
  });

  it('fails closed on Linux without secret-tool and names the missing tool', async () => {
    const missingTool = new LinuxSecretServiceSecretStore<ModelProviderSecretName>({
      platform: 'linux', commandRunner: async () => { throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }); },
    });
    const refused = submitToCustody(custodyChild(missingTool, []), { op: 'configure', configuration: CONFIGURATION, secret: SECRET });
    await expect(refused).rejects.toMatchObject({ code: 'KEYCHAIN_UNAVAILABLE', message: expect.stringContaining('install secret-tool') });
  });

  it('refuses a malformed request without quoting it', async () => {
    const receipts: string[] = [];
    const child = custodyChild(new InMemorySecretStore(), receipts);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end(`{"op":"configure","secret":"${SECRET}"`);
    await exited;
    expect(JSON.parse(receipts[0]!)).toEqual(refusalReceipt(new CustodyError('custody_request_invalid', 'Request is not JSON')));
  });

  it('answers a bad profileRef with invalid_params and never asks the Host to reload', async () => {
    const reloads: string[] = [];
    let spawned = 0;
    const submit = keysMainHandlers({
      spawnHostCommand: () => { spawned += 1; return custodyChild(new InMemorySecretStore(), []); },
      callHost: async method => { reloads.push(method); return null; },
    })['keys.submit'];
    await expect(submit({ op: 'replace_secret', profileRef: '../writer', secret: SECRET })).rejects.toMatchObject({ code: 'invalid_params' });
    // A list is not a change: keys.submit refuses it before spawning a custody child.
    await expect(submit({ op: 'list' } as never)).rejects.toMatchObject({ code: 'invalid_params' });
    expect(spawned).toBe(1);
    expect(reloads).toEqual([]);
  });

  it.each(['submit', 'list'] as const)('bounds a hung Host catalog refresh after %s without repeating a write', async operation => {
    vi.useFakeTimers();
    const secrets = new InMemorySecretStore<ModelProviderSecretName>();
    const write = vi.spyOn(secrets, 'set');
    let notify!: () => void;
    const refreshing = new Promise<void>(resolve => { notify = resolve; });
    const handlers = keysMainHandlers({
      spawnHostCommand: () => custodyChild(secrets, []),
      callHost: () => { notify(); return new Promise<null>(() => {}); },
    });
    const request = operation === 'submit'
      ? handlers['keys.submit']({ op: 'configure', configuration: CONFIGURATION, secret: SECRET })
      : handlers['keys.list'](undefined);
    const settled = Promise.resolve(request).then(value => ({ value }), (error: unknown) => ({ error }));
    await Promise.race([refreshing, settled]);
    await vi.advanceTimersByTimeAsync(CUSTODY_DEADLINE_MS);
    expect(await settled).toMatchObject({ error: { code: 'catalog_refresh_timeout',
      message: expect.stringContaining(operation === 'submit' ? 'The key change was saved' : 'Stored providers were read') } });
    expect(write).toHaveBeenCalledTimes(operation === 'submit' ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['stopped', new BridgeError('unknown_method', 'Unknown bridge method keys.profilesChanged')],
    ['not running', new BridgeError('host_exited', 'No Host is running')],
  ])('lists stored providers while the Host is %s', async (_state, refusal) => {
    const secrets = new InMemorySecretStore<ModelProviderSecretName>();
    const handlers = keysMainHandlers({ spawnHostCommand: () => custodyChild(secrets, []), callHost: () => Promise.reject(refusal) });
    await expect(Promise.resolve(handlers['keys.submit']({ op: 'configure', configuration: CONFIGURATION, secret: SECRET }))).rejects.toBe(refusal);
    const statuses = await handlers['keys.list'](undefined);
    expect(statuses.map(status => status.profile_ref)).toEqual(['writer']);
  });

  it('rebuilds the catalog on Reload after a committed change loses its receipt, without writing the key again', async () => {
    vi.useFakeTimers();
    const secrets = new InMemorySecretStore<ModelProviderSecretName>();
    const write = vi.spyOn(secrets, 'set');
    const profiles = new ProviderProfiles(keysDb);
    const brand = { instruction: 'reply', models: { pi: { label: 'Pi', runtime: 'pi' as const } } };
    let catalog = executionCatalog(brand, 'device', await profiles.load());
    profiles.subscribe(next => { catalog = executionCatalog(brand, 'device', next); });
    const lost = custodyChild(secrets, []);
    vi.spyOn(lost.stdout as PassThrough, 'end').mockReturnValue(lost.stdout as PassThrough);
    const committed = new Promise<void>(resolve => lost.once('exit', () => resolve()));
    const callHost = vi.fn(async () => { await profiles.changed(); return null; });
    let spawned = 0;
    const handlers = keysMainHandlers({ spawnHostCommand: () => (++spawned === 1 ? lost : custodyChild(secrets, [])), callHost });
    const request = handlers['keys.submit']({ op: 'configure', configuration: CONFIGURATION, secret: SECRET });
    const refused = expect(request).rejects.toMatchObject({ code: 'custody_timeout' });
    await committed;
    await vi.advanceTimersByTimeAsync(CUSTODY_DEADLINE_MS);
    await refused;
    expect(callHost).not.toHaveBeenCalled();
    expect(catalog.choices.map(choice => choice.id)).toEqual(['pi']);
    const statuses = await handlers['keys.list'](undefined);
    expect(statuses.map(status => status.profile_ref)).toEqual(['writer']);
    expect(catalog.choices.map(choice => choice.id)).toEqual(['pi', 'pi:writer']);
    expect(callHost).toHaveBeenCalledOnce();
    await expect(handlers['keys.list'](undefined)).resolves.toEqual(statuses);
    expect(callHost).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['submit', 'list'] as const)('bounds a hung %s before exit and while waiting for stdout', async operation => {
    vi.useFakeTimers();
    for (const exited of [false, true]) {
      const events = new EventEmitter();
      const child: CustodyChild = { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(() => true),
        once: (event, listener) => { events.once(event, listener); return child; } };
      const request = operation === 'list' ? listFromCustody(child)
        : submitToCustody(child, { op: 'replace_secret', profileRef: 'writer', secret: SECRET });
      const refused = expect(request).rejects.toMatchObject({ code: 'custody_timeout',
        message: expect.stringMatching(operation === 'list' ? /^(?!.*may still be saved).*Nothing was changed/ : /may still be saved.*reload stored providers/) });
      if (exited) { events.emit('exit', 0); await Promise.resolve(); }
      await vi.advanceTimersByTimeAsync(CUSTODY_DEADLINE_MS);
      await refused;
      // A list holds no configuration lock and is killed; a change keeps running and holding the lock, only the wait ends.
      if (operation === 'list') expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      else expect(child.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('cancels the deadline after a successful custody call', async () => {
    vi.useFakeTimers();
    const child = custodyChild(new InMemorySecretStore(), []);
    await expect(listFromCustody(child)).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(CUSTODY_DEADLINE_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects the submission when the custody child died before reading stdin', async () => {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const child: CommandChild = { stdin, stdout: new PassThrough(),
      once: (event, listener) => { events.once(event, listener); return child; } };
    const submitted = submitToCustody(child, { op: 'replace_secret', profileRef: 'writer', secret: SECRET });
    stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await expect(submitted).rejects.toMatchObject({ code: 'custody_exited' });
  });

  it('holds the configuration lock past a timed-out wait until the OS-store helper has written', { timeout: 30_000 }, async () => {
    // A real custody process whose OS store writes through a slow helper process, as `security` and `secret-tool` do.
    const osStore = path.join(root, 'os-store');
    const helper = `process.stdin.setEncoding('utf8'); let v = ''; process.stdin.on('data', c => { v += c; });
      process.stdin.on('end', () => setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(osStore)}, v), 1500));`;
    const script = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { runCommand } from '@byok-sdk/keys';
      import { runCustodyCommand } from ${JSON.stringify(path.resolve('src/custody/child.ts'))};
      const store = { providerLabel: 'test', available: async () => true, delete: async () => false,
        get: async () => (existsSync(${JSON.stringify(osStore)}) ? readFileSync(${JSON.stringify(osStore)}, 'utf8') : undefined),
        has: async () => existsSync(${JSON.stringify(osStore)}), scope() { return store; },
        set: async (_name, secret) => { writeFileSync(${JSON.stringify(`${osStore}.started`)}, ''); await runCommand(process.execPath, ['-e', ${JSON.stringify(helper)}], secret); } };
      process.exitCode = await runCustodyCommand(${JSON.stringify(keysDb)}, () => store);`;
    await new ProviderProfiles(keysDb).load();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let custody!: ChildProcess;
    const handlers = keysMainHandlers({
      spawnHostCommand: () => (custody = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] })),
      callHost: async () => null,
    });
    const first = Promise.resolve(handlers['keys.submit']({ op: 'configure', configuration: CONFIGURATION, secret: 'sk-first-synthetic' }));
    const refused = expect(first).rejects.toMatchObject({ code: 'custody_timeout' });
    while (!existsSync(`${osStore}.started`)) await sleep(20);
    await vi.advanceTimersByTimeAsync(CUSTODY_DEADLINE_MS);
    await refused;
    vi.useRealTimers();
    const exited = new Promise(resolve => custody.once('exit', resolve));
    const later = new ProviderRegistry({ profileStore: new SqliteProviderProfileStore({ path: keysDb, configurationLockWaitMs: 0 }), secretStore: {
      providerLabel: 'test', available: async () => true, delete: async () => false, has: async () => existsSync(osStore), scope() { return this; },
      get: async () => (existsSync(osStore) ? readFileSync(osStore, 'utf8') : undefined), set: async (_name, secret) => writeFileSync(osStore, secret) } });
    try {
      await expect(later.configure(CONFIGURATION, 'sk-later-synthetic')).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_BUSY' });
      await exited;
      expect(readFileSync(osStore, 'utf8')).toBe('sk-first-synthetic');
      await later.configure(CONFIGURATION, 'sk-later-synthetic');
      await sleep(2000);
      expect(readFileSync(osStore, 'utf8')).toBe('sk-later-synthetic');
    } finally {
      await later.close();
    }
  });
});
