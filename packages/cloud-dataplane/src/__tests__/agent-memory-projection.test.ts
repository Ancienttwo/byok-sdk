import { fileURLToPath } from 'node:url';
import {
  type AgentMemoryProjectionCommitInput,
  createWebCrypto,
} from '@byok-sdk/cloud';
import {
  AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES,
  type AgentMemoryProjectionMutation,
} from '@byok-sdk/protocol';
import { createMutableClock, tenantId, type TenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresAgentMemoryProjectionStore } from '../stores/agent-memory-projection';
import {
  createDataplaneScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-agent-memory');
const OTHER_TENANT = tenantId('tenant-agent-memory-other');
const AGENT_ID = 'memory-agent';

interface InputOptions {
  readonly tenantId?: TenantId;
  readonly deviceId?: string;
  readonly taskId?: string;
  readonly writerEpoch?: number;
  readonly sourceSeq?: number;
  readonly mutationId?: string;
  readonly body?: string;
}

async function input(options: InputOptions = {}): Promise<AgentMemoryProjectionCommitInput> {
  const crypto = createWebCrypto();
  const bytes = new TextEncoder().encode(options.body ?? '# Memory\n\n- redacted fact\n');
  const mutation: AgentMemoryProjectionMutation = {
    taskId: options.taskId ?? 'task-memory',
    agentRef: { agentId: AGENT_ID, profileRevision: 'profile-1' },
    sessionRef: 'session-memory',
    runtimeId: 'codex',
    grantRef: 'grant-memory',
    writerEpoch: options.writerEpoch ?? 1,
    sourceSeq: options.sourceSeq ?? 1,
    mutationId: options.mutationId ?? '30000000-0000-4000-8000-000000000001',
    policyRevision: 'policy-memory',
    snapshot: {
      redactedHash: await crypto.sha256(bytes),
      redactedByteCount: bytes.byteLength,
      redactedBytes: Buffer.from(bytes).toString('base64url'),
    },
  };
  return {
    tenantId: options.tenantId ?? TENANT,
    deviceId: options.deviceId ?? 'device-memory',
    mutation,
    redactedBytes: bytes,
  };
}

describe.skipIf(SKIP_DATAPLANE)(`Postgres Agent-memory projection — ${SKIP_REASON}`, () => {
  it('atomically replaces only the latest bytes while durable exact replays retain one immutable meter receipt', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const store = new PostgresAgentMemoryProjectionStore({ pool: scope.pool, clock, crypto: createWebCrypto() });
      const first = await input();

      const accepted = await store.commit(first);
      expect(accepted.outcome).toBe('accepted');
      expect(accepted.metering.acceptedRedactedBytes).toBe(first.redactedBytes.byteLength);

      clock.advance(1_000);
      const replay = await store.commit(first);
      expect(replay).toEqual({ ...accepted, outcome: 'idempotent' });

      const next = await input({
        sourceSeq: 2,
        mutationId: '30000000-0000-4000-8000-000000000002',
        body: '# Memory\n\n- newer redacted fact\n',
      });
      const nextReceipt = await store.commit(next);
      expect(nextReceipt.outcome).toBe('accepted');
      expect(nextReceipt.metering.meteringReceiptId).not.toBe(accepted.metering.meteringReceiptId);

      // The first receipt is still exact-replayable after the head has moved,
      // but its redacted body is not retained as a history/audit surface.
      expect(await store.commit(first)).toEqual({ ...accepted, outcome: 'idempotent' });
      const durable = await scope.pool.query<{
        readonly receipt_rows: string;
        readonly snapshot_bytes: number;
        readonly body_columns: number;
      }>(
        `SELECT
           (SELECT count(*)::text FROM agent_memory_projection_metering_receipt WHERE tenant_id = $1) AS receipt_rows,
           (SELECT octet_length(redacted_snapshot) FROM agent_memory_projection_head WHERE tenant_id = $1 AND agent_id = $2) AS snapshot_bytes,
           (SELECT count(*)::integer
              FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'agent_memory_projection_metering_receipt'
               AND column_name ILIKE '%snapshot%') AS body_columns`,
        [TENANT, AGENT_ID],
      );
      expect(durable.rows[0]).toEqual({
        receipt_rows: '2',
        snapshot_bytes: next.redactedBytes.byteLength,
        body_columns: 0,
      });
    } finally {
      await scope.dispose();
    }
  });

  it('fails closed for stale epochs, sequence gaps, changed replay bindings, hashes, and oversize snapshots', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresAgentMemoryProjectionStore({
        pool: scope.pool,
        clock: createMutableClock(),
        crypto: createWebCrypto(),
      });
      const first = await input();
      await store.commit(first);

      await expect(store.commit(await input({ sourceSeq: 3, mutationId: '30000000-0000-4000-8000-000000000003' })))
        .rejects.toMatchObject({ code: 'agent_memory_projection_sequence_gap' });

      await store.commit(await input({ writerEpoch: 2, sourceSeq: 1, mutationId: '30000000-0000-4000-8000-000000000004' }));
      await expect(store.commit(await input({ sourceSeq: 2, mutationId: '30000000-0000-4000-8000-000000000005' })))
        .rejects.toMatchObject({ code: 'agent_memory_projection_stale_epoch' });

      await expect(store.commit({
        ...first,
        mutation: { ...first.mutation, taskId: 'different-task' },
      })).rejects.toMatchObject({ code: 'agent_memory_projection_replay_mismatch' });

      await expect(store.commit({
        ...first,
        redactedBytes: new TextEncoder().encode('changed bytes'),
      })).rejects.toMatchObject({ code: 'agent_memory_projection_hash_mismatch' });

      const oversized = new Uint8Array(AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES + 1);
      const crypto = createWebCrypto();
      await expect(store.commit({
        ...first,
        mutation: {
          ...first.mutation,
          writerEpoch: 3,
          sourceSeq: 1,
          mutationId: '30000000-0000-4000-8000-000000000006',
          snapshot: {
            redactedHash: await crypto.sha256(oversized),
            redactedByteCount: oversized.byteLength,
            redactedBytes: Buffer.from(oversized).toString('base64url'),
          },
        },
        redactedBytes: oversized,
      })).rejects.toBeInstanceOf(Error);
      const counts = await scope.pool.query<{ readonly receipts: string; readonly heads: string }>(
        `SELECT
           (SELECT count(*)::text FROM agent_memory_projection_metering_receipt WHERE tenant_id = $1) AS receipts,
           (SELECT count(*)::text FROM agent_memory_projection_head WHERE tenant_id = $1) AS heads`,
        [TENANT],
      );
      expect(counts.rows[0]).toEqual({ receipts: '2', heads: '1' });
    } finally {
      await scope.dispose();
    }
  });

  it('erases head bytes and metering receipts by exact tenant and agent without an online device', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const store = new PostgresAgentMemoryProjectionStore({
        pool: scope.pool,
        clock: createMutableClock(),
        crypto: createWebCrypto(),
      });
      await store.commit(await input());
      await store.commit(await input({ tenantId: OTHER_TENANT, deviceId: 'device-memory-other' }));

      await expect(store.erase({ tenantId: TENANT, agentId: AGENT_ID })).resolves.toEqual({ nextWriterEpoch: 2 });
      const rows = await scope.pool.query<{ readonly tenant_id: string; readonly heads: string; readonly receipts: string; readonly fences: string }>(
        `SELECT tenant_id,
                (SELECT count(*)::text FROM agent_memory_projection_head h WHERE h.tenant_id = x.tenant_id) AS heads,
                (SELECT count(*)::text FROM agent_memory_projection_metering_receipt r WHERE r.tenant_id = x.tenant_id) AS receipts,
                (SELECT count(*)::text FROM agent_memory_projection_erase_fence f WHERE f.tenant_id = x.tenant_id) AS fences
           FROM (VALUES ($1::text), ($2::text)) AS x(tenant_id)
          ORDER BY tenant_id`,
        [TENANT, OTHER_TENANT],
      );
      expect(rows.rows).toEqual([
        { tenant_id: TENANT, heads: '0', receipts: '0', fences: '1' },
        { tenant_id: OTHER_TENANT, heads: '1', receipts: '1', fences: '0' },
      ]);

      // Old local epochs cannot re-inject into an erased empty head. The exact
      // next writer epoch restarts at sourceSeq 1 without retaining a body.
      await expect(store.commit(await input())).rejects.toMatchObject({ code: 'agent_memory_projection_erased_epoch' });
      expect((await store.commit(await input({
        writerEpoch: 2,
        sourceSeq: 1,
        mutationId: '30000000-0000-4000-8000-000000000007',
      }))).outcome).toBe('accepted');
    } finally {
      await scope.dispose();
    }
  });
});
