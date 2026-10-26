import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock } from '@byok-sdk/core';
import { createWebCrypto, WireV4ReceiptMigrationError } from '@byok-sdk/cloud';
import { decodeEnvelope } from '@byok-sdk/protocol';
import { createSqliteEmbeddedStores } from '..';
import { isSqliteAvailable } from '../../../sqlite-support';
import { migrateSqliteReceiptsToWireV4 } from '../wire-v4-receipt-migration';

const v3Terminal = readFileSync(new URL('../../../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd().split('\n')
  .find((line) => (JSON.parse(line) as { type: string }).type === 'task.complete')!;
const AGENT = { agentId: 'agent-1', profileRevision: 'rev-1' };
const agentOffer = JSON.stringify({ deviceId: 'device-1', type: 'task.offer_for_agent', payload: { instruction: 'x', agentRef: AGENT } });
const legacyOffer = JSON.stringify({ deviceId: 'device-1', type: 'task.offer', payload: { instruction: 'x' } });
const unrelated = '{"anything":"kept"}';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function storeWith(rows: ReadonlyArray<readonly [tenant: string, key: string, body: string]>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'byok-wire-v4-receipts-'));
  directories.push(dir);
  const path = join(dir, 'store.sqlite');
  await createSqliteEmbeddedStores({ path }, { clock: createMutableClock(), crypto: createWebCrypto() }).close();
  const db = new DatabaseSync(path);
  const insert = db.prepare('INSERT INTO request_receipt (tenant_id, key, body, recorded_at) VALUES (?, ?, ?, ?)');
  for (const [tenant, key, body] of rows) insert.run(tenant, key, body, '2026-10-01T00:00:00.000Z');
  db.close();
  return path;
}

function receipts(path: string): ReadonlyArray<{ tenant_id: string; key: string; body: string; recorded_at: string }> {
  const db = new DatabaseSync(path);
  try {
    return db.prepare('SELECT tenant_id, key, body, recorded_at FROM request_receipt ORDER BY tenant_id, key').all() as never;
  } finally {
    db.close();
  }
}

describe.skipIf(!isSqliteAvailable())('SQLite wire v3 -> v4 receipt migration (#925)', () => {
  it('re-encodes v3 terminal receipts and keeps v4-readable and unrelated receipts', async () => {
    const path = await storeWith([
      ['tenant-a', 'task:t1:terminal', v3Terminal],
      ['tenant-b', 'task:t1:terminal', v3Terminal],
      ['tenant-a', 'task-offer:m1', agentOffer],
      ['tenant-a', 'task-redaction:t1', unrelated],
    ]);

    expect(migrateSqliteReceiptsToWireV4(path)).toEqual({ migrated: 2, unchanged: 1 });

    const rows = receipts(path);
    for (const row of rows.filter((r) => r.key === 'task:t1:terminal')) {
      expect(decodeEnvelope(row.body)).toMatchObject({ v: 4, type: 'task.complete' });
      expect(row.recorded_at).toBe('2026-10-01T00:00:00.000Z');
    }
    expect(rows.find((r) => r.key === 'task-offer:m1')!.body).toBe(agentOffer);
    expect(rows.find((r) => r.key === 'task-redaction:t1')!.body).toBe(unrelated);
    expect(migrateSqliteReceiptsToWireV4(path)).toEqual({ migrated: 0, unchanged: 3 });
  });

  it('changes no receipt and lists the refused ones when any receipt cannot be migrated', async () => {
    const path = await storeWith([
      ['tenant-a', 'task:t1:terminal', v3Terminal],
      ['tenant-a', 'task-offer:legacy', legacyOffer],
    ]);
    const before = receipts(path);

    let failure: unknown;
    try {
      migrateSqliteReceiptsToWireV4(path);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WireV4ReceiptMigrationError);
    expect((failure as WireV4ReceiptMigrationError).refused).toEqual([
      { tenantId: 'tenant-a', key: 'task-offer:legacy', kind: 'offer', refusal: 'type_without_v4_form', type: 'task.offer' },
    ]);
    expect(receipts(path)).toEqual(before);
  });

  it('refuses a path with no store instead of creating one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byok-wire-v4-receipts-'));
    directories.push(dir);
    expect(() => migrateSqliteReceiptsToWireV4(join(dir, 'missing.sqlite'))).toThrow(/No BYOK SQLite database/);
  });
});
