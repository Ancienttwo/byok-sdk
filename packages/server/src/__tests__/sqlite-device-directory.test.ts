import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, type TenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createSqliteEmbeddedStores } from '../stores/sqlite';

const tenant = 'tenant-a' as TenantId;
const other = 'tenant-b' as TenantId;
const registration = (deviceId: string, productId = 'product', machineId?: string) => ({
  deviceId, productId, deviceName: 'fixture', devicePublicKey: 'test-key',
  proofKeyId: 'proof-key', proofKeyEpoch: 1, ...(machineId === undefined ? {} : { machineId }),
});

describe('SQLite durable device authority', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function database() {
    const root = mkdtempSync(join(tmpdir(), 'byok-device-directory-')); roots.push(root);
    return join(root, 'server.sqlite');
  }
  const open = (path: string, migration?: 'v1-to-v2') => createSqliteEmbeddedStores(
    { path, ...(migration === undefined ? {} : { migration }) },
    { clock: createMutableClock(), crypto: createWebCrypto() },
  );

  it('persists supersession, tenant isolation, capabilities and revocation without restoring presence', async () => {
    const path = database(); let stores = open(path);
    try {
      await stores.cloud.devices.register(tenant, registration('old', 'product', 'machine'));
      await stores.cloud.devices.register(other, registration('other-tenant', 'product', 'machine'));
      await stores.cloud.devices.register(tenant, registration('other-product', 'other', 'machine'));
      await stores.cloud.devices.register(tenant, registration('new', 'product', 'machine'));
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
        ...registration('new', 'product', 'machine'), proofKeyEpoch: -1,
      })).rejects.toThrow();
      await expect(stores.cloud.devices.resolveByDeviceId('old')).resolves.toMatchObject({ deviceId: 'old' });
      await expect(stores.cloud.devices.resolveByDeviceId('new')).resolves.toBeUndefined();
    } finally { await stores.close(); }
  });

  it('requires explicit atomic adoption of v1 and preserves existing tasks', async () => {
    const path = database(); const seed = open(path);
    await seed.cloud.tasks.open(tenant, { taskId: 'before', deviceId: 'historic' }); await seed.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE device_directory; UPDATE byok_sqlite_meta SET value = '1' WHERE key = 'schema_version'"); legacy.close();
    expect(() => open(path)).toThrow("migration: 'v1-to-v2'");
    const migrated = open(path, 'v1-to-v2');
    try {
      await expect(migrated.cloud.tasks.get(tenant, 'before')).resolves.toMatchObject({ taskId: 'before' });
      await expect(migrated.cloud.devices.list(tenant)).resolves.toEqual([]);
    } finally { await migrated.close(); }
    const read = new DatabaseSync(path, { readOnly: true });
    expect(read.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe('2'); read.close();
  });

  it('rejects unknown versions and malformed old databases without marking them migrated', async () => {
    const path = database(); await open(path).close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE device_directory; DROP TABLE task_attempt; UPDATE byok_sqlite_meta SET value = '1' WHERE key = 'schema_version'"); legacy.close();
    expect(() => open(path, 'v1-to-v2')).toThrow();
    const read = new DatabaseSync(path);
    expect(read.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe('1');
    expect(read.prepare("SELECT name FROM sqlite_master WHERE name = 'device_directory'").get()).toBeUndefined();
    read.exec("UPDATE byok_sqlite_meta SET value = '999' WHERE key = 'schema_version'"); read.close();
    expect(() => open(path, 'v1-to-v2')).toThrow('999');
  });

  it('refuses adoption when an existing coordination column is missing', async () => {
    const path = database(); await open(path).close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE device_directory; UPDATE byok_sqlite_meta SET value = '1' WHERE key = 'schema_version'; ALTER TABLE task_attempt RENAME COLUMN device_id TO broken_device_id");
    legacy.close();
    expect(() => open(path, 'v1-to-v2')).toThrow();
    const read = new DatabaseSync(path, { readOnly: true });
    expect(read.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe('1');
    read.close();
  });

  it('rolls back the new table when adoption fails before the version commit', async () => {
    const path = database(); await open(path).close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE device_directory; UPDATE byok_sqlite_meta SET value = '1' WHERE key = 'schema_version'; CREATE INDEX device_directory_machine ON task_attempt (device_id)");
    legacy.close();
    expect(() => open(path, 'v1-to-v2')).toThrow();
    const read = new DatabaseSync(path, { readOnly: true });
    expect(read.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe('1');
    expect(read.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_directory'").get()).toBeUndefined();
    read.close();
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
