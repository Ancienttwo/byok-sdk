import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, type TenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { pairDeviceDigest } from '@byok-sdk/protocol';
import { createSqliteEmbeddedStores } from '../stores/sqlite';

const tenant = 'tenant-a' as TenantId;
const other = 'tenant-b' as TenantId;
const registration = (deviceId: string, productId = 'product', machineId?: string, expectedDeviceDigest: string | null = null) => ({
  deviceId, productId, deviceName: 'fixture', devicePublicKey: 'test-key',
  proofKeyId: 'proof-key', proofKeyEpoch: 1, ...(machineId === undefined ? {} : { machineId }), expectedDeviceDigest,
});
const fence = (deviceId: string) => pairDeviceDigest({ tenantId: tenant, productId: 'product', deviceId });

describe('SQLite durable device authority', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function database() {
    const root = mkdtempSync(join(tmpdir(), 'byok-device-directory-')); roots.push(root);
    return join(root, 'server.sqlite');
  }
  const open = (path: string) => createSqliteEmbeddedStores(
    { path },
    { clock: createMutableClock(), crypto: createWebCrypto() },
  );

  it('persists supersession, tenant isolation, capabilities and revocation without restoring presence', async () => {
    const path = database(); let stores = open(path);
    try {
      await stores.cloud.devices.register(tenant, registration('old', 'product', 'machine'));
      await stores.cloud.devices.register(other, registration('other-tenant', 'product', 'machine'));
      await stores.cloud.devices.register(tenant, registration('other-product', 'other', 'machine'));
      await stores.cloud.devices.register(tenant, registration('new', 'product', 'machine', await fence('old')));
      await stores.cloud.devices.register(tenant, registration('unidentified-1'));
      await stores.cloud.devices.register(tenant, registration('unidentified-2'));
      await expect(stores.cloud.devices.register(other, registration('new'))).rejects.toThrow('another tenant');
      await stores.cloud.devices.revoke(other, 'new');
      await expect(stores.cloud.devices.recordCapabilities(other, { deviceId: 'new', capabilities: [] })).resolves.toBeUndefined();
      const declared = { deviceId: 'new', capabilities: ['agent-message-v1'], harnesses: [{ id: 'custom-test', capabilities: { mcpToolsets: true } }] };
      await stores.cloud.devices.recordCapabilities(tenant, declared);
      await stores.close(); stores = open(path);
      await expect(stores.cloud.devices.resolveByDeviceId('old')).resolves.toBeUndefined();
      await expect(stores.cloud.devices.get(other, 'new')).resolves.toBeUndefined();
      await expect(stores.cloud.devices.get(tenant, 'new')).resolves.toMatchObject(declared);
      expect((await stores.cloud.devices.list(tenant)).map(device => device.deviceId)).toEqual([
        'new', 'other-product', 'unidentified-1', 'unidentified-2',
      ]);
      await expect(stores.cloud.devices.readiness(tenant, stores.core.presence)).resolves.toMatchObject({
        activePairedDeviceCount: 4, observedPresenceCount: 0,
      });
      await stores.cloud.devices.revoke(tenant, 'new');
      await stores.close(); stores = open(path);
      await expect(stores.cloud.devices.resolveByDeviceId('new')).resolves.toBeUndefined();
      await expect(stores.cloud.devices.resolveByDeviceId('other-tenant')).resolves.toMatchObject({ tenantId: other });
    } finally { await stores.close(); }
  });

  it('rolls back supersession when the replacement record is invalid', async () => {
    const stores = open(database());
    try {
      await stores.cloud.devices.register(tenant, registration('old', 'product', 'machine'));
      await expect(stores.cloud.devices.register(tenant, {
        ...registration('new', 'product', 'machine', await fence('old')), proofKeyEpoch: -1,
      })).rejects.toThrow();
      await expect(stores.cloud.devices.resolveByDeviceId('old')).resolves.toMatchObject({ deviceId: 'old' });
      await expect(stores.cloud.devices.resolveByDeviceId('new')).resolves.toBeUndefined();
    } finally { await stores.close(); }
  });

  it.each(['1', '2', '3', '4', '5', '9'])('refuses a schema %s database at open and leaves it unchanged', async (version) => {
    const path = database(); await open(path).close();
    const old = new DatabaseSync(path);
    old.prepare("UPDATE byok_sqlite_meta SET value = ? WHERE key = 'schema_version'").run(version); old.close();
    expect(() => open(path)).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: version, requiredVersion: '10' }));
    expect(() => open(path)).toThrow('start on a new database');
    const read = new DatabaseSync(path, { readOnly: true });
    expect(read.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe(version);
    read.close();
  });

  it('refuses a released store before any write: the file bytes and its directory stay as they were', () => {
    const path = database();
    copyFileSync(new URL('../../../../scripts/release/fixtures/stores/0.43.0/server-sqlite.db', import.meta.url), path);
    const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex');
    const before = digest();
    expect(() => open(path)).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: '9' }));
    expect(digest()).toBe(before);
    expect(readdirSync(join(path, '..'))).toEqual(['server.sqlite']);
  });

  it('refuses a released store with pending WAL frames before any write: the file, its WAL and its directory stay as they were', () => {
    const source = database();
    copyFileSync(new URL('../../../../scripts/release/fixtures/stores/0.43.0/server-sqlite.db', import.meta.url), source);
    const writer = new DatabaseSync(source);
    const path = database();
    try {
      writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
      writer.prepare("INSERT INTO byok_sqlite_meta (key, value) VALUES ('pending', 'wal')").run();
      // Copied while the writer holds them, so the WAL still has its frames and the SHM its index.
      for (const suffix of ['', '-wal', '-shm']) copyFileSync(`${source}${suffix}`, `${path}${suffix}`);
    } finally { writer.close(); }
    const files = ['', '-wal', '-shm'].map((suffix) => `${path}${suffix}`);
    const digests = () => files.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'));
    const before = digests();
    expect(() => open(path)).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: '9' }));
    expect(digests()).toEqual(before);
    expect(readdirSync(join(path, '..')).sort()).toEqual(['server.sqlite', 'server.sqlite-shm', 'server.sqlite-wal']);
  });

  it('refuses a current file missing any index or trigger, without recreating it', async () => {
    const reference = database(); await open(reference).close();
    const read = new DatabaseSync(reference, { readOnly: true });
    const objects = read.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL").all() as { type: string; name: string }[];
    read.close();
    expect(objects.length).toBeGreaterThan(10);
    for (const { type, name } of objects) {
      const path = database(); copyFileSync(reference, path);
      const edit = new DatabaseSync(path); edit.exec(`DROP ${type.toUpperCase()} ${name}`); edit.close();
      expect(() => open(path), name).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_INVALID' }));
      const check = new DatabaseSync(path, { readOnly: true });
      expect(check.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name), name).toBeUndefined();
      check.close();
    }
  });

  it('refuses a current file whose index definition differs', async () => {
    const path = database(); await open(path).close();
    const edit = new DatabaseSync(path);
    edit.exec('DROP INDEX task_attempt_status_idx; CREATE INDEX task_attempt_status_idx ON task_attempt (tenant_id, status)');
    edit.close();
    expect(() => open(path)).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_INVALID', message: expect.stringContaining('index task_attempt_status_idx') }));
  });

  it.each([
    ['table', 'CREATE TABLE future_authority (id TEXT PRIMARY KEY)'],
    ['index', 'CREATE INDEX future_idx ON request_receipt (recorded_at)'],
    ['trigger', 'CREATE TRIGGER future_trigger AFTER INSERT ON request_receipt BEGIN SELECT 1; END'],
  ])('refuses a current file holding an unknown %s, which a newer build wrote', async (_kind, ddl) => {
    const path = database(); await open(path).close();
    const edit = new DatabaseSync(path); edit.exec(ddl); edit.close();
    expect(() => open(path)).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: '10' }));
  });

  it('rejects unknown versions and malformed old databases without marking them migrated', async () => {
    const path = database(); await open(path).close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE wake; DROP TABLE request_receipt; DROP TABLE device_directory; DROP TABLE task_attempt; UPDATE byok_sqlite_meta SET value = '1' WHERE key = 'schema_version'"); legacy.close();
    expect(() => open(path)).toThrow();
    const read = new DatabaseSync(path);
    expect(read.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe('1');
    expect(read.prepare("SELECT name FROM sqlite_master WHERE name = 'device_directory'").get()).toBeUndefined();
    read.exec("UPDATE byok_sqlite_meta SET value = '999' WHERE key = 'schema_version'"); read.close();
    expect(() => open(path)).toThrow('999');
  });

  it('rejects corrupt capability authority instead of inferring a declaration', async () => {
    const path = database(); let stores = open(path);
    await stores.cloud.devices.register(tenant, registration('device')); await stores.close();
    const corrupt = new DatabaseSync(path);
    corrupt.exec("UPDATE device_directory SET capabilities_json = '[false]'"); corrupt.close();
    stores = open(path);
    try { await expect(stores.cloud.devices.resolveByDeviceId('device')).rejects.toThrow('capabilities'); }
    finally { await stores.close(); }
  });
});
