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
import { contentHash, createMutableClock, isCoreError, tenantId } from '@byok/core';
import { migrate } from '../migrate';
import { PostgresQuotaStore } from '../stores/core/quota';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-a');

const HARD_LIMIT = 1_000n;
const RACERS = 8;
const BYTES_EACH = 200n;
/** Eight racers at 200 bytes against a 1000-byte limit: exactly five may win. */
const ADMISSIBLE = 5;

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

      const attempts = await Promise.allSettled(
        Array.from({ length: RACERS }, (_unused, index) =>
          quota.reserve(TENANT, {
            reservationId: `res-${index}`,
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

      // The ledger agrees with the winners: no admitted reservation is missing
      // its bytes, and no refused one left bytes behind.
      const usage = await quota.readUsage(TENANT);
      expect(usage.reservedBytes).toBe(BigInt(ADMISSIBLE) * BYTES_EACH);
      expect(usage.reservedBytes).toBeLessThanOrEqual(HARD_LIMIT);
    } finally {
      await scope.dispose();
    }
  });
});
