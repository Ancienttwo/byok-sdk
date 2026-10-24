import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { runE2eeMemberStoreConformance } from '../../../conformance/src/cloud/e2ee-member';
import { isSqliteAvailable } from '../sqlite-support';
import { createSqliteEmbeddedStores, type SqliteEmbeddedStores } from '../stores/sqlite';
import { E2EE_MEMBER_SCHEMA, SqliteE2eeMemberStore } from '../stores/sqlite/e2ee-member';

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;
const TENANT = tenantId('sqlite-e2ee');
const EXPIRES = '2099-01-01T00:00:00.000Z';
let requests = 0;
/** A device-proof binding with a requestId no other write has used. */
const freshRequest = () => ({ requestId: `request-${++requests}`, operation: 'e2ee-member-key.register', resource: '/byok/e2ee/member-key', bodySha256: 'sha256', bodySize: 1 });
const open = (path: string) => createSqliteEmbeddedStores({ path }, { clock: createMutableClock(), crypto: createWebCrypto() });

if (isSqliteAvailable()) {
  runE2eeMemberStoreConformance('sqlite', {
    create() {
      const stores = open(':memory:');
      return { store: stores.e2eeMember, receipts: stores.cloud.receipts, dispose: () => stores.close() };
    },
  });
}

async function seed(stores: SqliteEmbeddedStores, deviceId: string, machineId?: string): Promise<string> {
  await stores.cloud.devices.register(TENANT, {
    productId: 'product', deviceId, deviceName: deviceId, devicePublicKey: `${deviceId}-key`, proofKeyId: 'identity', proofKeyEpoch: 0,
    ...(machineId === undefined ? {} : { machineId }),
  });
  const memberId = `member-${deviceId}`;
  expect(await stores.e2eeMember.registerMember(TENANT, { deviceId, memberId, bundle: `{"m":"${memberId}"}`, deviceMac: 'mac', macExpiresAt: EXPIRES, request: freshRequest() }))
    .toBe('registered');
  expect(await stores.e2eeMember.putClientPairingMac(TENANT, { deviceId, body: '{"mac":"client"}', expiresAt: EXPIRES })).toBe('stored');
  expect(await stores.e2eeMember.putScopeKeyPackages(TENANT, { rows: [{ scopeId: 'scope', epoch: 1, recipient: memberId, keyId: 'key', sender: memberId, package: '{}', recipientKemEpoch: 1 }] }))
    .toEqual({ outcome: 'stored', stored: 1 });
  return memberId;
}

async function memberState(stores: SqliteEmbeddedStores, deviceId: string, memberId: string) {
  return {
    registration: (await stores.e2eeMember.readMemberRegistration(TENANT, { deviceId, now: '2026-10-24T00:00:00.000Z' })) !== undefined,
    clientMac: (await stores.e2eeMember.readClientPairingMac(TENANT, { deviceId, now: '2026-10-24T00:00:00.000Z' })) !== undefined,
    packages: (await stores.e2eeMember.readScopeKeyPackages(TENANT, { scopeId: 'scope', recipient: memberId })).length,
  };
}

