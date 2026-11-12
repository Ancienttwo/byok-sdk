import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemorySecretStore, LinuxSecretServiceSecretStore, modelProviderSecretName, SqliteProviderProfileStore,
  type ModelProviderSecretName, type ProviderConfiguration, type SecretStore,
} from '@byok-sdk/keys';
import type { ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { executionCatalog } from '../host/conversation/catalog.ts';
import { catalogEntryFor, ProviderProfiles } from '../host/keys/catalog.ts';
import { refusalReceipt, runCustody } from './child.ts';
import { keysMainHandlers } from './main-handlers.ts';
import { CustodyError } from './protocol.ts';
import { CUSTODY_DEADLINE_MS, listFromCustody, submitToCustody, type CustodyChild } from './submit.ts';

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

  it.each(['submit', 'list'] as const)('bounds a hung %s before exit and while waiting for stdout', async operation => {
    vi.useFakeTimers();
    for (const exited of [false, true]) {
      const events = new EventEmitter();
      const child: CustodyChild = { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(() => true),
        once: (event, listener) => { events.once(event, listener); return child; } };
      const request = operation === 'list' ? listFromCustody(child)
        : submitToCustody(child, { op: 'replace_secret', profileRef: 'writer', secret: SECRET });
      const refused = expect(request).rejects.toMatchObject({ code: 'custody_timeout', message: expect.stringContaining('reload stored providers') });
      if (exited) { events.emit('exit', 0); await Promise.resolve(); }
      await vi.advanceTimersByTimeAsync(CUSTODY_DEADLINE_MS);
      await refused;
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      expect(child.stdin.destroyed && child.stdout.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('cancels the deadline after a successful custody call', async () => {
    vi.useFakeTimers();
    const child = custodyChild(new InMemorySecretStore(), []);
    await expect(listFromCustody(child)).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(CUSTODY_DEADLINE_MS);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects the submission when the custody child died before reading stdin', async () => {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const child: CustodyChild = { stdin, stdout: new PassThrough(), kill: vi.fn(() => true),
      once: (event, listener) => { events.once(event, listener); return child; } };
    const submitted = submitToCustody(child, { op: 'replace_secret', profileRef: 'writer', secret: SECRET });
    stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await expect(submitted).rejects.toMatchObject({ code: 'custody_exited' });
  });
});
