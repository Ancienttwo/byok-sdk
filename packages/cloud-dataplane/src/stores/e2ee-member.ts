import type { Clock, TenantId } from '@byok-sdk/core';
import type {
  E2eeMemberChainAppendInput,
  E2eeMemberChainAppendResult,
  E2eeMemberChainRow,
  E2eeMemberRegisterResult,
  E2eeMemberRegistrationInput,
  E2eeMemberRegistrationRow,
  E2eeMemberStore,
  E2eeProvenWrite,
  E2eeScopeKeyPackagePutInput,
  E2eeScopeKeyPackagePutResult,
  E2eeScopeKeyPackageRow,
} from '@byok-sdk/cloud';
import { parseRecordedWriteResult } from '@byok-sdk/cloud';
import type { Pool, PoolClient } from 'pg';

type PackageRow = { scope_id: string; epoch: string; recipient: string; key_id: string; sender: string; package: string };

function decodePackage(row: PackageRow): E2eeScopeKeyPackageRow {
  return { scopeId: row.scope_id, epoch: Number(row.epoch), recipient: row.recipient, keyId: row.key_id, sender: row.sender, package: row.package };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {}
}

/**
 * Single-use device requests (owner batch §41a A) use `proof_request_receipt`
 * (0004), the authority the truth put uses for the same device `requestId`s.
 * The transaction lock has the truth committer's key, so a truth commit and
 * an E2EE write of one `requestId` also run one after the other. It is taken
 * first, before the scope locks.
 */
async function recordedRequest<T>(
  client: PoolClient,
  tenant: TenantId,
  proof: E2eeProvenWrite | undefined,
  parse: (text: string) => T,
): Promise<T | 'request_conflict' | undefined> {
  if (proof === undefined) return undefined;
  const { deviceId, request } = proof;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['truth-receipt', tenant, deviceId, request.requestId])]);
  const stored = await client.query<{ operation: string; resource: string; body_sha256: string; body_size: string; response_body: string }>(
    `SELECT operation, resource, body_sha256, body_size::text AS body_size, response_body FROM proof_request_receipt
      WHERE tenant_id = $1 AND device_id = $2 AND request_id = $3`, [tenant, deviceId, request.requestId]);
  const row = stored.rows[0];
  if (row === undefined) return undefined;
  const same = row.operation === request.operation && row.resource === request.resource
    && row.body_sha256 === request.bodySha256 && row.body_size === String(request.bodySize);
  return same ? parse(row.response_body) : 'request_conflict';
}

async function recordRequest<T>(client: PoolClient, tenant: TenantId, proof: E2eeProvenWrite | undefined, result: T, now: Date): Promise<T> {
  if (proof === undefined) return result;
  const { deviceId, request } = proof;
  await client.query(
    `INSERT INTO proof_request_receipt (tenant_id, device_id, request_id, operation, resource, body_sha256, body_size, response_status, response_body, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 200, $8, $9)`,
    [tenant, deviceId, request.requestId, request.operation, request.resource, request.bodySha256, request.bodySize, JSON.stringify(result), now]);
  return result;
}

/**
 * Take the transaction lock of each `(tenant, id)` of one kind, in one sorted
 * order so two lockers cannot deadlock. The order across kinds is fixed: the
 * request lock, then `e2ee-scope` before any other e2ee statement, then
 * `e2ee-member-kem`. A shred and a package put of one scope then run one
 * after the other, also for a new scope or a new epoch, which has no row to
 * lock yet (owner batch §50h A). A `rotate` and a package put to its member
 * do the same, also before the member has a floor row (§77a).
 */
async function lockEach(client: PoolClient, kind: 'e2ee-scope' | 'e2ee-member-kem', tenant: TenantId, ids: Iterable<string>): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([kind, tenant, id])]);
  }
}

