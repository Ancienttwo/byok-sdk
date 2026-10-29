import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { isSqliteAvailable } from '../sqlite-support';
import { createSqliteEmbeddedStores } from '../stores/sqlite';

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;
const TENANT = tenantId('sqlite-proof');
const OTHER = tenantId('sqlite-proof-other');
const binding = (requestId: string) => ({
  deviceId: 'device-1', requestId, operation: 'truth.put', resource: '/byok/records/k/key',
  bodySha256: 'sha256', bodySize: 1n, responseStatus: 200, responseBody: '{"ok":true}',
});

describeSqlite('SQLite proof request receipts', () => {
  const directories: string[] = [];
  const tempPath = () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-proof-'));
    directories.push(directory);
    return join(directory, 'server.sqlite');
  };
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the first result for a request id across a restart', async () => {
    const path = tempPath();
    const first = createSqliteEmbeddedStores({ path }, { clock: createMutableClock(), crypto: createWebCrypto() });
    const recorded = await first.cloud.proofReceipts.record(TENANT, binding('request-1'));
    expect(recorded).toMatchObject({ created: true, receipt: { tenantId: TENANT, requestId: 'request-1', bodySize: 1n } });
    await first.close();

    const second = createSqliteEmbeddedStores({ path }, { clock: createMutableClock(), crypto: createWebCrypto() });
    try {
      expect(await second.cloud.proofReceipts.record(TENANT, { ...binding('request-1'), responseBody: '{"ok":false}' }))
        .toEqual({ created: false, receipt: recorded.receipt });
      expect(await second.cloud.proofReceipts.get(TENANT, 'device-1', 'request-1')).toEqual(recorded.receipt);
      expect(await second.cloud.proofReceipts.get(OTHER, 'device-1', 'request-1')).toBeUndefined();
    } finally {
      await second.close();
    }
  });

  // Used device-proof request ids are pruned once their proof can no longer authenticate.
  it('prunes proof receipts recorded before the cutoff, per tenant and within the limit, and keeps later ones', async () => {
    const path = tempPath();
    const clock = createMutableClock(new Date('2026-10-25T00:00:00.000Z'));
    const stores = createSqliteEmbeddedStores({ path }, { clock, crypto: createWebCrypto() });
    const record = (tenant: typeof TENANT, requestId: string) => stores.cloud.proofReceipts.record(tenant, binding(requestId));
    try {
      await record(TENANT, 'old-1');
      await record(TENANT, 'old-2');
      await record(OTHER, 'other-old');
      const cutoff = '2026-10-25T00:15:00.000Z';
      clock.set(new Date(cutoff));
      await record(TENANT, 'at-cutoff');

      const prune = (limit: number) => stores.proofReceiptAuthority.collectExpired(TENANT, { now: cutoff, limit, recordedBefore: cutoff });
      expect(await prune(1)).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: true });
      expect(await prune(5)).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: false });
      expect(await prune(5)).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });

      // The receipt recorded at the cutoff stays; a pruned request id is free again.
      expect(await stores.cloud.proofReceipts.get(TENANT, 'device-1', 'at-cutoff')).toMatchObject({ recordedAt: cutoff });
      expect(await record(TENANT, 'old-1')).toMatchObject({ created: true });
      // Another tenant's receipt is untouched.
      expect(await stores.proofReceiptAuthority.collectExpired(OTHER, { now: cutoff, limit: 5, recordedBefore: cutoff }))
        .toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: false });
      await expect(stores.proofReceiptAuthority.collectExpired(TENANT, { now: cutoff, limit: 5, recordedBefore: 'yesterday' }))
        .rejects.toThrow();
    } finally {
      await stores.close();
    }
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'proof_request_receipt_recorded_idx'").get())
        .toEqual({ sql: expect.stringContaining('ON proof_request_receipt (tenant_id, recorded_at)') });
    } finally {
      raw.close();
    }
  });

  it('adds the table to an existing database without a version change', async () => {
    const path = tempPath();
    const open = () => createSqliteEmbeddedStores({ path }, { clock: createMutableClock(), crypto: createWebCrypto() });
    await open().close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE proof_request_receipt');
    const version = raw.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get();
    raw.close();

    const reopened = open();
    try {
      expect(await reopened.cloud.proofReceipts.record(TENANT, binding('request-1'))).toMatchObject({ created: true });
    } finally {
      await reopened.close();
    }
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()).toEqual(version);
    check.close();
  });
});
