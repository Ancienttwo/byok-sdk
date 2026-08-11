/**
 * The no-orphaned-tombstone property under REAL connection concurrency.
 *
 * The sibling of `quota-concurrency.test.ts`, and the same kind of assertion:
 * `runCoreConformance`'s object dimension pins the port BEHAVIOR — that
 * `markDeletePending` refuses at `refCount != 0` — one caller at a time. What
 * only a SQL composition can get wrong is whether a reference write and the
 * tombstone that must refuse against it actually serialize.
 *
 * They do not, for free. Unlocked, `addReference` is three autocommitted
 * statements: read the state, insert the reference row, recompute `ref_count`.
 * Under READ COMMITTED every one of them takes its own snapshot, so
 * `markDeletePending`'s `WHERE ref_count = 0 AND state IN (...)` guard — a
 * genuine CAS against the manifest row — can pass in the window after the state
 * read and before the recount, and the object lands on `delete_pending` with a
 * live reference. That is not a counting bug: S4B's GC sweep reads
 * `delete_pending` as permission to delete the bytes a truth record still
 * points at. `PostgresObjectStore` therefore takes `FOR UPDATE` on the manifest
 * row before it reads the state, so the tombstone queues against the reference
 * write instead of interleaving with it.
 *
 * The interleaving here is FORCED, not sampled. A third session holds the
 * manifest row, both racers are started against it and observed blocked (or,
 * unlocked, observed reading straight past it), and the holder then releases
 * them into a fixed queue order. Removing the `FOR UPDATE` turns this red on
 * every round rather than on some of them — which is the point, since a race
 * assertion that only sometimes fires is not a guard.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  createMutableClock,
  isCoreError,
  tenantId,
  type ContentHash,
} from '@byok-sdk/core';
import { migrate } from '../migrate';
import { PostgresObjectStore } from '../stores/core/objects';
import { createDataplaneScope, SKIP_DATAPLANE, type DataplaneScope } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-a');

/**
 * One round is one forced interleaving. Three of them, because the failure this
 * pins must be reproducible rather than sampled: a single round that happens to
 * schedule favorably would let the lock be deleted on a green suite.
 */
const ROUNDS = 3;
const BYTE_SIZE = 128n;
const CONTENT_TYPE = 'application/octet-stream';

function hashForRound(round: number): ContentHash {
  return contentHash(`sha256:${round.toString(16).padStart(64, '0')}`);
}

/**
 * Waits until `count` of this scope's own backends are blocked on a lock.
 *
 * `pg_stat_activity` is server-wide, so the filter on `application_name` is
 * load-bearing: another dataplane test file running concurrently has its own
 * blocked backends and would satisfy this wait for free.
 */
async function waitForBlockedBackends(scope: DataplaneScope, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await scope.pool.query<{ blocked: string }>(
      `SELECT count(*)::text AS blocked FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event_type = 'Lock'`,
      [scope.applicationName],
    );
    if (Number(result.rows[0]?.blocked ?? '0') >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} blocked backend(s) in ${scope.schema}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(SKIP_DATAPLANE)('object reference writes under real concurrency', () => {
  it('never tombstones an object that a concurrent reference write is landing on', async () => {
    // Wide enough that the holder, both racers, and the observer are genuinely
    // distinct connections rather than a queue the client serialized for us.
    const scope = await createDataplaneScope(8);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const objects = new PostgresObjectStore(scope.pool, createMutableClock());

      for (let round = 0; round < ROUNDS; round += 1) {
        const hash = hashForRound(round);
        await objects.putManifest(TENANT, {
          hash,
          byteSize: BYTE_SIZE,
          contentType: CONTENT_TYPE,
        });
        await objects.commit(TENANT, {
          hash,
          observedByteSize: BYTE_SIZE,
          observedContentType: CONTENT_TYPE,
        });

        // The barrier. Both racers must contend for this row, so neither can
        // finish before the other has started.
        const holder = await scope.pool.connect();
        let tombstone: Promise<unknown>;
        let reference: Promise<unknown>;
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM object_manifest WHERE tenant_id = $1 AND hash = $2 FOR UPDATE',
            [TENANT, hash],
          );

          // The tombstone goes first and is confirmed blocked, which fixes the
          // queue order: whatever the reference write does next, it is behind
          // a `markDeletePending` that will run the instant the holder lets go.
          tombstone = objects.markDeletePending(TENANT, hash).catch((error: unknown) => error);
          await waitForBlockedBackends(scope, 1);

          reference = objects
            .addReference(TENANT, { hash, refKind: 'truth_record', refId: `rec-${round}` })
            .catch((error: unknown) => error);
          // Give the reference write time to reach the row — blocked on it
          // under the fix, or (without it) to read the still-`committed` state
          // and queue its recount behind the tombstone.
          await new Promise((resolve) => setTimeout(resolve, 150));

          await holder.query('COMMIT');
        } finally {
          holder.release();
        }

        const [tombstoneOutcome, referenceOutcome] = await Promise.all([tombstone, reference]);
        const final = await objects.get(TENANT, hash);
        expect(final).toBeDefined();

        // The property, stated as the thing GC is allowed to assume: a
        // tombstone means nothing points at the bytes.
        expect(final?.state === 'delete_pending' && final.refCount > 0).toBe(false);

        // And the two outcomes agree with the row, so the property is not being
        // satisfied by both operations quietly failing.
        if (final?.state === 'delete_pending') {
          expect(final.refCount).toBe(0);
          expect(tombstoneOutcome).toMatchObject({ state: 'delete_pending' });
          expect(isCoreError(referenceOutcome, 'object_state_invalid')).toBe(true);
        } else {
          expect(final?.state).toBe('committed');
          expect(final?.refCount).toBe(1);
          expect(referenceOutcome).toMatchObject({ state: 'committed', refCount: 1 });
          expect(isCoreError(tombstoneOutcome, 'object_state_invalid')).toBe(true);
        }
      }
    } finally {
      await scope.dispose();
    }
  });
});
