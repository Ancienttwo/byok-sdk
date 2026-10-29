/**
 * Migration 0032 and the retention policies stored before it (#1120).
 *
 * Each stored policy gets an archive window of 90 days, or the sum of its
 * unacked and dead-letter windows when that is longer, and keeps every other
 * column, so a policy the application accepted before is still read and
 * maintained. A policy row, referenced by an entitlement or not, whose windows
 * the application would refuse or whose window sum no archive window can hold
 * (above Number.MAX_SAFE_INTEGER) stops the migration, which then leaves the
 * schema, the rows and the migration ledger exactly as they were.
 */
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresRetentionPolicyStore } from '../stores/retention-policy';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON, type DataplaneScope } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const MIGRATION = '0032_terminal_task_archive.sql';
const DAY_MS = 86_400_000n;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const BIGINT_MAX = 9_223_372_036_854_775_807n;

interface StoredPolicy {
  readonly tenant: string;
  readonly unackedMs: bigint;
  readonly deadLetterMs: bigint;
  readonly ackedMs?: bigint;
  /** A policy no entitlement names is still a stored row. */
  readonly referenced?: boolean;
}

/** Applies every migration before 0032, stores each policy, and adds 0032 to the directory. */
async function before0032(scope: DataplaneScope, policies: readonly StoredPolicy[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'byok-before-0032-'));
  for (const name of await readdir(DEPLOY_SQL)) {
    if (name.endsWith('.sql') && name < '0032') await copyFile(join(DEPLOY_SQL, name), join(directory, name));
  }
  await migrate(scope.pool, directory);
  for (const { tenant, unackedMs, deadLetterMs, ackedMs = DAY_MS, referenced = true } of policies) {
    await scope.pool.query(
      `INSERT INTO tenant_retention_policy (
         tenant_id, policy_id, mailbox_acked_retention_ms, mailbox_unacked_retention_ms,
         mailbox_dead_letter_retention_ms, request_receipt_retention_ms, object_orphan_grace_ms, updated_at
       ) VALUES ($1, 'stored', $2, $3, $4, $5, $6, '2026-01-01T00:00:00.000Z')`,
      [tenant, ackedMs, unackedMs, deadLetterMs, DAY_MS, DAY_MS],
    );
    if (!referenced) continue;
    await scope.pool.query(
      `INSERT INTO storage_entitlement (tenant_id, version, hard_limit_bytes, max_object_bytes, max_inline_bytes, mailbox_limit_bytes, retention_policy_id)
       VALUES ($1, 1, 1000, 100, 10, 1000, 'stored')`,
      [tenant],
    );
  }
  await copyFile(join(DEPLOY_SQL, MIGRATION), join(directory, MIGRATION));
  return directory;
}

/** Everything a refused 0032 must leave as it was. */
async function snapshot(scope: DataplaneScope) {
  const query = async (sql: string) => (await scope.pool.query(sql)).rows;
  return {
    policies: await query('SELECT * FROM tenant_retention_policy ORDER BY tenant_id, policy_id'),
    columns: await query(`SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'tenant_retention_policy' ORDER BY column_name`),
    checks: await query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'tenant_retention_policy'::regclass ORDER BY conname`),
    taskColumns: await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'task' ORDER BY column_name`),
    ledger: await query('SELECT version FROM byok_schema_migration ORDER BY version'),
  };
}

