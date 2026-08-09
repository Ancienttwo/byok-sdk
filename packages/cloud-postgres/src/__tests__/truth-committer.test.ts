import { fileURLToPath } from 'node:url';
import {
  TruthCommitError,
  createWebCrypto,
  type PreparedTruthWrite,
  type TruthCommitInput,
} from '@byok-sdk/cloud';
import {
  contentHash,
  createMutableClock,
  isCoreConflictError,
  isCoreError,
  tenantId,
  type ContentHash,
} from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresObjectStore } from '../stores/core/objects';
import { PostgresQuotaStore } from '../stores/core/quota';
import { PostgresTruthCommitter } from '../truth-committer';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-truth');
const NOW = '2026-08-09T00:00:00.000Z';
const PROOF_HASH = contentHash(`sha256:${'f'.repeat(64)}`);

describe.skipIf(SKIP_DATAPLANE)('atomic truth commit authority', () => {
  it('settles inline truth, returns byte-stable replay, and rejects request rebinding', async () => {
    const harness = await createHarness();
    try {
      const write = await inlineWrite('memory', 'profile', 0, 'remember');
      const input = commitInput('request-1', [write]);
      const first = await harness.committer.commit(TENANT, input);
      const replay = await harness.committer.commit(TENANT, input);

      expect(first.replayed).toBe(false);
      expect(replay).toEqual({ response: first.response, replayed: true });
      expect(first.response.primary).toMatchObject({
        kind: 'memory',
        recordKey: 'profile',
        rev: 1,
        byteSize: 8,
      });
      const usage = await harness.quota.readUsage(TENANT);
      expect(usage.committedInlineBytes).toBe(8n);
      expect(usage.reservedBytes).toBe(0n);

      await expect(
        harness.committer.commit(TENANT, { ...input, resource: 'memory/rebound' }),
      ).rejects.toBeInstanceOf(TruthCommitError);
      const receiptCount = await harness.scope.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM proof_request_receipt',
      );
      expect(receiptCount.rows[0]?.count).toBe('1');
    } finally {
      await harness.scope.dispose();
    }
  });

  it('commits terminal and snapshot candidates as one receipt and one accounting unit', async () => {
    const harness = await createHarness();
    try {
      const terminal = await terminalWrite('task-1', 'terminal');
      const profile = await inlineWrite('profile', 'prefs', 0, 'profile');
      const memory = await inlineWrite('memory', 'facts', 0, 'memory');
      const result = await harness.committer.commit(
        TENANT,
        commitInput('batch-1', [terminal, profile, memory]),
      );

      expect(result.response.primary.kind).toBe('task.terminal');
      expect(result.response.snapshots.map((entry) => `${entry.kind}/${entry.recordKey}`)).toEqual([
        'profile/prefs',
        'memory/facts',
      ]);
      const rows = await harness.scope.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM attested_record WHERE tenant_id = $1',
        [TENANT],
      );
      const receipts = await harness.scope.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM proof_request_receipt WHERE tenant_id = $1',
        [TENANT],
      );
      expect(rows.rows[0]?.count).toBe('3');
      expect(receipts.rows[0]?.count).toBe('1');
      expect((await harness.quota.readUsage(TENANT)).committedInlineBytes).toBe(21n);
    } finally {
      await harness.scope.dispose();
    }
  });

  it('keeps terminal first-write immutable and tenant-scoped', async () => {
    const harness = await createHarness();
    const otherTenant = tenantId('tenant-other');
    try {
      await harness.quota.writeEntitlement(otherTenant, {
        version: 1n,
        hardLimitBytes: 10_000n,
        maxObjectBytes: 5_000n,
        maxInlineBytes: 1_000n,
        mailboxLimitBytes: 1_000n,
        retentionPolicyId: 'default',
      });
      const first = await terminalWrite('task-shared', 'first terminal');
      await harness.committer.commit(TENANT, commitInput('terminal-a', [first]));
      const identical = await harness.committer.commit(TENANT, commitInput('terminal-b', [first]));
      expect(identical.response.primary.rev).toBe(1);

      const conflicting = await terminalWrite('task-shared', 'different terminal');
      await expect(
        harness.committer.commit(TENANT, commitInput('terminal-c', [conflicting])),
      ).rejects.toSatisfy((error: unknown) => isCoreConflictError(error, 'terminal_conflict'));

      await expect(
        harness.committer.commit(otherTenant, commitInput('terminal-other', [conflicting])),
      ).resolves.toMatchObject({ response: { primary: { contentHash: conflicting.contentHash } } });
      expect(
        (await harness.committer.getRecord(TENANT, {
          kind: 'task.terminal',
          recordKey: 'task-shared',
        }))?.contentHash,
      ).toBe(first.contentHash);
    } finally {
      await harness.scope.dispose();
    }
  });

  it('rejects inline quota overflow without leaving truth or receipt state', async () => {
    const harness = await createHarness();
    try {
      await harness.quota.writeEntitlement(TENANT, {
        version: 2n,
        hardLimitBytes: 5n,
        maxObjectBytes: 5_000n,
        maxInlineBytes: 1_000n,
        mailboxLimitBytes: 1_000n,
        retentionPolicyId: 'default',
      });
      const write = await inlineWrite('memory', 'over-quota', 0, 'sixsix');
      await expect(
        harness.committer.commit(TENANT, commitInput('over-quota', [write])),
      ).rejects.toSatisfy((error: unknown) => isCoreError(error, 'storage_quota_exceeded'));
      expect(
        await harness.committer.getRecord(TENANT, { kind: 'memory', recordKey: 'over-quota' }),
      ).toBeUndefined();
      const receipts = await harness.scope.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM proof_request_receipt WHERE tenant_id = $1',
        [TENANT],
      );
      expect(receipts.rows[0]?.count).toBe('0');
    } finally {
      await harness.scope.dispose();
    }
  });

  it('rolls back truth, accounting, reservations and receipt when receipt insertion fails last', async () => {
    const harness = await createHarness();
    try {
      await harness.scope.pool.query(`
        CREATE FUNCTION reject_truth_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected receipt failure';
        END
        $$;
        CREATE TRIGGER reject_truth_receipt_trigger
          BEFORE INSERT ON proof_request_receipt
          FOR EACH ROW EXECUTE FUNCTION reject_truth_receipt();
      `);

      const write = await inlineWrite('memory', 'rollback', 0, 'must disappear');
      await expect(
        harness.committer.commit(TENANT, commitInput('rollback-1', [write])),
      ).rejects.toThrow('injected receipt failure');

      const counts = await harness.scope.pool.query<{
        records: string;
        receipts: string;
        reservations: string;
      }>(`SELECT
          (SELECT count(*) FROM attested_record)::text AS records,
          (SELECT count(*) FROM proof_request_receipt)::text AS receipts,
          (SELECT count(*) FROM storage_reservation)::text AS reservations`);
      expect(counts.rows[0]).toEqual({ records: '0', receipts: '0', reservations: '0' });
      expect((await harness.quota.readUsage(TENANT)).committedInlineBytes).toBe(0n);
    } finally {
      await harness.scope.dispose();
    }
  });

  it('requires committed object manifests and replaces GC references atomically', async () => {
    const harness = await createHarness();
    try {
      const hash = contentHash(`sha256:${'a'.repeat(64)}`);
      const pendingHash = contentHash(`sha256:${'b'.repeat(64)}`);
      await harness.quota.reserve(TENANT, {
        reservationId: 'object-1',
        kind: 'object',
        expectedBytes: 128n,
        contentHash: hash,
        contentType: 'application/octet-stream',
        ttlMs: 60_000,
      });
      await harness.objects.putManifest(TENANT, {
        hash,
        byteSize: 128n,
        contentType: 'application/octet-stream',
      });
      await harness.quota.finalizeReservation(TENANT, {
        reservationId: 'object-1',
        observedByteSize: 128n,
        observedContentType: 'application/octet-stream',
      });
      await harness.objects.putManifest(TENANT, {
        hash: pendingHash,
        byteSize: 64n,
        contentType: 'application/octet-stream',
      });

      const rejected = objectWrite('memory', 'pending', 0, pendingHash, 64n);
      await expect(
        harness.committer.commit(TENANT, commitInput('pending-1', [rejected])),
      ).rejects.toMatchObject({ code: 'truth_object_not_committed' });

      const object = objectWrite('memory', 'object-backed', 0, hash, 128n);
      await harness.committer.commit(TENANT, commitInput('object-2', [object]));
      expect((await harness.objects.get(TENANT, hash))?.refCount).toBe(1);
      const ref = await harness.scope.pool.query<{ ref_kind: string; ref_id: string }>(
        'SELECT ref_kind, ref_id FROM object_reference WHERE tenant_id = $1 AND hash = $2',
        [TENANT, hash],
      );
      expect(ref.rows).toEqual([{ ref_kind: 'truth', ref_id: 'memory:object-backed' }]);

      const inline = await inlineWrite('memory', 'object-backed', 1, 'now inline');
      await harness.committer.commit(TENANT, commitInput('object-3', [inline]));
      expect((await harness.objects.get(TENANT, hash))?.refCount).toBe(0);
      expect((await harness.quota.readUsage(TENANT)).committedInlineBytes).toBe(10n);
    } finally {
      await harness.scope.dispose();
    }
  });

  it('locks old and new manifests in one order when concurrent snapshots swap object hashes', async () => {
    const harness = await createHarness(12);
    try {
      const hashA = contentHash(`sha256:${'d'.repeat(64)}`);
      const hashB = contentHash(`sha256:${'e'.repeat(64)}`);
      for (const [index, hash] of [hashA, hashB].entries()) {
        const reservationId = `swap-object-${index}`;
        await harness.quota.reserve(TENANT, {
          reservationId,
          kind: 'object',
          expectedBytes: 32n,
          contentHash: hash,
          contentType: 'application/octet-stream',
          ttlMs: 60_000,
        });
        await harness.objects.putManifest(TENANT, {
          hash,
          byteSize: 32n,
          contentType: 'application/octet-stream',
        });
        await harness.quota.finalizeReservation(TENANT, {
          reservationId,
          observedByteSize: 32n,
          observedContentType: 'application/octet-stream',
        });
      }
      await harness.committer.commit(
        TENANT,
        commitInput('swap-initial-left', [objectWrite('memory', 'swap-left', 0, hashA, 32n)]),
      );
      await harness.committer.commit(
        TENANT,
        commitInput('swap-initial-right', [objectWrite('memory', 'swap-right', 0, hashB, 32n)]),
      );

      for (let round = 1; round <= 4; round += 1) {
        const leftHash = round % 2 === 1 ? hashB : hashA;
        const rightHash = round % 2 === 1 ? hashA : hashB;
        await Promise.all([
          harness.committer.commit(
            TENANT,
            commitInput(`swap-left-${round}`, [
              objectWrite('memory', 'swap-left', round, leftHash, 32n),
            ]),
          ),
          harness.committer.commit(
            TENANT,
            commitInput(`swap-right-${round}`, [
              objectWrite('memory', 'swap-right', round, rightHash, 32n),
            ]),
          ),
        ]);
        expect((await harness.objects.get(TENANT, hashA))?.refCount).toBe(1);
        expect((await harness.objects.get(TENANT, hashB))?.refCount).toBe(1);
      }
    } finally {
      await harness.scope.dispose();
    }
  });

  it('serializes missing snapshot rows so concurrent expectedRev=0 has one typed loser', async () => {
    const harness = await createHarness(10);
    try {
      const left = await inlineWrite('profile', 'race', 0, 'left');
      const right = await inlineWrite('profile', 'race', 0, 'right');
      const outcomes = await Promise.allSettled([
        harness.committer.commit(TENANT, commitInput('race-left', [left])),
        harness.committer.commit(TENANT, commitInput('race-right', [right])),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const loser = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect(isCoreConflictError(loser.reason, 'truth_revision_conflict')).toBe(true);
      expect(await harness.committer.getRecord(TENANT, { kind: 'profile', recordKey: 'race' })).toMatchObject({
        rev: 1,
      });
    } finally {
      await harness.scope.dispose();
    }
  });

  it('counts one tenant/hash once and releases it only after the last inline reference moves', async () => {
    const harness = await createHarness();
    try {
      const sharedA = await inlineWrite('memory', 'shared-a', 0, 'shared');
      const sharedB = await inlineWrite('profile', 'shared-b', 0, 'shared');
      await harness.committer.commit(TENANT, commitInput('shared-a-1', [sharedA]));
      await harness.committer.commit(TENANT, commitInput('shared-b-1', [sharedB]));
      expect((await harness.quota.readUsage(TENANT)).committedInlineBytes).toBe(6n);

      const movedA = await inlineWrite('memory', 'shared-a', 1, 'replacement');
      await harness.committer.commit(TENANT, commitInput('shared-a-2', [movedA]));
      expect((await harness.quota.readUsage(TENANT)).committedInlineBytes).toBe(17n);

      const movedB = await inlineWrite('profile', 'shared-b', 1, 'replacement');
      await harness.committer.commit(TENANT, commitInput('shared-b-2', [movedB]));
      expect((await harness.quota.readUsage(TENANT)).committedInlineBytes).toBe(11n);
    } finally {
      await harness.scope.dispose();
    }
  });

  it('serializes concurrent exact request replay into one write and one replay', async () => {
    const harness = await createHarness(10);
    try {
      const write = await inlineWrite('profile', 'same-request', 0, 'once');
      const input = commitInput('same-request', [write]);
      const results = await Promise.all([
        harness.committer.commit(TENANT, input),
        harness.committer.commit(TENANT, input),
      ]);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(results[0]?.response).toEqual(results[1]?.response);
      const record = await harness.committer.getRecord(TENANT, {
        kind: 'profile',
        recordKey: 'same-request',
      });
      expect(record?.rev).toBe(1);
    } finally {
      await harness.scope.dispose();
    }
  });

  it('rejects one object hash declared with two byte sizes before any mutation', async () => {
    const harness = await createHarness();
    try {
      const hash = contentHash(`sha256:${'c'.repeat(64)}`);
      const first = objectWrite('memory', 'one', 0, hash, 10n);
      const second = objectWrite('profile', 'two', 0, hash, 11n);
      await expect(
        harness.committer.commit(TENANT, commitInput('size-mismatch', [first, second])),
      ).rejects.toSatisfy((error: unknown) => isCoreError(error, 'storage_integrity_mismatch'));
      const records = await harness.scope.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM attested_record',
      );
      expect(records.rows[0]?.count).toBe('0');
    } finally {
      await harness.scope.dispose();
    }
  });
});

