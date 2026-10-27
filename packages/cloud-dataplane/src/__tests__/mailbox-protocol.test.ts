/**
 * The wire-major startup fence on the Worker-loadable cloud composition
 * (PRD §8.3 "升级与排空", plan R4).
 *
 * `createPostgresCloudStores` is async and refuses with a typed error when any
 * pending mailbox row is not a `PROTOCOL_VERSION` envelope. Two layers:
 *
 * - a substrate-free layer over a recording pool stand-in, which pins the
 *   predicate, the keyset paging and the read-only SQL shape and runs
 *   everywhere;
 * - a Postgres layer over the real `deploy/sql` schema, which proves a pending
 *   v2 row refuses the composition and the database is row-identical
 *   afterwards. It skips without the dataplane substrate, like every other
 *   Postgres suite here.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWebCrypto } from '@byok-sdk/cloud';
import { contentHash, createMutableClock, tenantId } from '@byok-sdk/core';
import { createEnvelope, encodeEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import type { Pool } from 'pg';
import { migrate } from '../migrate';
import * as runtime from '../runtime';
import { PostgresMailboxStore } from '../stores/core/mailbox';
import { PostgresQuotaStore } from '../stores/core/quota';
import {
  createPostgresCloudStores,
  POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED,
  PostgresMailboxProtocolUnsupportedError,
  type PostgresObjectStorageOptions,
} from '../stores/index';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-mailbox-protocol');
const HASH = contentHash(`sha256:${'d'.repeat(64)}`);

/** Constructing the blob store opens no connection, so a static config is enough for the fence. */
const OBJECT_STORAGE: PostgresObjectStorageOptions = {
  endpoint: 'http://127.0.0.1:9',
  bucket: 'byok-mailbox-protocol',
  accessKeyId: 'unused',
  secretAccessKey: 'unused',
  region: 'us-east-1',
  signingClock: { now: () => new Date() },
};

function cancelEnvelope(v: unknown, seq = 1): string {
  const envelope = createEnvelope('task.cancel', { reason: 'user cancelled' }, {
    id: '00000000-0000-4000-8000-000000000006', ts: '2026-01-01T00:00:05.000Z', taskId: 'task-golden-1', seq,
  });
  return JSON.stringify({ ...envelope, v });
}

interface RecordedQuery { readonly sql: string; readonly params: readonly unknown[] }
interface StubRow { readonly tenant_id: string; readonly device_id: string; readonly seq_text: string; readonly body: string }