describe.skipIf(SKIP_DATAPLANE)(`Postgres 0032 and the policies stored before it — ${SKIP_REASON}`, () => {
  it('keeps every stored window and archives no earlier than the mailbox windows allow', async () => {
    const scope = await createDataplaneScope();
    const cases = [
      { policy: { tenant: 'policy-defaults', unackedMs: 7n * DAY_MS, deadLetterMs: 30n * DAY_MS }, archiveMs: 90n * DAY_MS },
      { policy: { tenant: 'policy-long', unackedMs: 60n * DAY_MS, deadLetterMs: 60n * DAY_MS }, archiveMs: 120n * DAY_MS },
      { policy: { tenant: 'policy-ninety', unackedMs: 45n * DAY_MS, deadLetterMs: 45n * DAY_MS }, archiveMs: 90n * DAY_MS },
      { policy: { tenant: 'policy-largest', unackedMs: MAX - 1n, deadLetterMs: 1n }, archiveMs: MAX },
    ] as const;
    const directory = await before0032(scope, [
      ...cases.map(({ policy }) => policy),
      { tenant: 'policy-unreferenced', unackedMs: 60n * DAY_MS, deadLetterMs: 60n * DAY_MS, referenced: false },
    ]);
    try {
      await expect(migrate(scope.pool, directory)).resolves.toMatchObject({ applied: [MIGRATION] });
      const store = new PostgresRetentionPolicyStore(scope.pool, createMutableClock());
      for (const { policy, archiveMs } of cases) {
        await expect(store.readRetentionPolicy(tenantId(policy.tenant))).resolves.toMatchObject({
          mailboxAckedRetentionMs: DAY_MS,
          mailboxUnackedRetentionMs: policy.unackedMs,
          mailboxDeadLetterRetentionMs: policy.deadLetterMs,
          requestReceiptRetentionMs: DAY_MS,
          objectOrphanGraceMs: DAY_MS,
          terminalTaskArchiveMs: archiveMs,
          updatedAt: '2026-01-01T00:00:00.000Z',
        });
      }
      const unreferenced = await scope.pool.query<{ ms: string }>(
        `SELECT terminal_task_archive_ms::text AS ms FROM tenant_retention_policy WHERE tenant_id = 'policy-unreferenced'`,
      );
      expect(unreferenced.rows).toEqual([{ ms: String(120n * DAY_MS) }]);
      // The application writes the column; nothing supplies it otherwise.
      const column = await scope.pool.query(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'tenant_retention_policy' AND column_name = 'terminal_task_archive_ms'`,
      );
      expect(column.rows).toEqual([{ is_nullable: 'NO', column_default: null }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await scope.dispose();
    }
  });

  it.each([
    { name: 'a window sum one above the largest window', policy: { tenant: 'policy-sum-over', unackedMs: MAX, deadLetterMs: 1n } },
    { name: 'two largest windows', policy: { tenant: 'policy-both-max', unackedMs: MAX, deadLetterMs: MAX } },
    { name: 'bigint extremes the application never accepted', policy: { tenant: 'policy-bigint', unackedMs: BIGINT_MAX, deadLetterMs: BIGINT_MAX } },
    { name: 'an unreferenced row with a zero window', policy: { tenant: 'policy-zero', unackedMs: DAY_MS, deadLetterMs: DAY_MS, ackedMs: 0n, referenced: false } },
  ])('stops before any change for $name and names the policy', async ({ policy }) => {
    const scope = await createDataplaneScope();
    const directory = await before0032(scope, [{ tenant: 'policy-valid', unackedMs: 7n * DAY_MS, deadLetterMs: 30n * DAY_MS }, policy]);
    try {
      const before = await snapshot(scope);
      const refused = await migrate(scope.pool, directory).then(() => undefined, (error: unknown) => error);
      expect(String(refused)).toMatch(new RegExp(`0032: .*: ${policy.tenant}/stored$`, 'u'));
      expect(await snapshot(scope)).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await scope.dispose();
    }
  });

  it('applies once the operator corrects the refused windows', async () => {
    const scope = await createDataplaneScope();
    const directory = await before0032(scope, [{ tenant: 'policy-sum-over', unackedMs: MAX, deadLetterMs: 1n }]);
    try {
      await expect(migrate(scope.pool, directory)).rejects.toThrow(/0032: /u);
      await scope.pool.query(`UPDATE tenant_retention_policy SET mailbox_unacked_retention_ms = $1 WHERE tenant_id = 'policy-sum-over'`, [MAX - 1n]);
      await expect(migrate(scope.pool, directory)).resolves.toMatchObject({ applied: [MIGRATION] });
      await expect(new PostgresRetentionPolicyStore(scope.pool, createMutableClock()).readRetentionPolicy(tenantId('policy-sum-over')))
        .resolves.toMatchObject({ mailboxUnackedRetentionMs: MAX - 1n, mailboxDeadLetterRetentionMs: 1n, terminalTaskArchiveMs: MAX });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await scope.dispose();
    }
  });
});