async function createHarness(poolSize = 8) {
  const scope = await createDataplaneScope(poolSize);
  await migrate(scope.pool, DEPLOY_SQL);
  const clock = createMutableClock(new Date(NOW));
  const quota = new PostgresQuotaStore(scope.pool, clock);
  await quota.writeEntitlement(TENANT, {
    version: 1n,
    hardLimitBytes: 10_000n,
    maxObjectBytes: 5_000n,
    maxInlineBytes: 1_000n,
    mailboxLimitBytes: 1_000n,
    retentionPolicyId: 'default',
  });
  return {
    scope,
    quota,
    objects: new PostgresObjectStore(scope.pool, clock),
    committer: new PostgresTruthCommitter({ pool: scope.pool, clock, crypto: createWebCrypto() }),
  };
}

function commitInput(
  requestId: string,
  writes: readonly [PreparedTruthWrite, ...PreparedTruthWrite[]],
): TruthCommitInput {
  return {
    deviceId: 'device-a',
    requestId,
    operation: 'truth.write',
    resource: `${writes[0].kind}/${writes[0].recordKey}`,
    proofBodySha256: PROOF_HASH,
    proofBodySize: 100n,
    writes,
  };
}

async function inlineWrite(
  kind: 'profile' | 'memory',
  recordKey: string,
  expectedRev: number,
  body: string,
): Promise<PreparedTruthWrite> {
  const bytes = new TextEncoder().encode(body);
  return {
    kind,
    recordKey,
    expectedRev,
    contentHash: contentHash(await createWebCrypto().sha256(bytes)),
    byteSize: BigInt(bytes.byteLength),
    body: { kind: 'inline', body },
  };
}

async function terminalWrite(recordKey: string, body: string): Promise<PreparedTruthWrite> {
  const bytes = new TextEncoder().encode(body);
  return {
    kind: 'task.terminal',
    recordKey,
    contentHash: contentHash(await createWebCrypto().sha256(bytes)),
    byteSize: BigInt(bytes.byteLength),
    body: { kind: 'inline', body },
  };
}

function objectWrite(
  kind: 'profile' | 'memory',
  recordKey: string,
  expectedRev: number,
  hash: ContentHash,
  byteSize: bigint,
): PreparedTruthWrite {
  return {
    kind,
    recordKey,
    expectedRev,
    contentHash: hash,
    byteSize,
    body: { kind: 'object', hash },
  };
}
