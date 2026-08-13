/**
 * The no-oversell property under REAL connection concurrency.
 *
 * This is not a second copy of a conformance assertion. `runCoreConformance`'s
 * quota dimension asserts the port BEHAVIOR — that a reservation which would
 * cross the hard limit is refused with `storage_quota_exceeded` — and it does
 * so sequentially, one caller at a time. What it cannot assert, because it is
 * composition-agnostic by construction, is the thing only a SQL composition can
 * get wrong: whether concurrent reservers actually serialize.
 *
 * They do not, for free. Admission is a guarded `INSERT ... SELECT ... WHERE`
 * whose operand is an aggregate over live reservations, and under READ
 * COMMITTED every statement takes its snapshot at statement start — so without
 * a lock, N racers all read a pre-insert world and all pass. Postgres'
 * EvalPlanQual re-check, the mechanism that makes `UPDATE ... WHERE status = $x`
 * a genuine CAS elsewhere in this package, re-evaluates only against the
 * updated target row and leaves a subquery over another table on the original
 * snapshot. `PostgresQuotaStore.reserve` therefore takes `FOR UPDATE` on the
 * tenant's entitlement row first, so the guarded statement runs on a snapshot
 * acquired behind that lock.
 *
 * Removing that lock passes every conformance case and every gate in this
 * repository, and oversells the tenant (verified while writing this file: six
 * winners instead of five). This test is the only thing standing between that
 * refactor and production, which is why it lives here — beside the composition
 * whose substrate semantics it pins — rather than in the composition-agnostic
 * suite, where it would have to assert something no in-memory store can fail.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentHash, createMutableClock, isCoreError, tenantId } from '@byok-sdk/core';
import { migrate } from '../migrate';
import { PostgresObjectStore } from '../stores/core/objects';
import { PostgresQuotaStore } from '../stores/core/quota';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-a');

const HARD_LIMIT = 1_000n;
const RACERS = 8;
const BYTES_EACH = 200n;
/** Eight racers at 200 bytes against a 1000-byte limit: exactly five may win. */
const ADMISSIBLE = 5;
/**
 * One race is not enough evidence. Measured while writing this: with the
 * `FOR UPDATE` removed, a single round oversells on roughly five sixths of its
 * runs — so a one-round assertion lets the lock be deleted on a green suite
 * about one time in six. Three independent rounds inside one test drive that
 * escape rate to a few tenths of a percent, at the cost of two more races.
 */
const ROUNDS = 3;
const DEDUP_RACERS = 4;

