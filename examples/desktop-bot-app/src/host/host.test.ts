import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryDeviceCredentialBackend } from '@byok-sdk/client/testing';
import { inspectProviderProfileStore, parseModelProviderProfile, SqliteProviderProfileStore } from '@byok-sdk/keys';
import { createByokServer } from '@byok-sdk/server';
import { BRIDGE_VERSION, encodeMessage, type HostState } from '../bridge/protocol.ts';
import { composeHost, lateServerConsumers, type HostCompositionOptions } from './compose.ts';
import { precheckHostStores } from './precheck.ts';
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
    expect(states.at(-1)).toMatchObject({ state: 'stopped', reason: expect.stringMatching(/^Store server-sqlite at .* is rejected/) });
    expect((await inspectProviderProfileStore(keysDb())).verdict).toBe('migration-required');
    await expect(stat(path.join(root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' });

    const reply = once(createInterface({ input: output }), 'line');
    input.write(encodeMessage({ id: 2, method: 'shutdown' }));
    expect(JSON.parse((await reply)[0] as string)).toEqual({ id: 2, result: null });
    await host;
  });
});
