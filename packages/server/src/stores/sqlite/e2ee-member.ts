import type { Clock, TenantId } from '@byok-sdk/core';
import type {
  E2eeMemberChainAppendInput,
  E2eeMemberChainAppendResult,
  E2eeMemberChainRow,
  E2eeMemberRegisterResult,
  E2eeMemberRegistrationInput,
  E2eeMemberRegistrationRow,
  E2eeMemberStore,
  E2eeScopeKeyPackagePutInput,
  E2eeScopeKeyPackagePutResult,
  E2eeScopeKeyPackageRow,
} from '@byok-sdk/cloud';
import type { DatabaseSync } from 'node:sqlite';

/**
 * #654 E2c. Added to every database on open with `IF NOT EXISTS`, after the
 * schema version gate, so no embedded user runs a migration for a feature
 * only hosted devices use. Each table is then checked by projection, so a
 * same-named table of another shape fails closed.
 */
export const E2EE_MEMBER_SCHEMA = `
CREATE TABLE IF NOT EXISTS e2ee_member_chain_entry (
  tenant_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  entry TEXT NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE TABLE IF NOT EXISTS e2ee_member_key (
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  bundle TEXT NOT NULL,
  PRIMARY KEY (tenant_id, device_id),
  UNIQUE (tenant_id, member_id)
);
CREATE TABLE IF NOT EXISTS e2ee_scope_epoch (
  tenant_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  key_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope_id, epoch)
);
CREATE TABLE IF NOT EXISTS e2ee_scope_key_package (
  tenant_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  recipient TEXT NOT NULL,
  key_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  package TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope_id, epoch, recipient),
  FOREIGN KEY (tenant_id, scope_id, epoch) REFERENCES e2ee_scope_epoch (tenant_id, scope_id, epoch)
);
CREATE INDEX IF NOT EXISTS e2ee_scope_key_package_recipient ON e2ee_scope_key_package (tenant_id, recipient);
CREATE TABLE IF NOT EXISTS e2ee_scope_shred (
  tenant_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  chain_seq INTEGER NOT NULL CHECK (chain_seq > 0),
  PRIMARY KEY (tenant_id, scope_id)
);
`;

export const E2EE_MEMBER_PROJECTIONS = [
  'tenant_id, seq, entry FROM e2ee_member_chain_entry',
  'tenant_id, device_id, member_id, bundle FROM e2ee_member_key',
  'tenant_id, scope_id, epoch, key_id FROM e2ee_scope_epoch',
  'tenant_id, scope_id, epoch, recipient, key_id, sender, package FROM e2ee_scope_key_package',
  'tenant_id, scope_id, chain_seq FROM e2ee_scope_shred',
] as const;

/** The device's member state, deleted in the device directory's own transaction on revoke and supersession. */
export function deleteE2eeDeviceState(db: DatabaseSync, tenant: TenantId, deviceIds: readonly string[]): void {
  for (const deviceId of deviceIds) {
    db.prepare(`DELETE FROM e2ee_scope_key_package WHERE tenant_id = ? AND recipient IN (
      SELECT member_id FROM e2ee_member_key WHERE tenant_id = ? AND device_id = ?)`).run(tenant, tenant, deviceId);
    db.prepare('DELETE FROM e2ee_member_key WHERE tenant_id = ? AND device_id = ?').run(tenant, deviceId);
  }
}

interface Coordinator {
  run<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
  transaction<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
}

interface Expiring {
  readonly body: string;
  readonly expiresAt: string;
}

type PackageRow = Record<string, unknown> & {
  scope_id: string; epoch: number; recipient: string; key_id: string; sender: string; package: string;
};

/**
 * SQLite E2EE member store. The coordinator runs one call at a time, so each
 * transaction checks every row before it writes any. Pairing MACs live for
 * one pairing window and stay in memory, like pairing codes. Each MAC write
 * first drops the MACs whose window has passed. A shred receipt goes to
 * `request_receipt`, the request receipt store, in the append transaction.
 */
export class SqliteE2eeMemberStore implements E2eeMemberStore {
  /** `macs` is the pairing MAC map; a test passes its own to watch the sweep. */
  constructor(
    private readonly coordinator: Coordinator,
    private readonly clock: Clock,
    private readonly macs: Map<string, Expiring> = new Map(),
  ) {}

