import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceCredentialBackend } from '@byok-sdk/client';
import { InMemoryDeviceCredentialBackend } from '@byok-sdk/client/testing';
import { inspectProviderProfileStore, parseModelProviderProfile, SqliteProviderProfileStore } from '@byok-sdk/keys';
import { createByokServer } from '@byok-sdk/server';
import { BRIDGE_VERSION, encodeMessage, type HostState } from '../bridge/protocol.ts';
import { composeHost, lateServerConsumers, type HostCompositionOptions } from './compose.ts';
import { precheckHostStores } from './precheck.ts';
import { startFresh } from './recovery.ts';
import { superviseHost } from './supervise.ts';

let root: string;
const options = (): HostCompositionOptions => ({
  productId: 'byok-desktop-test', productName: 'BYOK Desktop Test', releaseVersion: '0.0.1',
  storeDir: path.join(root, 'store'), hostStorageRoot: path.join(root, 'home'), deviceCredentials: new InMemoryDeviceCredentialBackend(),
  onChanged: () => {},
});
const keysDb = () => path.join(root, 'home', 'host', 'keys.db');

afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const makeRoot = async () => {
  // Short and real: the daemon's mutex socket path must fit the platform limit.
  root = await realpath(await mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'byok-desk-')));
};

/** A keys store as 0.41.0 wrote it: the current table rebuilt with the CHECK set before `opencode-go`. */
async function createKeysStore041(file: string): Promise<void> {
  const store = new SqliteProviderProfileStore({ path: file });
  const now = new Date().toISOString();
  await store.save(parseModelProviderProfile({
    adapter: 'openai_compatible', auth_mode: 'none', base_url: 'http://127.0.0.1:9/v1', capabilities: [], created_at: now, updated_at: now,
    display_name: 'Local', enabled: true, kind: 'model', model: 'local-model', profile_ref: 'local', provider_kind: 'custom',
  }));
  await store.close();
  const raw = new DatabaseSync(file);
  const { sql } = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'provider_profile'").get() as { sql: string };
  const earlier = sql.replace("'opencode-go', ", '');
  expect(earlier).not.toBe(sql);
  raw.exec(`
    ALTER TABLE provider_profile RENAME TO earlier;
    ${earlier};
    INSERT INTO provider_profile SELECT * FROM earlier;
    DROP TABLE earlier;
    CREATE UNIQUE INDEX provider_profile_one_enabled ON provider_profile(kind) WHERE enabled = 1;
  `);
  raw.close();
}