describeSqlite('SQLite E2EE member state', () => {
  const directories: string[] = [];
  const tempPath = () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-e2ee-'));
    directories.push(directory);
    return join(directory, 'server.sqlite');
  };
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the chain, registrations and packages across a restart', async () => {
    const path = tempPath();
    const first = open(path);
    const memberId = await seed(first, 'device-1');
    expect(await first.e2eeMember.appendChainEntries(TENANT, { rows: [{ seq: 1, entry: '{"seq":1}' }], rotations: [], shreds: [] })).toMatchObject({ outcome: 'appended' });
    await first.close();

    const second = open(path);
    try {
      expect(await second.e2eeMember.readChainEntries(TENANT, { afterSeq: 0, limit: 256 })).toEqual([{ seq: 1, entry: '{"seq":1}' }]);
      // Pairing MACs live for one pairing window in memory, like pairing codes.
      expect(await memberState(second, 'device-1', memberId)).toEqual({ registration: true, clientMac: false, packages: 1 });
    } finally {
      await second.close();
    }
  });

  it('adds the tables to an existing database without a version change', async () => {
    const path = tempPath();
    await open(path).close();
    const raw = new DatabaseSync(path);
    for (const table of ['e2ee_scope_key_package', 'e2ee_scope_epoch', 'e2ee_member_key', 'e2ee_member_chain_entry']) raw.exec(`DROP TABLE ${table}`);
    const version = raw.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get();
    raw.close();

    const reopened = open(path);
    try {
      expect(await reopened.e2eeMember.appendChainEntries(TENANT, { rows: [{ seq: 1, entry: '{}' }], rotations: [], shreds: [] })).toMatchObject({ outcome: 'appended' });
    } finally {
      await reopened.close();
    }
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()).toEqual(version);
    check.close();
  });

  it('adds the KEM floor table and the own-epoch index to a database that has the other E2EE tables', async () => {
    const path = tempPath();
    await open(path).close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP INDEX e2ee_scope_key_package_own_epoch');
    raw.exec('DROP TABLE e2ee_member_kem_floor');
    const version = raw.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get();
    raw.close();

    const reopened = open(path);
    try {
      expect(await reopened.e2eeMember.appendChainEntries(TENANT, { rows: [{ seq: 1, entry: '{}' }], rotations: [{ seq: 1, memberId: 'member', kemEpoch: 2 }], shreds: [] }))
        .toMatchObject({ outcome: 'appended' });
      expect(await reopened.e2eeMember.putScopeKeyPackages(TENANT, {
        rows: [{ scopeId: 'scope', epoch: 1, recipient: 'member', keyId: 'key', sender: 'member', package: '{}', recipientKemEpoch: 1 }],
      })).toEqual({ outcome: 'kem_epoch_stale', recipient: 'member', kemEpoch: 1, floor: 2 });
    } finally {
      await reopened.close();
    }
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()).toEqual(version);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'e2ee_scope_key_package_own_epoch'").get())
      .toEqual({ name: 'e2ee_scope_key_package_own_epoch' });
    check.close();
  });

  it('refuses a same-named table of another shape', async () => {
    const path = tempPath();
    await open(path).close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE e2ee_member_key');
    raw.exec('CREATE TABLE e2ee_member_key (tenant_id TEXT, device_id TEXT)');
    raw.close();
    expect(() => open(path)).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_INVALID' }));
  });

  it('refuses a replay whose stored result is not a valid result of that write', async () => {
    const path = tempPath();
    const proof = { deviceId: 'device-1', request: { requestId: 'corrupt', operation: 'e2ee-member-chain.append', resource: '/byok/e2ee/chain', bodySha256: 'sha256', bodySize: 1 } };
    const append = { rows: [{ seq: 1, entry: '{"seq":1}' }], rotations: [], shreds: [], proof };
    const first = open(path);
    expect(await first.e2eeMember.appendChainEntries(TENANT, append)).toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
    await first.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE proof_request_receipt SET response_body = '{\"outcome\":\"stored\",\"stored\":1}' WHERE request_id = 'corrupt'").run();
    raw.close();

    const second = open(path);
    try {
      await expect(second.e2eeMember.appendChainEntries(TENANT, append)).rejects.toMatchObject({ code: 'e2ee_member_state_unreadable' });
    } finally {
      await second.close();
    }
  });

  it('refuses a replay of a key package put whose stored result is not a valid result of that write', async () => {
    const path = tempPath();
    const proof = { deviceId: 'device-1', request: { requestId: 'corrupt-put', operation: 'e2ee-scope-key-package.put', resource: '/byok/e2ee/key-packages', bodySha256: 'sha256', bodySize: 1 } };
    const put = { rows: [{ scopeId: 'scope', epoch: 1, recipient: 'member-1', keyId: 'key', sender: 'member-1', package: '{}', recipientKemEpoch: 1 }], proof };
    const first = open(path);
    expect(await first.e2eeMember.putScopeKeyPackages(TENANT, put)).toEqual({ outcome: 'stored', stored: 1 });
    await first.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE proof_request_receipt SET response_body = '{\"outcome\":\"appended\",\"appended\":1,\"replayed\":0}' WHERE request_id = 'corrupt-put'").run();
    raw.close();

    const second = open(path);
    try {
      await expect(second.e2eeMember.putScopeKeyPackages(TENANT, put)).rejects.toMatchObject({ code: 'e2ee_member_state_unreadable' });
    } finally {
      await second.close();
    }
  });

  it('refuses a replay of a member key register whose stored result is not a valid result of that write', async () => {
    const path = tempPath();
    const request = { requestId: 'corrupt-register', operation: 'e2ee-member-key.register', resource: '/byok/e2ee/member-key', bodySha256: 'sha256', bodySize: 1 };
    const register = { deviceId: 'device-1', memberId: 'member-1', bundle: '{"m":"member-1"}', deviceMac: 'mac', macExpiresAt: EXPIRES, request };
    const first = open(path);
    expect(await first.e2eeMember.registerMember(TENANT, register)).toBe('registered');
    await first.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE proof_request_receipt SET response_body = '\"device_conflict\"' WHERE request_id = 'corrupt-register'").run();
    raw.close();

    const second = open(path);
    try {
      await expect(second.e2eeMember.registerMember(TENANT, register)).rejects.toMatchObject({ code: 'e2ee_member_state_unreadable' });
    } finally {
      await second.close();
    }
  });

  it('deletes a device member state on revoke and on machine supersession, and keeps the rest', async () => {
    const stores = open(':memory:');
    try {
      const revoked = await seed(stores, 'revoked-device');
      const kept = await seed(stores, 'kept-device');
      const old = await seed(stores, 'old-device', 'c'.repeat(64));
      await stores.cloud.devices.revoke(TENANT, 'revoked-device');
      const fresh = await seed(stores, 'new-device', 'c'.repeat(64));

      expect(await memberState(stores, 'revoked-device', revoked)).toEqual({ registration: false, clientMac: false, packages: 0 });
      expect(await memberState(stores, 'old-device', old)).toEqual({ registration: false, clientMac: false, packages: 0 });
      expect(await memberState(stores, 'kept-device', kept)).toEqual({ registration: true, clientMac: true, packages: 1 });
      expect(await memberState(stores, 'new-device', fresh)).toEqual({ registration: true, clientMac: true, packages: 1 });
    } finally {
      await stores.close();
    }
  });
});