/** A pool stand-in that serves the given pending rows through the scan's own keyset contract. */
function recordingPool(pending: readonly StubRow[]): { readonly pool: Pool; readonly queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const key = (row: StubRow) => [row.tenant_id, row.device_id, BigInt(row.seq_text)] as const;
  const after = (row: StubRow, cursor: readonly unknown[]) => {
    const [t, d, s] = key(row);
    const [ct, cd, cs] = [cursor[0] as string, cursor[1] as string, BigInt(cursor[2] as string)];
    return t > ct || (t === ct && (d > cd || (d === cd && s > cs)));
  };
  const pool = {
    async query(sql: string, params: readonly unknown[] = []) {
      queries.push({ sql, params });
      const limit = params[params.length - 1] as number;
      const cursor = params.length === 4 ? params.slice(0, 3) : undefined;
      const rows = pending.filter((row) => cursor === undefined || after(row, cursor)).slice(0, limit);
      return { rows };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const compose = (pool: Pool) =>
  createPostgresCloudStores({ pool, clock: createMutableClock(), crypto: createWebCrypto(), objectStorage: OBJECT_STORAGE });

describe('pending-mailbox wire-major fence (substrate-free)', () => {
  it('is exported from the Worker runtime entry, and the factory has no synchronous form', () => {
    expect(runtime.PostgresMailboxProtocolUnsupportedError).toBe(PostgresMailboxProtocolUnsupportedError);
    expect(runtime.POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED).toBe('POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED');
    const { pool } = recordingPool([]);
    const pending = compose(pool);
    expect(pending).toBeInstanceOf(Promise);
    return pending;
  });

  it('returns the full composition when every pending row is a current-major envelope', async () => {
    const { pool, queries } = recordingPool([
      { tenant_id: 't', device_id: 'd', seq_text: '1', body: cancelEnvelope(PROTOCOL_VERSION, 1) },
      { tenant_id: 't', device_id: 'd', seq_text: '2', body: encodeEnvelope(createEnvelope('task.offer_for_agent', { instruction: 'x', agentRef: { agentId: 'agent-x', profileRevision: 'rev-1' } }, { taskId: 'task-x', seq: 2 })) },
    ]);
    const stores = await compose(pool);
    expect(Object.keys(stores).sort()).toEqual([
      'activity', 'agentMessageDraft', 'approvals', 'blobs', 'cancellations', 'dedup', 'devices', 'egress', 'nonces',
      'pairing', 'pairingCodes', 'proofReceipts', 'rateLimiter', 'receipts', 'tasks',
    ]);
    expect(queries).toHaveLength(1);
  });

  it.each([
    ['v2', cancelEnvelope(2)],
    ['v1', cancelEnvelope(1)],
    ['v4', cancelEnvelope(PROTOCOL_VERSION + 1)],
    ['string major', cancelEnvelope(String(PROTOCOL_VERSION))],
    ['no major', cancelEnvelope(undefined)],
    ['broken json', 'broken json'],
    ['json null', 'null'],
    ['json array', '[3]'],
  ])('refuses a pending %s row with the typed error and returns no stores', async (_label, body) => {
    const { pool } = recordingPool([
      { tenant_id: 't', device_id: 'a', seq_text: '1', body: cancelEnvelope(PROTOCOL_VERSION) },
      { tenant_id: 't', device_id: 'b', seq_text: '7', body },
    ]);
    const refusal = await compose(pool).then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(PostgresMailboxProtocolUnsupportedError);
    expect(refusal).toMatchObject({
      code: POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED,
      requiredVersion: PROTOCOL_VERSION,
      tenantId: 't',
      deviceId: 'b',
      seq: 7n,
    });
    expect((refusal as Error).message).toContain(`protocol v${PROTOCOL_VERSION}`);
  });

  it('pages by primary key without skipping a row, and issues only pending-row SELECTs', async () => {
    const pending: StubRow[] = Array.from({ length: 600 }, (_, index) => ({
      tenant_id: 't', device_id: index < 300 ? 'a' : 'b', seq_text: String(index + 1), body: cancelEnvelope(PROTOCOL_VERSION),
    }));
    pending[599] = { ...pending[599]!, body: cancelEnvelope(2) };
    const { pool, queries } = recordingPool(pending);
    await expect(compose(pool)).rejects.toMatchObject({ code: POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED, deviceId: 'b', seq: 600n });
    expect(queries).toHaveLength(3);
    expect(queries[1]!.params.slice(0, 3)).toEqual(['t', 'a', '256']);
    expect(queries[2]!.params.slice(0, 3)).toEqual(['t', 'b', '512']);
    for (const { sql } of queries) {
      expect(sql.trimStart()).toMatch(/^SELECT /u);
      expect(sql).toContain("state = 'pending'");
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/iu);
    }
  });
});

describe.skipIf(SKIP_DATAPLANE)(`pending-mailbox wire-major fence [postgres] — ${SKIP_REASON}`, () => {
  async function seeded() {
    const scope = await createDataplaneScope();
    await migrate(scope.pool, DEPLOY_SQL);
    const clock = createMutableClock();
    await new PostgresQuotaStore(scope.pool, clock).writeEntitlement(TENANT, {
      version: 1n, hardLimitBytes: 10_000_000n, maxObjectBytes: 10_000_000n, maxInlineBytes: 10_000_000n,
      mailboxLimitBytes: 10_000_000n, retentionPolicyId: 'default',
    });
    const mailbox = new PostgresMailboxStore(scope.pool, clock);
    const append = (deviceId: string, messageId: string, body: string) => mailbox.append(TENANT, {
      deviceId, messageId, admission: 'limited',
      materialize: () => ({ body, bodyHash: HASH, byteSize: BigInt(new TextEncoder().encode(body).length) }),
    });
    const snapshot = async () => ({
      outbox: (await scope.pool.query('SELECT * FROM outbox ORDER BY tenant_id, device_id, seq')).rows,
      streams: (await scope.pool.query('SELECT * FROM device_stream ORDER BY tenant_id, device_id')).rows,
    });
    return { scope, clock, mailbox, append, snapshot };
  }

  it('refuses a pending v2 row and leaves every mailbox row and cursor unchanged', async () => {
    const { scope, mailbox, append, snapshot } = await seeded();
    try {
      // Acked v2 history is not inspected; a pending v3 row is admissible.
      const history = await append('device-a', 'history', cancelEnvelope(2));
      await mailbox.recordDelivery(TENANT, { deviceId: 'device-a', deliveredSeq: history.seq });
      await mailbox.advanceCursor(TENANT, { deviceId: 'device-a', ackedSeq: history.seq });
      await append('device-a', 'current', cancelEnvelope(PROTOCOL_VERSION));
      const undrained = await append('device-b', 'undrained', cancelEnvelope(2));
      const before = await snapshot();
      expect(before.outbox.filter((row) => row.state === 'pending')).toHaveLength(2);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(compose(scope.pool)).rejects.toMatchObject({
          name: 'PostgresMailboxProtocolUnsupportedError',
          code: POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED,
          tenantId: TENANT,
          deviceId: 'device-b',
          seq: BigInt(undrained.seq),
        });
        expect(await snapshot()).toEqual(before);
      }
    } finally {
      await scope.dispose();
    }
  });

  it('composes over pending v3 rows with retained v2 history, across more than one scan page', async () => {
    const { scope, mailbox, append } = await seeded();
    try {
      const history = await append('device-a', 'history', cancelEnvelope(2));
      await mailbox.recordDelivery(TENANT, { deviceId: 'device-a', deliveredSeq: history.seq });
      await mailbox.advanceCursor(TENANT, { deviceId: 'device-a', ackedSeq: history.seq });
      for (let index = 0; index < 300; index += 1) await append('device-a', `current-${index}`, cancelEnvelope(PROTOCOL_VERSION));
      const stores = await compose(scope.pool);
      expect(stores.tasks).toBeDefined();

      // The page boundary does not hide a late offender.
      const late = await append('device-a', 'late-v2', cancelEnvelope(2));
      await expect(compose(scope.pool)).rejects.toMatchObject({ code: POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED, seq: BigInt(late.seq) });
    } finally {
      await scope.dispose();
    }
  });
});
