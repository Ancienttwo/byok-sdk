/**
 * The Postgres E2EE member store (#654 E2c): the shared store contract, and
 * the device cleanup that only Postgres runs inside the device transaction.
 */
import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId, type TenantId } from '@byok-sdk/core';
import { runE2eeMemberStoreConformance } from '@byok-sdk/conformance';
import { E2EE_SCOPE_ID_MAX_LENGTH } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { migrate } from '../migrate';
import { PostgresDeviceDirectory } from '../stores/devices';
import { PostgresE2eeMemberStore } from '../stores/e2ee-member';
import { PostgresRequestReceiptStore } from '../stores/receipts';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT_A = tenantId('e2ee-cleanup-a');
const TENANT_B = tenantId('e2ee-cleanup-b');
const EXPIRES = '2099-01-01T00:00:00.000Z';
const MACHINE = 'b'.repeat(64);
let requests = 0;
/** A device-proof binding with a requestId no other write has used. */
const freshRequest = () => ({ requestId: `request-${++requests}`, operation: 'e2ee-member-key.register', resource: '/byok/e2ee/member-key', bodySha256: 'sha256', bodySize: 1 });

if (SKIP_DATAPLANE) {
  describe.skip(`E2EE member store [postgres] — ${SKIP_REASON}`, () => { it('needs a dataplane substrate', () => undefined); });
} else {
  runE2eeMemberStoreConformance('postgres', {
    async create() {
      const scope = await createDataplaneScope();
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      return {
        store: new PostgresE2eeMemberStore(scope.pool, clock),
        receipts: new PostgresRequestReceiptStore(scope.pool, clock),
        dispose: () => scope.dispose(),
      };
    },
  });
}

async function memberRows(pool: Pool, tenant: TenantId, deviceId: string, memberId: string): Promise<Record<string, number>> {
  const count = async (sql: string, params: readonly unknown[]) =>
    Number((await pool.query<{ count: string }>(sql, [...params])).rows[0]!.count);
  return {
    member_key: await count('SELECT count(*)::text AS count FROM e2ee_member_key WHERE tenant_id = $1 AND device_id = $2', [tenant, deviceId]),
    pairing_mac: await count('SELECT count(*)::text AS count FROM e2ee_pairing_mac WHERE tenant_id = $1 AND device_id = $2', [tenant, deviceId]),
    packages: await count('SELECT count(*)::text AS count FROM e2ee_scope_key_package WHERE tenant_id = $1 AND recipient = $2', [tenant, memberId]),
  };
}