describeSqlite('SQLite pairing MAC map', () => {
  it('drops MACs whose pairing window has passed on the next MAC write', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(E2EE_MEMBER_SCHEMA);
    const coordinator = {
      run: async <T>(operation: (db: DatabaseSync) => T | Promise<T>) => operation(db),
      transaction: async <T>(operation: (db: DatabaseSync) => T | Promise<T>) => {
        db.exec('BEGIN');
        try {
          const result = await operation(db);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    };
    const clock = createMutableClock(new Date('2026-10-24T00:00:00.000Z'));
    const macs = new Map<string, { readonly body: string; readonly expiresAt: string }>();
    const store = new SqliteE2eeMemberStore(coordinator, clock, macs);
    const register = (deviceId: string, expiresAt: string) =>
      store.registerMember(TENANT, { deviceId, memberId: `member-${deviceId}`, bundle: `{"m":"${deviceId}"}`, deviceMac: 'mac', macExpiresAt: expiresAt, request: freshRequest() });
    try {
      expect(await register('ending', '2026-10-24T00:10:00.000Z')).toBe('registered');
      expect(await store.putClientPairingMac(TENANT, { deviceId: 'ending', body: '{}', expiresAt: '2026-10-24T00:10:00.000Z' })).toBe('stored');
      expect(await register('lasting', '2026-10-24T00:30:00.000Z')).toBe('registered');
      expect(macs.size).toBe(3);

      clock.advance(10 * 60_000);
      expect(await register('fresh', '2026-10-24T00:20:00.000Z')).toBe('registered');

      expect([...macs.keys()].map(key => JSON.parse(key))).toEqual([[TENANT, 'lasting', 'device'], [TENANT, 'fresh', 'device']]);
    } finally {
      db.close();
    }
  });
});