describe('desktop Host composition', () => {
  it('pairs in process on the first start only', { timeout: 120_000 }, async () => {
    await makeRoot();
    const config = options();
    const first = await composeHost(config);
    const deviceId = first.daemon.status().deviceId;
    expect(deviceId).toBeDefined();
    await first.close();

    const second = await composeHost(config);
    expect(second.daemon.status().deviceId).toBe(deviceId);
    // A custody receipt rebuilds K8's catalog: the new profile's Pi entry takes a Bot.
    const keys = new SqliteProviderProfileStore({ path: keysDb() });
    const now = new Date().toISOString();
    await keys.save(parseModelProviderProfile({
      adapter: 'openai_compatible', auth_mode: 'none', base_url: 'http://127.0.0.1:9/v1', capabilities: [], created_at: now, updated_at: now,
      display_name: 'Local', enabled: true, kind: 'model', model: 'local-model', profile_ref: 'local', provider_kind: 'custom',
      pi_model: { contextWindow: 8192, maxTokens: 1024, reasoning: false, thinkingLevel: 'off',
        compat: { supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' } },
    }));
    await keys.close();
    const bot = { id: 'writer', name: 'Writer', role: 'Writes', persona: 'Short.', model: 'pi:local' };
    await expect(second.domains.handlers['k8.saveBot'](bot)).rejects.toThrow('Unavailable model: pi:local');
    await second.domains.handlers['keys.profilesChanged'](undefined);
    await second.domains.handlers['k8.saveBot'](bot);
    expect((await second.domains.handlers['k8.view']({ botId: null })).models).toContainEqual({ id: 'pi:local', label: 'Local' });
    await second.close();

    // A server that no longer lists this device refuses the pairing; nothing re-pairs.
    await rm(path.join(root, 'home', 'host', 'server.sqlite'));
    await expect(composeHost(config)).rejects.toMatchObject({ name: 'HostStoppedError', message: 'Pairing with the embedded server refused: device_unknown' });
  });

  it('stops with the missing paths when the SDK asset root lacks its files', async () => {
    await makeRoot();
    const config = { ...options(), sdkHosting: { assetRoot: root, helperHost: { mode: 'self-executable' as const } } };
    await expect(composeHost(config)).rejects.toMatchObject({ name: 'HostStoppedError', message: expect.stringMatching(/^SDK hosting assets missing under /) });
  });

  it('holds a wake that is due before the consumers bind, and delivers it once they do', async () => {
    const late = lateServerConsumers();
    const server = createByokServer({ productId: 'byok-desktop-test', storage: { kind: 'memory' }, wake: late.wake, agentMessage: late.agentMessage });
    await server.wakes.schedule({ dedupKey: 'due', availableAt: Date.now() });
    await vi.waitFor(async () => expect((await server.wakes.pending())[0]?.state).toBe('delivering'));
    const consume = vi.fn(async () => {});
    late.bind({ consume, consumeMessage: async () => { throw new Error('no message expected'); } });
    await vi.waitFor(async () => expect(await server.wakes.pending()).toEqual([]));
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ dedupKey: 'due', delivery: 1 }), expect.any(AbortSignal));
    await server.close();
  });

  it('migrates a 0.41.0 keys store before any store opens', async () => {
    await makeRoot();
    await mkdir(path.dirname(keysDb()), { recursive: true });
    await createKeysStore041(keysDb());
    expect((await inspectProviderProfileStore(keysDb())).verdict).toBe('migration-required');

    await precheckHostStores({ storeDir: path.join(root, 'store'), serverDb: path.join(root, 'home', 'host', 'server.sqlite'), keysDb: keysDb() });

    expect((await inspectProviderProfileStore(keysDb())).verdict).toBe('accepted');
    const store = new SqliteProviderProfileStore({ path: keysDb(), readOnly: true });
    expect((await store.getEnabled())?.profile_ref).toBe('local');
    await store.close();
  });

  it('stops with the refused store and its reason, migrating and opening nothing', async () => {
    await makeRoot();
    const serverDb = path.join(root, 'home', 'host', 'server.sqlite');
    await mkdir(path.dirname(serverDb), { recursive: true });
    await writeFile(serverDb, 'not a database');
    // A Host that ran before: it kept its loopback port beside the stores.
    await writeFile(path.join(root, 'home', 'host', 'loopback-port'), '45678');
    await createKeysStore041(keysDb());
    const input = new PassThrough();
    const output = new PassThrough();
    const states: HostState[] = [];
    const stopped = new Promise<void>(resolve => createInterface({ input: output }).on('line', line => {
      const message = JSON.parse(line) as { event?: string; state: HostState };
      if (message.event !== 'state') return;
      states.push(message.state);
      if (message.state.state === 'stopped') resolve();
    }));
    const host = superviseHost(options(), { input, output });

    input.write(encodeMessage({ id: 1, method: 'hello', params: { bridgeVersion: BRIDGE_VERSION } }));
    await stopped;
    expect(states.at(-1)).toMatchObject({ state: 'stopped', storeRefused: true, reason: expect.stringMatching(/^Store server-sqlite at .* is rejected/) });
    expect((await inspectProviderProfileStore(keysDb())).verdict).toBe('migration-required');
    await expect(stat(path.join(root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' });

    // The stopped Host still writes the SDK support bundle.
    const lines = createInterface({ input: output });
    const exported = once(lines, 'line');
    input.write(encodeMessage({ id: 2, method: 'settings.exportDiagnostics' }));
    const bundle = JSON.parse((await exported)[0] as string) as { id: number; result: { path: string } };
    expect(bundle.id).toBe(2);
    expect((await stat(bundle.result.path)).isFile()).toBe(true);

    const reply = once(lines, 'line');
    input.write(encodeMessage({ id: 3, method: 'shutdown' }));
    expect(JSON.parse((await reply)[0] as string)).toEqual({ id: 3, result: null });
    await host;
  });

  it('starts fresh: moves the stores aside, clears the enrollment last, and moves everything back when the clear is refused', { timeout: 120_000 }, async () => {
    await makeRoot();
    const config = options();
    const backend = config.deviceCredentials as InMemoryDeviceCredentialBackend;
    const first = await composeHost(config);
    const firstDevice = first.daemon.status().deviceId;
    await first.close();
    const layout = { storeDir: config.storeDir, scratchRoot: { path: path.join(config.storeDir, 'tmp') }, hostStorageRoot: config.hostStorageRoot };
    const fresh = (stamp: string, deviceCredentials: DeviceCredentialBackend) => startFresh({ layout, productId: config.productId, stamp, deviceCredentials });

    const lockedKeychain = new Proxy(backend, {
      get: (target, key) => (key === 'clear' ? async () => { throw new Error('keychain locked'); }
        : (Reflect.get(target, key) as (...args: unknown[]) => unknown).bind(target)),
    });
    await expect(fresh('a', lockedKeychain)).rejects.toMatchObject({ code: 'clear_failed' });
    expect((await readdir(root)).sort()).toEqual(['home', 'store']);
    expect((await readdir(config.hostStorageRoot)).filter(name => name.includes('.aside-'))).toEqual([]);
    expect(await backend.read()).toBeDefined();

    const moved = await fresh('b', backend);
    expect(moved.map(move => path.relative(root, move.to)).sort()).toContain('store.aside-b');
    expect(moved.map(move => path.relative(root, move.to))).toContain(path.join('home', 'host.aside-b'));
    expect(await backend.read()).toBeUndefined();
    await expect(stat(config.storeDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const second = await composeHost(config);
    expect(second.daemon.status().deviceId).not.toBe(firstDevice);
    await second.close();
  });

  it('starts fresh without an SDK store: the Host stores move aside and nothing is cleared', async () => {
    await makeRoot();
    await mkdir(path.join(root, 'home', 'host'), { recursive: true });
    await writeFile(path.join(root, 'home', 'host', 'settings.json'), '{}');
    const layout = { storeDir: path.join(root, 'store'), scratchRoot: { path: path.join(root, 'store', 'tmp') }, hostStorageRoot: path.join(root, 'home') };
    const moved = await startFresh({ layout, productId: 'byok-desktop-test', stamp: 'c', deviceCredentials: new InMemoryDeviceCredentialBackend() });
    expect(moved.map(move => path.relative(root, move.to))).toEqual([path.join('home', 'host.aside-c')]);
  });
});