/** Wait until one connection of this scope's pool waits on a row lock. */
async function waitForLockWait(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE application_name = current_setting('application_name') AND wait_event_type = 'Lock'`);
    if (rows[0]!.waiting > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('the revoke never waited on the held package lock');
}

async function seed(devices: PostgresDeviceDirectory, store: PostgresE2eeMemberStore, tenant: TenantId, deviceId: string, machineId?: string) {
  await devices.register(tenant, {
    productId: 'product',
    deviceId,
    deviceName: deviceId,
    devicePublicKey: `${deviceId}-public-key`,
    proofKeyId: 'identity',
    proofKeyEpoch: 0,
    ...(machineId === undefined ? {} : { machineId }),
  });
  const memberId = `member-${deviceId}`;
  expect(await store.registerMember(tenant, { deviceId, memberId, bundle: `{"memberId":"${memberId}"}`, deviceMac: 'mac', macExpiresAt: EXPIRES, request: freshRequest() })).toBe('registered');
  expect(await store.putClientPairingMac(tenant, { deviceId, body: '{"mac":"client"}', expiresAt: EXPIRES })).toBe('stored');
  expect(await store.putScopeKeyPackages(tenant, { rows: [{
    scopeId: 'scope', epoch: 1, recipient: memberId, keyId: 'key', sender: memberId, package: `{"recipient":"${memberId}"}`, recipientKemEpoch: 1,
  }] })).toEqual({ outcome: 'stored', stored: 1 });
  return memberId;
}

describe.skipIf(SKIP_DATAPLANE)('Postgres device cleanup removes the device member state', () => {
  it('deletes the revoked device rows and keeps every other device and tenant', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const devices = new PostgresDeviceDirectory(scope.pool, createMutableClock());
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      const revoked = await seed(devices, store, TENANT_A, 'revoked-device');
      const kept = await seed(devices, store, TENANT_A, 'kept-device');
      const other = await seed(devices, store, TENANT_B, 'other-device');
      await expect(memberRows(scope.pool, TENANT_A, 'revoked-device', revoked)).resolves.toEqual({ member_key: 1, pairing_mac: 2, packages: 1 });

      await devices.revoke(TENANT_A, 'revoked-device');

      await expect(memberRows(scope.pool, TENANT_A, 'revoked-device', revoked)).resolves.toEqual({ member_key: 0, pairing_mac: 0, packages: 0 });
      await expect(memberRows(scope.pool, TENANT_A, 'kept-device', kept)).resolves.toEqual({ member_key: 1, pairing_mac: 2, packages: 1 });
      await expect(memberRows(scope.pool, TENANT_B, 'other-device', other)).resolves.toEqual({ member_key: 1, pairing_mac: 2, packages: 1 });
      // The chain is tenant history: a revoke never edits it.
      expect(await store.appendChainEntries(TENANT_A, { rows: [{ seq: 1, entry: '{}' }], rotations: [], shreds: [] })).toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      await devices.revoke(TENANT_A, 'kept-device');
      expect(await store.readChainEntries(TENANT_A, { afterSeq: 0, limit: 256 })).toEqual([{ seq: 1, entry: '{}' }]);
    } finally {
      await scope.dispose();
    }
  });

  it('locks package rows in the order a put locks them, so a revoke racing a put does not deadlock', async () => {
    const scope = await createDataplaneScope(4);
    const holder = await scope.pool.connect();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const devices = new PostgresDeviceDirectory(scope.pool, createMutableClock());
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      const member = await seed(devices, store, TENANT_A, 'raced-device');
      // Store scope 'b' before scope 'a', so the table order is not the put order.
      for (const scopeId of ['b', 'a']) {
        await store.putScopeKeyPackages(TENANT_A, { rows: [{ scopeId, epoch: 1, recipient: member, keyId: 'key', sender: member, package: '{}', recipientKemEpoch: 1 }] });
      }
      const lock = 'SELECT 1 FROM e2ee_scope_key_package WHERE tenant_id = $1 AND scope_id = $2 AND epoch = 1 AND recipient = $3 FOR UPDATE';
      // The holder locks rows as a sorted put does: 'a', then 'b'.
      await holder.query('BEGIN');
      await holder.query(lock, [TENANT_A, 'a', member]);
      const revoked = devices.revoke(TENANT_A, 'raced-device');
      await waitForLockWait(scope.pool);
      await holder.query(lock, [TENANT_A, 'b', member]);
      await holder.query('COMMIT');
      await revoked;

      await expect(memberRows(scope.pool, TENANT_A, 'raced-device', member)).resolves.toEqual({ member_key: 0, pairing_mac: 0, packages: 0 });
    } finally {
      holder.release();
      await scope.dispose();
    }
  });

  it('deletes the superseded device rows when the same machine pairs again', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const devices = new PostgresDeviceDirectory(scope.pool, createMutableClock());
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      const old = await seed(devices, store, TENANT_A, 'old-device', MACHINE);
      const fresh = await seed(devices, store, TENANT_A, 'new-device', MACHINE);

      await expect(devices.get(TENANT_A, 'old-device')).resolves.toBeUndefined();
      await expect(memberRows(scope.pool, TENANT_A, 'old-device', old)).resolves.toEqual({ member_key: 0, pairing_mac: 0, packages: 0 });
      await expect(memberRows(scope.pool, TENANT_A, 'new-device', fresh)).resolves.toEqual({ member_key: 1, pairing_mac: 2, packages: 1 });
    } finally {
      await scope.dispose();
    }
  });
});

describe.skipIf(SKIP_DATAPLANE)('Postgres shred serializes with package puts of its scope', () => {
  // The store's lock identity for one (tenant, scope).
  const scopeLock = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
  const scopeKey = (scopeId: string) => JSON.stringify(['e2ee-scope', TENANT_A, scopeId]);
  const row = (epoch: number, keyId: string) =>
    ({ scopeId: 'scope', epoch, recipient: 'member', keyId, sender: 'member', package: `{"epoch":${epoch}}`, recipientKemEpoch: 1 });
  const shred = { seq: 1, scopeId: 'scope', receipt: { key: 'e2ee-scope-shred:scope', body: '{"chainSeq":1}' } };

  it('locks the packages of every shredded scope in cleanup order, so a racing cleanup does not deadlock', async () => {
    const scope = await createDataplaneScope(4);
    const holder = await scope.pool.connect();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      for (const scopeId of ['a', 'b']) {
        await store.putScopeKeyPackages(TENANT_A, { rows: [{ ...row(1, 'k1'), scopeId }] });
      }
      const lock = `SELECT 1 FROM e2ee_scope_key_package WHERE tenant_id = $1 AND scope_id = $2 AND epoch = 1 AND recipient = 'member' FOR UPDATE`;
      // The holder locks rows as device cleanup does: 'a', then 'b'. The append shreds 'b' before 'a'.
      await holder.query('BEGIN');
      await holder.query(lock, [TENANT_A, 'a']);
      const appended = store.appendChainEntries(TENANT_A, {
        rows: [{ seq: 1, entry: '{"op":"shred","scope":"b"}' }, { seq: 2, entry: '{"op":"shred","scope":"a"}' }],
        rotations: [], shreds: [{ ...shred, seq: 1, scopeId: 'b' }, { ...shred, seq: 2, scopeId: 'a', receipt: { key: 'e2ee-scope-shred:a', body: '{"chainSeq":2}' } }],
      });
      await waitForLockWait(scope.pool);
      await holder.query(lock, [TENANT_A, 'b']);
      await holder.query('COMMIT');
      await expect(appended).resolves.toEqual({ outcome: 'appended', appended: 2, replayed: 0 });
      const left = await scope.pool.query<{ packages: number }>('SELECT count(*)::int AS packages FROM e2ee_scope_key_package WHERE tenant_id = $1', [TENANT_A]);
      expect(left.rows[0]).toEqual({ packages: 0 });
    } finally {
      holder.release();
      await scope.dispose();
    }
  });

  it('records a shred of the longest Host scope id, with an incompressible id', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      // 512 random code points of three UTF-8 bytes each: 1536 bytes that do not compress.
      const scopeId = String.fromCodePoint(...Array.from({ length: E2EE_SCOPE_ID_MAX_LENGTH }, () => 0x4e00 + Math.floor(Math.random() * 0x5000)));
      const receipt = { key: `e2ee-scope-shred:${scopeId}`, body: '{"chainSeq":1}' };
      await expect(store.appendChainEntries(TENANT_A, { rows: [{ seq: 1, entry: '{"op":"shred"}' }], rotations: [], shreds: [{ seq: 1, scopeId, receipt }] }))
        .resolves.toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      await expect(new PostgresRequestReceiptStore(scope.pool, createMutableClock()).get(TENANT_A, receipt.key)).resolves.toMatchObject({ body: receipt.body });
      await expect(store.putScopeKeyPackages(TENANT_A, { rows: [{ ...row(1, 'k1'), scopeId }] })).resolves.toEqual({ outcome: 'scope_shredded', scopeId });
    } finally {
      await scope.dispose();
    }
  });

  it('makes a put of a new epoch wait for a shred, then refuses it', async () => {
    const scope = await createDataplaneScope(4);
    const holder = await scope.pool.connect();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      // The holder is a shred that has taken the scope lock and not yet committed.
      await holder.query('BEGIN');
      await holder.query(scopeLock, [scopeKey('scope')]);
      const put = store.putScopeKeyPackages(TENANT_A, { rows: [row(1, 'k1')] });
      await waitForLockWait(scope.pool);
      await holder.query(`INSERT INTO e2ee_scope_shred (tenant_id, scope_id, chain_seq) VALUES ($1, 'scope', 1)`, [TENANT_A]);
      await holder.query('COMMIT');
      await expect(put).resolves.toEqual({ outcome: 'scope_shredded', scopeId: 'scope' });
      await expect(store.readScopeKeyPackages(TENANT_A, { scopeId: 'scope' })).resolves.toEqual([]);
    } finally {
      holder.release();
      await scope.dispose();
    }
  });

  it('makes a shred wait for a put of a new epoch, then deletes what it stored', async () => {
    const scope = await createDataplaneScope(4);
    const holder = await scope.pool.connect();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      // The holder is a put that has taken the scope lock and stores a new epoch.
      await holder.query('BEGIN');
      await holder.query(scopeLock, [scopeKey('scope')]);
      const appended = store.appendChainEntries(TENANT_A, { rows: [{ seq: 1, entry: '{"op":"shred"}' }], rotations: [], shreds: [shred] });
      await waitForLockWait(scope.pool);
      await holder.query(`INSERT INTO e2ee_scope_epoch (tenant_id, scope_id, epoch, key_id) VALUES ($1, 'scope', 1, 'k1')`, [TENANT_A]);
      await holder.query(
        `INSERT INTO e2ee_scope_key_package (tenant_id, scope_id, epoch, recipient, key_id, sender, package, updated_at)
         VALUES ($1, 'scope', 1, 'member', 'k1', 'member', '{}', now())`, [TENANT_A]);
      await holder.query('COMMIT');
      await expect(appended).resolves.toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      const left = await scope.pool.query<{ packages: number; epochs: number }>(
        `SELECT (SELECT count(*)::int FROM e2ee_scope_key_package WHERE tenant_id = $1) AS packages,
                (SELECT count(*)::int FROM e2ee_scope_epoch WHERE tenant_id = $1) AS epochs`, [TENANT_A]);
      expect(left.rows[0]).toEqual({ packages: 0, epochs: 0 });
      await expect(store.putScopeKeyPackages(TENANT_A, { rows: [row(2, 'k2')] })).resolves.toEqual({ outcome: 'scope_shredded', scopeId: 'scope' });
    } finally {
      holder.release();
      await scope.dispose();
    }
  });
});

describe.skipIf(SKIP_DATAPLANE)('Postgres rotate serializes with package puts to its member', () => {
  const memberLock = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
  const memberKey = JSON.stringify(['e2ee-member-kem', TENANT_A, 'member']);
  const put = (store: PostgresE2eeMemberStore) => store.putScopeKeyPackages(TENANT_A, {
    rows: [{ scopeId: 'scope', epoch: 1, recipient: 'member', keyId: 'k1', sender: 'member', package: '{}', recipientKemEpoch: 1 }],
  });

  it('makes a put wait for a rotate of its recipient, then refuses it', async () => {
    const scope = await createDataplaneScope(4);
    const holder = await scope.pool.connect();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      // The holder is a rotate that has taken the member lock and not yet committed.
      await holder.query('BEGIN');
      await holder.query(memberLock, [memberKey]);
      const refused = put(store);
      await waitForLockWait(scope.pool);
      await holder.query(`INSERT INTO e2ee_member_kem_floor (tenant_id, member_id, kem_epoch, chain_seq) VALUES ($1, 'member', 2, 1)`, [TENANT_A]);
      await holder.query('COMMIT');
      await expect(refused).resolves.toEqual({ outcome: 'kem_epoch_stale', recipient: 'member', kemEpoch: 1, floor: 2 });
      await expect(store.readScopeKeyPackages(TENANT_A, { scopeId: 'scope' })).resolves.toEqual([]);
    } finally {
      holder.release();
      await scope.dispose();
    }
  });

  it('makes a rotate wait for a put to its member, then raises the floor', async () => {
    const scope = await createDataplaneScope(4);
    const holder = await scope.pool.connect();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      // The holder is a put that has taken the member lock.
      await holder.query('BEGIN');
      await holder.query(memberLock, [memberKey]);
      const appended = store.appendChainEntries(TENANT_A, {
        rows: [{ seq: 1, entry: '{"op":"rotate"}' }], rotations: [{ seq: 1, memberId: 'member', kemEpoch: 2 }], shreds: [],
      });
      await waitForLockWait(scope.pool);
      await holder.query('COMMIT');
      await expect(appended).resolves.toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      const floor = await scope.pool.query('SELECT kem_epoch::int AS kem_epoch, chain_seq::int AS chain_seq FROM e2ee_member_kem_floor WHERE tenant_id = $1', [TENANT_A]);
      expect(floor.rows).toEqual([{ kem_epoch: 2, chain_seq: 1 }]);
      await expect(put(store)).resolves.toEqual({ outcome: 'kem_epoch_stale', recipient: 'member', kemEpoch: 1, floor: 2 });
    } finally {
      holder.release();
      await scope.dispose();
    }
  });
});

describe.skipIf(SKIP_DATAPLANE)('Postgres single-use device requests share proof_request_receipt with the truth put', () => {
  it('refuses an E2EE write whose requestId a truth put already used, and records an E2EE write there', async () => {
    const scope = await createDataplaneScope(2);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      await scope.pool.query(
        `INSERT INTO proof_request_receipt (tenant_id, device_id, request_id, operation, resource, body_sha256, body_size, response_status, response_body, recorded_at)
         VALUES ($1, 'dev-1', 'shared', 'truth.write', 'memory/key', 'sha256-truth', 5, 200, '{}', now())`, [TENANT_A]);
      const request = (requestId: string) => ({ requestId, operation: 'e2ee-member-chain.append', resource: '/byok/e2ee/chain', bodySha256: 'sha256-e2ee', bodySize: 7 });
      expect(await store.appendChainEntries(TENANT_A, { rows: [{ seq: 1, entry: '{}' }], rotations: [], shreds: [], proof: { deviceId: 'dev-1', request: request('shared') } }))
        .toEqual({ outcome: 'request_conflict' });
      expect(await store.appendChainEntries(TENANT_A, { rows: [{ seq: 1, entry: '{}' }], rotations: [], shreds: [], proof: { deviceId: 'dev-1', request: request('fresh') } }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      const stored = await scope.pool.query(
        `SELECT operation, resource, body_sha256, body_size::int AS body_size, response_status, response_body FROM proof_request_receipt
          WHERE tenant_id = $1 AND device_id = 'dev-1' AND request_id = 'fresh'`, [TENANT_A]);
      expect(stored.rows).toEqual([{
        operation: 'e2ee-member-chain.append', resource: '/byok/e2ee/chain', body_sha256: 'sha256-e2ee', body_size: 7,
        response_status: 200, response_body: '{"outcome":"appended","appended":1,"replayed":0}',
      }]);
    } finally {
      await scope.dispose();
    }
  });

  it('applies two parallel writes of one requestId once: the other gets the recorded result', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      const proof = { deviceId: 'dev-1', request: { requestId: 'parallel', operation: 'e2ee-member-chain.append', resource: '/byok/e2ee/chain', bodySha256: 'sha256-e2ee', bodySize: 7 } };
      const append = () => store.appendChainEntries(TENANT_A, { rows: [{ seq: 1, entry: '{}' }], rotations: [], shreds: [], proof });
      expect(await Promise.all([append(), append()])).toEqual([
        { outcome: 'appended', appended: 1, replayed: 0 },
        { outcome: 'appended', appended: 1, replayed: 0 },
      ]);
      expect(await store.readChainEntries(TENANT_A, { afterSeq: 0, limit: 256 })).toEqual([{ seq: 1, entry: '{}' }]);
      const receipts = await scope.pool.query("SELECT count(*)::int AS n FROM proof_request_receipt WHERE tenant_id = $1 AND request_id = 'parallel'", [TENANT_A]);
      expect(receipts.rows).toEqual([{ n: 1 }]);
    } finally {
      await scope.dispose();
    }
  });

  it('refuses a replay whose stored result is not a valid result of that write', async () => {
    const scope = await createDataplaneScope(2);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresE2eeMemberStore(scope.pool, createMutableClock());
      const proof = { deviceId: 'dev-1', request: { requestId: 'corrupt', operation: 'e2ee-member-chain.append', resource: '/byok/e2ee/chain', bodySha256: 'sha256-e2ee', bodySize: 7 } };
      const append = () => store.appendChainEntries(TENANT_A, { rows: [{ seq: 1, entry: '{}' }], rotations: [], shreds: [], proof });
      await append();
      await scope.pool.query(
        `UPDATE proof_request_receipt SET response_body = '{"outcome":"stored","stored":1}' WHERE tenant_id = $1 AND request_id = 'corrupt'`, [TENANT_A]);
      await expect(append()).rejects.toMatchObject({ code: 'e2ee_member_state_unreadable' });
    } finally {
      await scope.dispose();
    }
  });
});