/**
 * Postgres E2EE member store (`deploy/sql/0027_e2ee_member.sql`,
 * `0028_e2ee_scope_shred.sql`, `0029_e2ee_member_kem_floor.sql`). Device revocation and machine supersession
 * delete a device's rows in the device transaction (`DEVICE_STATE_DELETES`
 * in `devices.ts`). A shred receipt goes to `device_request_receipts`, the
 * request receipt store, in the append transaction.
 */
export class PostgresE2eeMemberStore implements E2eeMemberStore {
  constructor(private readonly pool: Pool, private readonly clock: Clock) {}

  async #transaction<T>(operation: (client: PoolClient) => Promise<T | undefined>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      // `undefined` means refused: nothing the call wrote may stay.
      await client.query(result === undefined ? 'ROLLBACK' : 'COMMIT');
      return result as T;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async appendChainEntries(tenant: TenantId, input: E2eeMemberChainAppendInput): Promise<E2eeMemberChainAppendResult> {
    const { rows } = input;
    let refusal: E2eeMemberChainAppendResult | undefined;
    const result = await this.#transaction<E2eeMemberChainAppendResult>(async client => {
      const replay = await recordedRequest(client, tenant, input.proof, text => parseRecordedWriteResult('chainAppend', text));
      if (replay === 'request_conflict') {
        refusal = { outcome: 'request_conflict' };
        return undefined;
      }
      if (replay !== undefined) return replay;
      await lockEach(client, 'e2ee-scope', tenant, input.shreds.map(shred => shred.scopeId));
      // Every rotation's member, as every shred's scope: which ones are new is known only after the head read.
      await lockEach(client, 'e2ee-member-kem', tenant, input.rotations.map(rotation => rotation.memberId));
      // READ COMMITTED is enough: the head read sees only committed rows, and
      // the primary key decides between two writers of one seq.
      const head = await client.query<{ head: string }>(
        'SELECT COALESCE(MAX(seq), 0) AS head FROM e2ee_member_chain_entry WHERE tenant_id = $1', [tenant]);
      const headSeq = Number(head.rows[0]!.head);
      // Rows are contiguous, so only the first may leave a gap.
      if (rows[0]!.seq > headSeq + 1) {
        refusal = { outcome: 'gap', seq: rows[0]!.seq, headSeq };
        return undefined;
      }
      let appended = 0;
      let replayed = 0;
      for (const row of rows) {
        const inserted = row.seq > headSeq
          ? await client.query(
            `INSERT INTO e2ee_member_chain_entry (tenant_id, seq, entry) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, seq) DO NOTHING`, [tenant, row.seq, row.entry])
          : undefined;
        if (inserted?.rowCount) {
          appended += 1;
          continue;
        }
        const stored = await client.query<{ entry: string }>(
          'SELECT entry FROM e2ee_member_chain_entry WHERE tenant_id = $1 AND seq = $2', [tenant, row.seq]);
        if (stored.rows[0]?.entry !== row.entry) {
          refusal = { outcome: 'conflict', seq: row.seq };
          return undefined;
        }
        replayed += 1;
      }
      const now = this.clock.now();
      const shreds = input.shreds.filter(shred => shred.seq > headSeq);
      const scopeIds = [...new Set(shreds.map(shred => shred.scopeId))];
      if (scopeIds.length > 0) {
        // Packages before their epochs, which they reference. One statement
        // locks the package rows of every shredded scope in the order a put
        // and device cleanup lock them, (scope_id, epoch, recipient) in code
        // point order, so a racing device cleanup cannot deadlock with it.
        await client.query(
          `DELETE FROM e2ee_scope_key_package p USING (
             SELECT scope_id, epoch, recipient FROM e2ee_scope_key_package
              WHERE tenant_id = $1 AND scope_id = ANY($2::text[])
              ORDER BY scope_id COLLATE "C", epoch, recipient COLLATE "C"
              FOR UPDATE) locked
            WHERE p.tenant_id = $1 AND p.scope_id = locked.scope_id AND p.epoch = locked.epoch AND p.recipient = locked.recipient`,
          [tenant, scopeIds]);
        await client.query('DELETE FROM e2ee_scope_epoch WHERE tenant_id = $1 AND scope_id = ANY($2::text[])', [tenant, scopeIds]);
      }
      for (const shred of shreds) {
        await client.query(
          `INSERT INTO e2ee_scope_shred (tenant_id, scope_id, chain_seq) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, scope_id) DO NOTHING`, [tenant, shred.scopeId, shred.seq]);
        await client.query(
          `INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, key) DO NOTHING`, [tenant, shred.receipt.key, shred.receipt.body, now]);
      }
      for (const rotation of input.rotations) {
        if (rotation.seq <= headSeq) continue;
        await client.query(
          `INSERT INTO e2ee_member_kem_floor (tenant_id, member_id, kem_epoch, chain_seq) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, member_id) DO UPDATE SET kem_epoch = EXCLUDED.kem_epoch, chain_seq = EXCLUDED.chain_seq
           WHERE e2ee_member_kem_floor.kem_epoch < EXCLUDED.kem_epoch`, [tenant, rotation.memberId, rotation.kemEpoch, rotation.seq]);
      }
      return recordRequest<E2eeMemberChainAppendResult>(client, tenant, input.proof, { outcome: 'appended', appended, replayed }, now);
    });
    return refusal ?? result;
  }

  async readChainEntries(tenant: TenantId, input: { readonly afterSeq: number; readonly limit: number }): Promise<readonly E2eeMemberChainRow[]> {
    const result = await this.pool.query<{ seq: string; entry: string }>(
      `SELECT seq, entry FROM e2ee_member_chain_entry WHERE tenant_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [tenant, input.afterSeq, input.limit]);
    return result.rows.map(row => ({ seq: Number(row.seq), entry: row.entry }));
  }

  async putScopeKeyPackages(tenant: TenantId, { rows, proof }: E2eeScopeKeyPackagePutInput): Promise<E2eeScopeKeyPackagePutResult> {
    let refusal: E2eeScopeKeyPackagePutResult | undefined;
    const updatedAt = this.clock.now();
    const result = await this.#transaction<E2eeScopeKeyPackagePutResult>(async client => {
      const replay = await recordedRequest(client, tenant, proof, text => parseRecordedWriteResult('keyPackagePut', text));
      if (replay === 'request_conflict') {
        refusal = { outcome: 'request_conflict' };
        return undefined;
      }
      if (replay !== undefined) return replay;
      const scopeIds = [...new Set(rows.map(row => row.scopeId))];
      await lockEach(client, 'e2ee-scope', tenant, scopeIds);
      const shredded = await client.query<{ scope_id: string }>(
        'SELECT scope_id FROM e2ee_scope_shred WHERE tenant_id = $1 AND scope_id = ANY($2::text[]) ORDER BY scope_id COLLATE "C" LIMIT 1',
        [tenant, scopeIds]);
      if (shredded.rows[0] !== undefined) {
        refusal = { outcome: 'scope_shredded', scopeId: shredded.rows[0].scope_id };
        return undefined;
      }
      const recipients = [...new Set(rows.map(row => row.recipient))];
      await lockEach(client, 'e2ee-member-kem', tenant, recipients);
      const floors = await client.query<{ member_id: string; kem_epoch: string }>(
        `SELECT member_id, kem_epoch FROM e2ee_member_kem_floor
          WHERE tenant_id = $1 AND member_id = ANY($2::text[])
          ORDER BY member_id COLLATE "C"`, [tenant, recipients]);
      const floor = new Map(floors.rows.map(row => [row.member_id, Number(row.kem_epoch)]));
      const stale = rows.find(row => row.recipientKemEpoch < (floor.get(row.recipient) ?? 0));
      if (stale !== undefined) {
        refusal = { outcome: 'kem_epoch_stale', recipient: stale.recipient, kemEpoch: stale.recipientKemEpoch, floor: floor.get(stale.recipient)! };
        return undefined;
      }
      for (const row of rows) {
        await client.query(
          `INSERT INTO e2ee_scope_epoch (tenant_id, scope_id, epoch, key_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, scope_id, epoch) DO NOTHING`, [tenant, row.scopeId, row.epoch, row.keyId]);
        // A concurrent first writer's row is visible here once it commits;
        // FOR SHARE holds it until this transaction ends.
        const fixed = await client.query<{ key_id: string }>(
          'SELECT key_id FROM e2ee_scope_epoch WHERE tenant_id = $1 AND scope_id = $2 AND epoch = $3 FOR SHARE',
          [tenant, row.scopeId, row.epoch]);
        const keyId = fixed.rows[0]!.key_id;
        if (keyId !== row.keyId) {
          refusal = { outcome: 'key_id_conflict', scopeId: row.scopeId, epoch: row.epoch, keyId };
          return undefined;
        }
        await client.query(
          `INSERT INTO e2ee_scope_key_package (tenant_id, scope_id, epoch, recipient, key_id, sender, package, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tenant_id, scope_id, epoch, recipient) DO UPDATE SET
             sender = EXCLUDED.sender, package = EXCLUDED.package, updated_at = EXCLUDED.updated_at`,
          [tenant, row.scopeId, row.epoch, row.recipient, row.keyId, row.sender, row.package, updatedAt]);
      }
      return recordRequest<E2eeScopeKeyPackagePutResult>(client, tenant, proof, { outcome: 'stored', stored: rows.length }, updatedAt);
    });
    return refusal ?? result;
  }

  async readOwnScopeKeyPackages(
    tenant: TenantId,
    input: { readonly scopeId: string; readonly recipient: string; readonly afterEpoch: number; readonly limit: number },
  ): Promise<{ readonly rows: readonly E2eeScopeKeyPackageRow[]; readonly scopeHeadEpoch: number | undefined }> {
    // Two reads, no snapshot: a head newer than the page only feeds the next
    // epoch choice, and a put of a taken epoch is refused by its keyId.
    const rows = await this.pool.query<PackageRow>(
      `SELECT scope_id, epoch, recipient, key_id, sender, package FROM e2ee_scope_key_package
        WHERE tenant_id = $1 AND scope_id = $2 AND recipient = $3 AND epoch > $4
        ORDER BY epoch LIMIT $5`,
      [tenant, input.scopeId, input.recipient, input.afterEpoch, input.limit]);
    const head = await this.pool.query<{ head: string | null }>(
      'SELECT MAX(epoch)::text AS head FROM e2ee_scope_epoch WHERE tenant_id = $1 AND scope_id = $2', [tenant, input.scopeId]);
    const scopeHeadEpoch = head.rows[0]!.head;
    return { rows: rows.rows.map(decodePackage), scopeHeadEpoch: scopeHeadEpoch === null ? undefined : Number(scopeHeadEpoch) };
  }

  async readScopeKeyPackages(
    tenant: TenantId,
    input: { readonly scopeId: string; readonly epoch?: number; readonly recipient?: string },
  ): Promise<readonly E2eeScopeKeyPackageRow[]> {
    const result = await this.pool.query<PackageRow>(
      `SELECT scope_id, epoch, recipient, key_id, sender, package FROM e2ee_scope_key_package
        WHERE tenant_id = $1 AND scope_id = $2 AND ($3::bigint IS NULL OR epoch = $3) AND ($4::text IS NULL OR recipient = $4)
        ORDER BY epoch, recipient COLLATE "C"`,
      [tenant, input.scopeId, input.epoch ?? null, input.recipient ?? null]);
    return result.rows.map(decodePackage);
  }

  async registerMember(tenant: TenantId, input: E2eeMemberRegistrationInput): Promise<E2eeMemberRegisterResult> {
    let refusal: E2eeMemberRegisterResult | undefined;
    const proof = { deviceId: input.deviceId, request: input.request };
    const result = await this.#transaction<E2eeMemberRegisterResult>(async client => {
      const replay = await recordedRequest(client, tenant, proof, text => parseRecordedWriteResult('memberKeyRegister', text));
      if (replay === 'request_conflict') {
        refusal = replay;
        return undefined;
      }
      if (replay !== undefined) return replay;
      const inserted = await client.query(
        `INSERT INTO e2ee_member_key (tenant_id, device_id, member_id, bundle) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`, [tenant, input.deviceId, input.memberId, input.bundle]);
      if (!inserted.rowCount) {
        const stored = await client.query<{ bundle: string }>(
          'SELECT bundle FROM e2ee_member_key WHERE tenant_id = $1 AND device_id = $2', [tenant, input.deviceId]);
        const bundle = stored.rows[0]?.bundle;
        if (bundle !== input.bundle) {
          refusal = bundle === undefined ? 'member_conflict' : 'device_conflict';
          return undefined;
        }
      }
      await client.query(
        `INSERT INTO e2ee_pairing_mac (tenant_id, device_id, kind, body, expires_at) VALUES ($1, $2, 'device', $3, $4)
         ON CONFLICT (tenant_id, device_id, kind) DO UPDATE SET body = EXCLUDED.body, expires_at = EXCLUDED.expires_at`,
        [tenant, input.deviceId, input.deviceMac, input.macExpiresAt]);
      return recordRequest<E2eeMemberRegisterResult>(client, tenant, proof, inserted.rowCount ? 'registered' : 'replayed', this.clock.now());
    });
    return refusal ?? result;
  }

  async readMemberRegistration(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly now: string },
  ): Promise<E2eeMemberRegistrationRow | undefined> {
    const result = await this.pool.query<{ member_id: string; bundle: string; mac: string | null }>(
      `SELECT k.member_id, k.bundle, m.body AS mac FROM e2ee_member_key k
         LEFT JOIN e2ee_pairing_mac m ON m.tenant_id = k.tenant_id AND m.device_id = k.device_id
          AND m.kind = 'device' AND m.expires_at > $3
        WHERE k.tenant_id = $1 AND k.device_id = $2`, [tenant, input.deviceId, input.now]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return row.mac === null ? { memberId: row.member_id, bundle: row.bundle } : { memberId: row.member_id, bundle: row.bundle, deviceMac: row.mac };
  }

  async putClientPairingMac(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly body: string; readonly expiresAt: string },
  ): Promise<'stored' | 'not_registered'> {
    // One statement: the registration check and the write see one snapshot.
    const result = await this.pool.query(
      `INSERT INTO e2ee_pairing_mac (tenant_id, device_id, kind, body, expires_at)
       SELECT $1::text, $2::text, 'client', $3::text, $4::timestamptz
        WHERE EXISTS (SELECT 1 FROM e2ee_member_key WHERE tenant_id = $1::text AND device_id = $2::text)
       ON CONFLICT (tenant_id, device_id, kind) DO UPDATE SET body = EXCLUDED.body, expires_at = EXCLUDED.expires_at`,
      [tenant, input.deviceId, input.body, input.expiresAt]);
    return result.rowCount ? 'stored' : 'not_registered';
  }

  async readClientPairingMac(tenant: TenantId, input: { readonly deviceId: string; readonly now: string }): Promise<string | undefined> {
    const result = await this.pool.query<{ body: string }>(
      `SELECT body FROM e2ee_pairing_mac WHERE tenant_id = $1 AND device_id = $2 AND kind = 'client' AND expires_at > $3`,
      [tenant, input.deviceId, input.now]);
    return result.rows[0]?.body;
  }
}