  #setMac(key: string, value: Expiring): void {
    const now = this.clock.now().getTime();
    for (const [stored, mac] of this.macs) {
      if (Date.parse(mac.expiresAt) <= now) this.macs.delete(stored);
    }
    this.macs.set(key, value);
  }

  appendChainEntries(tenant: TenantId, input: E2eeMemberChainAppendInput): Promise<E2eeMemberChainAppendResult> {
    const { rows } = input;
    return this.coordinator.transaction(db => {
      const headSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM e2ee_member_chain_entry WHERE tenant_id = ?')
        .get(tenant) as { head: number }).head;
      if (rows[0]!.seq > headSeq + 1) return { outcome: 'gap', seq: rows[0]!.seq, headSeq };
      const stored = db.prepare('SELECT entry FROM e2ee_member_chain_entry WHERE tenant_id = ? AND seq = ?');
      for (const row of rows) {
        if (row.seq > headSeq) break;
        if ((stored.get(tenant, row.seq) as { entry: string }).entry !== row.entry) return { outcome: 'conflict', seq: row.seq };
      }
      const fresh = rows.filter(row => row.seq > headSeq);
      const insert = db.prepare('INSERT INTO e2ee_member_chain_entry (tenant_id, seq, entry) VALUES (?, ?, ?)');
      for (const row of fresh) insert.run(tenant, row.seq, row.entry);
      const recordedAt = this.clock.now().toISOString();
      for (const shred of input.shreds) {
        if (shred.seq <= headSeq) continue;
        db.prepare('DELETE FROM e2ee_scope_key_package WHERE tenant_id = ? AND scope_id = ?').run(tenant, shred.scopeId);
        db.prepare('DELETE FROM e2ee_scope_epoch WHERE tenant_id = ? AND scope_id = ?').run(tenant, shred.scopeId);
        db.prepare('INSERT INTO e2ee_scope_shred (tenant_id, scope_id, chain_seq) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
          .run(tenant, shred.scopeId, shred.seq);
        db.prepare('INSERT INTO request_receipt (tenant_id, key, body, recorded_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
          .run(tenant, shred.receipt.key, shred.receipt.body, recordedAt);
      }
      return { outcome: 'appended', appended: fresh.length, replayed: rows.length - fresh.length };
    });
  }

  readChainEntries(tenant: TenantId, input: { readonly afterSeq: number; readonly limit: number }): Promise<readonly E2eeMemberChainRow[]> {
    return this.coordinator.run(db => db
      .prepare('SELECT seq, entry FROM e2ee_member_chain_entry WHERE tenant_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(tenant, input.afterSeq, input.limit)
      .map(row => ({ seq: row.seq as number, entry: row.entry as string })));
  }

  putScopeKeyPackages(tenant: TenantId, { rows }: E2eeScopeKeyPackagePutInput): Promise<E2eeScopeKeyPackagePutResult> {
    return this.coordinator.transaction(db => {
      const shred = db.prepare('SELECT 1 FROM e2ee_scope_shred WHERE tenant_id = ? AND scope_id = ?');
      const shredded = rows.find(row => shred.get(tenant, row.scopeId) !== undefined);
      if (shredded !== undefined) return { outcome: 'scope_shredded', scopeId: shredded.scopeId };
      const stored = db.prepare('SELECT key_id FROM e2ee_scope_epoch WHERE tenant_id = ? AND scope_id = ? AND epoch = ?');
      // The first row of a new scope epoch fixes its keyId for the rest of the call.
      const fixed = new Map<string, string>();
      for (const row of rows) {
        const epochKey = JSON.stringify([row.scopeId, row.epoch]);
        const keyId = (stored.get(tenant, row.scopeId, row.epoch) as { key_id: string } | undefined)?.key_id ?? fixed.get(epochKey);
        if (keyId !== undefined && keyId !== row.keyId) {
          return { outcome: 'key_id_conflict', scopeId: row.scopeId, epoch: row.epoch, keyId };
        }
        fixed.set(epochKey, row.keyId);
      }
      const epoch = db.prepare('INSERT INTO e2ee_scope_epoch (tenant_id, scope_id, epoch, key_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
      const put = db.prepare(`INSERT INTO e2ee_scope_key_package (tenant_id, scope_id, epoch, recipient, key_id, sender, package)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, scope_id, epoch, recipient) DO UPDATE SET sender = excluded.sender, package = excluded.package`);
      for (const row of rows) {
        epoch.run(tenant, row.scopeId, row.epoch, row.keyId);
        put.run(tenant, row.scopeId, row.epoch, row.recipient, row.keyId, row.sender, row.package);
      }
      return { outcome: 'stored', stored: rows.length };
    });
  }

  readScopeKeyPackages(
    tenant: TenantId,
    input: { readonly scopeId: string; readonly epoch?: number; readonly recipient?: string },
  ): Promise<readonly E2eeScopeKeyPackageRow[]> {
    return this.coordinator.run(db => (db.prepare(`SELECT scope_id, epoch, recipient, key_id, sender, package FROM e2ee_scope_key_package
        WHERE tenant_id = ? AND scope_id = ? AND (? IS NULL OR epoch = ?) AND (? IS NULL OR recipient = ?)
        ORDER BY epoch, recipient`)
      .all(tenant, input.scopeId, input.epoch ?? null, input.epoch ?? null, input.recipient ?? null, input.recipient ?? null) as PackageRow[])
      .map(row => ({ scopeId: row.scope_id, epoch: row.epoch, recipient: row.recipient, keyId: row.key_id, sender: row.sender, package: row.package })));
  }

  async registerMember(tenant: TenantId, input: E2eeMemberRegistrationInput): Promise<E2eeMemberRegisterResult> {
    const result = await this.coordinator.transaction((db): E2eeMemberRegisterResult => {
      const existing = db.prepare('SELECT bundle FROM e2ee_member_key WHERE tenant_id = ? AND device_id = ?')
        .get(tenant, input.deviceId) as { bundle: string } | undefined;
      if (existing !== undefined && existing.bundle !== input.bundle) return 'device_conflict';
      if (existing === undefined) {
        const taken = db.prepare('SELECT 1 FROM e2ee_member_key WHERE tenant_id = ? AND member_id = ?').get(tenant, input.memberId);
        if (taken !== undefined) return 'member_conflict';
        db.prepare('INSERT INTO e2ee_member_key (tenant_id, device_id, member_id, bundle) VALUES (?, ?, ?, ?)')
          .run(tenant, input.deviceId, input.memberId, input.bundle);
      }
      return existing === undefined ? 'registered' : 'replayed';
    });
    if (result === 'registered' || result === 'replayed') {
      this.#setMac(macKey(tenant, input.deviceId, 'device'), { body: input.deviceMac, expiresAt: input.macExpiresAt });
    }
    return result;
  }

  readMemberRegistration(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly now: string },
  ): Promise<E2eeMemberRegistrationRow | undefined> {
    return this.coordinator.run(db => {
      const row = db.prepare('SELECT member_id, bundle FROM e2ee_member_key WHERE tenant_id = ? AND device_id = ?')
        .get(tenant, input.deviceId) as { member_id: string; bundle: string } | undefined;
      if (row === undefined) return undefined;
      const mac = live(this.macs.get(macKey(tenant, input.deviceId, 'device')), input.now);
      return mac === undefined ? { memberId: row.member_id, bundle: row.bundle } : { memberId: row.member_id, bundle: row.bundle, deviceMac: mac };
    });
  }

  putClientPairingMac(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly body: string; readonly expiresAt: string },
  ): Promise<'stored' | 'not_registered'> {
    return this.coordinator.run(db => {
      if (db.prepare('SELECT 1 FROM e2ee_member_key WHERE tenant_id = ? AND device_id = ?').get(tenant, input.deviceId) === undefined) {
        return 'not_registered';
      }
      this.#setMac(macKey(tenant, input.deviceId, 'client'), { body: input.body, expiresAt: input.expiresAt });
      return 'stored';
    });
  }

  readClientPairingMac(tenant: TenantId, input: { readonly deviceId: string; readonly now: string }): Promise<string | undefined> {
    // Device cleanup deletes the registration in SQL; a MAC left in memory
    // for a removed registration is not returned.
    return this.coordinator.run(db =>
      db.prepare('SELECT 1 FROM e2ee_member_key WHERE tenant_id = ? AND device_id = ?').get(tenant, input.deviceId) === undefined
        ? undefined
        : live(this.macs.get(macKey(tenant, input.deviceId, 'client')), input.now));
  }
}

function macKey(tenant: TenantId, deviceId: string, kind: 'device' | 'client'): string {
  return JSON.stringify([tenant, deviceId, kind]);
}

function live(value: Expiring | undefined, now: string): string | undefined {
  return value !== undefined && Date.parse(now) < Date.parse(value.expiresAt) ? value.body : undefined;
}