describe.skipIf(SKIP_DATAPLANE)('quota reservation under real concurrency', () => {
  it('admits exactly as many concurrent reservations as the hard limit allows', async () => {
    // A pool wide enough that the racers are genuinely concurrent connections
    // rather than a queue the client serialized on our behalf.
    const scope = await createDataplaneScope(RACERS + 4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, createMutableClock());
      await quota.writeEntitlement(TENANT, {
        version: 1n,
        hardLimitBytes: HARD_LIMIT,
        maxObjectBytes: 400n,
        maxInlineBytes: 100n,
        mailboxLimitBytes: 500n,
        retentionPolicyId: 'default',
      });

      for (let round = 0; round < ROUNDS; round += 1) {
        const attempts = await Promise.allSettled(
          Array.from({ length: RACERS }, (_unused, index) =>
            quota.reserve(TENANT, {
              reservationId: `res-${round}-${index}`,
              kind: 'object',
              expectedBytes: BYTES_EACH,
              contentHash: contentHash(`sha256:${index.toString(16).padStart(64, '0')}`),
              contentType: 'application/octet-stream',
              ttlMs: 60_000,
            }),
          ),
        );

        const winners = attempts.filter((attempt) => attempt.status === 'fulfilled');
        const losers = attempts.filter((attempt) => attempt.status === 'rejected');
        expect(winners).toHaveLength(ADMISSIBLE);
        for (const loser of losers) {
          const reason = (loser as PromiseRejectedResult).reason as unknown;
          // A loser learns it was over quota, not that the database was busy.
          expect(isCoreError(reason, 'storage_quota_exceeded')).toBe(true);
        }

        // The ledger agrees with the winners: no admitted reservation is
        // missing its bytes, and no refused one left bytes behind.
        const usage = await quota.readUsage(TENANT);
        expect(usage.reservedBytes).toBe(BigInt(ADMISSIBLE) * BYTES_EACH);
        expect(usage.reservedBytes).toBeLessThanOrEqual(HARD_LIMIT);

        // Reset to an empty ledger so the next round races from the same
        // starting world rather than against the previous round's winners.
        await scope.pool.query('DELETE FROM storage_reservation');
      }
    } finally {
      await scope.dispose();
    }
  });

  it('accounts one object when same-hash finalizers race from a pending manifest', async () => {
    const scope = await createDataplaneScope(DEDUP_RACERS + 3);
    const locker = await scope.pool.connect();
    let lockerReleased = false;
    let finalizations: readonly Promise<Awaited<ReturnType<PostgresQuotaStore['finalizeReservation']>>>[] = [];
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const objects = new PostgresObjectStore(scope.pool, clock);
      const hash = contentHash(`sha256:${'a'.repeat(64)}`);
      await quota.writeEntitlement(TENANT, {
        version: 1n,
        hardLimitBytes: HARD_LIMIT,
        maxObjectBytes: 400n,
        maxInlineBytes: 100n,
        mailboxLimitBytes: 500n,
        retentionPolicyId: 'default',
      });
      for (let index = 0; index < DEDUP_RACERS; index += 1) {
        await quota.reserve(TENANT, {
          reservationId: `dedup-${index}`,
          kind: 'object',
          expectedBytes: BYTES_EACH,
          contentHash: hash,
          contentType: 'application/octet-stream',
          ttlMs: 60_000,
        });
      }
      await objects.putManifest(TENANT, {
        hash,
        byteSize: BYTES_EACH,
        contentType: 'application/octet-stream',
      });

      // Hold the manifest row so every statement materializes the same
      // pre-transition `pending` state before one of them wins the update.
      // This deterministically catches snapshot-based dedupe decisions.
      await locker.query('BEGIN');
      await locker.query(
        'SELECT 1 FROM object_manifest WHERE tenant_id = $1 AND hash = $2 FOR UPDATE',
        [TENANT, hash],
      );
      finalizations = Array.from({ length: DEDUP_RACERS }, (_unused, index) =>
        quota.finalizeReservation(TENANT, {
          reservationId: `dedup-${index}`,
          observedByteSize: BYTES_EACH,
          observedContentType: 'application/octet-stream',
        }),
      );

      let blocked = 0;
      for (let attempt = 0; attempt < 100 && blocked < DEDUP_RACERS; attempt += 1) {
        const result = await scope.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM pg_stat_activity
            WHERE application_name = $1
              AND wait_event_type = 'Lock'
              AND query LIKE '%WITH candidate AS MATERIALIZED%'`,
          [scope.applicationName],
        );
        blocked = Number(result.rows[0]?.count ?? '0');
        if (blocked < DEDUP_RACERS) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(blocked).toBe(DEDUP_RACERS);

      await locker.query('COMMIT');
      locker.release();
      lockerReleased = true;

      const results = await Promise.all(finalizations);
      expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
      expect(results.filter((result) => result.deduplicated)).toHaveLength(DEDUP_RACERS - 1);
      const usage = await quota.readUsage(TENANT);
      expect(usage.committedObjectBytes).toBe(BYTES_EACH);
      expect(usage.objectCount).toBe(1n);
      expect(usage.reservedBytes).toBe(0n);
    } finally {
      if (!lockerReleased) {
        await locker.query('ROLLBACK').catch(() => undefined);
        locker.release();
      }
      await Promise.allSettled(finalizations);
      await scope.dispose();
    }
  });
});
